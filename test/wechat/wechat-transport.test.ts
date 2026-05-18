import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertWechatApiResponseOk,
  assertMediaUploadSizeAllowed,
  buildInboundMessageClaimPath,
  clearInboundMessageClaims,
  classifyWechatTransportError,
  describeWechatTransportError,
  formatByteSize,
  isWechatContextTokenStaleError,
  isWechatSyncSessionTimeout,
  resolveMediaUploadLimitBytes,
  tryClaimInboundMessage,
  WechatApiResponseError,
} from "../../src/wechat/wechat-transport.ts";

describe("wechat upload limits", () => {
  test("uses the default per-media upload limits", () => {
    expect(resolveMediaUploadLimitBytes("image", {})).toBe(20 * 1024 * 1024);
    expect(resolveMediaUploadLimitBytes("file", {})).toBe(50 * 1024 * 1024);
    expect(resolveMediaUploadLimitBytes("voice", {})).toBe(20 * 1024 * 1024);
    expect(resolveMediaUploadLimitBytes("video", {})).toBe(100 * 1024 * 1024);
  });

  test("allows env overrides and ignores invalid values", () => {
    expect(
      resolveMediaUploadLimitBytes("video", {
        WECHAT_MAX_VIDEO_MB: "64",
      } as NodeJS.ProcessEnv),
    ).toBe(64 * 1024 * 1024);

    expect(
      resolveMediaUploadLimitBytes("video", {
        WECHAT_MAX_VIDEO_MB: "not-a-number",
      } as NodeJS.ProcessEnv),
    ).toBe(100 * 1024 * 1024);
  });

  test("throws a clear error when a file exceeds the configured limit", () => {
    expect(() =>
      assertMediaUploadSizeAllowed(
        "video",
        377_800_000,
        {} as NodeJS.ProcessEnv,
      ),
    ).toThrow(
      "Video too large: 360 MB exceeds 100 MB limit. Set WECHAT_MAX_VIDEO_MB to override.",
    );
  });

  test("formats byte sizes consistently", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1_536)).toBe("1.5 KB");
    expect(formatByteSize(20 * 1024 * 1024)).toBe("20.0 MB");
  });

  test("classifies transient fetch failures as retryable network errors", () => {
    const cause = Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), {
      code: "ETIMEDOUT",
      syscall: "connect",
      address: "10.0.0.1",
      port: 443,
    });
    const error = new TypeError("fetch failed", { cause });

    expect(classifyWechatTransportError(error)).toEqual({
      kind: "network",
      retryable: true,
    });
    expect(describeWechatTransportError(error)).toContain("TypeError: fetch failed");
    expect(describeWechatTransportError(error)).toContain("code=ETIMEDOUT");
  });

  test("treats HTTP 503 as retryable and HTTP 401 as fatal auth", () => {
    expect(classifyWechatTransportError(new Error("HTTP 503: upstream unavailable"))).toEqual({
      kind: "http",
      retryable: true,
      statusCode: 503,
    });

    expect(classifyWechatTransportError(new Error("HTTP 401: unauthorized"))).toEqual({
      kind: "auth",
      retryable: false,
      statusCode: 401,
    });
  });

  test("treats WeChat session timeout as fatal auth instead of retryable network", () => {
    expect(
      classifyWechatTransportError(
        new Error('WeChat session timed out. Run "wechat-setup" to log in again.'),
      ),
    ).toEqual({
      kind: "auth",
      retryable: false,
    });
  });

  test("detects expired WeChat sync sessions from app-level responses", () => {
    expect(
      isWechatSyncSessionTimeout({
        errcode: -14,
        errmsg: "session timeout",
      }),
    ).toBe(true);
    expect(
      isWechatSyncSessionTimeout({
        errcode: -14,
        errmsg: "other failure",
      }),
    ).toBe(false);
  });

  test("throws on app-level sendmessage failures even when HTTP succeeded", () => {
    expect(() =>
      assertWechatApiResponseOk(
        "sendmessage",
        JSON.stringify({ ret: 1, errcode: 45009, errmsg: "rate limited" }),
      ),
    ).toThrow("sendmessage failed: ret=1 errcode=45009 errmsg=rate limited");

    expect(() =>
      assertWechatApiResponseOk("sendmessage", JSON.stringify({ ret: 0 })),
    ).not.toThrow();
  });

  test("classifies sendmessage ret=-2 as stale WeChat context", () => {
    let thrown: unknown;

    try {
      assertWechatApiResponseOk("sendmessage", JSON.stringify({ ret: -2 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WechatApiResponseError);
    expect(thrown).toMatchObject({
      endpoint: "sendmessage",
      ret: -2,
      errcode: undefined,
      errmsg: "",
    });
    expect(isWechatContextTokenStaleError(thrown)).toBe(true);
    expect(describeWechatTransportError(thrown)).toContain(
      "WechatApiResponseError: sendmessage failed: ret=-2 errcode=undefined errmsg=",
    );
  });

  test("does not classify other app-level failures as stale WeChat context", () => {
    expect(
      isWechatContextTokenStaleError(
        new WechatApiResponseError({
          endpoint: "getupdates",
          ret: -2,
        }),
      ),
    ).toBe(false);
    expect(
      isWechatContextTokenStaleError(
        new WechatApiResponseError({
          endpoint: "sendmessage",
          ret: 1,
        }),
      ),
    ).toBe(false);
  });

  test("claims each inbound message key only once across processes", () => {
    const claimsDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claims-"));
    const scopedMessageKey = "account-1|sender|client|123|ctx";

    try {
      expect(tryClaimInboundMessage(scopedMessageKey, { claimsDir })).toBe(true);
      expect(tryClaimInboundMessage(scopedMessageKey, { claimsDir })).toBe(false);
      expect(fs.existsSync(buildInboundMessageClaimPath(scopedMessageKey, claimsDir))).toBe(true);
    } finally {
      clearInboundMessageClaims(claimsDir);
    }
  });

  test("reclaims stale inbound message claims after the TTL expires", () => {
    const claimsDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claims-"));
    const scopedMessageKey = "account-1|sender|client|456|ctx";
    const nowMs = Date.now();

    try {
      expect(
        tryClaimInboundMessage(scopedMessageKey, {
          claimsDir,
          nowMs,
          ttlMs: 1000,
        }),
      ).toBe(true);

      const claimPath = buildInboundMessageClaimPath(scopedMessageKey, claimsDir);
      fs.utimesSync(claimPath, new Date(nowMs - 5000), new Date(nowMs - 5000));

      expect(
        tryClaimInboundMessage(scopedMessageKey, {
          claimsDir,
          nowMs,
          ttlMs: 1000,
        }),
      ).toBe(true);
    } finally {
      clearInboundMessageClaims(claimsDir);
    }
  });
});
