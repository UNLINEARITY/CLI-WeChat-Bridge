// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import os from "node:os";
import path from "node:path";
import type { BridgeAdapterKind } from "./bridge-types.ts";
import type { ChannelAttachment } from "../core/channel-types.ts";
import { normalizeOutput } from "../core/text-utils.ts";

const WECHAT_ATTACHMENT_SEND_INTENT_RE =
  /\b(send|upload|attach|forward|share)\b/i;

const WECHAT_ATTACHMENT_SEND_INTENT_ZH_RE =
  /发送|发给我|发我|给我发|发过来|发一下|发来|发到|发微信|上传|转发|分享|传给我|传我|传到/;

const WECHAT_ATTACHMENT_SHORT_SEND_ZH_RE =
  /^(?:发|发呀|发呢|发吧|直接发|发给我|发我|发微信|发送微信)$/;

const WECHAT_ATTACHMENT_TARGET_RE = /\bwechat\b/i;

const WECHAT_ATTACHMENT_TARGET_ZH_RE = /微信/;

const WECHAT_ATTACHMENT_FILE_TERM_RE =
  /\b(file|attachment|pdf|document|docx?|xlsx?|pptx?|csv|txt|zip|rar|7z|image|photo|picture|screenshot|audio|voice|video|png|jpe?g|gif|webp|bmp|mp3|wav|m4a|ogg|aac|mov|mp4|mkv|avi)\b/i;

const WECHAT_ATTACHMENT_FILE_TERM_ZH_RE =
  /文件|附件|文档|压缩包|图片|照片|截图|音频|语音|视频|pdf|PDF/;

const LOCAL_ATTACHMENT_PATH_HINT_RE =
  /(?:[A-Za-z]:\\|(?:~[\\/])?(?:Desktop|Documents|Downloads|Pictures|Videos|Music)[\\/]|桌面|下载目录|下载文件夹)/i;

const WECHAT_ATTACHMENT_PROMPT_PREFIX = [
  "[WeChat bridge note]",
  "Your final reply will be forwarded back to a WeChat chat.",
  "If the user asks you to send a local file or media to WeChat and you know the local path, do not say that you lack a WeChat sending tool.",
  "For a real send request, locate the original local file path and reference that path directly in the attachment block.",
  "Do not create, copy, move, or write files into ~/.claude/channels/wechat, ~/.cli-bridge, or any outbound-attachments directory.",
  "Do not call Write, cp, copy, xcopy, robocopy, mv, move, or shell redirection to stage outbound files for WeChat.",
  "Put any brief visible reply text first, then end the message with exactly one trailing block like:",
  "```wechat-attachments",
  "file C:\\Users\\name\\Desktop\\document.docx",
  "```",
  "Valid kinds: image, file, video, voice.",
  "Use `file` for PDFs and ordinary documents. Only include files you truly intend to upload.",
  "",
  "[User request]",
].join("\n");

const WECHAT_ATTACHMENT_BLOCK_RE =
  /\n```wechat-attachments[ \t]*\n([\s\S]*?)\n```[ \t]*$/;

/** Add a line to a reply while keeping its trailing attachment block last. */
export function appendBeforeAttachmentBlock(text: string, line: string): string {
  const match = WECHAT_ATTACHMENT_BLOCK_RE.exec(text);
  if (!match) return `${text.trimEnd()}\n\n${line}`;
  return `${text.slice(0, match.index).trimEnd()}\n\n${line}${text.slice(match.index)}`;
}

export const OUTBOUND_ATTACHMENT_DENY_MESSAGE =
  "The WeChat bridge does not use outbound attachment directories. Do not create or copy files under .claude/channels/wechat/outbound-attachments or .cli-bridge/outbound-attachments. To send a file, put the original absolute local file path in the final ```wechat-attachments``` block.";

const WECHAT_OUTBOUND_ATTACHMENT_PATH_RE =
  /(?:^|\/)(?:(?:\.claude\/channels\/wechat\/|\.cli-bridge\/)?outbound-attachments)(?:\/|$)/i;

const WECHAT_OUTBOUND_ATTACHMENT_WRITE_COMMAND_RE =
  /\b(cp|copy|copy-item|xcopy|robocopy|mv|move|move-item|mkdir|md|new-item|ni|set-content|add-content|out-file|write-output|touch)\b|>\s*["']?[^&|]*outbound-attachments/i;

const WECHAT_OUTBOUND_ATTACHMENT_MUTATION_TOOL_RE =
  /^(?:write|edit|multiedit|notebookedit|patch|create|mkdir|move|copy|file[_-]?change|external_directory)$/i;

const WECHAT_ATTACHMENT_KINDS = ["image", "file", "video", "voice"] as const;

const INLINE_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

const INLINE_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
]);

