import os from "node:os";
import path from "node:path";

import type {
  ApprovalRequest,
  BridgeAdapterKind,
  BridgeAdapterState,
  BridgeResumeSessionCandidate,
  BridgeResumeThreadCandidate,
  BridgeSessionSwitchReason,
  BridgeSessionSwitchSource,
  BridgeState,
  BridgeThreadSwitchReason,
  BridgeThreadSwitchSource,
  PendingApproval,
  PendingUserInputRequest,
  UserInputRequestQuestion,
} from "./bridge-types.ts";

const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export type SystemCommand =
  | { type: "status" }
  | { type: "resume"; target?: string }
  | { type: "new_session" }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "confirm"; code?: string }
  | { type: "deny" }
  | { type: "answer"; raw: string };

export const MESSAGE_START_GRACE_MS = 5_000;
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

export const WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE =
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
const INLINE_REFERENCE_ONLY_FILE_EXTENSIONS = new Set([
  ".bat",
  ".c",
  ".cc",
  ".cjs",
  ".cmd",
  ".cpp",
  ".cs",
  ".cts",
  ".cxx",
  ".go",
  ".h",
  ".hh",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".m",
  ".mjs",
  ".mm",
  ".mts",
  ".php",
  ".pl",
  ".ps1",
  ".psd1",
  ".psm1",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
  ".vb",
  ".zsh",
]);
const INLINE_MAAS_URL_RE =
  /https?:\/\/[^\s]*?\/([A-Za-z]:\\.+?(?:\.\s*[A-Za-z0-9]{2,8})+)(?:\?[^\n]*)?/g;
const INLINE_WINDOWS_PATH_RE =
  /(^|[^\w])`?([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n`]+\\)*[^\\/:*?"<>|\r\n`]+?(?:\.\s*[A-Za-z0-9]{2,8})+)`?(?=$|[^\w])/gm;
const INLINE_HOME_RELATIVE_PATH_RE =
  /(^|[^\w])`?((?:~[\\/])?(?:Desktop|Documents|Downloads|Pictures|Videos|Music)[\\/](?:[^\\/:*?"<>|\r\n`]+[\\/])*[^\\/:*?"<>|\r\n`]+?(?:\.\s*[A-Za-z0-9]{2,8})+)`?(?=$|[^\w])/gim;

export type WechatAttachmentKind = (typeof WECHAT_ATTACHMENT_KINDS)[number];

export type WechatReplyAttachment = {
  kind: WechatAttachmentKind;
  path: string;
};

export type WechatInboundPromptAttachment = {
  kind: "image" | "file";
  path: string;
  fileName?: string;
  sizeBytes?: number;
};

export type ParsedWechatFinalReply = {
  visibleText: string;
  attachments: WechatReplyAttachment[];
};

type CodexSessionJsonLine = {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    phase?: string;
    message?: string;
  };
};

