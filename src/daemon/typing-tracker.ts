// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { ChannelDriver } from "../core/channel-driver.ts";

type TypingSlot = { adapter: string };

/**
 * Which windows show "typing…" to whom. Several windows can type for the
 * same recipient; the indicator ends once none of them does, and always for
 * the recipient it was started for. A window waiting for the operator
 * (approval or question) pauses its indicator and resumes it afterwards.
 */
export class TypingTracker {
  private readonly driver: Pick<ChannelDriver, "beginTyping" | "endTyping">;
  private readonly log: (message: string) => void;
  private readonly active = new Map<TypingSlot, string>();
  private readonly paused = new Map<TypingSlot, string>();

  constructor(driver: Pick<ChannelDriver, "beginTyping" | "endTyping">, log: (message: string) => void) {
    this.driver = driver;
    this.log = log;
  }

  /** A remote turn started in this window. */
  start(slot: TypingSlot, recipientId: string): void {
    this.paused.delete(slot);
    this.active.set(slot, recipientId);
    this.log(`typing_start: adapter=${slot.adapter} recipient=${recipientId}`);
    void this.driver.beginTyping?.(recipientId);
  }

  /** The window now waits for the operator. */
  pause(slot: TypingSlot): void {
    const recipientId = this.active.get(slot);
    if (recipientId === undefined) return;
    this.release(slot, "paused");
    this.paused.set(slot, recipientId);
  }

  /** The operator answered; the CLI works again. */
  resume(slot: TypingSlot): void {
    const recipientId = this.paused.get(slot);
    if (recipientId !== undefined) this.start(slot, recipientId);
  }

  /** The turn in this window ended. */
  stop(slot: TypingSlot, reason: string): void {
    this.paused.delete(slot);
    this.release(slot, reason);
  }

  private release(slot: TypingSlot, reason: string): void {
    const recipientId = this.active.get(slot);
    if (recipientId === undefined) return;
    this.active.delete(slot);
    if ([...this.active.values()].includes(recipientId)) return;
    this.log(`typing_end: adapter=${slot.adapter} recipient=${recipientId} reason=${reason}`);
    void this.driver.endTyping?.(recipientId);
  }
}