const INLINE_VOICE_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".aac",
]);

// Directly executable / installer file types are never auto-uploaded from a
// path mentioned in a reply: handing these to WeChat contacts by accident is
// a real hazard. Everything else — source code, documents, archives, data
// files — stays auto-sendable so common workflows keep working.
const INLINE_REFERENCE_ONLY_FILE_EXTENSIONS = new Set([
  // Windows binaries and installers
  ".exe",
  ".dll",
  ".sys",
  ".msi",
  ".msp",
  ".scr",
  ".com",
  ".pif",
  ".cpl",
  ".ocx",
  ".hta",
  ".jar",
  // Windows one-click script launchers
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".vbe",
  ".jse",
  ".wsf",
  ".wsh",
  // Unix one-click script launchers and installable packages
  ".sh",
  ".bash",
  ".deb",
  ".rpm",
  ".apk",
  ".dmg",
]);

const INLINE_MAAS_URL_RE =
  /https?:\/\/[^\s]*?\/([A-Za-z]:\\.+?(?:\.\s*[A-Za-z0-9]{2,8})+)(?:\?[^\n]*)?/g;

const INLINE_WINDOWS_PATH_RE =
  /(^|[^\w])`?([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n`]+\\)*[^\\/:*?"<>|\r\n`]+?(?:\.\s*[A-Za-z0-9]{2,8})+)`?(?=$|[^\w])/gm;

const INLINE_HOME_RELATIVE_PATH_RE =
  /(^|[^\w])`?((?:~[\\/])?(?:Desktop|Documents|Downloads|Pictures|Videos|Music)[\\/](?:[^\\/:*?"<>|\r\n`]+[\\/])*[^\\/:*?"<>|\r\n`]+?(?:\.\s*[A-Za-z0-9]{2,8})+)`?(?=$|[^\w])/gim;

export type ReplyAttachmentKind = (typeof WECHAT_ATTACHMENT_KINDS)[number];

export type ReplyAttachment = {
  kind: ReplyAttachmentKind;
  path: string;
};

export type InboundPromptAttachment = {
  kind: "image" | "file";
  path: string;
  fileName?: string;
  sizeBytes?: number;
};

export type ParsedFinalReply = {
  visibleText: string;
  attachments: ReplyAttachment[];
};

export function shouldInjectAttachmentPrompt(text: string): boolean {
  const normalized = normalizeOutput(text).trim();
  if (!normalized || normalized.includes("```wechat-attachments")) {
    return false;
  }

  const mentionsSendIntent =
    WECHAT_ATTACHMENT_SEND_INTENT_RE.test(normalized) ||
    WECHAT_ATTACHMENT_SEND_INTENT_ZH_RE.test(normalized) ||
    WECHAT_ATTACHMENT_SHORT_SEND_ZH_RE.test(normalized);
  if (!mentionsSendIntent) {
    return false;
  }

  const mentionsWechatTarget =
    WECHAT_ATTACHMENT_TARGET_RE.test(normalized) ||
    WECHAT_ATTACHMENT_TARGET_ZH_RE.test(normalized);
  const mentionsFileOrMedia =
    WECHAT_ATTACHMENT_FILE_TERM_RE.test(normalized) ||
    WECHAT_ATTACHMENT_FILE_TERM_ZH_RE.test(normalized);
  const mentionsLocalPath = LOCAL_ATTACHMENT_PATH_HINT_RE.test(normalized);
  const looksLikeShortSendCommand = normalized.length <= 32;

  return (
    mentionsWechatTarget ||
    mentionsFileOrMedia ||
    mentionsLocalPath ||
    looksLikeShortSendCommand
  );
}

export function containsOutboundAttachmentPath(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().replace(/\\/g, "/");
  return WECHAT_OUTBOUND_ATTACHMENT_PATH_RE.test(normalized);
}

export function containsOutboundAttachmentPathDeep(value: unknown): boolean {
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown): boolean => {
    if (containsOutboundAttachmentPath(candidate)) {
      return true;
    }
    if (!candidate || typeof candidate !== "object") {
      return false;
    }
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      return candidate.some((item) => visit(item));
    }
    return Object.values(candidate).some((item) => visit(item));
  };

  return visit(value);
}

export function isOutboundAttachmentWriteCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    containsOutboundAttachmentPath(command) &&
    WECHAT_OUTBOUND_ATTACHMENT_WRITE_COMMAND_RE.test(command)
  );
}

export function isOutboundAttachmentMutationTool(
  toolName: unknown,
  targetPath: unknown,
): boolean {
  return (
    typeof toolName === "string" &&
    WECHAT_OUTBOUND_ATTACHMENT_MUTATION_TOOL_RE.test(toolName.trim()) &&
    containsOutboundAttachmentPath(targetPath)
  );
}

function formatPromptByteSize(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(bytes >= 100 * 1024 ? 0 : 1)} KB`;
  }
  return `${bytes} B`;
}

function formatInboundAttachmentPrompt(
  attachments: InboundPromptAttachment[],
): string {
  const lines = [
    "[WeChat inbound attachments — ACTION REQUIRED]",
    "The user sent the following files through WeChat. You MUST use the Read tool to read each file path below BEFORE responding. Do NOT skip reading these files — the user expects you to see their content (including images).",
  ];

  attachments.forEach((attachment, index) => {
    const sizeText = formatPromptByteSize(attachment.sizeBytes);
    const metadata = [
      `kind=${attachment.kind}`,
      attachment.fileName ? `name=${attachment.fileName}` : "",
      sizeText ? `size=${sizeText}` : "",
    ].filter(Boolean);
    lines.push(`${index + 1}. ${metadata.join(" ")} path=${attachment.path}`);
  });

  lines.push("");
  lines.push("Remember: Read each path above with the Read tool NOW. Images are viewable via Read.");

  return lines.join("\n");
}

export function buildAttachmentInboundPrompt(
  text: string,
  attachments: InboundPromptAttachment[] = [],
): string {
  const trimmedAttachments = attachments.filter((attachment) => attachment.path.trim());

  if (!trimmedAttachments.length) {
    if (!shouldInjectAttachmentPrompt(text)) {
      return text;
    }

    const normalized = normalizeOutput(text).trim();
    if (!normalized) {
      return text;
    }

    return `${WECHAT_ATTACHMENT_PROMPT_PREFIX}\n${normalized}`;
  }

  const baseText = normalizeOutput(text).trim() || "Received WeChat attachment(s).";
  const userPrompt = shouldInjectAttachmentPrompt(baseText)
    ? `${WECHAT_ATTACHMENT_PROMPT_PREFIX}\n${baseText.trim()}`
    : baseText;

  return `${userPrompt.trim()}\n\n${formatInboundAttachmentPrompt(trimmedAttachments)}`;
}

/**
 * Inbound prompt builder injected into the WeChat channel driver. Only image
 * and file attachments are described in the prompt.
 */
export function buildChannelInboundPrompt(
  text: string,
  attachments: ChannelAttachment[],
): string {
  return buildAttachmentInboundPrompt(
    text,
    attachments.filter((attachment): attachment is InboundPromptAttachment =>
      attachment.kind === "image" || attachment.kind === "file"),
  );
}

export function parseFinalReply(text: string): ParsedFinalReply {
  const normalized = normalizeOutput(text);
  const withLeadingNewline = normalized.startsWith("\n")
    ? normalized
    : `\n${normalized}`;
  const match = withLeadingNewline.match(WECHAT_ATTACHMENT_BLOCK_RE);
  if (!match) {
    return extractInlineAttachments(normalized);
  }

  const attachments: ReplyAttachment[] = [];
  const attachmentBlock = match[1];
  if (attachmentBlock === undefined) {
    return extractInlineAttachments(normalized);
  }

  const lines = attachmentBlock
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return extractInlineAttachments(normalized);
  }

  for (const line of lines) {
    const parsed = /^(image|file|video|voice)\s+(.+)$/.exec(line);
    if (!parsed) {
      return extractInlineAttachments(normalized);
    }

    const kind = parsed[1] as ReplyAttachmentKind;
    const rawPath = parsed[2];
    if (!rawPath) {
      return extractInlineAttachments(normalized);
    }

    const attachmentPath = resolveAttachmentPath(rawPath);
    if (!attachmentPath) {
      return extractInlineAttachments(normalized);
    }

    attachments.push({
      kind,
      path: attachmentPath,
    });
  }

  const blockIndex = withLeadingNewline.length - match[0].length;
  const visibleText = withLeadingNewline.slice(0, blockIndex).trim();
  const parsedFromBlock = {
    visibleText,
    attachments,
  };
  return parsedFromBlock.attachments.length > 0
    ? parsedFromBlock
    : extractInlineAttachments(normalized);
}

const OPENCODE_WORKING_NOTICE_RE = /^OpenCode is still working on:\s*$/i;

const OPENCODE_TRANSIENT_NOTICE_RES = [
  /^Bridge error: opencode companion is not connected\./i,
  /^OpenCode companion is not connected(?: for bridge workspace)?:?$/i,
  /^Run "wechat-opencode".*$/i,
  /^OpenCode session switched to \S+ from the local terminal\.$/i,
  /^Local OpenCode input:\s*$/i,
];

const OPENCODE_REASONING_LINE_RES = [
  /\bCLAUDE\.md\b/i,
  /\bNo tool needed\.?$/i,
  /\bThe user said\b/i,
  /\bI need to (?:respond|reply|answer|tell the user)\b/i,
  /\bWe need to (?:respond|reply|answer)\b/i,
  /\bI should\b/i,
  /\bI(?:'ll| will) (?:respond|reply|answer|tell the user|provide)\b/i,
  /\bI'll provide\b/i,
  /^Let me (?:directly )?(?:answer|respond)\b/i,
  /根据系统提示/i,
  /系统提示中说/i,
  /我需要(?:告诉用户|回答|回复)/,
  /我们需要(?:回答|回复)/,
  /^让我直接(?:回答|回复)/,
  /^我要直接(?:回答|回复)/,
  /^用户(?:说|问)了/,
];

const OPENCODE_INLINE_REASONING_MARKER_RE =
  /\b(?:The user\b|I need to\b|I should\b|I(?:'ll| will)\b|We need to\b|Let me\b)/i;

const OPENCODE_INLINE_REASONING_SENTENCE_RE =
  /^(?:The user\b|I need to\b|I should\b|I(?:'ll| will)\b|We need to\b|Let me\b)[^.!?\n]*(?:[.!?]+)\s*/i;

function stripInlineOpenCodeReasoningPrefix(text: string): string {
  let current = text.trim();
  const markerIndex = current.search(OPENCODE_INLINE_REASONING_MARKER_RE);
  if (markerIndex > 0 && markerIndex <= 80) {
    current = current.slice(markerIndex).trimStart();
  }

  for (let index = 0; index < 6; index += 1) {
    const match = current.match(OPENCODE_INLINE_REASONING_SENTENCE_RE);
    if (!match) {
      break;
    }
    current = current.slice(match[0].length).trimStart();
  }

  return current;
}

function isOpenCodeReasoningResidue(text: string): boolean {
  return !text.replace(/[\s"'“”‘’`.,!?;:()[\]{}<>…。！？；：（）【】《》、，-]/g, "");
}

