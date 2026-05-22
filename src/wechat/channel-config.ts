import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(MODULE_DIR, "..", "..");

export const DEFAULT_BASE_URL =
  process.env.WECHAT_ILINK_BASE_URL?.trim() || "https://ilinkai.weixin.qq.com";
export const BOT_TYPE = "3";

export const CHANNEL_DATA_DIR = process.env.CLAUDE_WECHAT_CHANNEL_DATA_DIR?.trim()
  ? path.resolve(process.env.CLAUDE_WECHAT_CHANNEL_DATA_DIR.trim())
  : path.join(os.homedir(), ".claude", "channels", "wechat");
export const GLOBAL_CHANNEL_DATA_DIR = path.join(
  os.homedir(),
  ".claude",
  "channels",
  "wechat",
);

export const CREDENTIALS_FILE = path.join(CHANNEL_DATA_DIR, "account.json");
export const SYNC_BUF_FILE = path.join(CHANNEL_DATA_DIR, "sync_buf.txt");
export const CONTEXT_CACHE_FILE = path.join(
  CHANNEL_DATA_DIR,
  "context_tokens.json",
);
export const BRIDGE_STATE_FILE = path.join(CHANNEL_DATA_DIR, "bridge-state.json");
export const BRIDGE_LOG_FILE = path.join(CHANNEL_DATA_DIR, "bridge.log");
export const BRIDGE_LOCK_FILE = path.join(CHANNEL_DATA_DIR, "bridge.lock.json");
export const CODEX_PANEL_ENDPOINT_FILE = path.join(
  CHANNEL_DATA_DIR,
  "codex-panel-endpoint.json",
);
export const WORKSPACES_DIR = path.join(CHANNEL_DATA_DIR, "workspaces");
export const INBOUND_MESSAGE_CLAIMS_DIR = path.join(
  GLOBAL_CHANNEL_DATA_DIR,
  "inbound-message-claims",
);
export const INBOUND_ATTACHMENTS_DIR = path.join(
  CHANNEL_DATA_DIR,
  "inbound-attachments",
);

export type WorkspaceChannelPaths = {
  workspaceDir: string;
  stateFile: string;
  endpointFile: string;
};

const LEGACY_CHANNEL_DATA_DIR = path.join(
  PROJECT_DIR,
  "~",
  ".claude",
  "channels",
  "wechat",
);
const LEGACY_CREDENTIALS_FILE = path.join(LEGACY_CHANNEL_DATA_DIR, "account.json");
const LEGACY_SYNC_BUF_FILE = path.join(LEGACY_CHANNEL_DATA_DIR, "sync_buf.txt");

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

export function ensureWorkspaceChannelDir(cwd: string): WorkspaceChannelPaths {
  ensureChannelDataDir();
  const paths = getWorkspaceChannelPaths(cwd);
  fs.mkdirSync(paths.workspaceDir, { recursive: true });
  return paths;
}

function channelDataDirHasState(): boolean {
  try {
    if (!fs.existsSync(CHANNEL_DATA_DIR)) {
      return false;
    }
    return fs.readdirSync(CHANNEL_DATA_DIR).length > 0;
  } catch {
    return true;
  }
}

export function shouldMigrateLegacyCredentials(params: {
  channelDataDirHadState: boolean;
  credentialsExists: boolean;
  legacyCredentialsExists: boolean;
}): boolean {
  return (
    params.legacyCredentialsExists &&
    !params.credentialsExists &&
    !params.channelDataDirHadState
  );
}

export function migrateLegacyChannelFiles(
  log?: (message: string) => void,
): string[] {
  const migrated: string[] = [];
  const channelDataDirHadState = channelDataDirHasState();

  if (
    !fs.existsSync(LEGACY_CREDENTIALS_FILE) &&
    !fs.existsSync(LEGACY_SYNC_BUF_FILE)
  ) {
    return migrated;
  }

  ensureChannelDataDir();

  if (
    shouldMigrateLegacyCredentials({
      channelDataDirHadState,
      credentialsExists: fs.existsSync(CREDENTIALS_FILE),
      legacyCredentialsExists: fs.existsSync(LEGACY_CREDENTIALS_FILE),
    })
  ) {
    fs.copyFileSync(LEGACY_CREDENTIALS_FILE, CREDENTIALS_FILE);
    migrated.push("credentials");
  }

  if (migrated.length && log) {
    log(
      `Migrated legacy ${migrated.join(
        " and ",
      )} from ${LEGACY_CHANNEL_DATA_DIR} to ${CHANNEL_DATA_DIR}.`,
    );
  }

  return migrated;
}
