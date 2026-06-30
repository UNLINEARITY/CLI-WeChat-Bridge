import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initLocaleFromEnv } from "../i18n/index.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(MODULE_DIR, "..", "..");

export const DEFAULT_BASE_URL =
  process.env.WECHAT_ILINK_BASE_URL?.trim() || "https://ilinkai.weixin.qq.com";
export const BOT_TYPE = "3";

export function resolveChannelDataDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  const configured = env.CLI_BRIDGE_DATA_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(homeDir, ".cli-bridge");
}

export const CHANNEL_DATA_DIR = resolveChannelDataDir();

export const CREDENTIALS_FILE = path.join(CHANNEL_DATA_DIR, "account.json");
export const SYNC_BUF_FILE = path.join(CHANNEL_DATA_DIR, "sync_buf.txt");
export const CONTEXT_CACHE_FILE = path.join(
  CHANNEL_DATA_DIR,
  "context_tokens.json",
);
export const BRIDGE_STATE_FILE = path.join(CHANNEL_DATA_DIR, "bridge-state.json");
export const BRIDGE_LOG_FILE = path.join(CHANNEL_DATA_DIR, "bridge.log");

// Hard cap for bridge.log. Long-running daemons otherwise grow it without bound.
export const BRIDGE_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * Append a line to a log file, trimming it down to the tail half whenever it
 * exceeds BRIDGE_LOG_MAX_BYTES. Trimming is best-effort under concurrent
 * writers (a few lines may be lost during a trim) but keeps the file bounded.
 */
export function appendBoundedLog(filePath: string, line: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > BRIDGE_LOG_MAX_BYTES) {
      const keepSize = Math.floor(BRIDGE_LOG_MAX_BYTES / 2);
      const fd = fs.openSync(filePath, "r");
      try {
        const tail = Buffer.alloc(keepSize);
        const bytesRead = fs.readSync(fd, tail, 0, keepSize, stat.size - keepSize);
        fs.writeFileSync(filePath, tail.subarray(0, bytesRead));
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // File missing or unreadable: fall through to a plain append.
  }
  fs.appendFileSync(filePath, line);
}
export const BRIDGE_LOCK_FILE = path.join(CHANNEL_DATA_DIR, "bridge.lock.json");
export const DAEMON_ENDPOINT_FILE = path.join(CHANNEL_DATA_DIR, "daemon-endpoint.json");
export const CODEX_PANEL_ENDPOINT_FILE = path.join(
  CHANNEL_DATA_DIR,
  "codex-panel-endpoint.json",
);
export const WORKSPACES_DIR = path.join(CHANNEL_DATA_DIR, "workspaces");
export const INBOUND_MESSAGE_CLAIMS_DIR = path.join(
  CHANNEL_DATA_DIR,
  "inbound-message-claims",
);
export const INBOUND_ATTACHMENTS_DIR = path.join(
  CHANNEL_DATA_DIR,
  "inbound-attachments",
);
export const EMOJI_BINDINGS_FILE = path.join(CHANNEL_DATA_DIR, "emoji-bindings.json");

initLocaleFromEnv();

export type WorkspaceChannelPaths = {
  workspaceDir: string;
  stateFile: string;
  endpointFile: string;
};

export type WorkspaceEndpointAdapter = "codex" | "claude" | "opencode" | "shell";

type LegacyChannelSource = {
  dataDir: string;
};

export type LegacyChannelMigrationOptions = {
  channelDataDir?: string;
  legacyDataDirs?: string[];
};

type LegacyMigrationItem = {
  label: string;
  sourceName: string;
  targetName: string;
  kind: "file" | "directory";
};

const LEGACY_GLOBAL_CHANNEL_DATA_DIR = path.join(
  os.homedir(),
  ".claude",
  "channels",
  "wechat",
);
const LEGACY_REPO_CHANNEL_DATA_DIR = path.join(
  PROJECT_DIR,
  "~",
  ".claude",
  "channels",
  "wechat",
);
const LEGACY_ENV_CHANNEL_DATA_DIR = process.env.CLAUDE_WECHAT_CHANNEL_DATA_DIR?.trim()
  ? path.resolve(process.env.CLAUDE_WECHAT_CHANNEL_DATA_DIR.trim())
  : "";
const LEGACY_CHANNEL_SOURCE_DIRS = [
  LEGACY_ENV_CHANNEL_DATA_DIR,
  LEGACY_GLOBAL_CHANNEL_DATA_DIR,
  LEGACY_REPO_CHANNEL_DATA_DIR,
].filter(Boolean);
const LEGACY_CHANNEL_SOURCES: LegacyChannelSource[] = LEGACY_CHANNEL_SOURCE_DIRS.map((dataDir) => ({
  dataDir,
}));

