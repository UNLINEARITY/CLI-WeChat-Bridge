import crypto from "node:crypto";
import { createCipheriv, createDecipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CONTEXT_CACHE_FILE,
  CREDENTIALS_FILE,
  ensureChannelDataDir,
  INBOUND_ATTACHMENTS_DIR,
  INBOUND_MESSAGE_CLAIMS_DIR,
  migrateLegacyChannelFiles,
  SYNC_BUF_FILE,
} from "./channel-config.ts";

export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "0.3.0";
const RECENT_MESSAGE_CACHE_SIZE = 500;
const BYTES_PER_MB = 1024 * 1024;
const SEND_TIMEOUT_MS = 15_000;
const INBOUND_DOWNLOAD_TIMEOUT_MS = 30_000;
const CDN_MAX_RETRIES = 3;
const ERROR_CAUSE_DEPTH_LIMIT = 4;
const INBOUND_MESSAGE_CLAIM_TTL_MS = 10 * 60 * 1000;
const SYNC_SESSION_TIMEOUT_ERRCODE = -14;

const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;

const MSG_ITEM_TEXT = 1;
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_VOICE = 3;
const MSG_ITEM_FILE = 4;
const MSG_ITEM_VIDEO = 5;

const MSG_STATE_FINISH = 2;

const UPLOAD_MEDIA_TYPE_IMAGE = 1;
const UPLOAD_MEDIA_TYPE_VIDEO = 2;
const UPLOAD_MEDIA_TYPE_FILE = 3;
const UPLOAD_MEDIA_TYPE_VOICE = 4;

export type AccountData = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
  enableThinkingForward?: boolean;
};

type ContextTokenState = Record<string, string>;

export interface TextItem {
  text?: string;
}

export interface CdnMedia {
  aes_key?: string;
  aeskey?: string;
  encrypt_query_param?: string;
  full_url?: string;
}

export interface ImageItem {
  aes_key?: string;
  aeskey?: string;
  file_name?: string;
  media?: CdnMedia;
  mid_size?: number;
}

export interface FileItem {
  aes_key?: string;
  aeskey?: string;
  file_name?: string;
  len?: string;
  media?: CdnMedia;
}

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

export interface MessageItem {
  type?: number;
  text_item?: TextItem;
  voice_item?: { text?: string };
  image_item?: ImageItem;
  file_item?: FileItem;
  ref_msg?: RefMessage;
}

export interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
}

export function isWechatSyncSessionTimeout(response: {
  errcode?: number;
  errmsg?: string;
}): boolean {
  return (
    response.errcode === SYNC_SESSION_TIMEOUT_ERRCODE &&
    /session timeout/i.test(response.errmsg ?? "")
  );
}

export type InboundWechatMessage = {
  senderId: string;
  sender: string;
  sessionId: string;
  text: string;
  attachments: InboundWechatAttachment[];
  contextToken?: string;
  createdAt: string;
  createdAtMs?: number;
};

export type InboundWechatAttachmentKind = "image" | "file";

export type InboundWechatAttachment = {
  kind: InboundWechatAttachmentKind;
  path: string;
  fileName: string;
  sizeBytes: number;
};

export type InboundWechatAttachmentDescriptor = {
  kind: InboundWechatAttachmentKind;
  fileName: string;
  media: CdnMedia;
  aesKey: string;
  expectedSizeBytes?: number;
};

export type ExtractedInboundWechatMessageContent = {
  text: string;
  attachments: InboundWechatAttachmentDescriptor[];
};

type PollMessagesOptions = {
  timeoutMs?: number;
  minCreatedAtMs?: number;
};

type PollMessagesResult = {
  messages: InboundWechatMessage[];
  ignoredBacklogCount: number;
};

type TransportLogger = {
  log: (message: string) => void;
  logError: (message: string) => void;
};

type ResetSyncOptions = {
  clearContextCache?: boolean;
};

type SendImageOptions = {
  recipientId?: string;
  caption?: string;
};

type SendFileOptions = {
  recipientId?: string;
  title?: string;
};

type SendVideoOptions = {
  recipientId?: string;
  title?: string;
};

type UploadLabel = "image" | "file" | "voice" | "video";

type ResolvedRecipient = {
  account: AccountData;
  recipientId: string;
  contextToken: string;
};

type UploadPreparation = {
  rawsize: number;
  filesize: number;
  aeskey: Buffer;
  downloadParam: string;
};

export type WechatTransportErrorKind =
  | "timeout"
  | "network"
  | "http"
  | "auth"
  | "unknown";

export type WechatTransportErrorClassification = {
  kind: WechatTransportErrorKind;
  retryable: boolean;
  statusCode?: number;
};

export class WechatApiResponseError extends Error {
  readonly endpoint: string;
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg: string;

  constructor(params: {
    endpoint: string;
    ret?: number;
    errcode?: number;
    errmsg?: string;
  }) {
    const errmsg = params.errmsg ?? "";
    super(
      `${params.endpoint} failed: ret=${params.ret} errcode=${params.errcode} errmsg=${errmsg}`,
    );
    this.name = "WechatApiResponseError";
    this.endpoint = params.endpoint;
    this.ret = params.ret;
    this.errcode = params.errcode;
    this.errmsg = errmsg;
  }
}

export function isWechatContextTokenStaleError(
  error: unknown,
): error is WechatApiResponseError {
  return (
    error instanceof WechatApiResponseError &&
    error.endpoint === "sendmessage" &&
    error.ret === -2
  );
}

const DEFAULT_MEDIA_UPLOAD_LIMIT_MB: Record<UploadLabel, number> = {
  image: 20,
  file: 50,
  voice: 20,
  video: 100,
};

