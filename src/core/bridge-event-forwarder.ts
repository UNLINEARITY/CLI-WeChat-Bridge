import type { BridgeEvent } from "../bridge/bridge-types.ts";

type EventOf<T extends BridgeEvent["type"]> = Extract<BridgeEvent, { type: T }>;

export type BridgeEventForwarderHandlers = {
  stdout?: (event: EventOf<"stdout">) => void | Promise<void>;
  stderr?: (event: EventOf<"stderr">) => void | Promise<void>;
  finalReply?: (event: EventOf<"final_reply">) => void | Promise<void>;
  status?: (event: EventOf<"status">) => void | Promise<void>;
  notice?: (event: EventOf<"notice">) => void | Promise<void>;
  thinking?: (event: EventOf<"thinking">) => void | Promise<void>;
  approvalRequired?: (event: EventOf<"approval_required">) => void | Promise<void>;
  userInputRequired?: (event: EventOf<"user_input_required">) => void | Promise<void>;
  mirroredUserInput?: (event: EventOf<"mirrored_user_input">) => void | Promise<void>;
  sessionSwitched?: (event: EventOf<"session_switched">) => void | Promise<void>;
  threadSwitched?: (event: EventOf<"thread_switched">) => void | Promise<void>;
  taskComplete?: (event: EventOf<"task_complete">) => void | Promise<void>;
  taskFailed?: (event: EventOf<"task_failed">) => void | Promise<void>;
  fatalError?: (event: EventOf<"fatal_error">) => void | Promise<void>;
  shutdownRequested?: (event: EventOf<"shutdown_requested">) => void | Promise<void>;
};

/** Dispatch a BridgeEvent without importing any channel or transport code. */
export async function forwardBridgeEvent(
  event: BridgeEvent,
  handlers: BridgeEventForwarderHandlers,
): Promise<void> {
  switch (event.type) {
    case "stdout":
      await handlers.stdout?.(event);
      return;
    case "stderr":
      await handlers.stderr?.(event);
      return;
    case "final_reply":
      await handlers.finalReply?.(event);
      return;
    case "status":
      await handlers.status?.(event);
      return;
    case "notice":
      await handlers.notice?.(event);
      return;
    case "thinking":
      await handlers.thinking?.(event);
      return;
    case "approval_required":
      await handlers.approvalRequired?.(event);
      return;
    case "user_input_required":
      await handlers.userInputRequired?.(event);
      return;
    case "mirrored_user_input":
      await handlers.mirroredUserInput?.(event);
      return;
    case "session_switched":
      await handlers.sessionSwitched?.(event);
      return;
    case "thread_switched":
      await handlers.threadSwitched?.(event);
      return;
    case "task_complete":
      await handlers.taskComplete?.(event);
      return;
    case "task_failed":
      await handlers.taskFailed?.(event);
      return;
    case "fatal_error":
      await handlers.fatalError?.(event);
      return;
    case "shutdown_requested":
      await handlers.shutdownRequested?.(event);
      return;
  }
}
