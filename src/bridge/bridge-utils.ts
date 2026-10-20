// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { BridgeAdapterKind } from "./bridge-types.ts";
import { parseBridgeControlCommand, type BridgeControlCommand } from "../core/bridge-control.ts";
import { normalizeOutput, summarizeOutput } from "../core/text-utils.ts";

export {
  buildInstanceId,
  buildOneTimeCode,
  formatDuration,
  normalizeOutput,
  nowIso,
  stripAnsi,
  summarizeOutput,
  truncatePreview,
} from "../core/text-utils.ts";

/** Compatibility alias; canonical command definitions live in src/core. */
export type SystemCommand = BridgeControlCommand;

// Messages older than bridge start minus this grace window are treated as
// pre-start backlog and skipped. The window must absorb realistic clock skew
// between the local machine and WeChat server timestamps: with a small value,
// a PC clock running slightly ahead silently dropped fresh messages.
export const MESSAGE_START_GRACE_MS = 30_000;

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

export function parseSystemCommand(text: string): SystemCommand | null {
  return parseBridgeControlCommand(text);
}

export function parseControlCommand(
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

  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (options.hasPendingConfirmation) {
    switch (trimmed.toLowerCase()) {
      case "confirm":
      case "yes":
        return { type: "confirm" };
      case "deny":
      case "no":
        return { type: "deny" };
    }
  }

  // While a question waits, a plain reply is its answer; "/" stays a command.
  if (options.hasPendingUserInput && !trimmed.startsWith("/")) {
    return { type: "answer", raw: trimmed };
  }
  return null;
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
  // A missing or unparsable timestamp must not drop the message: treat it as
  // fresh and let normal processing continue.
  if (!Number.isFinite(createdAtMs) || (createdAtMs as number) <= 0) {
    return false;
  }

  return (createdAtMs as number) < bridgeStartedAtMs - graceMs;
}
