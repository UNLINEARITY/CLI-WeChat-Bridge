import type { ChannelConversationRef } from "./channel-types.ts";

/**
 * Outbound target priority for standalone bridges:
 * 1. an explicit override captured at enqueue time;
 * 2. for the operator on multi-conversation channels, the pre-resolved turn
 *    target (callers pass `TurnCoordinator.resolveTarget(operatorConversation)`);
 * 3. otherwise a direct conversation to the sender.
 */
export function resolveOutboundConversationTarget(params: {
  senderId: string;
  operatorId: string;
  override?: ChannelConversationRef;
  multiConversation: boolean;
  operatorTarget: ChannelConversationRef;
  directConversation: (senderId: string) => ChannelConversationRef;
}): ChannelConversationRef {
  if (params.override) {
    return params.override;
  }
  if (params.multiConversation && params.senderId === params.operatorId) {
    return params.operatorTarget;
  }
  return params.directConversation(params.senderId);
}

/**
 * Outbound target priority for daemon sends. Multi-conversation operators
 * resolve through the current inbound conversation first, then the active
 * slot's remembered target, then the daemon fallback conversation.
 */
export function resolveDaemonOutboundTarget(params: {
  senderId: string;
  operatorId: string;
  override?: ChannelConversationRef;
  multiConversation: boolean;
  inboundConversation?: ChannelConversationRef | null;
  activeSlotTarget?: ChannelConversationRef | null;
  fallbackConversation: ChannelConversationRef;
  directConversation: (senderId: string) => ChannelConversationRef;
}): ChannelConversationRef {
  if (params.override) {
    return params.override;
  }
  if (params.multiConversation && params.senderId === params.operatorId) {
    return params.inboundConversation
      ?? params.activeSlotTarget
      ?? params.fallbackConversation;
  }
  return params.directConversation(params.senderId);
}
