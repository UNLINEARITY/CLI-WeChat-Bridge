// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { t } from "../i18n/index.ts";
import type {
  BridgeAdapter,
  BridgeAdapterKind,
  BridgeResumeSessionCandidate,
  BridgeSessionSwitchReason,
} from "./bridge-types.ts";
import {
  formatResumeSessionList,
  formatSessionSwitchMessage,
} from "./bridge-utils.ts";

export const RESUME_SESSION_LIST_LIMIT = 8;
export const RESUME_SESSION_SNAPSHOT_TTL_MS = 5 * 60 * 1_000;

const RESUME_SESSION_PREFIX_SCAN_LIMIT = 100;

type ResumeSessionSnapshot = {
  createdAtMs: number;
  candidates: BridgeResumeSessionCandidate[];
};

export type ResumeSessionCommandResult =
  | {
      kind: "list";
      message: string;
    }
  | {
      kind: "already_active" | "resumed";
      message: string;
      sessionId: string;
    };

type ResumeSessionCoordinatorOptions = {
  adapter: BridgeAdapterKind;
  runtime: Pick<BridgeAdapter, "getState" | "listResumeSessions" | "resumeSession">;
  now?: () => number;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function adapterDisplayName(adapter: BridgeAdapterKind): string {
  switch (adapter) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
  }
}

function adapterSessionNoun(adapter: BridgeAdapterKind): string {
  return t(adapter === "codex" ? "session.thread" : "session.noun");
}

export function isWechatResumeEnabled(adapter: BridgeAdapterKind): boolean {
  return (
    adapter === "codex" ||
    adapter === "claude" ||
    adapter === "opencode" ||
    adapter === "pi"
  );
}

export function shouldForwardSessionSwitchEvent(
  reason: BridgeSessionSwitchReason,
): boolean {
  return reason !== "wechat_resume";
}

export class ResumeSessionCoordinator {
  private readonly adapter: BridgeAdapterKind;
  private readonly runtime: ResumeSessionCoordinatorOptions["runtime"];
  private readonly now: () => number;
  private snapshot: ResumeSessionSnapshot | null = null;

  constructor(options: ResumeSessionCoordinatorOptions) {
    this.adapter = options.adapter;
    this.runtime = options.runtime;
    this.now = options.now ?? Date.now;
  }

  clear(): void {
    this.snapshot = null;
  }

  async execute(target?: string): Promise<ResumeSessionCommandResult> {
    const normalizedTarget = target?.trim() ?? "";
    if (!normalizedTarget) {
      const candidates = await this.listCandidates(RESUME_SESSION_LIST_LIMIT);
      this.snapshot = {
        createdAtMs: this.now(),
        candidates,
      };
      return {
        kind: "list",
        message: formatResumeSessionList({
          adapter: this.adapter,
          candidates,
          currentSessionId:
            this.runtime.getState().sharedSessionId ??
            this.runtime.getState().sharedThreadId,
        }),
      };
    }

    const candidate = await this.resolveCandidate(normalizedTarget);
    const currentSessionId =
      this.runtime.getState().sharedSessionId ??
      this.runtime.getState().sharedThreadId;
    if (candidate.sessionId === currentSessionId) {
      return {
        kind: "already_active",
        sessionId: candidate.sessionId,
        message: t("session.alreadyActive", { adapter: adapterDisplayName(this.adapter), noun: adapterSessionNoun(this.adapter), id: candidate.sessionId.slice(0, 12) }),
      };
    }

    await this.runtime.resumeSession(candidate.sessionId);
    return {
      kind: "resumed",
      sessionId: candidate.sessionId,
      message: formatSessionSwitchMessage({
        adapter: this.adapter,
        sessionId: candidate.sessionId,
        source: "wechat",
        reason: "wechat_resume",
      }),
    };
  }

  private async resolveCandidate(target: string): Promise<BridgeResumeSessionCandidate> {
    if (/^\d+$/.test(target)) {
      const snapshot = this.getCurrentSnapshot();
      if (!snapshot) {
        throw new Error(t("session.list.expired"));
      }
      const index = Number(target) - 1;
      const candidate = snapshot.candidates[index];
      if (!candidate) {
        throw new Error(
          t("session.list.range", { target }),
        );
      }
      return candidate;
    }

    const snapshot = this.getCurrentSnapshot();
    const snapshotMatch = this.findIdMatch(snapshot?.candidates ?? [], target);
    if (snapshotMatch) {
      return snapshotMatch;
    }

    const candidates = await this.listCandidates(RESUME_SESSION_PREFIX_SCAN_LIMIT);
    const candidate = this.findIdMatch(candidates, target);
    if (candidate) {
      return candidate;
    }

    // A complete ID may be older than the recent candidate window. The
    // adapter remains responsible for validating its existence and cwd.
    return {
      sessionId: target,
      title: target,
      lastUpdatedAt: new Date(0).toISOString(),
      source: this.adapter,
    };
  }

  private findIdMatch(
    candidates: BridgeResumeSessionCandidate[],
    target: string,
  ): BridgeResumeSessionCandidate | null {
    const normalizedTarget = target.toLowerCase();
    const exact = candidates.find(
      (candidate) => candidate.sessionId.toLowerCase() === normalizedTarget,
    );
    if (exact) {
      return exact;
    }

    const prefixMatches = candidates.filter((candidate) =>
      candidate.sessionId.toLowerCase().startsWith(normalizedTarget),
    );
    if (prefixMatches.length > 1) {
      throw new Error(
        t("session.list.ambiguous", { target }),
      );
    }
    return prefixMatches[0] ?? null;
  }

  private getCurrentSnapshot(): ResumeSessionSnapshot | null {
    if (!this.snapshot) {
      return null;
    }
    if (this.now() - this.snapshot.createdAtMs > RESUME_SESSION_SNAPSHOT_TTL_MS) {
      this.snapshot = null;
      return null;
    }
    return this.snapshot;
  }

  private async listCandidates(limit: number): Promise<BridgeResumeSessionCandidate[]> {
    try {
      return await this.runtime.listResumeSessions(limit);
    } catch (error) {
      const message = describeError(error);
      if (/^Failed to list\s/i.test(message)) {
        throw error;
      }
      throw new Error(
        t("session.list.failed", { adapter: adapterDisplayName(this.adapter), noun: t(this.adapter === "codex" ? "session.threads" : "session.sessions"), message }),
        { cause: error },
      );
    }
  }
}
