import { describe, expect, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertWechatApiResponseOk,
  assertMediaUploadSizeAllowed,
  buildCdnDownloadUrl,
  buildInboundMessageClaimPath,
  clearInboundMessageClaims,
  classifyWechatTransportError,
  decodeInboundMediaAesKey,
  decryptInboundMediaPayload,
  describeWechatTransportError,
  extractInboundMessageContent,
  formatByteSize,
  isWechatContextTokenStaleError,
  isWechatSyncSessionTimeout,
  resolveInboundMediaDownloadLimitBytes,
  resolveMediaUploadLimitBytes,
  tryClaimInboundMessage,
  WechatApiResponseError,
  WeChatTransport,
  type WeixinMessage,
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

  test("uses separate inbound download limits", () => {
    expect(resolveInboundMediaDownloadLimitBytes("image", {} as NodeJS.ProcessEnv)).toBe(
      20 * 1024 * 1024,
    );
    expect(
      resolveInboundMediaDownloadLimitBytes("file", {
        WECHAT_MAX_INBOUND_FILE_MB: "12",
      } as NodeJS.ProcessEnv),
    ).toBe(12 * 1024 * 1024);
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

  test("stops an in-flight long poll without waiting for its timeout", async () => {
    const originalFetch = globalThis.fetch;
    let fetchStarted: (() => void) | null = null;
    const fetchReady = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });

    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      fetchStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;

    const transport = new WeChatTransport({
      log: () => undefined,
      logError: () => undefined,
    });
    transport.getCredentials = () => ({
      token: "test-token",
      baseUrl: "https://example.invalid",
      accountId: "test-account",
      userId: "test-user",
      savedAt: new Date().toISOString(),
    });

    try {
      const polling = transport.pollMessages({ timeoutMs: 60_000 });
      await fetchReady;
      const startedAt = Date.now();
      transport.stop();
      await expect(polling).resolves.toEqual({
        messages: [],
        ignoredBacklogCount: 0,
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      transport.stop();
      globalThis.fetch = originalFetch;
    }
  });
});

describe("wechat inbound media", () => {
  test("extracts image and file descriptors without requiring text", () => {
    const message: WeixinMessage = {
      item_list: [
        {
          type: 2,
          image_item: {
            file_name: "screenshot.png",
            media: {
              aes_key: "00112233445566778899aabbccddeeff",
              encrypt_query_param: "img-param",
            },
          },
        },
        {
          type: 4,
          file_item: {
            file_name: "report.pdf",
            len: "128",
            media: {
              aes_key: "ffeeddccbbaa99887766554433221100",
              encrypt_query_param: "file-param",
            },
          },
        },
      ],
    };

    expect(extractInboundMessageContent(message)).toEqual({
      text: "",
      attachments: [
        expect.objectContaining({
          kind: "image",
          fileName: "screenshot.png",
          aesKey: "00112233445566778899aabbccddeeff",
          expectedSizeBytes: undefined,
        }),
        expect.objectContaining({
          kind: "file",
          fileName: "report.pdf",
          aesKey: "ffeeddccbbaa99887766554433221100",
          expectedSizeBytes: 128,
        }),
      ],
    });
  });

  test("adds an explicit note when media metadata is missing", () => {
    const message: WeixinMessage = {
      item_list: [{ type: 2, image_item: {} }],
    };

    expect(extractInboundMessageContent(message)).toEqual({
      text: "[WeChat image attachment could not be downloaded: missing media metadata]",
      attachments: [],
    });
  });

  test("builds CDN download URLs from encrypted query params", () => {
    expect(buildCdnDownloadUrl("https://novac2c.cdn.weixin.qq.com/c2c", "a+b/c=")).toBe(
      "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%2Bb%2Fc%3D",
    );
  });

  test("decodes inbound AES keys and decrypts media payloads", () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const plaintext = Buffer.from("wechat inbound media");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    expect(decodeInboundMediaAesKey(key.toString("hex"))).toEqual(key);
    expect(decodeInboundMediaAesKey(key.toString("base64"))).toEqual(key);
    expect(decodeInboundMediaAesKey(Buffer.from(key.toString("hex")).toString("base64"))).toEqual(
      key,
    );
    expect(decryptInboundMediaPayload(ciphertext, key.toString("hex"))).toEqual(plaintext);
  });
});
