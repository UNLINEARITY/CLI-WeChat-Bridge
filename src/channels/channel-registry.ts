// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { BridgeAdapterKind } from "../bridge/bridge-types.ts";
import type { ChannelDriver } from "../core/channel-driver.ts";
import type {
  BridgeChannelId,
  BridgeChannelPort,
  ChannelAttachment,
  ChannelConversationRef,
  ChannelOutputKind,
} from "../core/channel-types.ts";
import { migrateLegacyChannelFiles } from "../wechat/channel-config.ts";
import { ensureWechatCredentials } from "../wechat/setup.ts";
import { WeChatTransport } from "../wechat/wechat-transport.ts";
import { createChannelDriver } from "./channel-driver-factory.ts";
import { LocalChannelPort } from "./local/local-channel-port.ts";
import {
  getLocalChannelFiles,
  LOCAL_CHANNEL_OPERATOR_ID,
  type LocalChannelFiles,
} from "./local/local-driver.ts";
import { ensureTelegramAccount } from "./telegram/setup.ts";
import { TelegramChannelPort } from "./telegram/telegram-channel-port.ts";
import { TelegramTransport } from "./telegram/telegram-transport.ts";
import { WechatChannelPort } from "./wechat/wechat-channel-port.ts";
import { getPendingChannelMessagesFile } from "../core/pending-message-store.ts";
import { ensureWecomAccount } from "./wecom/setup.ts";
import { WecomChannelPort } from "./wecom/wecom-channel-port.ts";
import { WecomTransport } from "./wecom/wecom-transport.ts";

export type ChannelTransports = {
  wechat: WeChatTransport | null;
  wecom: WecomTransport | null;
  telegram: TelegramTransport | null;
  localFiles: LocalChannelFiles | null;
};

/** Credentials and transports resolved for one channel before orchestration starts. */
export type ChannelSetup = {
  channelId: BridgeChannelId;
  operatorId: string;
  accountId?: string;
  transports: ChannelTransports;
};

/**
 * Callbacks the orchestrator hands to a channel port. Target-addressed
 * channels (WeCom, Telegram) use `sendTextToTarget`; recipient-addressed
 * channels (WeChat, local) use `sendTextToRecipient`.
 */
export type ChannelPortHooks = {
  sendTextToTarget: (
    target: ChannelConversationRef,
    text: string,
    kind: ChannelOutputKind,
  ) => Promise<boolean>;
  sendTextToRecipient: (
    recipientId: string,
    text: string,
    context: string,
  ) => Promise<boolean>;
  queueAttachment: <T>(action: () => Promise<T>) => Promise<T>;
  prefixText?: (adapter: BridgeAdapterKind | undefined, text: string) => string;
  onEmptyVisibleReply: (adapter: BridgeAdapterKind | undefined, rawText: string) => void;
  onTextSent?: (adapter: BridgeAdapterKind | undefined, text: string) => void;
};

/** Everything orchestration needs from a channel, with no channel-id branching. */
export type ChannelRuntime = {
  readonly id: BridgeChannelId;
  readonly operatorId: string;
  readonly accountId?: string;
  readonly driver: ChannelDriver;
  /** Long-poll transport for pull channels (WeChat); null for push channels. */
  readonly pollTransport: WeChatTransport | null;
  createPort(hooks: ChannelPortHooks): BridgeChannelPort;
  pendingMessagesFile(cwd: string): string;
  /** Stop every transport this channel owns. Best effort. */
  stop(): Promise<void>;
};

export type ChannelSetupContext = {
  cwd: string;
  log: (message: string) => void;
  logError: (message: string) => void;
};

export type ChannelRuntimeContext = {
  buildAttachmentInboundPrompt: (text: string, attachments: ChannelAttachment[]) => string;
  log: (message: string) => void;
  logError: (message: string) => void;
};

type ChannelDefinition = {
  /** Runs before daemon startup cleanup (e.g. legacy data migration). */
  prepare?: (log: (message: string) => void) => void;
  setup: (context: ChannelSetupContext) => Promise<ChannelSetup>;
  createPort: (transports: ChannelTransports, hooks: ChannelPortHooks) => BridgeChannelPort;
};

const NO_TRANSPORTS: ChannelTransports = {
  wechat: null,
  wecom: null,
  telegram: null,
  localFiles: null,
};

function transportLogger(context: ChannelSetupContext) {
  return {
    log: (message: string) => context.log(message),
    error: (message: string) => context.logError(message),
  };
}

function requireTransport<T>(transport: T | null, message: string): T {
  if (!transport) {
    throw new Error(message);
  }
  return transport;
}

