// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { ChannelOutputKind } from "../../core/channel-types.ts";
import type { ChannelSendKind } from "../../core/channel-types.ts";

export function toTelegramOutputKind(context: ChannelSendKind): ChannelOutputKind {
  const known = new Set<ChannelOutputKind>([
    "status",
    "notice",
    "thinking",
    "final_reply",
    "approval_required",
    "user_input_required",
    "mirrored_input",
    "task_failed",
    "fatal_error",
  ]);
  return known.has(context as ChannelOutputKind)
    ? (context as ChannelOutputKind)
    : context === "mirrored_user_input"
      ? "mirrored_input"
      : "notice";
}

export function buildTelegramInboundPrompt(
  text: string,
  attachments: Array<{
    kind: string;
    path: string;
    fileName?: string;
    sizeBytes?: number;
  }> = [],
): string {
  const normalizedText = text.trim();
  if (attachments.length === 0) {
    return normalizedText;
  }
  const lines = [
    "[Telegram inbound attachments — ACTION REQUIRED]",
    "Use the local attachment paths below when the user asks you to inspect or process them.",
  ];
  attachments.forEach((attachment, index) => {
    const metadata = [
      `kind=${attachment.kind}`,
      attachment.fileName ? `name=${attachment.fileName}` : "",
      typeof attachment.sizeBytes === "number" ? `bytes=${attachment.sizeBytes}` : "",
    ].filter(Boolean);
    lines.push(`${index + 1}. ${metadata.join(" ")} path=${attachment.path}`);
  });
  return [normalizedText || "Received Telegram attachment(s).", lines.join("\n")].join(
    "\n\n",
  );
}

/** Telegram displays plain text; identity keeps one shaping point per channel. */
export function formatTelegramVisibleText(text: string): string {
  return text;
}
