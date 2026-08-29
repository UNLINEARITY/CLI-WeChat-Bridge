import type { BridgeAdapterState } from "../bridge/bridge-types.ts";
import type { BridgeControlCommand } from "./bridge-control.ts";
import type { ChannelInboundMessage } from "./channel-types.ts";

export type BridgeMessageRouteResult =
  | { kind: "handled" }
  | { kind: "deferred" }
  | { kind: "dispatched"; result: unknown };

export type BridgeMessageRouterContext = {
  message: ChannelInboundMessage;
  authorized: boolean;
  command: BridgeControlCommand | null;
  adapterState: Pick<BridgeAdapterState, "status" | "activeTurnOrigin">;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  shouldDefer?: boolean;
  onUnauthorized: () => Promise<void>;
  handleCommand: (command: BridgeControlCommand) => Promise<boolean>;
  remindPendingApproval: () => Promise<void>;
  remindPendingUserInput: () => Promise<void>;
  remindBusy: () => Promise<void>;
  defer: () => Promise<void>;
  dispatch: () => Promise<unknown>;
};

/**
 * Common, channel-neutral ordering for an inbound bridge message.
 * Channel-specific parsing and daemon slot selection stay outside this
 * function and are supplied through callbacks.
 */
export async function routeBridgeMessage(
  context: BridgeMessageRouterContext,
): Promise<BridgeMessageRouteResult> {
  if (!context.authorized) {
    await context.onUnauthorized();
    return { kind: "handled" };
  }

  if (context.command && await context.handleCommand(context.command)) {
    return { kind: "handled" };
  }

  if (context.hasPendingApproval) {
    await context.remindPendingApproval();
    return { kind: "handled" };
  }

  if (context.hasPendingUserInput || context.adapterState.status === "awaiting_input") {
    await context.remindPendingUserInput();
    return { kind: "handled" };
  }

  if (context.shouldDefer) {
    await context.defer();
    return { kind: "deferred" };
  }

  if (
    context.adapterState.status === "busy" ||
    context.adapterState.status === "awaiting_approval"
  ) {
    await context.remindBusy();
    return { kind: "handled" };
  }

  return { kind: "dispatched", result: await context.dispatch() };
}