export function sanitizeFinalReplyText(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  const normalized =
    adapter === "opencode"
      ? cleanupVisibleReplyText(stripInlineOpenCodeReasoningPrefix(text))
      : cleanupVisibleReplyText(text);
  if (!normalized || adapter !== "opencode") {
    return normalized;
  }

  const keptLines: string[] = [];
  let dropNextContextLine = false;
  let sawDroppedMeta = false;
  let tailStartIndex = 0;

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      keptLines.push("");
      continue;
    }

    if (dropNextContextLine) {
      dropNextContextLine = false;
      if (line.length <= 200) {
        sawDroppedMeta = true;
        tailStartIndex = keptLines.length;
        continue;
      }
    }

    if (OPENCODE_WORKING_NOTICE_RE.test(line)) {
      sawDroppedMeta = true;
      tailStartIndex = keptLines.length;
      dropNextContextLine = true;
      continue;
    }

    if (
      OPENCODE_TRANSIENT_NOTICE_RES.some((pattern) => pattern.test(line)) ||
      OPENCODE_REASONING_LINE_RES.some((pattern) => pattern.test(line))
    ) {
      sawDroppedMeta = true;
      tailStartIndex = keptLines.length;
      continue;
    }

    const previousLine = keptLines.length > 0 ? keptLines[keptLines.length - 1] : undefined;
    if (
      previousLine &&
      previousLine.trim() &&
      previousLine.trim().replace(/\s+/g, " ") === line.replace(/\s+/g, " ")
    ) {
      continue;
    }

    keptLines.push(line);
  }

  const cleaned = cleanupVisibleReplyText(keptLines.join("\n"));
  if (!sawDroppedMeta) {
    return cleaned;
  }

  const tail = cleanupVisibleReplyText(keptLines.slice(tailStartIndex).join("\n"));
  const resolved = tail || cleaned;
  return isOpenCodeReasoningResidue(resolved) ? "" : resolved;
}