const MEDIA_UPLOAD_LIMIT_ENV_KEYS: Record<UploadLabel, string> = {
  image: "WECHAT_MAX_IMAGE_MB",
  file: "WECHAT_MAX_FILE_MB",
  voice: "WECHAT_MAX_VOICE_MB",
  video: "WECHAT_MAX_VIDEO_MB",
};

const DEFAULT_MEDIA_INBOUND_LIMIT_MB: Record<InboundWechatAttachmentKind, number> = {
  image: 20,
  file: 50,
};

const MEDIA_INBOUND_LIMIT_ENV_KEYS: Record<InboundWechatAttachmentKind, string> = {
  image: "WECHAT_MAX_INBOUND_IMAGE_MB",
  file: "WECHAT_MAX_INBOUND_FILE_MB",
};

const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 425, 429]);
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const RETRYABLE_NETWORK_ERROR_HINTS = [
  "connection closed",
  "connection reset",
  "connection refused",
  "econnaborted",
  "econnrefused",
  "econnreset",
  "ehostunreach",
  "enetunreach",
  "enotfound",
  "eai_again",
  "fetch failed",
  "network error",
  "request timeout",
  "socket hang up",
  "timed out",
  "timeout",
];

type ErrorWithCause = Error & {
  cause?: unknown;
  code?: unknown;
  errno?: unknown;
  syscall?: unknown;
  hostname?: unknown;
  address?: unknown;
  port?: unknown;
};

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNumericResponseField(
  response: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = response[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readStringResponseField(
  response: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = response[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function assertWechatApiResponseOk(endpoint: string, raw: string): void {
  const trimmed = raw.trim();
  if (!trimmed) {
    return;
  }

  let response: unknown;
  try {
    response = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!isRecord(response)) {
    return;
  }

  const ret = readNumericResponseField(response, "ret");
  const errcode = readNumericResponseField(response, "errcode");
  const failed =
    (ret !== undefined && ret !== 0) ||
    (errcode !== undefined && errcode !== 0);
  if (!failed) {
    return;
  }

  const errmsg =
    readStringResponseField(response, "errmsg") ??
    readStringResponseField(response, "message") ??
    readStringResponseField(response, "msg") ??
    "";
  throw new WechatApiResponseError({ endpoint, ret, errcode, errmsg });
}

function describeErrorNode(value: unknown): string {
  if (value instanceof Error) {
    const error = value as ErrorWithCause;
    const parts: string[] = [];
    if (error.name && error.message) {
      parts.push(`${error.name}: ${error.message}`);
    } else if (error.message) {
      parts.push(error.message);
    } else if (error.name) {
      parts.push(error.name);
    }
    if (typeof error.code === "string" && error.code.trim()) {
      parts.push(`code=${error.code}`);
    }
    if (
      (typeof error.errno === "string" && error.errno.trim()) ||
      typeof error.errno === "number"
    ) {
      parts.push(`errno=${error.errno}`);
    }
    if (typeof error.syscall === "string" && error.syscall.trim()) {
      parts.push(`syscall=${error.syscall}`);
    }
    if (typeof error.hostname === "string" && error.hostname.trim()) {
      parts.push(`host=${error.hostname}`);
    }
    if (typeof error.address === "string" && error.address.trim()) {
      parts.push(`address=${error.address}`);
    }
    if (
      (typeof error.port === "string" && error.port.trim()) ||
      typeof error.port === "number"
    ) {
      parts.push(`port=${error.port}`);
    }
    return parts.filter(Boolean).join(" ");
  }

  if (isRecord(value)) {
    const parts: string[] = [];
    if (typeof value.message === "string" && value.message.trim()) {
      parts.push(value.message);
    }
    if (typeof value.code === "string" && value.code.trim()) {
      parts.push(`code=${value.code}`);
    }
    if (
      (typeof value.errno === "string" && value.errno.trim()) ||
      typeof value.errno === "number"
    ) {
      parts.push(`errno=${value.errno}`);
    }
    if (typeof value.syscall === "string" && value.syscall.trim()) {
      parts.push(`syscall=${value.syscall}`);
    }
    if (typeof value.hostname === "string" && value.hostname.trim()) {
      parts.push(`host=${value.hostname}`);
    }
    if (typeof value.address === "string" && value.address.trim()) {
      parts.push(`address=${value.address}`);
    }
    if (
      (typeof value.port === "string" && value.port.trim()) ||
      typeof value.port === "number"
    ) {
      parts.push(`port=${value.port}`);
    }
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }

  return String(value);
}

function getErrorCause(value: unknown): unknown {
  if (value instanceof Error) {
    return (value as ErrorWithCause).cause;
  }
  if (isRecord(value) && "cause" in value) {
    return value.cause;
  }
  return undefined;
}

function collectErrorCodes(value: unknown): string[] {
  const seen = new Set<unknown>();
  const codes = new Set<string>();
  let current: unknown = value;
  let depth = 0;

  while (current && depth < ERROR_CAUSE_DEPTH_LIMIT && !seen.has(current)) {
    seen.add(current);
    if (isRecord(current) && typeof current.code === "string" && current.code.trim()) {
      codes.add(current.code.toUpperCase());
    }
    current = getErrorCause(current);
    depth += 1;
  }

  return [...codes];
}

function extractHttpStatusCode(error: Error): number | null {
  const match = /^HTTP (\d{3}):/.exec(error.message);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function describeWechatTransportError(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current && depth < ERROR_CAUSE_DEPTH_LIMIT && !seen.has(current)) {
    seen.add(current);
    const description = describeErrorNode(current);
    if (description) {
      parts.push(depth === 0 ? description : `cause: ${description}`);
    }
    current = getErrorCause(current);
    depth += 1;
  }

  return parts.length > 0 ? parts.join(" | ") : String(error);
}

export function classifyWechatTransportError(
  error: unknown,
): WechatTransportErrorClassification {
  if (error instanceof Error) {
    if (
      /WeChat session timed out/i.test(error.message) ||
      /errcode=-14\b.*session timeout/i.test(error.message)
    ) {
      return { kind: "auth", retryable: false };
    }

    if (error.name === "AbortError") {
      return { kind: "timeout", retryable: true };
    }

    const statusCode = extractHttpStatusCode(error);
    if (statusCode !== null) {
      if (statusCode === 401 || statusCode === 403) {
        return { kind: "auth", retryable: false, statusCode };
      }
      if (statusCode >= 500 || RETRYABLE_HTTP_STATUS_CODES.has(statusCode)) {
        return { kind: "http", retryable: true, statusCode };
      }
      return { kind: "http", retryable: false, statusCode };
    }
  }

  const errorCodes = collectErrorCodes(error);
  if (errorCodes.some((code) => RETRYABLE_NETWORK_ERROR_CODES.has(code))) {
    return { kind: "network", retryable: true };
  }

  const details = describeWechatTransportError(error).toLowerCase();
  if (RETRYABLE_NETWORK_ERROR_HINTS.some((hint) => details.includes(hint))) {
    return { kind: "network", retryable: true };
  }

  return { kind: "unknown", retryable: false };
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureChannelDataDir();
  const data = JSON.stringify(value, null, 2);
  // Atomic write via temp file + rename, so a crash mid-write cannot leave a
  // truncated/half-written JSON that would break readers on the next launch.
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, data, "utf-8");
  fs.renameSync(tempPath, filePath);
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };

  if (body) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(params.token, params.body),
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function isHexAesKey(value: string): boolean {
  return /^[a-f0-9]{32}$/i.test(value);
}

export function decodeInboundMediaAesKey(value: string): Buffer {
  const trimmed = value.trim();
  if (isHexAesKey(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 16) {
    return decoded;
  }

  const decodedText = decoded.toString("utf8").trim();
  if (isHexAesKey(decodedText)) {
    return Buffer.from(decodedText, "hex");
  }

  throw new Error("Unsupported inbound media aes key format.");
}

export function decryptInboundMediaPayload(ciphertext: Buffer, aesKey: string): Buffer {
  return decryptAesEcb(ciphertext, decodeInboundMediaAesKey(aesKey));
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes >= BYTES_PER_MB) {
    const value = bytes / BYTES_PER_MB;
    return `${value.toFixed(value >= 100 ? 0 : 1)} MB`;
  }
  if (bytes >= 1024) {
    const value = bytes / 1024;
    return `${value.toFixed(value >= 100 ? 0 : 1)} KB`;
  }
  return `${bytes} B`;
}

export function resolveMediaUploadLimitBytes(
  label: UploadLabel,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envKey = MEDIA_UPLOAD_LIMIT_ENV_KEYS[label];
  const raw = env[envKey];
  const fallbackMb = DEFAULT_MEDIA_UPLOAD_LIMIT_MB[label];
  const parsedMb = raw ? Number(raw) : Number.NaN;
  const limitMb =
    Number.isFinite(parsedMb) && parsedMb > 0 ? parsedMb : fallbackMb;
  return Math.floor(limitMb * BYTES_PER_MB);
}

export function resolveInboundMediaDownloadLimitBytes(
  label: InboundWechatAttachmentKind,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envKey = MEDIA_INBOUND_LIMIT_ENV_KEYS[label];
  const raw = env[envKey];
  const fallbackMb = DEFAULT_MEDIA_INBOUND_LIMIT_MB[label];
  const parsedMb = raw ? Number(raw) : Number.NaN;
  const limitMb =
    Number.isFinite(parsedMb) && parsedMb > 0 ? parsedMb : fallbackMb;
  return Math.floor(limitMb * BYTES_PER_MB);
}

export function assertMediaUploadSizeAllowed(
  label: UploadLabel,
  rawsize: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const limitBytes = resolveMediaUploadLimitBytes(label, env);
  if (rawsize <= limitBytes) {
    return;
  }

  const envKey = MEDIA_UPLOAD_LIMIT_ENV_KEYS[label];
  const labelName = label.charAt(0).toUpperCase() + label.slice(1);
  throw new Error(
    `${labelName} too large: ${formatByteSize(rawsize)} exceeds ${formatByteSize(limitBytes)} limit. Set ${envKey} to override.`,
  );
}

function assertInboundMediaDownloadSizeAllowed(
  label: InboundWechatAttachmentKind,
  rawsize: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const limitBytes = resolveInboundMediaDownloadLimitBytes(label, env);
  if (rawsize <= limitBytes) {
    return;
  }

  const envKey = MEDIA_INBOUND_LIMIT_ENV_KEYS[label];
  const labelName = label.charAt(0).toUpperCase() + label.slice(1);
  throw new Error(
    `${labelName} too large: ${formatByteSize(rawsize)} exceeds ${formatByteSize(limitBytes)} inbound limit. Set ${envKey} to override.`,
  );
}

function encodeMessageAesKey(aeskey: Buffer): string {
  return Buffer.from(aeskey.toString("hex")).toString("base64");
}

async function getUploadUrl(
  account: AccountData,
  params: {
    filekey: string;
    media_type: number;
    to_user_id: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
  },
): Promise<{ upload_param?: string }> {
  const raw = await apiFetch({
    baseUrl: account.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      ...params,
      no_need_thumb: true,
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token: account.token,
    timeoutMs: SEND_TIMEOUT_MS,
  });
  try {
    return JSON.parse(raw) as { upload_param?: string };
  } catch (error) {
    // A 200-OK but non-JSON body (e.g. an HTML error page, empty body) would
    // otherwise throw an unclassified SyntaxError that bypasses transport error
    // classification/retry. Surface it as a meaningful error instead.
    throw new Error(
      `getUploadUrl returned a non-JSON response (${raw.length} bytes): ${String(error)}`,
      { cause: error },
    );
  }
}

function buildCdnUploadUrl(
  cdnBaseUrl: string,
  uploadParam: string,
  filekey: string,
): string {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

export function buildCdnDownloadUrl(
  cdnBaseUrl: string,
  downloadParam: string,
): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(downloadParam)}`;
}

function isTrustedCdnDownloadUrl(url: URL): boolean {
  const trustedHost = new URL(CDN_BASE_URL).hostname;
  return url.protocol === "https:" && url.hostname === trustedHost;
}

function resolveCdnDownloadUrl(media: CdnMedia): string {
  const fullUrl = media.full_url?.trim();
  if (fullUrl) {
    try {
      const url = new URL(fullUrl);
      if (isTrustedCdnDownloadUrl(url)) {
        return url.toString();
      }
    } catch {
      // Fall back to the encrypted query param below.
    }
  }

  const downloadParam = media.encrypt_query_param?.trim();
  if (!downloadParam) {
    throw new Error("Inbound media is missing encrypt_query_param.");
  }

  return buildCdnDownloadUrl(CDN_BASE_URL, downloadParam);
}

async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadParam: string;
  filekey: string;
  aeskey: Buffer;
  onRetry?: (attempt: number) => void;
}): Promise<{ downloadParam: string }> {
  const ciphertext = encryptAesEcb(params.buf, params.aeskey);
  const cdnUrl = buildCdnUploadUrl(CDN_BASE_URL, params.uploadParam, params.filekey);

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= CDN_MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        throw new Error(`CDN server error: ${errMsg}`);
      }

      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        throw new Error("CDN response missing x-encrypted-param header");
      }
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) {
        throw err;
      }
      if (attempt >= CDN_MAX_RETRIES) {
        break;
      }
      params.onRetry?.(attempt);
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error ? lastError : new Error("CDN upload failed");
  }

  return { downloadParam };
}

async function downloadBufferFromCdn(params: {
  media: CdnMedia;
  kind: InboundWechatAttachmentKind;
  onRetry?: (attempt: number) => void;
}): Promise<Buffer> {
  const cdnUrl = resolveCdnDownloadUrl(params.media);
  const limitBytes = resolveInboundMediaDownloadLimitBytes(params.kind);
  let lastError: unknown;

  for (let attempt = 1; attempt <= CDN_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INBOUND_DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(cdnUrl, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        throw new Error(`CDN server error: ${errMsg}`);
      }

      const contentLength = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(contentLength) && contentLength > aesEcbPaddedSize(limitBytes)) {
        throw new Error(
          `${params.kind} download too large: ${formatByteSize(contentLength)} encrypted payload exceeds ${formatByteSize(limitBytes)} inbound limit.`,
        );
      }

      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) {
        throw err;
      }
      if (attempt >= CDN_MAX_RETRIES) {
        break;
      }
      params.onRetry?.(attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("CDN download failed");
}

function extractReferenceLabel(item: MessageItem): string | null {
  const ref = item.ref_msg;
  if (!ref) {
    return null;
  }

  const parts: string[] = [];
  if (ref.title?.trim()) {
    parts.push(ref.title.trim());
  }
  const quotedText = ref.message_item?.text_item?.text?.trim();
  if (quotedText) {
    parts.push(quotedText);
  }

  return parts.length ? `Quoted: ${parts.join(" | ")}` : null;
}

function parseExpectedSize(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function buildInboundAttachmentDescriptor(
  kind: InboundWechatAttachmentKind,
  item: MessageItem,
): InboundWechatAttachmentDescriptor | null {
  if (kind === "image") {
    const imageItem = item.image_item;
    const media = imageItem?.media;
    const aesKey = media?.aes_key ?? media?.aeskey ?? imageItem?.aes_key ?? imageItem?.aeskey;
    if (!media || !aesKey?.trim()) {
      return null;
    }

    return {
      kind,
      fileName: imageItem?.file_name?.trim() || "wechat-image.jpg",
      media,
      aesKey,
      expectedSizeBytes: parseExpectedSize(imageItem?.mid_size),
    };
  }

  const fileItem = item.file_item;
  const media = fileItem?.media;
  const aesKey = media?.aes_key ?? media?.aeskey ?? fileItem?.aes_key ?? fileItem?.aeskey;
  if (!media || !aesKey?.trim()) {
    return null;
  }

  return {
    kind,
    fileName: fileItem?.file_name?.trim() || "wechat-file",
    media,
    aesKey,
    expectedSizeBytes: parseExpectedSize(fileItem?.len),
  };
}

function formatUnsupportedInboundAttachment(kind: InboundWechatAttachmentKind): string {
  return `[WeChat ${kind} attachment could not be downloaded: missing media metadata]`;
}

export function extractInboundMessageContent(
  message: WeixinMessage,
): ExtractedInboundWechatMessageContent {
  if (!message.item_list?.length) {
    return { text: "", attachments: [] };
  }

  const lines: string[] = [];
  const attachments: InboundWechatAttachmentDescriptor[] = [];

  for (const item of message.item_list) {
    const reference = extractReferenceLabel(item);
    if (reference && !lines.includes(reference)) {
      lines.push(reference);
    }

    if (item.type === MSG_ITEM_TEXT) {
      const text = item.text_item?.text?.trim();
      if (text) {
        lines.push(text);
      }
    }

    if (item.type === MSG_ITEM_VOICE) {
      const transcript = item.voice_item?.text?.trim();
      if (transcript) {
        lines.push(transcript);
      }
    }

    if (item.type === MSG_ITEM_IMAGE) {
      const attachment = buildInboundAttachmentDescriptor("image", item);
      if (attachment) {
        attachments.push(attachment);
      } else {
        lines.push(formatUnsupportedInboundAttachment("image"));
      }
    }

    if (item.type === MSG_ITEM_FILE) {
      const attachment = buildInboundAttachmentDescriptor("file", item);
      if (attachment) {
        attachments.push(attachment);
      } else {
        lines.push(formatUnsupportedInboundAttachment("file"));
      }
    }
  }

  return {
    text: lines.join("\n").trim(),
    attachments,
  };
}

function buildMessageKey(message: WeixinMessage): string {
  return [
    message.from_user_id ?? "",
    message.client_id ?? "",
    String(message.create_time_ms ?? ""),
    message.context_token ?? "",
  ].join("|");
}

function buildScopedMessageClaimKey(accountId: string, messageKey: string): string {
  return `${accountId}|${messageKey}`;
}

export function buildInboundMessageClaimPath(
  messageKey: string,
  claimsDir = INBOUND_MESSAGE_CLAIMS_DIR,
): string {
  const fileName = `${crypto.createHash("sha1").update(messageKey).digest("hex")}.json`;
  return path.join(claimsDir, fileName);
}

export function clearInboundMessageClaims(
  claimsDir = INBOUND_MESSAGE_CLAIMS_DIR,
): void {
  // Delete claim files individually from a directory snapshot rather than
  // `rmSync(claimsDir, { recursive })`. A recursive rmdir can remove a file a
  // concurrent process just created via tryClaimInboundMessage, silently
  // invalidating its claim and letting the same message be double-processed.
  // Per-file removal only deletes files present at snapshot time.
  let entries: string[];
  try {
    entries = fs.readdirSync(claimsDir);
  } catch {
    return; // directory does not exist; nothing to clear
  }
  for (const entry of entries) {
    try {
      fs.rmSync(path.join(claimsDir, entry), { force: true });
    } catch {
      // best effort
    }
  }
}

export function tryClaimInboundMessage(
  messageKey: string,
  options: {
    claimsDir?: string;
    nowMs?: number;
    ttlMs?: number;
  } = {},
): boolean {
  if (!messageKey) {
    return false;
  }

  const claimsDir = options.claimsDir ?? INBOUND_MESSAGE_CLAIMS_DIR;
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? INBOUND_MESSAGE_CLAIM_TTL_MS;
  const claimPath = buildInboundMessageClaimPath(messageKey, claimsDir);

  const attemptClaim = (): boolean => {
    fs.mkdirSync(claimsDir, { recursive: true });
    const handle = fs.openSync(claimPath, "wx");
    try {
      fs.writeFileSync(
        handle,
        JSON.stringify(
          {
            key: messageKey,
            claimedAt: new Date(nowMs).toISOString(),
            pid: process.pid,
          },
          null,
          2,
        ),
        "utf-8",
      );
    } finally {
      fs.closeSync(handle);
    }
    return true;
  };

  try {
    return attemptClaim();
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "";
    if (code !== "EEXIST") {
      // Real persistence failure (permissions, disk full, missing dir, ...).
      // Returning true here would claim success WITHOUT writing the claim file,
      // letting concurrent processes all think they own this message and
      // double-process it. Fail closed so the message is retried instead.
      return false;
    }
  }

  try {
    const stat = fs.statSync(claimPath);
    if (Number.isFinite(stat.mtimeMs) && nowMs - stat.mtimeMs > ttlMs) {
      fs.rmSync(claimPath, { force: true });
      return attemptClaim();
    }
  } catch {
    return attemptClaim();
  }

  return false;
}

function normalizeSender(senderId: string): string {
  return senderId.split("@")[0] || senderId;
}

function formatTimestamp(timestampMs?: number): string {
  if (!timestampMs) {
    return new Date().toISOString();
  }
  return new Date(timestampMs).toISOString();
}

function appendInboundAttachmentFailureText(text: string, failureLines: string[]): string {
  if (failureLines.length === 0) {
    return text;
  }
  return [text, ...failureLines].filter(Boolean).join("\n").trim();
}

function sanitizeInboundAttachmentFileName(
  fileName: string,
  fallback: string,
): string {
  const lastSegment = fileName.trim().replace(/\\/g, "/").split("/").pop() ?? "";
  const withoutControlChars = Array.from(lastSegment)
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("");
  const sanitized = withoutControlChars
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.slice(0, 160) || fallback;
}

function buildInboundAttachmentFilePath(params: {
  kind: InboundWechatAttachmentKind;
  fileName: string;
  createdAtMs?: number;
}): string {
  const timestamp = formatTimestamp(params.createdAtMs);
  const day = timestamp.slice(0, 10);
  const directory = path.join(INBOUND_ATTACHMENTS_DIR, day);
  const fallback = params.kind === "image" ? "wechat-image.jpg" : "wechat-file";
  const safeFileName = sanitizeInboundAttachmentFileName(params.fileName, fallback);
  const uniquePrefix = `${timestamp.replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
  return path.join(directory, `${uniquePrefix}-${safeFileName}`);
}

export class WeChatTransport {
  private readonly logger: TransportLogger;
  private readonly recentMessageKeys = new Set<string>();
  private readonly recentMessageOrder: string[] = [];
  private readonly contextTokenCache: Map<string, string>;
  private syncBuffer = "";

  constructor(logger: TransportLogger) {
    this.logger = logger;
    migrateLegacyChannelFiles((message) => this.logger.log(message));
    this.contextTokenCache = new Map<string, string>(
      Object.entries(readJsonFile<ContextTokenState>(CONTEXT_CACHE_FILE) ?? {}),
    );
    this.syncBuffer = this.readSyncBuffer();
  }

  getCredentials(): AccountData | null {
    return readJsonFile<AccountData>(CREDENTIALS_FILE);
  }

  getStatusText(): string {
    const account = this.getCredentials();
    const syncExists = fs.existsSync(SYNC_BUF_FILE);
    const contextExists = fs.existsSync(CONTEXT_CACHE_FILE);

    return [
      `credentials_file: ${CREDENTIALS_FILE}`,
      `credentials_present: ${account ? "yes" : "no"}`,
      `sync_state_file: ${SYNC_BUF_FILE}`,
      `sync_state_present: ${syncExists ? "yes" : "no"}`,
      `context_cache_file: ${CONTEXT_CACHE_FILE}`,
      `context_cache_present: ${contextExists ? "yes" : "no"}`,
      `cached_context_count: ${this.contextTokenCache.size}`,
      `max_image_mb: ${resolveMediaUploadLimitBytes("image") / BYTES_PER_MB}`,
      `max_file_mb: ${resolveMediaUploadLimitBytes("file") / BYTES_PER_MB}`,
      `max_voice_mb: ${resolveMediaUploadLimitBytes("voice") / BYTES_PER_MB}`,
      `max_video_mb: ${resolveMediaUploadLimitBytes("video") / BYTES_PER_MB}`,
      `max_inbound_image_mb: ${resolveInboundMediaDownloadLimitBytes("image") / BYTES_PER_MB}`,
      `max_inbound_file_mb: ${resolveInboundMediaDownloadLimitBytes("file") / BYTES_PER_MB}`,
      `account_id: ${account?.accountId ?? "(none)"}`,
      `user_id: ${account?.userId ?? "(none)"}`,
      `saved_at: ${account?.savedAt ?? "(none)"}`,
    ].join("\n");
  }

  resetSyncState(options: ResetSyncOptions = {}): string {
    this.clearSyncBuffer();
    this.clearRecentMessages();
    clearInboundMessageClaims();

    if (options.clearContextCache) {
      this.clearContextTokenCache();
    }

    return options.clearContextCache
      ? "Reset sync state and cleared cached context tokens."
      : "Reset sync state.";
  }

  async pollMessages(
    options: PollMessagesOptions = {},
  ): Promise<PollMessagesResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    const account = this.requireAccount();

    let response = await this.getUpdates(account, timeoutMs);
    if (isWechatSyncSessionTimeout(response) && this.syncBuffer) {
      this.logger.log(
        "WeChat sync session timed out. Clearing local sync cursor and retrying once.",
      );
      this.clearSyncBuffer();
      response = await this.getUpdates(account, timeoutMs);
    }

    if (isWechatSyncSessionTimeout(response)) {
      throw new Error('WeChat session timed out. Run "wechat-setup" to log in again.');
    }

    const isError =
      (response.ret !== undefined && response.ret !== 0) ||
      (response.errcode !== undefined && response.errcode !== 0);

    if (isError) {
      throw new Error(
        `getUpdates failed: ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ""}`,
      );
    }

    if (response.get_updates_buf) {
      this.syncBuffer = response.get_updates_buf;
      this.saveSyncBuffer(this.syncBuffer);
    }

    const messages: InboundWechatMessage[] = [];
    let ignoredBacklogCount = 0;

    for (const rawMessage of response.msgs ?? []) {
      if (rawMessage.message_type !== MSG_TYPE_USER) {
        continue;
      }

      const extracted = extractInboundMessageContent(rawMessage);
      if (!extracted.text && extracted.attachments.length === 0) {
        continue;
      }

      const senderId = rawMessage.from_user_id ?? "unknown";
      if (rawMessage.context_token) {
        this.cacheContextToken(senderId, rawMessage.context_token);
      }

      // Filter pre-start backlog BEFORE claiming/remembering the message so a
      // skipped message is not permanently locked away from other processes.
      // A missing create_time_ms is treated as fresh rather than dropped.
      const createdAtMs = rawMessage.create_time_ms ?? 0;
      if (
        typeof options.minCreatedAtMs === "number" &&
        Number.isFinite(createdAtMs) &&
        createdAtMs > 0 &&
        createdAtMs < options.minCreatedAtMs
      ) {
        ignoredBacklogCount += 1;
        continue;
      }

      const messageKey = buildMessageKey(rawMessage);
      if (!this.rememberMessage(messageKey)) {
        continue;
      }
      if (!tryClaimInboundMessage(buildScopedMessageClaimKey(account.accountId, messageKey))) {
        continue;
      }

      const { attachments, failureLines } = await this.downloadInboundAttachments(
        extracted.attachments,
        rawMessage,
      );
      const text = appendInboundAttachmentFailureText(extracted.text, failureLines);

      messages.push({
        senderId,
        sender: normalizeSender(senderId),
        sessionId: rawMessage.session_id ?? "",
        text,
        attachments,
        contextToken: rawMessage.context_token,
        createdAt: formatTimestamp(rawMessage.create_time_ms),
        createdAtMs,
      });
    }

    return { messages, ignoredBacklogCount };
  }

  private async downloadInboundAttachments(
    descriptors: InboundWechatAttachmentDescriptor[],
    rawMessage: WeixinMessage,
  ): Promise<{ attachments: InboundWechatAttachment[]; failureLines: string[] }> {
    const attachments: InboundWechatAttachment[] = [];
    const failureLines: string[] = [];

    for (const descriptor of descriptors) {
      try {
        const encrypted = await downloadBufferFromCdn({
          media: descriptor.media,
          kind: descriptor.kind,
          onRetry: (attempt) => {
            this.logger.log(
              `CDN download attempt ${attempt} failed for inbound ${descriptor.kind}, retrying...`,
            );
          },
        });
        const plaintext = decryptInboundMediaPayload(encrypted, descriptor.aesKey);
        assertInboundMediaDownloadSizeAllowed(descriptor.kind, plaintext.length);
        if (
          descriptor.expectedSizeBytes !== undefined &&
          plaintext.length !== descriptor.expectedSizeBytes
        ) {
          this.logger.log(
            `Inbound ${descriptor.kind} size differs from metadata: expected=${descriptor.expectedSizeBytes} actual=${plaintext.length}`,
          );
        }

        const filePath = buildInboundAttachmentFilePath({
          kind: descriptor.kind,
          fileName: descriptor.fileName,
          createdAtMs: rawMessage.create_time_ms,
        });
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, plaintext);

        attachments.push({
          kind: descriptor.kind,
          path: filePath,
          fileName: path.basename(filePath),
          sizeBytes: plaintext.length,
        });
      } catch (error) {
        const message = `Failed to download inbound WeChat ${descriptor.kind} (${descriptor.fileName}): ${describeWechatTransportError(error)}`;
        this.logger.logError(message);
        failureLines.push(`[${message}]`);
      }
    }

    return { attachments, failureLines };
  }

  async sendText(senderId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const resolved = this.resolveRecipient(senderId);
    await this.sendTextWithContextToken(
      resolved.account,
      resolved.recipientId,
      trimmed,
      resolved.contextToken,
    );
  }

  async sendNotification(message: string, recipientId?: string): Promise<string> {
    const trimmed = message.trim();
    if (!trimmed) {
      throw new Error("Notification text cannot be empty.");
    }

    const resolved = this.resolveRecipient(recipientId);
    await this.sendTextWithContextToken(
      resolved.account,
      resolved.recipientId,
      trimmed,
      resolved.contextToken,
    );
    return resolved.recipientId;
  }

  async sendImage(imagePath: string, options: SendImageOptions = {}): Promise<string> {
    const resolved = this.resolveRecipient(options.recipientId);
    const caption = options.caption?.trim();

    if (caption) {
      await this.sendTextWithContextToken(
        resolved.account,
        resolved.recipientId,
        caption,
        resolved.contextToken,
      );
    }

    const upload = await this.prepareUpload(
      resolved.account,
      resolved.recipientId,
      imagePath,
      UPLOAD_MEDIA_TYPE_IMAGE,
      "image",
    );

    await this.sendMessage(resolved.account, resolved.recipientId, resolved.contextToken, [
      {
        type: MSG_ITEM_IMAGE,
        image_item: {
          media: {
            encrypt_query_param: upload.downloadParam,
            aes_key: encodeMessageAesKey(upload.aeskey),
            encrypt_type: 1,
          },
          mid_size: upload.filesize,
        },
      },
    ]);

    return resolved.recipientId;
  }

  async sendFile(filePath: string, options: SendFileOptions = {}): Promise<string> {
    const resolved = this.resolveRecipient(options.recipientId);
    const upload = await this.prepareUpload(
      resolved.account,
      resolved.recipientId,
      filePath,
      UPLOAD_MEDIA_TYPE_FILE,
      "file",
    );
    const fileName = options.title?.trim() || path.basename(filePath);

    await this.sendMessage(resolved.account, resolved.recipientId, resolved.contextToken, [
      {
        type: MSG_ITEM_FILE,
        file_item: {
          file_name: fileName,
          len: String(upload.rawsize),
          media: {
            encrypt_query_param: upload.downloadParam,
            aes_key: encodeMessageAesKey(upload.aeskey),
            encrypt_type: 1,
          },
        },
      },
    ]);

    return resolved.recipientId;
  }

  async sendVoice(voicePath: string, recipientId?: string): Promise<string> {
    const resolved = this.resolveRecipient(recipientId);
    const upload = await this.prepareUpload(
      resolved.account,
      resolved.recipientId,
      voicePath,
      UPLOAD_MEDIA_TYPE_VOICE,
      "voice",
    );

    await this.sendMessage(resolved.account, resolved.recipientId, resolved.contextToken, [
      {
        type: MSG_ITEM_VOICE,
        voice_item: {
          media: {
            encrypt_query_param: upload.downloadParam,
            aes_key: encodeMessageAesKey(upload.aeskey),
            encrypt_type: 1,
          },
        },
      },
    ]);

    return resolved.recipientId;
  }

  async sendVideo(videoPath: string, options: SendVideoOptions = {}): Promise<string> {
    const resolved = this.resolveRecipient(options.recipientId);
    const title = options.title?.trim();

    if (title) {
      await this.sendTextWithContextToken(
        resolved.account,
        resolved.recipientId,
        title,
        resolved.contextToken,
      );
    }

    const upload = await this.prepareUpload(
      resolved.account,
      resolved.recipientId,
      videoPath,
      UPLOAD_MEDIA_TYPE_VIDEO,
      "video",
    );

    await this.sendMessage(resolved.account, resolved.recipientId, resolved.contextToken, [
      {
        type: MSG_ITEM_VIDEO,
        video_item: {
          media: {
            encrypt_query_param: upload.downloadParam,
            aes_key: encodeMessageAesKey(upload.aeskey),
            encrypt_type: 1,
          },
          video_size: upload.filesize,
        },
      },
    ]);

    return resolved.recipientId;
  }

  private requireAccount(): AccountData {
    const account = this.getCredentials();
    if (!account) {
      throw new Error(
        `No saved WeChat credentials found. Start a bridge command in a terminal to log in automatically, or run "wechat-setup". Expected file: ${CREDENTIALS_FILE}`,
      );
    }
    return account;
  }

  private resolveRecipient(recipientId?: string): ResolvedRecipient {
    const account = this.requireAccount();

    let resolvedRecipientId = recipientId?.trim();
    if (!resolvedRecipientId) {
      const recipients = [...this.contextTokenCache.keys()];
      resolvedRecipientId = recipients[recipients.length - 1];
      if (!resolvedRecipientId) {
        throw new Error(
          "No cached context token is available. Fetch messages first or ask the user to send a new WeChat message.",
        );
      }
    }

    const contextToken = this.contextTokenCache.get(resolvedRecipientId);
    if (!contextToken) {
      throw new Error(
        `No cached context token for ${resolvedRecipientId}. Fetch messages first or ask the user to send a new WeChat message.`,
      );
    }

    return { account, recipientId: resolvedRecipientId, contextToken };
  }

  private async sendTextWithContextToken(
    account: AccountData,
    recipientId: string,
    text: string,
    contextToken: string,
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    await this.sendMessage(account, recipientId, contextToken, [
      { type: MSG_ITEM_TEXT, text_item: { text: trimmed } },
    ]);
  }

  private async sendMessage(
    account: AccountData,
    recipientId: string,
    contextToken: string,
    itemList: unknown[],
  ): Promise<void> {
    const raw = await apiFetch({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: recipientId,
          client_id: this.generateClientId(),
          message_type: MSG_TYPE_BOT,
          message_state: MSG_STATE_FINISH,
          item_list: itemList,
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token: account.token,
      timeoutMs: SEND_TIMEOUT_MS,
    });
    assertWechatApiResponseOk("sendmessage", raw);
  }

  private async prepareUpload(
    account: AccountData,
    recipientId: string,
    filePath: string,
    mediaType: number,
    label: UploadLabel,
  ): Promise<UploadPreparation> {
    const stat = this.requireExistingFile(filePath);
    assertMediaUploadSizeAllowed(label, stat.size);

    const plaintext = fs.readFileSync(filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = crypto.randomBytes(16).toString("hex");
    const aeskey = crypto.randomBytes(16);

    this.logger.log(
      `Uploading ${label}: ${filePath} (${rawsize} bytes, md5=${rawfilemd5})`,
    );

    const uploadResp = await getUploadUrl(account, {
      filekey,
      media_type: mediaType,
      to_user_id: recipientId,
      rawsize,
      rawfilemd5,
      filesize,
      aeskey: aeskey.toString("hex"),
    });

    if (!uploadResp.upload_param) {
      throw new Error("getUploadUrl returned no upload_param");
    }

    const { downloadParam } = await uploadBufferToCdn({
      buf: plaintext,
      uploadParam: uploadResp.upload_param,
      filekey,
      aeskey,
      onRetry: (attempt) => {
        this.logger.log(
          `CDN upload attempt ${attempt} failed for ${label}, retrying...`,
        );
      },
    });

    this.logger.log(
      `${label} upload complete, downloadParam length=${downloadParam.length}`,
    );

    return {
      rawsize,
      filesize,
      aeskey,
      downloadParam,
    };
  }

  private requireExistingFile(filePath: string): fs.Stats {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    return stat;
  }

  private async getUpdates(
    account: AccountData,
    timeoutMs: number,
  ): Promise<GetUpdatesResp> {
    try {
      const raw = await apiFetch({
        baseUrl: account.baseUrl,
        endpoint: "ilink/bot/getupdates",
        body: JSON.stringify({
          get_updates_buf: this.syncBuffer,
          base_info: { channel_version: CHANNEL_VERSION },
        }),
        token: account.token,
        timeoutMs,
      });

      return JSON.parse(raw) as GetUpdatesResp;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ret: 0, msgs: [], get_updates_buf: this.syncBuffer };
      }
      throw err;
    }
  }

  private rememberMessage(key: string): boolean {
    if (!key || this.recentMessageKeys.has(key)) {
      return false;
    }

    this.recentMessageKeys.add(key);
    this.recentMessageOrder.push(key);

    while (this.recentMessageOrder.length > RECENT_MESSAGE_CACHE_SIZE) {
      const oldest = this.recentMessageOrder.shift();
      if (oldest) {
        this.recentMessageKeys.delete(oldest);
      }
    }

    return true;
  }

  private clearRecentMessages(): void {
    this.recentMessageKeys.clear();
    this.recentMessageOrder.length = 0;
  }

  private readSyncBuffer(): string {
    try {
      if (!fs.existsSync(SYNC_BUF_FILE)) {
        return "";
      }
      return fs.readFileSync(SYNC_BUF_FILE, "utf-8");
    } catch (err) {
      this.logger.logError(`Failed to read sync state: ${String(err)}`);
      return "";
    }
  }

  private saveSyncBuffer(syncBuffer: string): void {
    ensureChannelDataDir();
    fs.writeFileSync(SYNC_BUF_FILE, syncBuffer, "utf-8");
  }

  private clearSyncBuffer(): void {
    this.syncBuffer = "";
    if (fs.existsSync(SYNC_BUF_FILE)) {
      fs.rmSync(SYNC_BUF_FILE, { force: true });
    }
  }

  private cacheContextToken(senderId: string, token: string): void {
    if (this.contextTokenCache.has(senderId)) {
      this.contextTokenCache.delete(senderId);
    }
    this.contextTokenCache.set(senderId, token);
    writeJsonFile(CONTEXT_CACHE_FILE, Object.fromEntries(this.contextTokenCache));
  }

  private clearContextTokenCache(): void {
    this.contextTokenCache.clear();
    if (fs.existsSync(CONTEXT_CACHE_FILE)) {
      fs.rmSync(CONTEXT_CACHE_FILE, { force: true });
    }
  }

  clearCachedContextToken(recipientId: string): boolean {
    const normalizedRecipientId = recipientId.trim();
    if (!normalizedRecipientId || !this.contextTokenCache.has(normalizedRecipientId)) {
      return false;
    }

    this.contextTokenCache.delete(normalizedRecipientId);
    writeJsonFile(CONTEXT_CACHE_FILE, Object.fromEntries(this.contextTokenCache));
    return true;
  }

  private generateClientId(): string {
    return `wechat-bridge:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  }
}
