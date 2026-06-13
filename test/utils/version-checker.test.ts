import { describe, expect, test } from "bun:test";

import {
  compareVersions,
  fetchLatestVersion,
  parseVersion,
} from "../../src/utils/version-checker.ts";

// 可注入的 fetch mock:按 URL 子串匹配 npm / github 路由,记录调用顺序。
function buildFetchMock(routes: {
  npm?: unknown;
  github?: unknown;
  npmStatus?: number;
  githubStatus?: number;
}): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes("registry.npmjs.org")) {
      const status = routes.npmStatus ?? 200;
      const body = routes.npm === undefined ? "" : JSON.stringify(routes.npm);
      return new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("api.github.com")) {
      const status = routes.githubStatus ?? 200;
      const body = routes.github === undefined ? "" : JSON.stringify(routes.github);
      return new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch, calls };
}

describe("parseVersion", () => {
  test("提取纯数字版本号", () => {
    expect(parseVersion("1.1.1")).toBe("1.1.1");
  });

  test("兼容 v 前缀", () => {
    expect(parseVersion("v1.2.3")).toBe("1.2.3");
  });

  test("trim 后提取", () => {
    expect(parseVersion("  2.0.0  ")).toBe("2.0.0");
  });

  test("从预发布标识中提取主版本号", () => {
    expect(parseVersion("v2.0.0-rc.1")).toBe("2.0.0");
  });

  test("无版本号返回 null", () => {
    expect(parseVersion("garbage")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  test("非字符串返回 null", () => {
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(123)).toBeNull();
  });
});

describe("compareVersions", () => {
  test("大于返回正数", () => {
    expect(compareVersions("1.1.1", "1.1.0")).toBeGreaterThan(0);
  });

  test("小于返回负数", () => {
    expect(compareVersions("1.0.0", "1.1.0")).toBeLessThan(0);
  });

  test("相等返回 0", () => {
    expect(compareVersions("1.1.1", "1.1.1")).toBe(0);
  });

  test("主版本号差异优先", () => {
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });
});

describe("fetchLatestVersion", () => {
  test("npm 命中时直接返回 npm 版本,且不回退 GitHub", async () => {
    const { fetch, calls } = buildFetchMock({ npm: { version: "1.2.3" } });
    const latest = await fetchLatestVersion({ fetchImpl: fetch });
    expect(latest).toBe("1.2.3");
    expect(calls.some((u) => u.includes("registry.npmjs.org"))).toBe(true);
    expect(calls.some((u) => u.includes("api.github.com"))).toBe(false);
  });

  test("npm 失败时回退 GitHub tags 并取最高版本", async () => {
    const { fetch } = buildFetchMock({
      npmStatus: 500,
      github: [{ name: "1.1.0" }, { name: "1.1.1" }, { name: "1.0.0" }],
    });
    const latest = await fetchLatestVersion({ fetchImpl: fetch });
    expect(latest).toBe("1.1.1");
  });

  test("GitHub tags 含 v 前缀也能正确解析", async () => {
    const { fetch } = buildFetchMock({
      npmStatus: 404,
      github: [{ name: "v1.5.0" }, { name: "v1.4.0" }],
    });
    const latest = await fetchLatestVersion({ fetchImpl: fetch });
    expect(latest).toBe("1.5.0");
  });

  test("npm 返回的 version 字段无效时回退 GitHub", async () => {
    const { fetch } = buildFetchMock({
      npm: { version: "not-a-version" },
      github: [{ name: "1.1.1" }],
    });
    const latest = await fetchLatestVersion({ fetchImpl: fetch });
    expect(latest).toBe("1.1.1");
  });

  test("两个源都失败时返回 null", async () => {
    const { fetch } = buildFetchMock({ npmStatus: 500, githubStatus: 503 });
    const latest = await fetchLatestVersion({ fetchImpl: fetch });
    expect(latest).toBeNull();
  });

  test("请求超时返回 null 且不挂起", async () => {
    const fetch = (async (
      _url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as typeof fetch;
    const latest = await fetchLatestVersion({ fetchImpl: fetch, timeoutMs: 50 });
    expect(latest).toBeNull();
  });
});