const LEGACY_MIGRATION_ITEMS: LegacyMigrationItem[] = [
  {
    label: "credentials",
    sourceName: "account.json",
    targetName: "account.json",
    kind: "file",
  },
  {
    label: "sync state",
    sourceName: "sync_buf.txt",
    targetName: "sync_buf.txt",
    kind: "file",
  },
  {
    label: "context tokens",
    sourceName: "context_tokens.json",
    targetName: "context_tokens.json",
    kind: "file",
  },
  {
    label: "update check cache",
    sourceName: "update-check.json",
    targetName: "update-check.json",
    kind: "file",
  },
  {
    label: "workspace state",
    sourceName: "workspaces",
    targetName: "workspaces",
    kind: "directory",
  },
  {
    label: "inbound attachments",
    sourceName: "inbound-attachments",
    targetName: "inbound-attachments",
    kind: "directory",
  },
  {
    label: "legacy bridge log",
    sourceName: "bridge.log",
    targetName: "legacy-bridge.log",
    kind: "file",
  },
];

export function ensureChannelDataDir(): void {
  fs.mkdirSync(CHANNEL_DATA_DIR, { recursive: true });
}

export function normalizeWorkspacePath(cwd: string): string {
  return path.resolve(cwd);
}

function buildComparableWorkspacePath(cwd: string): string {
  const normalized = normalizeWorkspacePath(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sanitizeWorkspaceSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return sanitized || "workspace";
}

export function buildWorkspaceKey(cwd: string): string {
  const normalized = normalizeWorkspacePath(cwd);
  const digest = crypto
    .createHash("sha256")
    .update(buildComparableWorkspacePath(normalized))
    .digest("hex")
    .slice(0, 12);
  const label = sanitizeWorkspaceSegment(path.basename(normalized));
  return `${label}-${digest}`;
}

export function getWorkspaceChannelPaths(cwd: string): WorkspaceChannelPaths {
  const workspaceDir = path.join(WORKSPACES_DIR, buildWorkspaceKey(cwd));
  return {
    workspaceDir,
    stateFile: path.join(workspaceDir, "bridge-state.json"),
    endpointFile: path.join(workspaceDir, "codex-panel-endpoint.json"),
  };
}

export function getWorkspaceAdapterEndpointFile(
  cwd: string,
  adapter: WorkspaceEndpointAdapter,
): string {
  return path.join(
    getWorkspaceChannelPaths(cwd).workspaceDir,
    `${adapter}-companion-endpoint.json`,
  );
}

export function ensureWorkspaceChannelDir(cwd: string): WorkspaceChannelPaths {
  ensureChannelDataDir();
  const paths = getWorkspaceChannelPaths(cwd);
  fs.mkdirSync(paths.workspaceDir, { recursive: true });
  return paths;
}

function isSamePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function legacySourceHasMigratableData(source: LegacyChannelSource): boolean {
  return LEGACY_MIGRATION_ITEMS.some((item) => {
    const sourcePath = path.join(source.dataDir, item.sourceName);
    if (!fs.existsSync(sourcePath)) {
      return false;
    }
    try {
      const stat = fs.statSync(sourcePath);
      return item.kind === "directory" ? stat.isDirectory() : stat.isFile();
    } catch {
      return false;
    }
  });
}

function findLegacyChannelSource(
  channelDataDir = CHANNEL_DATA_DIR,
  legacySources = LEGACY_CHANNEL_SOURCES,
): LegacyChannelSource | null {
  return (
    legacySources.find(
      (source) =>
        !isSamePath(source.dataDir, channelDataDir) &&
        legacySourceHasMigratableData(source),
    ) ?? null
  );
}

export function migrateLegacyChannelFiles(
  log?: (message: string) => void,
  options: LegacyChannelMigrationOptions = {},
): string[] {
  const channelDataDir = options.channelDataDir ?? CHANNEL_DATA_DIR;
  const legacySources = (options.legacyDataDirs ?? LEGACY_CHANNEL_SOURCE_DIRS).map(
    (dataDir) => ({ dataDir }),
  );
  const migrated: string[] = [];
  const skippedExisting: string[] = [];
  const legacySource = findLegacyChannelSource(channelDataDir, legacySources);

  if (!legacySource) {
    return migrated;
  }

  fs.mkdirSync(channelDataDir, { recursive: true });

  for (const item of LEGACY_MIGRATION_ITEMS) {
    const sourcePath = path.join(legacySource.dataDir, item.sourceName);
    const targetPath = path.join(channelDataDir, item.targetName);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    if (fs.existsSync(targetPath)) {
      skippedExisting.push(item.label);
      continue;
    }

    const stat = fs.statSync(sourcePath);
    if (item.kind === "directory") {
      if (!stat.isDirectory()) {
        continue;
      }
      fs.cpSync(sourcePath, targetPath, { recursive: true });
    } else {
      if (!stat.isFile()) {
        continue;
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
    migrated.push(item.label);
  }

  if (migrated.length && log) {
    const skippedText = skippedExisting.length
      ? ` Skipped existing: ${skippedExisting.join(", ")}.`
      : "";
    log(
      `Migrated legacy ${migrated.join(", ")} from ${
        legacySource.dataDir
      } to ${channelDataDir}.${skippedText}`,
    );
  }

  return migrated;
}
