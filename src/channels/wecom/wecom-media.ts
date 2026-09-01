import fs from "node:fs";
import path from "node:path";

import { decryptFile } from "@wecom/aibot-node-sdk";

import type { ChannelAttachment } from "../../core/channel-types.ts";
import { WECOM_INBOUND_ATTACHMENTS_DIR } from "./wecom-config.ts";
import type {
  ParsedWecomInboundFrame,
  WecomInboundAttachmentDescriptor,
} from "./wecom-message.ts";

const DEFAULT_INBOUND_LIMIT_MB = {
  image: 20,
  file: 50,
  video: 50,
} as const;

const INBOUND_LIMIT_ENV_KEYS = {
  image: "WECOM_MAX_INBOUND_IMAGE_MB",
  file: "WECOM_MAX_INBOUND_FILE_MB",
  video: "WECOM_MAX_INBOUND_VIDEO_MB",
} as const;

function resolvePositiveMb(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getWecomInboundLimitBytes(
  kind: WecomInboundAttachmentDescriptor["kind"],
  env: NodeJS.ProcessEnv = process.env,
): number {
  return Math.floor(
    resolvePositiveMb(
      env[INBOUND_LIMIT_ENV_KEYS[kind]],
      DEFAULT_INBOUND_LIMIT_MB[kind],
    ) * 1024 * 1024,
  );
}

function sanitizeFileName(value: string, fallback: string): string {
  const name = value.trim().replace(/\\/g, "/").split("/").pop() || fallback;
  const cleaned = Array.from(name)
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return cleaned || fallback;
}

function parseContentDispositionFileName(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8.trim());
    } catch {
      return utf8.trim();
    }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1]?.trim();
}

function extensionFor(kind: WecomInboundAttachmentDescriptor["kind"], mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() || "";
  const known: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return known[normalized] || (kind === "image" ? ".jpg" : kind === "video" ? ".mp4" : ".bin");
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes + 64) {
    throw new Error(`attachment exceeds the configured ${maxBytes}-byte limit`);
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    total += next.value.byteLength;
    if (total > maxBytes + 64) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`attachment exceeds the configured ${maxBytes}-byte limit`);
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function downloadWecomAttachment(
  descriptor: WecomInboundAttachmentDescriptor,
  options: {
    messageId: string;
    index: number;
    attachmentsDir?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<ChannelAttachment> {
  const maxBytes = getWecomInboundLimitBytes(descriptor.kind, options.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(descriptor.url, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`download returned HTTP ${response.status}`);
    }
    const encrypted = await readResponseWithLimit(response, maxBytes);
    const decrypted = descriptor.aesKey ? decryptFile(encrypted, descriptor.aesKey) : encrypted;
    if (decrypted.length > maxBytes) {
      throw new Error(`attachment exceeds the configured ${maxBytes}-byte limit`);
    }

    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const headerName = parseContentDispositionFileName(
      response.headers.get("content-disposition"),
    );
    const fallbackName = `${descriptor.kind}-${options.index + 1}${extensionFor(
      descriptor.kind,
      mimeType || "",
    )}`;
    const fileName = sanitizeFileName(
      descriptor.fileName || headerName || fallbackName,
      fallbackName,
    );
    const day = new Date().toISOString().slice(0, 10);
    const directory = path.join(
      options.attachmentsDir ?? WECOM_INBOUND_ATTACHMENTS_DIR,
      day,
    );
    fs.mkdirSync(directory, { recursive: true });
    const safeMessageId = options.messageId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
    const filePath = path.join(directory, `${safeMessageId}-${options.index + 1}-${fileName}`);
    fs.writeFileSync(filePath, decrypted);
    return {
      kind: descriptor.kind,
      path: filePath,
      fileName,
      mimeType,
      sizeBytes: decrypted.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadWecomInboundAttachments(
  parsed: ParsedWecomInboundFrame,
  options: {
    attachmentsDir?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<{ attachments: ChannelAttachment[]; failureNotes: string[] }> {
  const attachments: ChannelAttachment[] = [];
  const failureNotes: string[] = [];
  for (let index = 0; index < parsed.attachments.length; index += 1) {
    const descriptor = parsed.attachments[index]!;
    try {
      attachments.push(
        await downloadWecomAttachment(descriptor, {
          ...options,
          messageId: parsed.id,
          index,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failureNotes.push(`[WeCom attachment unavailable: ${descriptor.kind}; ${message}]`);
    }
  }
  return { attachments, failureNotes };
}
