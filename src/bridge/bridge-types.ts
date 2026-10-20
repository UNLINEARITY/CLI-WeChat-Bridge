// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
export type BridgeAdapterKind = "codex" | "claude" | "opencode" | "pi";
export type LegacyBridgeAdapterKind = BridgeAdapterKind | "shell";
export type BridgeLifecycleMode = "persistent" | "companion_bound";
export type BridgeSessionStartMode = "restore" | "new";
export type BridgeTurnOrigin = "wechat" | "local";
export type BridgeSessionSwitchSource = BridgeTurnOrigin | "restore";
export type BridgeSessionSwitchReason =
  | "local_follow"
  | "local_session_fallback"
  | "local_turn"
  | "wechat_resume"
  | "startup_restore";
export type BridgeThreadSwitchSource = BridgeSessionSwitchSource;
export type BridgeThreadSwitchReason = BridgeSessionSwitchReason;

export type BridgeWorkerStatus =
  | "starting"
  | "idle"
  | "busy"
  | "awaiting_approval"
  | "awaiting_input"
  | "stopped"
  | "error";

export type BridgeNoticeLevel = "info" | "warning";

export type ApprovalSource = "cli";

/** What an automatically approved request was, for the per-turn summary. */
export type AutoApprovalKind = "command" | "file_write" | "permissions" | "network" | "read" | "other";

/**
 * How the operator answers an approval: allow once, allow for the rest of the
 * session, reject (optionally with a reason for the model), or reject and
 * stop the turn.
 */
export type ApprovalDecision = "confirm" | "always" | "deny" | "abort";

export type ApprovalResolveOptions = {
  /** Why the operator rejected; given to the model where the CLI supports it. */
  reason?: string;
};

export type ApprovalRequest = {
  source: ApprovalSource;
  summary: string;
  commandPreview: string;
  toolName?: string;
  detailLabel?: string;
  detailPreview?: string;
  requestId?: string;
  confirmInput?: string;
  denyInput?: string;
  /** Decisions beyond confirm/deny that this request supports. */
  extraDecisions?: Array<"always" | "abort">;
  /** The CLI passes a rejection reason to the model. */
  denyReasonSupported?: boolean;
};

export type PendingApproval = ApprovalRequest & {
  createdAt: string;
};

export type UserInputRequestOption = {
  label: string;
  description: string;
  preview?: string;
};

export type UserInputRequestQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  multiple?: boolean;
  customAnswerMode?: "note" | "value";
  options?: UserInputRequestOption[] | null;
};

export type UserInputRequest = {
  requestId?: string;
  summary: string;
  questions: UserInputRequestQuestion[];
};

export type PendingUserInputRequest = UserInputRequest & {
  createdAt: string;
};

export type BridgeModelOption = {
  id: string;
  displayName: string;
  isCurrent?: boolean;
  supportedReasoningEfforts?: string[];
};

export type BridgeResumeSessionCandidate = {
  sessionId: string;
  title: string;
  lastUpdatedAt: string;
  source?: string;
  threadId?: string;
};

export type BridgeResumeThreadCandidate = BridgeResumeSessionCandidate;

export type BridgeState = {
  instanceId: string;
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
  bridgeStartedAtMs: number;
  authorizedUserId: string;
  ignoredBacklogCount: number;
  sharedSessionId?: string;
  sharedThreadId?: string;
  resumeConversationId?: string;
  transcriptPath?: string;
  pendingUserInput?: PendingUserInputRequest | null;
  lastActivityAt?: string;
  channelId?: "wechat" | "wecom" | "telegram" | "local";
};