const CHANNELS: Record<BridgeChannelId, ChannelDefinition> = {
  wechat: {
    prepare: (log) => migrateLegacyChannelFiles(log),
    setup: async (context) => {
      const credentials = await ensureWechatCredentials({
        requireUserId: true,
        validateExisting: true,
        log: context.log,
      });
      if (!credentials.userId) {
        throw new Error("Saved WeChat credentials are missing userId.");
      }
      return {
        channelId: "wechat",
        operatorId: credentials.userId,
        transports: {
          ...NO_TRANSPORTS,
          wechat: new WeChatTransport({ log: context.log, logError: context.logError }),
        },
      };
    },
    createPort: (transports, hooks) => {
      // Resolved lazily: text-only callers (and tests) never touch media.
      const transport = () => requireTransport(
        transports.wechat,
        "The wechat channel port requires a WeChat transport.",
      );
      return new WechatChannelPort({
        sendText: hooks.sendTextToRecipient,
        sendImage: (recipientId, filePath) =>
          hooks.queueAttachment(() => transport().sendImage(filePath, { recipientId })),
        sendFile: (recipientId, filePath) =>
          hooks.queueAttachment(() => transport().sendFile(filePath, { recipientId })),
        sendVoice: (recipientId, filePath) =>
          hooks.queueAttachment(() => transport().sendVoice(filePath, recipientId)),
        sendVideo: (recipientId, filePath) =>
          hooks.queueAttachment(() => transport().sendVideo(filePath, { recipientId })),
        prefixText: hooks.prefixText,
        onEmptyVisibleReply: hooks.onEmptyVisibleReply,
        onTextSent: hooks.onTextSent,
      });
    },
  },
  wecom: {
    setup: async (context) => {
      const account = await ensureWecomAccount({ log: context.log });
      if (!account.operatorUserId) {
        throw new Error("Saved WeCom credentials are missing operatorUserId.");
      }
      return {
        channelId: "wecom",
        operatorId: account.operatorUserId,
        accountId: account.botId,
        transports: {
          ...NO_TRANSPORTS,
          wecom: new WecomTransport({ account, logger: transportLogger(context) }),
        },
      };
    },
    createPort: (transports, hooks) =>
      new WecomChannelPort({
        transport: requireTransport(
          transports.wecom,
          "The wecom channel port requires a WeCom transport.",
        ),
        sendText: hooks.sendTextToTarget,
        prefixText: hooks.prefixText,
        onEmptyVisibleReply: hooks.onEmptyVisibleReply,
      }),
  },
  telegram: {
    setup: async (context) => {
      const account = await ensureTelegramAccount({ log: context.log });
      if (!account.operatorUserId) {
        throw new Error("Saved Telegram credentials are missing operatorUserId.");
      }
      return {
        channelId: "telegram",
        operatorId: account.operatorUserId,
        accountId: account.botUsername,
        transports: {
          ...NO_TRANSPORTS,
          telegram: new TelegramTransport({ account, logger: transportLogger(context) }),
        },
      };
    },
    createPort: (transports, hooks) =>
      new TelegramChannelPort({
        transport: requireTransport(
          transports.telegram,
          "The telegram channel port requires a Telegram transport.",
        ),
        sendText: hooks.sendTextToTarget,
        prefixText: hooks.prefixText,
        onEmptyVisibleReply: hooks.onEmptyVisibleReply,
      }),
  },
  local: {
    setup: async (context) => ({
      channelId: "local",
      operatorId: LOCAL_CHANNEL_OPERATOR_ID,
      transports: {
        ...NO_TRANSPORTS,
        localFiles: getLocalChannelFiles(context.cwd),
      },
    }),
    createPort: (_transports, hooks) =>
      new LocalChannelPort({
        sendText: hooks.sendTextToRecipient,
        prefixText: hooks.prefixText,
        onEmptyVisibleReply: hooks.onEmptyVisibleReply,
        onTextSent: hooks.onTextSent,
      }),
  },
};

/** Channel-specific preparation that must run before startup cleanup. */
export function prepareChannel(
  channelId: BridgeChannelId,
  log: (message: string) => void,
): void {
  CHANNELS[channelId].prepare?.(log);
}

/** Resolve credentials and build the transports for a channel. */
export async function setupChannel(
  channelId: BridgeChannelId,
  context: ChannelSetupContext,
): Promise<ChannelSetup> {
  return CHANNELS[channelId].setup(context);
}

/** Build the outbound port for a channel from its transports. */
export function createChannelPort(
  channelId: BridgeChannelId,
  transports: ChannelTransports,
  hooks: ChannelPortHooks,
): BridgeChannelPort {
  return CHANNELS[channelId].createPort(transports, hooks);
}

/** Build the channel runtime from an already resolved setup. */
export function createChannelRuntime(
  setup: ChannelSetup,
  context: ChannelRuntimeContext,
): ChannelRuntime {
  const { channelId, transports } = setup;
  const driver = createChannelDriver({
    channelId,
    authorizedUserId: setup.operatorId,
    accountId: setup.accountId,
    wechatTransport: transports.wechat,
    wecomTransport: transports.wecom,
    telegramTransport: transports.telegram,
    localFiles: transports.localFiles,
    buildAttachmentInboundPrompt: context.buildAttachmentInboundPrompt,
    log: context.log,
    logError: context.logError,
  });
  return {
    id: channelId,
    operatorId: setup.operatorId,
    accountId: setup.accountId,
    driver,
    pollTransport: driver.capabilities.pushInbound ? null : transports.wechat,
    createPort: (hooks) => createChannelPort(channelId, transports, hooks),
    pendingMessagesFile: (cwd) => getPendingChannelMessagesFile(cwd, channelId),
    stop: async () => {
      for (const stop of [
        () => transports.wechat?.stop(),
        () => transports.wecom?.stop(),
        () => transports.telegram?.stop(),
      ]) {
        try {
          await stop();
        } catch {
          // Best effort shutdown.
        }
      }
    },
  };
}
