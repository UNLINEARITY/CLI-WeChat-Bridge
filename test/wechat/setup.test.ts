import { describe, expect, test } from "bun:test";

import {
  formatQRCodeLoginInstruction,
  getStoredCredentialsInvalidReason,
  getQRCodeVisibleWidth,
  getWechatLoginRequiredReason,
  formatWechatSetupUsage,
  parseWechatSetupCliArgs,
  printQRCode,
  runWechatLogin,
  selectQRCodePresentation,
  type StoredAccount,
} from "../../src/wechat/setup.ts";

const account: StoredAccount = {
  token: "token-1",
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "bot-1",
  userId: "owner@im.wechat",
  savedAt: "2026-05-10T00:00:00.000Z",
};

describe("wechat setup credentials", () => {
  test("requires login when no credentials have been saved", () => {
    expect(getWechatLoginRequiredReason(null)).toBe(
      "No saved WeChat credentials found.",
    );
  });

  test("accepts complete credentials for bridge startup", () => {
    expect(
      getWechatLoginRequiredReason(account, {
        requireUserId: true,
      }),
    ).toBeNull();
  });

  test("requires login when bridge credentials cannot identify the owner", () => {
    const { userId, ...withoutUserId } = account;
    expect(
      getWechatLoginRequiredReason(withoutUserId, {
        requireUserId: true,
      }),
    ).toBe("Saved WeChat credentials are missing userId.");
  });

  test("detects expired saved credentials during startup validation", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          errcode: -14,
          errmsg: "session timeout",
        }),
        { status: 200 },
      )) as typeof fetch;

    try {
      await expect(
        getStoredCredentialsInvalidReason(account, {
          timeoutMs: 1000,
        }),
      ).resolves.toBe("Saved WeChat login has expired.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("wechat setup QR presentation", () => {
  test("fails before fetching a QR code when stdout is not interactive", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    const logs: string[] = [];
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("fetch should not be called");
    }) as typeof fetch;

    try {
      await expect(
        runWechatLogin({
          terminal: { platform: "win32", isTTY: false, columns: 80 },
          timeoutMs: 1,
          pollIntervalMs: 1,
          log: (message) => logs.push(message),
        }),
      ).rejects.toThrow(
        "WeChat login requires an interactive terminal.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
    expect(logs).toEqual([]);
  });

  test("does not render a QR code or URL directly in a non-interactive terminal", async () => {
    const writes: string[] = [];
    const url = "https://example.test/wechat-login";

    const presentation = await printQRCode(
      url,
      (message) => writes.push(message),
      { platform: "win32", isTTY: false, columns: 80 },
      "small",
      async () => "qr",
    );

    expect(presentation).toBe("url_only");
    expect(writes.join("")).toBe("");
    expect(writes.join("")).not.toContain(url);
  });

  test("uses normal QR output on Windows and prints one browser fallback URL", async () => {
    const writes: string[] = [];
    const url = "https://example.test/wechat-login";
    let generatedOptions: { small: boolean } | undefined;

    const presentation = await printQRCode(
      url,
      (message) => writes.push(message),
      { platform: "win32", isTTY: true, columns: 80 },
      "normal",
      async (_input, options) => {
        generatedOptions = options;
        return "\u001b[47m  \u001b[0m";
      },
    );

    const output = writes.join("");
    expect(presentation).toBe("qr_with_url");
    expect(generatedOptions).toEqual({ small: false });
    expect(output).not.toMatch(/[█▀▄]/);
    expect(output.split(url).length - 1).toBe(1);
  });

  test("keeps small QR output by default on Windows", async () => {
    let generatedOptions: { small: boolean } | undefined;

    const presentation = await printQRCode(
      "https://example.test/wechat-login",
      () => undefined,
      { platform: "win32", isTTY: true, columns: 80 },
      undefined,
      async (_input, options) => {
        generatedOptions = options;
        return "qr";
      },
    );

    expect(presentation).toBe("qr_with_url");
    expect(generatedOptions).toEqual({ small: true });
  });

  test("renders the actual Windows qrcode-terminal output without small Unicode blocks", async () => {
    const writes: string[] = [];
    const url = "https://example.test/wechat-login";

    const presentation = await printQRCode(
      url,
      (message) => writes.push(message),
      { platform: "win32", isTTY: true, columns: 120 },
      "normal",
    );

    const output = writes.join("");
    expect(presentation).toBe("qr_with_url");
    expect(output).not.toMatch(/[█▀▄]/);
    expect(output.split(url).length - 1).toBe(1);
  });

  test("keeps small QR output on non-Windows platforms", async () => {
    let generatedOptions: { small: boolean } | undefined;

    const presentation = await printQRCode(
      "https://example.test/wechat-login",
      () => undefined,
      { platform: "linux", isTTY: true, columns: 80 },
      "small",
      async (_input, options) => {
        generatedOptions = options;
        return "qr";
      },
    );

    expect(presentation).toBe("qr_with_url");
    expect(generatedOptions).toEqual({ small: true });
  });

  test("uses URL-only mode at the last terminal column or with invalid width", () => {
    expect(
      selectQRCodePresentation({ isTTY: true, columns: 4, renderedWidth: 4 }),
    ).toBe("url_only");
    expect(
      selectQRCodePresentation({ isTTY: true, columns: 5, renderedWidth: 4 }),
    ).toBe("qr_with_url");

    for (const columns of [undefined, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        selectQRCodePresentation({ isTTY: true, columns, renderedWidth: 4 }),
      ).toBe("url_only");
    }
  });

  test("prints only one browser URL when the rendered QR does not fit", async () => {
    const writes: string[] = [];
    const url = "https://example.test/wechat-login";

    const presentation = await printQRCode(
      url,
      (message) => writes.push(message),
      { platform: "win32", isTTY: true, columns: 5 },
      "normal",
      async () => "12345",
    );

    const output = writes.join("");
    expect(presentation).toBe("url_only");
    expect(output).not.toContain("12345");
    expect(output.split(url).length - 1).toBe(1);
  });

  test("measures QR width without counting ANSI SGR sequences", () => {
    expect(
      getQRCodeVisibleWidth("\u001b[47m  \u001b[0m\n\u001b[47m  \u001b[0m"),
    ).toBe(2);
  });

  test("uses URL-only mode when QR generation fails and does not expose it in log text", async () => {
    const writes: string[] = [];
    const url = "https://example.test/wechat-login";

    const presentation = await printQRCode(
      url,
      (message) => writes.push(message),
      { platform: "win32", isTTY: true, columns: 80 },
      "normal",
      async () => {
        throw new Error("renderer failed");
      },
    );

    expect(presentation).toBe("url_only");
    expect(writes.join("").split(url).length - 1).toBe(1);
    expect(formatQRCodeLoginInstruction(presentation)).not.toContain(
      "Scan the QR code above",
    );
  });

  test("formats distinct instructions for QR and URL-only presentations", () => {
    expect(formatQRCodeLoginInstruction("qr_with_url")).toContain(
      "Scan the QR code above",
    );
    expect(formatQRCodeLoginInstruction("url_only")).toContain(
      "Open the browser URL above",
    );
    expect(formatQRCodeLoginInstruction("url_only")).not.toContain(
      "Scan the QR code above",
    );
  });

  test("defaults setup QR mode to small and accepts an explicit normal mode", () => {
    expect(parseWechatSetupCliArgs([])).toEqual({ help: false, qrMode: "small" });
    expect(parseWechatSetupCliArgs(["--qr-mode", "normal"])).toEqual({
      help: false,
      qrMode: "normal",
    });
    expect(parseWechatSetupCliArgs(["--qr-mode=normal"])).toEqual({
      help: false,
      qrMode: "normal",
    });
  });

  test("rejects invalid setup QR modes and exposes the selection in help", () => {
    expect(() => parseWechatSetupCliArgs(["--qr-mode", "large"])).toThrow(
      "--qr-mode requires small or normal.",
    );
    expect(formatWechatSetupUsage()).toContain(
      "--qr-mode <small|normal>",
    );
  });
});
