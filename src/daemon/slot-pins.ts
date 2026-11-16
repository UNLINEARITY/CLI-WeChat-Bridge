// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";

import { t } from "../i18n/index.ts";
import { PIN_BINDINGS_FILE } from "../wechat/channel-config.ts";
import { writeJsonFileAtomic } from "../utils/atomic-file.ts";
import type { DaemonAdapterKind } from "./daemon-link.ts";

/**
 * A conversation pinned to a fixed window/slot. `instance` is the 1-based
 * numbered window of `adapter` inside `cwd`.
 */
export type ConversationPinTarget = {
  cwd: string;
  adapter: DaemonAdapterKind;
  instance: number;
};

export type ConversationPin = {
  /** `${channelId}:${conversationId}`; unique per conversation. */
  key: string;
  target: ConversationPinTarget;
};

/**
 * Conversation-to-slot pins. The daemon routes every inbound text from a
 * pinned conversation to its pinned window, no matter which window is active.
 */
export type SlotPins = {
  get(key: string): ConversationPinTarget | undefined;
  set(key: string, target: ConversationPinTarget): void;
  remove(key: string): boolean;
  list(): ConversationPin[];
};

export function conversationPinKey(channelId: string, conversationId: string): string {
  return `${channelId}:${conversationId}`;
}

/**
 * Key of a conversation-scoped tag pin. Tags are matched case-insensitively
 * and stored normalized to upper case, so `[a]` and `[A]` pin the same slot.
 */
export function pinTagKey(key: string, tag: string): string {
  return `${key}#${tag.toUpperCase()}`;
}

/**
 * Extract a leading `[tag] ` prefix from an inbound text, e.g. `[A] deploy
 * now` → tag `A`, remainder `deploy now`. Only matches when real content
 * follows the tag, so a bare `[A]` is left untouched.
 */
export function parseMessageTag(text: string): { tag: string; remainder: string } | null {
  const match = text.match(/^\s*\[([^[\]]{1,20})\]\s*([\s\S]+)$/);
  if (!match) {
    return null;
  }
  return { tag: match[1]!, remainder: match[2]! };
}

/** In-memory pins; used by tests. */
export function createMemorySlotPins(): SlotPins {
  const map = new Map<string, ConversationPinTarget>();
  return {
    get: (key) => map.get(key),
    set: (key, target) => {
      map.set(key, { ...target });
    },
    remove: (key) => map.delete(key),
    list: () =>
      Array.from(map.entries()).map(([key, target]) => ({ key, target: { ...target } })),
  };
}

type PinFileShape = {
  pins?: Record<string, ConversationPinTarget>;
  updatedAt?: string;
};

function readPinFile(pinsFile: string): Record<string, ConversationPinTarget> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pinsFile, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const pins = (parsed as PinFileShape).pins;
      if (pins && typeof pins === "object" && !Array.isArray(pins)) {
        return pins as Record<string, ConversationPinTarget>;
      }
    }
  } catch {
    // Missing or malformed file: fall back to an empty map.
  }
  return {};
}

function writePinFile(
  pinsFile: string,
  pins: Map<string, ConversationPinTarget>,
): void {
  writeJsonFileAtomic(pinsFile, {
    pins: Object.fromEntries(pins),
    updatedAt: new Date().toISOString(),
  });
}

/** Pins persisted at `pinsFile` (lazily loaded; writes are atomic). */
export function createFileSlotPins(pinsFile: string): SlotPins {
  let map: Map<string, ConversationPinTarget> | null = null;
  const ensureLoaded = (): Map<string, ConversationPinTarget> => {
    if (!map) {
      map = new Map(Object.entries(readPinFile(pinsFile)));
    }
    return map;
  };
  return {
    get(key) {
      return ensureLoaded().get(key);
    },
    set(key, target) {
      ensureLoaded().set(key, { ...target });
      writePinFile(pinsFile, ensureLoaded());
    },
    remove(key) {
      const removed = ensureLoaded().delete(key);
      if (removed) {
        writePinFile(pinsFile, ensureLoaded());
      }
      return removed;
    },
    list() {
      return Array.from(ensureLoaded().entries()).map(([key, target]) => ({
        key,
        target: { ...target },
      }));
    },
  };
}

/** Pins persisted next to the channel's other state. */
export const fileSlotPins: SlotPins = createFileSlotPins(PIN_BINDINGS_FILE);

// --- Pin command parsing (daemon) ---

export type PinCommand =
  | { type: "pin" }
  | { type: "pin-to"; window: string }
  | { type: "pin-tag"; tag: string; window?: string }
  | { type: "unpin" }
  | { type: "unpin-tag"; tag: string }
  | { type: "list" };

export function parsePinCommand(text: string): PinCommand | null {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === "/pin") {
    return { type: "pin" };
  }
  const pinTag = trimmed.match(/^\/pin\s+\[([^[\]]{1,20})\]\s*(.*)$/i);
  if (pinTag) {
    const window = pinTag[2]?.trim();
    return window
      ? { type: "pin-tag", tag: pinTag[1]!, window }
      : { type: "pin-tag", tag: pinTag[1]! };
  }
  const pinTo = trimmed.match(/^\/pin\s+(.+)$/);
  if (pinTo) {
    return { type: "pin-to", window: pinTo[1]!.trim() };
  }
  if (trimmed.toLowerCase() === "/unpin") {
    return { type: "unpin" };
  }
  const unpinTag = trimmed.match(/^\/unpin\s+\[([^[\]]{1,20})\]\s*$/i);
  if (unpinTag) {
    return { type: "unpin-tag", tag: unpinTag[1]! };
  }
  if (trimmed.toLowerCase() === "/pins") {
    return { type: "list" };
  }
  return null;
}

const PIN_WINDOW_PATTERN = /^(codex|claude|opencode|pi)(?:-([1-9]\d?))?$/i;

/**
 * Parse a pin window name like `codex` or `codex-2` into a slot reference.
 * Instances are 1-based; `codex` means instance 1.
 */
export function parsePinWindowName(
  window: string,
): { adapter: DaemonAdapterKind; instance: number } | null {
  const match = window.trim().match(PIN_WINDOW_PATTERN);
  if (!match) {
    return null;
  }
  return {
    adapter: match[1]!.toLowerCase() as DaemonAdapterKind,
    instance: match[2] ? Number(match[2]) : 1,
  };
}

export function formatPinUsage(): string {
  return t("pin.usage");
}

export function formatPinsListMessage(
  pins: ConversationPin[],
  windowName: (target: ConversationPinTarget) => string,
): string {
  if (pins.length === 0) {
    return t("pin.listEmpty");
  }
  const lines = pins.map((pin) => {
    const separator = pin.key.indexOf(":");
    const tagIndex = pin.key.indexOf("#", separator + 1);
    if (tagIndex >= 0) {
      const tag = pin.key.slice(tagIndex + 1);
      return t("pin.tagEntry", { tag, window: windowName(pin.target) });
    }
    const conversationId = separator >= 0 ? pin.key.slice(separator + 1) : pin.key;
    return t("pin.entry", {
      conversation: conversationId,
      window: windowName(pin.target),
    });
  });
  return `${t("pin.listHeader")}\n${lines.join("\n")}`;
}
