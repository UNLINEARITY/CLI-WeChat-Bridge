import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  buildWorkspaceKey,
  getWorkspaceChannelPaths,
  migrateLegacyChannelFiles,
  normalizeWorkspacePath,
  resolveChannelDataDir,
} from "../../src/wechat/channel-config.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cli-bridge-channel-config-"));
}

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

describe("workspace channel paths", () => {
  test("normalizes a workspace path to an absolute path", () => {
    const resolved = normalizeWorkspacePath(".");
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  test("builds a stable workspace key for the same cwd", () => {
    const cwd = path.resolve("test-workspaces", "repo");

    expect(buildWorkspaceKey(cwd)).toBe(buildWorkspaceKey(cwd));
  });

  test("builds different workspace paths for different cwd values", () => {
    const repoA = path.resolve("test-workspaces", "repo-a");
    const repoB = path.resolve("test-workspaces", "repo-b");

    const pathsA = getWorkspaceChannelPaths(repoA);
    const pathsB = getWorkspaceChannelPaths(repoB);

    expect(pathsA.workspaceDir).not.toBe(pathsB.workspaceDir);
    expect(pathsA.stateFile.endsWith("bridge-state.json")).toBe(true);
    expect(pathsA.endpointFile.endsWith("codex-panel-endpoint.json")).toBe(true);
  });

  test("uses .cli-bridge as the default user data directory", () => {
    expect(resolveChannelDataDir({} as NodeJS.ProcessEnv, "C:\\Users\\tester")).toBe(
      path.join("C:\\Users\\tester", ".cli-bridge"),
    );
  });

  test("uses the new data-dir env var when provided", () => {
    expect(
      resolveChannelDataDir(
        {
          CLI_BRIDGE_DATA_DIR: "C:\\bridge-data",
        } as NodeJS.ProcessEnv,
        "C:\\Users\\tester",
      ),
    ).toBe(path.resolve("C:\\bridge-data"));
  });

  test("does not use the legacy Claude data-dir env var as the active directory", () => {
    expect(
      resolveChannelDataDir(
        {
          CLAUDE_WECHAT_CHANNEL_DATA_DIR: "C:\\old-bridge-data",
        } as NodeJS.ProcessEnv,
        "C:\\Users\\tester",
      ),
    ).toBe(path.join("C:\\Users\\tester", ".cli-bridge"));
  });

});

describe("legacy channel data migration", () => {
  test("copies legacy data into an empty active data directory", () => {
    const root = makeTempDir();
    try {
      const channelDataDir = path.join(root, "new");
      const legacyDataDir = path.join(root, "legacy");
      const logs: string[] = [];

      writeTextFile(path.join(legacyDataDir, "account.json"), '{"token":"old"}');
      writeTextFile(path.join(legacyDataDir, "sync_buf.txt"), "sync");
      writeTextFile(
        path.join(legacyDataDir, "context_tokens.json"),
        '{"session":"ctx"}',
      );
      writeTextFile(
        path.join(legacyDataDir, "update-check.json"),
        '{"checked":true}',
      );
      writeTextFile(path.join(legacyDataDir, "bridge.log"), "old log");
      writeTextFile(path.join(legacyDataDir, "bridge.lock.json"), "lock");
      writeTextFile(
        path.join(legacyDataDir, "workspaces", "repo", "bridge-state.json"),
        "workspace state",
      );
      writeTextFile(
        path.join(
          legacyDataDir,
          "inbound-attachments",
          "2026-05-22",
          "photo.jpg",
        ),
        "image",
      );

      const migrated = migrateLegacyChannelFiles((message) => logs.push(message), {
        channelDataDir,
        legacyDataDirs: [legacyDataDir],
      });

      expect(migrated).toEqual([
        "credentials",
        "sync state",
        "context tokens",
        "update check cache",
        "workspace state",
        "inbound attachments",
        "legacy bridge log",
      ]);
      expect(readTextFile(path.join(channelDataDir, "account.json"))).toBe(
        '{"token":"old"}',
      );
      expect(readTextFile(path.join(channelDataDir, "sync_buf.txt"))).toBe("sync");
      expect(readTextFile(path.join(channelDataDir, "context_tokens.json"))).toBe(
        '{"session":"ctx"}',
      );
      expect(readTextFile(path.join(channelDataDir, "update-check.json"))).toBe(
        '{"checked":true}',
      );
      expect(readTextFile(path.join(channelDataDir, "legacy-bridge.log"))).toBe(
        "old log",
      );
      expect(
        readTextFile(
          path.join(channelDataDir, "workspaces", "repo", "bridge-state.json"),
        ),
      ).toBe("workspace state");
      expect(
        readTextFile(
          path.join(
            channelDataDir,
            "inbound-attachments",
            "2026-05-22",
            "photo.jpg",
          ),
        ),
      ).toBe("image");
      expect(fs.existsSync(path.join(channelDataDir, "bridge.lock.json"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(channelDataDir, "bridge.log"))).toBe(false);
      expect(fs.existsSync(path.join(legacyDataDir, "account.json"))).toBe(true);
      expect(logs[0]).toContain("Migrated legacy credentials");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not overwrite existing active files or directories", () => {
    const root = makeTempDir();
    try {
      const channelDataDir = path.join(root, "new");
      const legacyDataDir = path.join(root, "legacy");
      const logs: string[] = [];

      writeTextFile(path.join(channelDataDir, "account.json"), "new account");
      writeTextFile(path.join(channelDataDir, "legacy-bridge.log"), "new log");
      writeTextFile(
        path.join(channelDataDir, "workspaces", "repo", "bridge-state.json"),
        "new workspace",
      );

      writeTextFile(path.join(legacyDataDir, "account.json"), "old account");
      writeTextFile(path.join(legacyDataDir, "sync_buf.txt"), "old sync");
      writeTextFile(path.join(legacyDataDir, "bridge.log"), "old log");
      writeTextFile(
        path.join(legacyDataDir, "workspaces", "repo", "bridge-state.json"),
        "old workspace",
      );

      const migrated = migrateLegacyChannelFiles((message) => logs.push(message), {
        channelDataDir,
        legacyDataDirs: [legacyDataDir],
      });

      expect(migrated).toEqual(["sync state"]);
      expect(readTextFile(path.join(channelDataDir, "account.json"))).toBe(
        "new account",
      );
      expect(readTextFile(path.join(channelDataDir, "legacy-bridge.log"))).toBe(
        "new log",
      );
      expect(
        readTextFile(
          path.join(channelDataDir, "workspaces", "repo", "bridge-state.json"),
        ),
      ).toBe("new workspace");
      expect(readTextFile(path.join(channelDataDir, "sync_buf.txt"))).toBe(
        "old sync",
      );
      expect(logs[0]).toContain(
        "Skipped existing: credentials, workspace state, legacy bridge log.",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the first legacy source that has migratable data", () => {
    const root = makeTempDir();
    try {
      const channelDataDir = path.join(root, "new");
      const firstLegacyDataDir = path.join(root, "first-legacy");
      const secondLegacyDataDir = path.join(root, "second-legacy");

      writeTextFile(path.join(firstLegacyDataDir, "account.json"), "first account");
      writeTextFile(path.join(secondLegacyDataDir, "account.json"), "second account");
      writeTextFile(path.join(secondLegacyDataDir, "sync_buf.txt"), "second sync");

      const migrated = migrateLegacyChannelFiles(undefined, {
        channelDataDir,
        legacyDataDirs: [firstLegacyDataDir, secondLegacyDataDir],
      });

      expect(migrated).toEqual(["credentials"]);
      expect(readTextFile(path.join(channelDataDir, "account.json"))).toBe(
        "first account",
      );
      expect(fs.existsSync(path.join(channelDataDir, "sync_buf.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