export function extractInlineAttachments(text: string): ParsedFinalReply {
  const sanitized = text
    .replace(/\\\n\s*/g, "\\")
    .replace(/\.\s*\n?\s*([A-Za-z0-9]{2,8})(?=\?)/g, ".$1")
    .replace(/\?\s+/g, "?");
  const attachments: ReplyAttachment[] = [];
  const seenPaths = new Set<string>();
  let visibleText = sanitized;
  const rememberAttachment = (candidatePath: string): boolean => {
    const attachmentPath = resolveAttachmentPath(candidatePath);
    if (!attachmentPath) {
      return false;
    }

    const kind = inferInlineAttachmentKind(attachmentPath);
    if (!kind) {
      return false;
    }

    if (!seenPaths.has(attachmentPath)) {
      attachments.push({
        kind,
        path: attachmentPath,
      });
      seenPaths.add(attachmentPath);
    }
    return true;
  };

  visibleText = visibleText.replace(INLINE_MAAS_URL_RE, (fullMatch, candidatePath) => {
    return rememberAttachment(candidatePath) ? "" : fullMatch;
  });

  visibleText = visibleText.replace(
    INLINE_WINDOWS_PATH_RE,
    (fullMatch, prefix, candidatePath) => {
      return rememberAttachment(candidatePath) ? prefix : fullMatch;
    },
  );

  visibleText = visibleText.replace(
    INLINE_HOME_RELATIVE_PATH_RE,
    (fullMatch, prefix, candidatePath) => {
      return rememberAttachment(candidatePath) ? prefix : fullMatch;
    },
  );

  return {
    visibleText: cleanupVisibleReplyText(visibleText),
    attachments,
  };
}

// Platform-independent absolute-path check for WeChat attachment candidates.
// Recognizes Windows drive paths (C:\, C:/) and POSIX root paths (/, \), so an
// agent-emitted path resolves on any host OS. Node's path.isAbsolute is
// platform-specific: it rejects "C:\Users\..." on Linux/macOS, which dropped
// the attachment and failed CI on non-Windows runners.
function isAttachmentAbsolutePath(candidate: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(candidate);
}

function resolveAttachmentPath(candidatePath: string): string | null {
  const normalizedCandidate = normalizeAttachmentCandidate(candidatePath);
  if (!normalizedCandidate) {
    return null;
  }

  if (isAttachmentAbsolutePath(normalizedCandidate)) {
    return normalizedCandidate;
  }

  const homeRelativeMatch =
    /^(?:~[\\/])?(Desktop|Documents|Downloads|Pictures|Videos|Music)([\\/].+)?$/i.exec(
      normalizedCandidate,
    );
  if (!homeRelativeMatch) {
    return null;
  }

  const relativeTail = `${homeRelativeMatch[1]}${homeRelativeMatch[2] ?? ""}`;
  const relativeSegments = relativeTail.split(/[\\/]+/).filter(Boolean);
  if (!relativeSegments.length) {
    return null;
  }

  return path.normalize(path.join(os.homedir(), ...relativeSegments));
}

// Trim and clean a WeChat attachment candidate path. Intentionally does NOT
// rewrite separators to path.sep: the path must keep its original separator
// style (Windows "\" or POSIX "/") so the bridge can resolve agent-emitted
// paths regardless of host OS (see isAttachmentAbsolutePath).
function normalizeAttachmentCandidate(candidatePath: string): string {
  return candidatePath
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/\.\s+([A-Za-z0-9]{2,8})(?=$|[?/\s])/g, ".$1");
}

function inferInlineAttachmentKind(filePath: string): ReplyAttachmentKind | null {
  const extension = path.extname(filePath).toLowerCase();
  if (INLINE_IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (INLINE_VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  if (INLINE_VOICE_EXTENSIONS.has(extension)) {
    return "voice";
  }

  // Ordinary local files stay auto-sendable; only directly executable /
  // installer types are excluded so a path mentioned in prose cannot
  // accidentally ship a runnable binary to a WeChat contact.
  if (!extension || INLINE_REFERENCE_ONLY_FILE_EXTENSIONS.has(extension)) {
    return null;
  }

  return "file";
}

function cleanupVisibleReplyText(text: string): string {
  return text
    .replace(/```[^\n]*\n\s*```/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