export type BridgeAdapterState = {
  kind: BridgeAdapterKind;
  status: BridgeWorkerStatus;
  pid?: number;
  cwd: string;
  command: string;
  profile?: string;
  startedAt?: string;
  lastInputAt?: string;
  lastOutputAt?: string;
  pendingApproval?: ApprovalRequest | null;
  pendingApprovals?: ApprovalRequest[];
  supportsApprovalRequestIds?: boolean;
  supportsUserInputRequestIds?: boolean;
  supportsLocaleUpdates?: boolean;
  supportsAutoApprovalUpdates?: boolean;
  /** The companion accepts always/abort decisions and rejection reasons. */
  supportsApprovalDecisions?: boolean;
  sharedSessionId?: string;
  sharedThreadId?: string;
  activeRuntimeSessionId?: string;
  resumeConversationId?: string;
  transcriptPath?: string;
  lastSessionSwitchAt?: string;
  lastSessionSwitchSource?: BridgeSessionSwitchSource;
  lastSessionSwitchReason?: BridgeSessionSwitchReason;
  lastThreadSwitchAt?: string;
  lastThreadSwitchSource?: BridgeThreadSwitchSource;
  lastThreadSwitchReason?: BridgeThreadSwitchReason;
  activeTurnId?: string;
  activeTurnOrigin?: BridgeTurnOrigin;
  pendingApprovalOrigin?: BridgeTurnOrigin;
  pendingUserInput?: UserInputRequest | null;
  pendingUserInputOrigin?: BridgeTurnOrigin;
};

export type BridgeEvent =
  | {
      type: "stdout";
      text: string;
      timestamp: string;
    }
  | {
      type: "stderr";
      text: string;
      timestamp: string;
    }
  | {
      type: "final_reply";
      text: string;
      timestamp: string;
    }
  | {
      type: "status";
      status: BridgeWorkerStatus;
      message?: string;
      timestamp: string;
    }
  | {
      type: "notice";
      text: string;
      level: BridgeNoticeLevel;
      timestamp: string;
    }
  | {
      type: "approval_state_changed";
      requests: ApprovalRequest[];
      timestamp: string;
    }
  | {
      type: "approval_required";
      request: ApprovalRequest | PendingApproval;
      timestamp: string;
    }
  | {
      type: "approval_auto_resolved";
      kind: AutoApprovalKind;
      timestamp: string;
    }
  | {
      type: "user_input_required";
      request: UserInputRequest | PendingUserInputRequest;
      timestamp: string;
    }
  | {
      type: "mirrored_user_input";
      text: string;
      timestamp: string;
      origin: "local";
    }
  | {
      type: "session_switched";
      sessionId: string;
      source: BridgeSessionSwitchSource;
      reason: BridgeSessionSwitchReason;
      timestamp: string;
    }
  | {
      type: "thread_switched";
      threadId: string;
      source: BridgeThreadSwitchSource;
      reason: BridgeThreadSwitchReason;
      timestamp: string;
    }
  | {
      type: "task_complete";
      exitCode?: number;
      summary?: string;
      timestamp: string;
    }
  | {
      type: "task_failed";
      message: string;
      timestamp: string;
    }
  | {
      type: "fatal_error";
      message: string;
      timestamp: string;
    }
  | {
      type: "shutdown_requested";
      reason: "companion_closed" | "companion_reconnect_timeout";
      message: string;
      exitCode?: number;
      timestamp: string;
    };

export interface BridgeAdapter {
  setEventSink(sink: (event: BridgeEvent) => void): void;
  start(): Promise<void>;
  sendInput(text: string): Promise<void>;
  listResumeSessions(limit?: number): Promise<BridgeResumeSessionCandidate[]>;
  resumeSession(sessionId: string): Promise<void>;
  createSession?(): Promise<void>;
  listModels?(): Promise<BridgeModelOption[]>;
  selectModel?(modelId: string): Promise<BridgeModelOption>;
  setPlanMode?(enabled: boolean): Promise<boolean>;
  updateLocale?(locale: "zh" | "en"): Promise<boolean>;
  /** Mirror the daemon's `/auto` switch into a CLI running in another process. */
  setAutoApproval?(enabled: boolean): Promise<boolean>;
  interrupt(): Promise<boolean>;
  reset(): Promise<void>;
  resolveApproval(action: ApprovalDecision, requestId?: string, options?: ApprovalResolveOptions): Promise<boolean>;
  submitUserInput(answers: Record<string, string[]>, requestId?: string): Promise<boolean>;
  dispose(): Promise<void>;
  getState(): BridgeAdapterState;
}
