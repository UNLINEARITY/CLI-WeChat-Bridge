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
};

export type PendingApproval = ApprovalRequest & {
  code: string;
  createdAt: string;
};

export type UserInputRequestOption = {
  label: string;
  description: string;
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
  summary: string;
  questions: UserInputRequestQuestion[];
};

export type PendingUserInputRequest = UserInputRequest & {
  createdAt: string;
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
  pendingConfirmation?: PendingApproval | null;
  pendingUserInput?: PendingUserInputRequest | null;
  lastActivityAt?: string;
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
      type: "thinking";
      text: string;
      timestamp: string;
    }
  | {
      type: "approval_required";
      request: ApprovalRequest | PendingApproval;
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
  interrupt(): Promise<boolean>;
  reset(): Promise<void>;
  resolveApproval(action: "confirm" | "deny"): Promise<boolean>;
  resolveAllApprovals(action: "confirm" | "deny"): Promise<number>;
  submitUserInput(answers: Record<string, string[]>): Promise<boolean>;
  dispose(): Promise<void>;
  getState(): BridgeAdapterState;
}