export type CodexSessionAgentMessage = {
  timestamp?: string;
  phase?: string;
  message: string;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export function normalizeOutput(text: string): string {
  return stripAnsi(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function truncatePreview(text: string, maxLength = 140): string {
  const normalized = normalizeOutput(text).trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "(empty)";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function buildOneTimeCode(length = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  while (code.length < length) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export function buildInstanceId(): string {
  return `bridge-${Date.now().toString(36)}-${buildOneTimeCode(6).toLowerCase()}`;
}

export function parseSystemCommand(text: string): SystemCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  if (!rawCommand) {
    return null;
  }
  const command = rawCommand.toLowerCase();
  const argument = rest.join(" ").trim();

  switch (command) {
    case "/status":
      return { type: "status" };
    case "/resume":
      return argument ? { type: "resume", target: argument } : { type: "resume" };
    case "/new":
    case "/new-session":
      return { type: "new_session" };
    case "/stop":
      return { type: "stop" };
    case "/reset":
      return { type: "reset" };
    case "/confirm":
      return argument ? { type: "confirm", code: argument } : null;
    case "/deny":
      return { type: "deny" };
    case "/answer":
      return argument ? { type: "answer", raw: argument } : null;
    default:
      return null;
  }
}

export function parseWechatControlCommand(
  text: string,
  options: {
    adapter: BridgeAdapterKind;
    hasPendingConfirmation: boolean;
    hasPendingUserInput: boolean;
  },
): SystemCommand | null {
  const systemCommand = parseSystemCommand(text);
  if (systemCommand) {
    return systemCommand;
  }

  if (options.adapter !== "claude") {
    return null;
  }

  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "/confirm") {
    return { type: "confirm" };
  }

  if (!options.hasPendingConfirmation) {
    return null;
  }

  switch (normalized) {
    case "confirm":
    case "yes":
      return { type: "confirm" };
    case "deny":
    case "no":
      return { type: "deny" };
    default:
      return null;
  }
}

export function shouldInjectWechatAttachmentPrompt(text: string): boolean {
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

export function containsWechatOutboundAttachmentPath(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().replace(/\\/g, "/");
  return WECHAT_OUTBOUND_ATTACHMENT_PATH_RE.test(normalized);
}

export function containsWechatOutboundAttachmentPathDeep(value: unknown): boolean {
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown): boolean => {
    if (containsWechatOutboundAttachmentPath(candidate)) {
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

export function isWechatOutboundAttachmentWriteCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    containsWechatOutboundAttachmentPath(command) &&
    WECHAT_OUTBOUND_ATTACHMENT_WRITE_COMMAND_RE.test(command)
  );
}

export function isWechatOutboundAttachmentMutationTool(
  toolName: unknown,
  targetPath: unknown,
): boolean {
  return (
    typeof toolName === "string" &&
    WECHAT_OUTBOUND_ATTACHMENT_MUTATION_TOOL_RE.test(toolName.trim()) &&
    containsWechatOutboundAttachmentPath(targetPath)
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

function formatWechatInboundAttachmentPrompt(
  attachments: WechatInboundPromptAttachment[],
): string {
  const lines = [
    "[WeChat inbound attachments]",
    "The user sent attachment files through WeChat. They have been saved locally. Read the local paths directly if the user's request requires inspecting them.",
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

  return lines.join("\n");
}

export function buildWechatInboundPrompt(
  text: string,
  attachments: WechatInboundPromptAttachment[] = [],
): string {
  const trimmedAttachments = attachments.filter((attachment) => attachment.path.trim());

  if (!trimmedAttachments.length) {
    if (!shouldInjectWechatAttachmentPrompt(text)) {
      return text;
    }

    const normalized = normalizeOutput(text).trim();
    if (!normalized) {
      return text;
    }

    return `${WECHAT_ATTACHMENT_PROMPT_PREFIX}\n${normalized}`;
  }

  const baseText = normalizeOutput(text).trim() || "Received WeChat attachment(s).";
  const userPrompt = shouldInjectWechatAttachmentPrompt(baseText)
    ? `${WECHAT_ATTACHMENT_PROMPT_PREFIX}\n${baseText.trim()}`
    : baseText;

  return `${userPrompt.trim()}\n\n${formatWechatInboundAttachmentPrompt(trimmedAttachments)}`;
}

export function parseWechatFinalReply(text: string): ParsedWechatFinalReply {
  const normalized = normalizeOutput(text);
  const withLeadingNewline = normalized.startsWith("\n")
    ? normalized
    : `\n${normalized}`;
  const match = withLeadingNewline.match(WECHAT_ATTACHMENT_BLOCK_RE);
  if (!match) {
    return extractInlineWechatAttachments(normalized);
  }

  const attachments: WechatReplyAttachment[] = [];
  const attachmentBlock = match[1];
  if (attachmentBlock === undefined) {
    return extractInlineWechatAttachments(normalized);
  }

  const lines = attachmentBlock
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return extractInlineWechatAttachments(normalized);
  }

  for (const line of lines) {
    const parsed = /^(image|file|video|voice)\s+(.+)$/.exec(line);
    if (!parsed) {
      return extractInlineWechatAttachments(normalized);
    }

    const kind = parsed[1] as WechatAttachmentKind;
    const rawPath = parsed[2];
    if (!rawPath) {
      return extractInlineWechatAttachments(normalized);
    }

    const attachmentPath = resolveWechatAttachmentPath(rawPath);
    if (!attachmentPath) {
      return extractInlineWechatAttachments(normalized);
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
    : extractInlineWechatAttachments(normalized);
}

export function parseCodexSessionAgentMessage(
  line: string,
): CodexSessionAgentMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: CodexSessionJsonLine;
  try {
    parsed = JSON.parse(trimmed) as CodexSessionJsonLine;
  } catch {
    return null;
  }

  if (parsed.type !== "event_msg" || parsed.payload?.type !== "agent_message") {
    return null;
  }

  const message =
    typeof parsed.payload.message === "string"
      ? normalizeOutput(parsed.payload.message).trim()
      : "";
  if (!message) {
    return null;
  }

  return {
    timestamp: parsed.timestamp,
    phase: typeof parsed.payload.phase === "string" ? parsed.payload.phase : undefined,
    message,
  };
}

const HIGH_RISK_PATTERNS = [
  /\bremove-item\b/i,
  /\brd\b/i,
  /\brmdir\b/i,
  /\bdel\b/i,
  /\berase\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\bstop-computer\b/i,
  /\brestart-computer\b/i,
  /\bstop-process\b/i,
  /\btaskkill\b/i,
  /\breg\s+delete\b/i,
  /\bsc\s+delete\b/i,
  /\bdiskpart\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-f/i,
  /\bset-executionpolicy\b/i,
  /\bstart-process\b.*\b-verb\s+runas\b/i,
  /\b(?:invoke-expression|iex)\b/i,
  /\bcurl\b.*\|\s*(?:iex|powershell)\b/i,
  /\binvoke-webrequest\b.*\|\s*(?:iex|powershell)\b/i,
  /\brm\b\s+-[A-Za-z-]*r[A-Za-z-]*/i,
  /\bsudo\b/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\b/i,
  /\breboot\b/i,
  /\bsystemctl\b/i,
  /\blaunchctl\b/i,
  /\bcurl\b.*\|\s*(?:sh|bash|zsh)\b/i,
  /\bwget\b.*\|\s*(?:sh|bash|zsh)\b/i,
];

export function isHighRiskShellCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(normalized));
}

const ALWAYS_INTERACTIVE_SHELL_COMMANDS = new Set([
  "ftp",
  "htop",
  "irb",
  "less",
  "more",
  "mongosh",
  "mysql",
  "nano",
  "nvim",
  "psql",
  "redis-cli",
  "screen",
  "sftp",
  "sqlite3",
  "ssh",
  "telnet",
  "tmux",
  "top",
  "vi",
  "vim",
  "watch",
]);

function tokenizeShellCommand(command: string, maxTokens = 16): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
        if (tokens.length >= maxTokens) {
          return tokens;
        }
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function normalizeShellExecutableToken(token: string): string {
  const trimmed = token.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) {
    return "";
  }
  return path.parse(trimmed).name.toLowerCase();
}

function findCommandFlagIndex(args: string[], supportedFlags: string[]): number {
  return args.findIndex((arg) => supportedFlags.includes(arg.toLowerCase()));
}

function hasScriptLikeArg(args: string[]): boolean {
  return args.some((arg) => Boolean(arg) && !arg.startsWith("-") && !arg.startsWith("/"));
}

function hasAnyCommandFlag(args: string[], supportedFlags: string[]): boolean {
  return findCommandFlagIndex(args, supportedFlags) >= 0;
}

function buildInteractiveShellCommandMessage(executable: string, suggestion: string): string {
  return `Interactive command "${executable}" is not supported in shell mode yet. This shell bridge currently only supports non-interactive commands and scripts. ${suggestion}`;
}

export function getInteractiveShellCommandRejectionMessage(command: string): string | null {
  const tokens = tokenizeShellCommand(command);
  if (!tokens.length) {
    return null;
  }

  const firstToken = tokens[0];
  if (!firstToken) {
    return null;
  }

  const executable = normalizeShellExecutableToken(firstToken);
  const args = tokens.slice(1);
  const lowerArgs = args.map((arg) => arg.toLowerCase());

  if (!executable) {
    return null;
  }

  if (ALWAYS_INTERACTIVE_SHELL_COMMANDS.has(executable)) {
    return buildInteractiveShellCommandMessage(
      executable,
      "Run a non-interactive command or script instead.",
    );
  }

  switch (executable) {
    case "python":
    case "python3":
    case "py": {
      if (!args.length) {
        return buildInteractiveShellCommandMessage(
          executable,
          'Try "python script.py" or "python -c \\"...\\"" instead.',
        );
      }
      if (lowerArgs.includes("-i") || lowerArgs.includes("--interactive")) {
        return buildInteractiveShellCommandMessage(
          executable,
          'Try "python script.py" or "python -c \\"...\\"" instead.',
        );
      }
      if (hasAnyCommandFlag(lowerArgs, ["-c", "-h", "--help", "-v", "--version"])) {
        return null;
      }
      const moduleFlagIndex = findCommandFlagIndex(lowerArgs, ["-m"]);
      if (moduleFlagIndex >= 0) {
        return moduleFlagIndex < args.length - 1
          ? null
          : buildInteractiveShellCommandMessage(
              executable,
              'Try "python script.py" or "python -m module_name" instead.',
            );
      }
      return hasScriptLikeArg(args)
        ? null
        : buildInteractiveShellCommandMessage(
            executable,
            'Try "python script.py" or "python -c \\"...\\"" instead.',
          );
    }

    case "node":
      if (!args.length || lowerArgs.includes("-i") || lowerArgs.includes("--interactive")) {
        return buildInteractiveShellCommandMessage(
          executable,
          'Try "node script.js" or "node -e \\"...\\"" instead.',
        );
      }
      if (hasAnyCommandFlag(lowerArgs, ["-e", "--eval", "-p", "--print", "-h", "--help", "-v", "--version"])) {
        return null;
      }
      return hasScriptLikeArg(args)
        ? null
        : buildInteractiveShellCommandMessage(
            executable,
            'Try "node script.js" or "node -e \\"...\\"" instead.',
          );

    case "cmd":
      if (lowerArgs.includes("/?")) {
        return null;
      }
      if (lowerArgs.includes("/k") || !lowerArgs.includes("/c")) {
        return buildInteractiveShellCommandMessage(
          executable,
          'Try "cmd /c <command>" or run the command directly instead.',
        );
      }
      return null;

    case "powershell":
    case "pwsh":
      if (
        !args.length ||
        lowerArgs.includes("-noexit") ||
        lowerArgs.includes("-nologo") && args.length === 1
      ) {
        return buildInteractiveShellCommandMessage(
          executable,
          `Try "${executable} -Command \\"...\\"" or "${executable} -File script.ps1" instead.`,
        );
      }
      if (
        hasAnyCommandFlag(
          lowerArgs,
          ["-c", "-command", "-enc", "-encodedcommand", "-f", "-file", "-h", "-help", "-v", "-version", "-?"],
        )
      ) {
        return null;
      }
      return hasScriptLikeArg(args)
        ? null
        : buildInteractiveShellCommandMessage(
            executable,
            `Try "${executable} -Command \\"...\\"" or "${executable} -File script.ps1" instead.`,
          );

    case "bash":
    case "dash":
    case "ksh":
    case "sh":
    case "zsh":
      if (!args.length || lowerArgs.includes("-i")) {
        return buildInteractiveShellCommandMessage(
          executable,
          `Try "${executable} -c '...'" or "${executable} script.sh" instead.`,
        );
      }
      if (findCommandFlagIndex(lowerArgs, ["-c", "-lc"]) >= 0) {
        return null;
      }
      if (hasAnyCommandFlag(lowerArgs, ["-h", "--help", "--version"])) {
        return null;
      }
      return hasScriptLikeArg(args)
        ? null
        : buildInteractiveShellCommandMessage(
            executable,
            `Try "${executable} -c '...'" or "${executable} script.sh" instead.`,
          );

    default:
      return null;
  }
}

export function detectCliApproval(text: string): ApprovalRequest | null {
  const normalized = normalizeOutput(text);
  const compact = normalized.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }

  const approvalPatterns: Array<{
    pattern: RegExp;
    confirmInput?: string;
    denyInput?: string;
  }> = [
    { pattern: /\bdo you want to allow\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\bapprove\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\ballow this\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\b\(y\/n\)\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\byes\/no\b/i, confirmInput: "yes\r", denyInput: "no\r" },
    { pattern: /\bpress enter to continue\b/i, confirmInput: "\r" },
    { pattern: /\bconfirm to continue\b/i, confirmInput: "y\r", denyInput: "n\r" },
  ];

  const matched = approvalPatterns.find(({ pattern }) => pattern.test(compact));
  if (!matched) {
    return null;
  }

  const preview = truncatePreview(compact, 160);
  return {
    source: "cli",
    summary: "CLI approval is required before the session can continue.",
    commandPreview: preview,
    confirmInput: matched.confirmInput,
    denyInput: matched.denyInput,
  };
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0s";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (!minutes) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

export function summarizeOutput(text: string, maxLength = 280): string {
  const normalized = normalizeOutput(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!normalized.length) {
    return "(no output)";
  }

  const summary = normalized.slice(-6).join("\n");
  if (summary.length <= maxLength) {
    return summary;
  }

  return summary.slice(summary.length - maxLength);
}

export function formatStatusReport(
  bridgeState: BridgeState,
  adapterState: BridgeAdapterState,
): string {
  const pending = bridgeState.pendingConfirmation;
  const pendingUserInput = bridgeState.pendingUserInput;
  const persistedSharedSessionId =
    bridgeState.sharedSessionId ?? bridgeState.sharedThreadId;
  const sharedSessionId =
    adapterState.sharedSessionId ?? adapterState.sharedThreadId;
  const lastSessionSwitchAt =
    adapterState.lastSessionSwitchAt ?? adapterState.lastThreadSwitchAt;
  const lastSessionSwitchSource =
    adapterState.lastSessionSwitchSource ?? adapterState.lastThreadSwitchSource;
  const lastSessionSwitchReason =
    adapterState.lastSessionSwitchReason ?? adapterState.lastThreadSwitchReason;
  const formatEpochMs = (value?: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? new Date(value).toISOString()
      : "(none)";

  return [
    `instance_id: ${bridgeState.instanceId}`,
    `adapter: ${bridgeState.adapter}`,
    `command: ${bridgeState.command}`,
    `cwd: ${bridgeState.cwd}`,
    `profile: ${bridgeState.profile ?? "(none)"}`,
    `bridge_started_at: ${formatEpochMs(bridgeState.bridgeStartedAtMs)}`,
    `authorized_user: ${bridgeState.authorizedUserId}`,
    `ignored_backlog_count: ${bridgeState.ignoredBacklogCount}`,
    `persisted_shared_session_id: ${persistedSharedSessionId ?? "(none)"}`,
    `worker_status: ${adapterState.status}`,
    `worker_pid: ${adapterState.pid ?? "(unknown)"}`,
    `shared_session_id: ${sharedSessionId ?? "(none)"}`,
    `last_session_switch_at: ${lastSessionSwitchAt ?? "(none)"}`,
    `last_session_switch_source: ${lastSessionSwitchSource ?? "(none)"}`,
    `last_session_switch_reason: ${lastSessionSwitchReason ?? "(none)"}`,
    `active_turn_id: ${adapterState.activeTurnId ?? "(none)"}`,
    `active_turn_origin: ${adapterState.activeTurnOrigin ?? "(none)"}`,
    `pending_approval_origin: ${adapterState.pendingApprovalOrigin ?? "(none)"}`,
    `pending_user_input_origin: ${adapterState.pendingUserInputOrigin ?? "(none)"}`,
    `last_activity_at: ${bridgeState.lastActivityAt ?? "(none)"}`,
    `last_input_at: ${adapterState.lastInputAt ?? "(none)"}`,
    `last_output_at: ${adapterState.lastOutputAt ?? "(none)"}`,
    `pending_confirmation: ${pending ? `${pending.source}:${pending.code}` : "(none)"}`,
    `pending_user_input: ${pendingUserInput ? `${pendingUserInput.questions.length} question(s)` : "(none)"}`,
  ].join("\n");
}

export function formatSessionSwitchMessage(params: {
  adapter: BridgeAdapterKind;
  sessionId: string;
  source: BridgeSessionSwitchSource;
  reason: BridgeSessionSwitchReason;
}): string {
  const shortSessionId = params.sessionId.slice(0, 12);

  if (params.adapter === "claude") {
    switch (params.reason) {
      case "local_follow":
      case "local_session_fallback":
      case "local_turn":
        return `Claude session switched to ${shortSessionId} from the local terminal.`;
      case "wechat_resume":
        return `Claude session switched to ${shortSessionId} from WeChat.`;
      case "startup_restore":
        return `Claude restored shared session ${shortSessionId} on startup.`;
      default:
        return `Claude session switched to ${shortSessionId}.`;
    }
  }

  if (params.adapter === "opencode") {
    switch (params.reason) {
      case "local_follow":
      case "local_session_fallback":
      case "local_turn":
        return `OpenCode session switched to ${shortSessionId} from the local terminal.`;
      case "wechat_resume":
        return `OpenCode session switched to ${shortSessionId} from WeChat.`;
      case "startup_restore":
        return `OpenCode restored shared session ${shortSessionId} on startup.`;
      default:
        return `OpenCode session switched to ${shortSessionId}.`;
    }
  }

  switch (params.reason) {
    case "local_follow":
    case "local_session_fallback":
    case "local_turn":
      return `Codex thread switched to ${shortSessionId} from the local terminal.`;
    case "wechat_resume":
      return `Codex thread switched to ${shortSessionId} from WeChat.`;
    case "startup_restore":
      return `Codex restored shared thread ${shortSessionId} on startup.`;
    default:
      return `Codex thread switched to ${shortSessionId}.`;
  }
}

export function formatThreadSwitchMessage(params: {
  threadId: string;
  source: BridgeThreadSwitchSource;
  reason: BridgeThreadSwitchReason;
}): string {
  return formatSessionSwitchMessage({
    adapter: "codex",
    sessionId: params.threadId,
    source: params.source,
    reason: params.reason,
  });
}

export function formatResumeSessionList(params: {
  adapter: BridgeAdapterKind;
  candidates: BridgeResumeSessionCandidate[];
  currentSessionId?: string;
}): string {
  const { adapter, candidates, currentSessionId } = params;
  if (candidates.length === 0) {
    return adapter === "codex"
      ? "No saved Codex threads were found for this working directory."
      : adapter === "opencode"
        ? "No saved OpenCode sessions were found for this working directory."
        : "No saved sessions were found for this working directory.";
  }

  const title = adapter === "codex" ? "Recent Codex threads:" : adapter === "opencode" ? "Recent OpenCode sessions:" : "Recent sessions:";
  const resumeTargetLabel = adapter === "codex" ? "threadId" : "sessionId";
  return [
    title,
    ...candidates.map((candidate, index) => {
      const marker =
        currentSessionId && candidate.sessionId === currentSessionId ? " [current]" : "";
      return `${index + 1}. ${candidate.title} (${candidate.lastUpdatedAt}, ${candidate.sessionId.slice(0, 12)})${marker}`;
    }),
    `Reply with /resume <number> or /resume <${resumeTargetLabel}>.`,
  ].join("\n");
}

export function formatResumeThreadList(
  candidates: BridgeResumeThreadCandidate[],
  currentThreadId?: string,
): string {
  return formatResumeSessionList({
    adapter: "codex",
    candidates: candidates.map((candidate) => ({
      ...candidate,
      sessionId: candidate.sessionId ?? candidate.threadId ?? "",
      threadId: candidate.threadId ?? candidate.sessionId,
    })),
    currentSessionId: currentThreadId,
  });
}

export function formatMirroredUserInputMessage(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  const label =
    adapter === "codex"
      ? "Local Codex input"
      : adapter === "claude"
        ? "Local Claude input"
        : adapter === "opencode"
          ? "Local OpenCode input"
          : "Local input";
  return `${label}:\n${truncatePreview(text, 500)}`;
}

export function formatFinalReplyMessage(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  if (adapter === "claude" || adapter === "codex" || adapter === "opencode") {
    return text;
  }
  // After the early return above, only "shell" remains.
  const label = (adapter as string) === "codex" ? "Codex" : (adapter as string) === "claude" ? "Claude" : (adapter as string) === "opencode" ? "OpenCode" : adapter;
  return `${label} final reply:\n${text}`;
}

const OPENCODE_WORKING_NOTICE_RE = /^OpenCode is still working on:\s*$/i;
const OPENCODE_TRANSIENT_NOTICE_RES = [
  /^Bridge error: opencode companion is not connected\./i,
  /^OpenCode companion is not connected(?: for bridge workspace)?:?$/i,
  /^Run "wechat-(?:bridge-opencode|opencode(?:-start)?)".*$/i,
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

export function sanitizeWechatFinalReplyText(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  const normalized =
    adapter === "opencode"
      ? cleanupVisibleWechatReplyText(stripInlineOpenCodeReasoningPrefix(text))
      : cleanupVisibleWechatReplyText(text);
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

  const cleaned = cleanupVisibleWechatReplyText(keptLines.join("\n"));
  if (!sawDroppedMeta) {
    return cleaned;
  }

  const tail = cleanupVisibleWechatReplyText(keptLines.slice(tailStartIndex).join("\n"));
  const resolved = tail || cleaned;
  return isOpenCodeReasoningResidue(resolved) ? "" : resolved;
}

function extractInlineWechatAttachments(text: string): ParsedWechatFinalReply {
  const sanitized = text
    .replace(/\\\n\s*/g, "\\")
    .replace(/\.\s*\n?\s*([A-Za-z0-9]{2,8})(?=\?)/g, ".$1")
    .replace(/\?\s+/g, "?");
  const attachments: WechatReplyAttachment[] = [];
  const seenPaths = new Set<string>();
  let visibleText = sanitized;
  const rememberAttachment = (candidatePath: string): boolean => {
    const attachmentPath = resolveWechatAttachmentPath(candidatePath);
    if (!attachmentPath) {
      return false;
    }

    const kind = inferInlineWechatAttachmentKind(attachmentPath);
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
    visibleText: cleanupVisibleWechatReplyText(visibleText),
    attachments,
  };
}

function resolveWechatAttachmentPath(candidatePath: string): string | null {
  const normalizedCandidate = normalizeWechatAttachmentCandidate(candidatePath);
  if (!normalizedCandidate) {
    return null;
  }

  if (path.isAbsolute(normalizedCandidate)) {
    return path.normalize(normalizedCandidate);
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

function normalizeWechatAttachmentCandidate(candidatePath: string): string {
  return candidatePath
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/\.\s+([A-Za-z0-9]{2,8})(?=$|[?/\s])/g, ".$1")
    .replace(/[\\/]+/g, path.sep);
}

function inferInlineWechatAttachmentKind(filePath: string): WechatAttachmentKind | null {
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

  // Keep ordinary local files auto-sendable, but avoid turning common
  // source/script references in prose into unintended WeChat uploads.
  if (!extension || INLINE_REFERENCE_ONLY_FILE_EXTENSIONS.has(extension)) {
    return null;
  }

  return "file";
}

function cleanupVisibleWechatReplyText(text: string): string {
  return text
    .replace(/```[^\n]*\n\s*```/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatTaskFailedMessage(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  const label = adapter === "codex" ? "Codex" : adapter === "claude" ? "Claude" : adapter === "opencode" ? "OpenCode" : adapter;
  return `${label} task failed:\n${text}`;
}

export function formatApprovalMessage(
  pending: PendingApproval,
  adapterState: BridgeAdapterState,
): string {
  const isClaude = adapterState.kind === "claude";
  if (isClaude) {
    return [
      "Claude permission request.",
      ...(pending.toolName ? [`tool: ${pending.toolName}`] : []),
      ...(pending.detailPreview
        ? [`${pending.detailLabel ?? "details"}: ${pending.detailPreview}`]
        : pending.commandPreview
          ? [`details: ${pending.commandPreview}`]
          : []),
      "Reply with /confirm, confirm, or yes to continue.",
      "Reply with /deny, deny, or no to reject.",
    ].join("\n");
  }

  return [
    `${pending.source === "shell" ? "Shell" : "CLI"} approval is required.`,
    `adapter: ${adapterState.kind}`,
    `code: ${pending.code}`,
    `summary: ${pending.summary}`,
    `target: ${pending.commandPreview}`,
    "Reply with /confirm <code> to continue or /deny to reject.",
  ].join("\n");
}

export function formatPendingApprovalReminder(
  pending: PendingApproval,
  adapterState: BridgeAdapterState,
): string {
  if (adapterState.kind === "claude") {
    const target = pending.toolName
      ? `${pending.toolName}${pending.detailPreview ? ` (${pending.detailPreview})` : ""}`
      : pending.commandPreview;
    return `Approval is pending for ${truncatePreview(target, 140)}. Reply with /confirm, confirm, or yes to continue, or /deny, deny, or no to reject.`;
  }

  return `Approval is pending for ${pending.commandPreview}. Reply with /confirm ${pending.code} or /deny.`;
}

function formatUserInputQuestionLabel(
  question: UserInputRequestQuestion,
  index: number,
): string {
  return `${index + 1}. ${question.header} [id: ${question.id}]`;
}

function resolveUserInputQuestion(
  pending: PendingUserInputRequest,
  reference: string,
): UserInputRequestQuestion | null {
  const trimmed = reference.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    return pending.questions[index] ?? null;
  }

  const normalized = trimmed.toLowerCase();
  return (
    pending.questions.find((question) => question.id.toLowerCase() === normalized) ?? null
  );
}

function resolveUserInputOptionLabel(
  question: UserInputRequestQuestion,
  value: string,
): string | null {
  if (!question.options?.length) {
    return null;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    return question.options[index]?.label ?? null;
  }

  const normalized = trimmed.toLowerCase();
  return question.options.find((option) => option.label.toLowerCase() === normalized)?.label ?? null;
}

function parseSingleUserInputAnswer(
  question: UserInputRequestQuestion,
  rawValue: string,
): { answers: string[] } | { error: string } {
  const trimmed = normalizeOutput(rawValue).trim();
  if (!trimmed) {
    return {
      error: `Question "${question.header}" requires an answer.`,
    };
  }

  if (!question.options?.length) {
    return {
      answers: [trimmed],
    };
  }

  const separatorIndex = trimmed.indexOf("|");
  const selection = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex).trim() : trimmed;
  let note = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1).trim() : "";
  const answers: string[] = [];

  if (selection) {
    const selectedLabel = resolveUserInputOptionLabel(question, selection);
    if (selectedLabel) {
      answers.push(selectedLabel);
    } else if (question.isOther) {
      note = note ? `${selection}; ${note}` : selection;
    } else {
      return {
        error: `Question "${question.header}" expects an option number or label.`,
      };
    }
  }

  if (note) {
    answers.push(`user_note: ${note}`);
  }

  if (answers.length === 0) {
    return {
      error: `Question "${question.header}" requires an answer.`,
    };
  }

  return {
    answers,
  };
}

export function parsePendingUserInputAnswerCommand(
  raw: string,
  pending: PendingUserInputRequest,
): { answers: Record<string, string[]>; preview: string } | { error: string } {
  const input = normalizeOutput(raw).trim();
  if (!input) {
    return {
      error: "Reply with /answer followed by your response.",
    };
  }

  const answers: Record<string, string[]> = {};

  if (pending.questions.length === 1) {
    const question = pending.questions[0];
    if (!question) {
      return {
        error: "No pending user input question was found.",
      };
    }
    const parsed = parseSingleUserInputAnswer(question, input);
    if ("error" in parsed) {
      return parsed;
    }
    answers[question.id] = parsed.answers;
  } else {
    const segments = input
      .split(/\s*(?:;|\n)\s*/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      return {
        error: "Reply with /answer questionId=value; questionId2=value.",
      };
    }

    for (const segment of segments) {
      const separatorIndex = segment.indexOf("=");
      if (separatorIndex <= 0) {
        return {
          error: `Each answer must use questionId=value. Invalid segment: ${segment}`,
        };
      }

      const reference = segment.slice(0, separatorIndex).trim();
      const rawValue = segment.slice(separatorIndex + 1).trim();
      const question = resolveUserInputQuestion(pending, reference);
      if (!question) {
        return {
          error: `Unknown question reference: ${reference}`,
        };
      }
      if (answers[question.id]) {
        return {
          error: `Question "${question.id}" was answered more than once.`,
        };
      }

      const parsed = parseSingleUserInputAnswer(question, rawValue);
      if ("error" in parsed) {
        return parsed;
      }
      answers[question.id] = parsed.answers;
    }

    const missing = pending.questions.filter((question) => !answers[question.id]);
    if (missing.length > 0) {
      return {
        error: `Missing answers for: ${missing.map((question) => question.id).join(", ")}.`,
      };
    }
  }

  return {
    answers,
    preview: truncatePreview(
      pending.questions
        .map((question) => `${question.id}=${(answers[question.id] ?? []).join(", ")}`)
        .join("; "),
      180,
    ),
  };
}

export function formatUserInputRequestMessage(
  pending: PendingUserInputRequest,
  adapterState: BridgeAdapterState,
): string {
  const lines = [
    pending.summary,
    `adapter: ${adapterState.kind}`,
  ];

  const hasSecretQuestion = pending.questions.some((question) => question.isSecret);
  if (hasSecretQuestion) {
    lines.push("Warning: this prompt includes secret input upstream, but WeChat replies are not hidden.");
  }

  pending.questions.forEach((question, index) => {
    lines.push("");
    lines.push(formatUserInputQuestionLabel(question, index));
    lines.push(question.question);
    if (question.options?.length) {
      lines.push("options:");
      question.options.forEach((option, optionIndex) => {
        lines.push(`  ${optionIndex + 1}. ${option.label} - ${truncatePreview(option.description, 160)}`);
      });
    }
    if (question.isOther) {
      lines.push("custom note: allowed");
    }
  });

  lines.push("");
  if (pending.questions.length === 1) {
    const question = pending.questions[0];
    if (!question) {
      return lines.join("\n");
    }
    if (question.options?.length) {
      lines.push("Reply with /answer <option number or exact label>.");
      if (question.isOther) {
        lines.push('Add "| your note" to include extra context.');
      }
    } else {
      lines.push("Reply with /answer <your answer>.");
    }
  } else {
    lines.push("Reply with /answer questionId=value; questionId2=value.");
    lines.push("You can use question numbers instead of ids.");
    lines.push("For option questions, value can be the option number or exact label.");
    lines.push('Add "| your note" after an option answer to include extra context.');
  }
  lines.push("Use /stop to interrupt the active turn instead.");

  return lines.join("\n");
}

export function formatPendingUserInputReminder(
  pending: PendingUserInputRequest,
): string {
  if (pending.questions.length === 1) {
    const question = pending.questions[0];
    if (!question) {
      return "Codex is waiting for user input. Reply with /answer and your response, or use /stop to interrupt.";
    }
    return `Codex is waiting for user input for ${question.header}. Reply with /answer and your response, or use /stop to interrupt.`;
  }

  return `Codex is waiting for answers to ${pending.questions.length} questions. Reply with /answer questionId=value; questionId2=value, or use /stop to interrupt.`;
}

export class OutputBatcher {
  private readonly onFlush: (text: string) => Promise<void> | void;
  private readonly flushIntervalMs: number;
  private readonly maxChars: number;
  private buffer = "";
  private recentText = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain = Promise.resolve();

  constructor(
    onFlush: (text: string) => Promise<void> | void,
    flushIntervalMs = 1_000,
    maxChars = 1_200,
  ) {
    this.onFlush = onFlush;
    this.flushIntervalMs = flushIntervalMs;
    this.maxChars = maxChars;
  }

  push(text: string): void {
    const normalized = normalizeOutput(text);
    if (!normalized) {
      return;
    }

    this.buffer += normalized;
    this.recentText = (this.recentText + normalized).slice(-6_000);

    while (this.buffer.length >= this.maxChars) {
      const nextChunk = this.buffer.slice(0, this.maxChars);
      this.buffer = this.buffer.slice(this.maxChars);
      this.enqueueFlush(nextChunk);
    }

    this.ensureFlushTimer();
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.buffer) {
      await this.flushChain;
      return;
    }

    const chunk = this.buffer;
    this.buffer = "";
    this.enqueueFlush(chunk);
    await this.flushChain;
  }

  clear(): void {
    this.buffer = "";
    this.recentText = "";
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  getRecentSummary(maxLength = 280): string {
    return summarizeOutput(this.recentText, maxLength);
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer || !this.buffer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, this.flushIntervalMs);
  }

  private enqueueFlush(text: string): void {
    const payload = text.trim();
    if (!payload) {
      return;
    }

    this.flushChain = this.flushChain
      .then(() => Promise.resolve(this.onFlush(payload)))
      .catch(() => undefined);
  }
}

export function shouldDropStartupBacklogMessage(
  createdAtMs: number | undefined,
  bridgeStartedAtMs: number,
  graceMs = MESSAGE_START_GRACE_MS,
): boolean {
  if (!Number.isFinite(createdAtMs)) {
    return true;
  }

  return (createdAtMs as number) < bridgeStartedAtMs - graceMs;
}
