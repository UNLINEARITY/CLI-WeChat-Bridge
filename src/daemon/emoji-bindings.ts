import fs from "node:fs";
import { EMOJI_BINDINGS_FILE } from "../wechat/channel-config.ts";

export const DEFAULT_EMOJI_BINDINGS: Record<string, string> = {
  "[OK]": "/confirm",
  "[闭嘴]": "/stop",
  "[拥抱]": "/claude",
  "[强]": "/codex",
  "[胜利]": "/opencode",
  "[再见]": "/daemon-stop",
};

export type EmojiBindingsConfig = {
  bindings: Record<string, string>;
};

let bindingsMap: Map<string, string> | null = null;

function buildMap(bindings: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [emoji, command] of Object.entries(bindings)) {
    map.set(emoji.toLowerCase(), command);
  }
  return map;
}

export function loadEmojiBindings(): Map<string, string> {
  if (bindingsMap) {
    return bindingsMap;
  }
  try {
    if (fs.existsSync(EMOJI_BINDINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(EMOJI_BINDINGS_FILE, "utf-8")) as EmojiBindingsConfig;
      if (raw.bindings && typeof raw.bindings === "object") {
        bindingsMap = buildMap(raw.bindings);
        return bindingsMap;
      }
    }
  } catch {
    // Fall through to defaults on parse error.
  }
  bindingsMap = buildMap(DEFAULT_EMOJI_BINDINGS);
  return bindingsMap;
}

export function saveEmojiBindings(map: Map<string, string>): void {
  const bindings: Record<string, string> = {};
  for (const [emoji, command] of map) {
    bindings[emoji] = command;
  }
  const data: EmojiBindingsConfig = { bindings };
  fs.writeFile(EMOJI_BINDINGS_FILE, JSON.stringify(data, null, 2) + "\n", () => {});
}

export function setBinding(emoji: string, command: string): void {
  const map = loadEmojiBindings();
  map.set(emoji.toLowerCase(), command);
  bindingsMap = map;
  saveEmojiBindings(map);
}

export function removeBinding(emoji: string): boolean {
  const map = loadEmojiBindings();
  const key = emoji.toLowerCase();
  if (!map.has(key)) {
    return false;
  }
  map.delete(key);
  bindingsMap = map;
  saveEmojiBindings(map);
  return true;
}

export function listBindings(): Map<string, string> {
  return loadEmojiBindings();
}

export type EmojiCommandMatch = {
  command: string;
  remainder: string;
};

export function resolveEmojiCommand(text: string): EmojiCommandMatch | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) {
    return null;
  }
  const map = loadEmojiBindings();
  const lower = trimmed.toLowerCase();
  for (const [emoji, command] of map) {
    if (lower.startsWith(emoji)) {
      const remainder = trimmed.slice(emoji.length).trim();
      return { command, remainder };
    }
  }
  return null;
}
