import type { BridgeAdapterKind, BridgeEvent } from "../../bridge/bridge-types.ts";
import { truncatePreview } from "../../bridge/bridge-utils.ts";
import {
  classifyWechatTransportError,
  describeWechatTransportError,
  isWechatContextTokenStaleError,
} from "../../wechat/wechat-transport.ts";

export type WechatSendContext =
  | "final_reply"
  | "message"
  | "notice"
  | "approval_required"
  | "user_input_required"
  | "mirrored_user_input"
  | "session_switched"
  | "thread_switched"
  | "task_failed"
  | "fatal_error"
  | "inbound_error"
  | "thinking";

export const WECHAT_SEND_MAX_ATTEMPTS = 3;
export const CODEX_LOCAL_THREAD_NOTICE_SUPPRESS_MS = 5_000;

const WECHAT_SEND_RETRY_BASE_MS = 750;

export function formatUserFacingBridgeFatalError(message: string): string {
  return `Bridge error: ${message.replace(/\s+Recent app-server log:.*$/s, "").trim()}`;
}

export function shouldForwardBridgeEventToWechat(
  adapter: BridgeAdapterKind,
  eventType: BridgeEvent["type"],
  options: {
    text?: string;
  } = {},
): boolean {
  if (adapter !== "opencode" && adapter !== "pi") {
    return true;
  }

  switch (eventType) {
    case "stdout":
    case "stderr":
    case "thread_switched":
      return false;
    case "notice":
      return adapter === "pi" || /^OpenCode local draft:\s*/i.test(options.text ?? "");
    case "mirrored_user_input":
      return true;
    default:
      return true;
  }
}

/**
 * Local Codex panels can emit a burst of weak thread notifications while a
 * WeChat turn is settling. Suppress only the user-facing notice in that
 * window; the adapter still updates its internal shared-thread state.
 */
export function shouldSuppressCodexLocalThreadNotice(params: {
  adapter: BridgeAdapterKind;
  source: "local" | "wechat" | "restore";
  activeTurnOrigin?: "wechat" | "local";
  lastFinalReplyAtMs?: number;
  nowMs?: number;
}): boolean {
  if (params.adapter !== "codex" || params.source !== "local") {
    return false;
  }
  if (params.activeTurnOrigin === "wechat") {
    return true;
  }
  if (typeof params.lastFinalReplyAtMs !== "number") {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  const elapsedMs = nowMs - params.lastFinalReplyAtMs;
  return (
    elapsedMs >= 0 && elapsedMs < CODEX_LOCAL_THREAD_NOTICE_SUPPRESS_MS
  );
}

export function formatUserFacingInboundError(params: {
  adapter: BridgeAdapterKind;
  cwd?: string;
  errorText: string;
}): string {
  const { adapter, cwd, errorText } = params;

  if (
    adapter === "opencode" &&
    /opencode companion is not connected/i.test(errorText)
  ) {
    return cwd
      ? `OpenCode is not connected for workspace:\n${cwd}\nRun "wechat-opencode" in that directory to recreate or reconnect the visible terminal.`
      : 'OpenCode is not connected. Run "wechat-opencode" in this directory, then retry.';
  }

  return `Bridge error: ${errorText}`;
}

export function formatWechatSendFailureLogEntry(params: {
  context: WechatSendContext;
  recipientId: string;
  error: unknown;
}): string {
  return `wechat_send_failed: context=${params.context} recipient=${params.recipientId} error=${truncatePreview(describeWechatTransportError(params.error), 400)}`;
}

export function formatWechatContextTokenStaleLogEntry(params: {
  context: WechatSendContext;
  recipientId: string;
  error: unknown;
}): string {
  return `wechat_context_token_stale: context=${params.context} recipient=${params.recipientId} action=wechat_message_required error=${truncatePreview(describeWechatTransportError(params.error), 400)}`;
}

export function formatWechatSendRetryLogEntry(params: {
  context: WechatSendContext;
  recipientId: string;
  attempt: number;
  delayMs: number;
  error: unknown;
}): string {
  return `wechat_send_retry: context=${params.context} recipient=${params.recipientId} attempt=${params.attempt} delay_ms=${params.delayMs} error=${truncatePreview(describeWechatTransportError(params.error), 400)}`;
}

export function isRetryableWechatSendError(error: unknown): boolean {
  if (isWechatContextTokenStaleError(error)) {
    return false;
  }

  const classification = classifyWechatTransportError(error);
  if (classification.retryable) {
    return true;
  }

  const details = describeWechatTransportError(error);
  return /^(?:Error|WechatApiResponseError): sendmessage failed:/i.test(details) &&
    !/errcode=-14\b.*session timeout/i.test(details);
}

export function isWechatContextUnavailableError(error: unknown): boolean {
  return (
    isWechatContextTokenStaleError(error) ||
    (error instanceof Error && /No cached context token(?: is available| for )/i.test(error.message))
  );
}

export function computeWechatSendRetryDelayMs(attempt: number): number {
  return WECHAT_SEND_RETRY_BASE_MS * attempt;
}
