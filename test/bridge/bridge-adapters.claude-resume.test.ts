import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildClaudeProjectSessionDirectory,
  ClaudeCompanionAdapter,
  listClaudeResumeSessions,
} from "../../src/bridge/bridge-adapters.claude.ts";
import type { BridgeEvent } from "../../src/bridge/bridge-types.ts";

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claude-resume-test-"));
  tempDirectories.push(directory);
  return directory;
}

function writeSession(
  projectDir: string,
  sessionId: string,
  entries: Array<Record<string, unknown>>,
): string {
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  return filePath;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Claude resume test state.");
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("Claude resume session discovery", () => {
  test("uses bounded JSONL metadata and Claude title priority", () => {
    const configDir = makeTempDirectory();
    const cwd = path.join(configDir, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const projectDir = buildClaudeProjectSessionDirectory(cwd, env);
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const filler = "x".repeat(140_000);
    writeSession(projectDir, sessionId, [
      {
        type: "user",
        sessionId,
        cwd,
        isSidechain: false,
        timestamp: "2026-08-20T08:00:00.000Z",
        message: { role: "user", content: "First prompt" },
      },
      { type: "attachment", sessionId, cwd, isSidechain: false, attachment: filler },
      { type: "last-prompt", sessionId, lastPrompt: "Latest prompt" },
      { type: "ai-title", sessionId, aiTitle: "Generated title" },
      { type: "custom-title", sessionId, customTitle: "User title" },
      {
        type: "assistant",
        sessionId,
        timestamp: "2026-08-21T09:30:00.000Z",
        message: { role: "assistant", content: "Done" },
      },
    ]);

    expect(listClaudeResumeSessions(cwd, 8, env)).toEqual([
      {
        sessionId,
        title: "User title",
        lastUpdatedAt: "2026-08-21T09:30:00.000Z",
        source: "claude",
      },
    ]);
  });

  test("uses sessions-index metadata and excludes foreign or sidechain sessions", () => {
    const configDir = makeTempDirectory();
    const cwd = path.join(configDir, "workspace");
    const foreignCwd = path.join(configDir, "foreign");
    fs.mkdirSync(cwd, { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const projectDir = buildClaudeProjectSessionDirectory(cwd, env);
    fs.mkdirSync(projectDir, { recursive: true });
    const validId = "22222222-2222-4222-8222-222222222222";
    const sidechainId = "33333333-3333-4333-8333-333333333333";
    const foreignId = "44444444-4444-4444-8444-444444444444";
    writeSession(projectDir, validId, [
      { type: "mode", sessionId: validId },
    ]);
    writeSession(projectDir, sidechainId, [
      { type: "user", sessionId: sidechainId, cwd, isSidechain: true },
    ]);
    writeSession(projectDir, foreignId, [
      { type: "user", sessionId: foreignId, cwd: foreignCwd, isSidechain: false },
    ]);
    fs.writeFileSync(
      path.join(projectDir, "sessions-index.json"),
      `${JSON.stringify({
        version: 1,
        originalPath: cwd,
        entries: [
          {
            sessionId: validId,
            fullPath: path.join(projectDir, `${validId}.jsonl`),
            firstPrompt: "Indexed prompt",
            modified: "2026-08-22T10:00:00.000Z",
            projectPath: cwd,
            isSidechain: false,
          },
          {
            sessionId: sidechainId,
            projectPath: cwd,
            isSidechain: true,
          },
        ],
      })}\n`,
      "utf8",
    );

    expect(listClaudeResumeSessions(cwd, 8, env)).toEqual([
      {
        sessionId: validId,
        title: "Indexed prompt",
        lastUpdatedAt: "2026-08-22T10:00:00.000Z",
        source: "claude",
      },
    ]);
  });

  test("sorts by semantic transcript time instead of a touched file mtime", () => {
    const configDir = makeTempDirectory();
    const cwd = path.join(configDir, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const projectDir = buildClaudeProjectSessionDirectory(cwd, env);
    fs.mkdirSync(projectDir, { recursive: true });
    const newerId = "55555555-5555-4555-8555-555555555555";
    const olderId = "66666666-6666-4666-8666-666666666666";
    writeSession(projectDir, newerId, [
      {
        type: "user",
        sessionId: newerId,
        cwd,
        isSidechain: false,
        timestamp: "2026-08-23T10:00:00.000Z",
        message: { role: "user", content: "Newer" },
      },
    ]);
    const olderPath = writeSession(projectDir, olderId, [
      {
        type: "user",
        sessionId: olderId,
        cwd,
        isSidechain: false,
        timestamp: "2026-08-22T10:00:00.000Z",
        message: { role: "user", content: "Older" },
      },
    ]);
    fs.utimesSync(olderPath, new Date(), new Date());

    expect(listClaudeResumeSessions(cwd, 8, env).map((item) => item.sessionId)).toEqual([
      newerId,
      olderId,
    ]);
  });
});

describe("Claude resume session switching", () => {
  test("injects an exact /resume command and waits for matching hooks", async () => {
    const configDir = makeTempDirectory();
    const cwd = path.join(configDir, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    const targetId = "77777777-7777-4777-8777-777777777777";
    const targetPath = path.join(configDir, `${targetId}.jsonl`);
    fs.writeFileSync(targetPath, "", "utf8");

    const adapter = new ClaudeCompanionAdapter({
      kind: "claude",
      command: "claude",
      cwd,
      renderMode: "companion",
      initialSharedSessionId: "runtime-old",
      initialResumeConversationId: "88888888-8888-4888-8888-888888888888",
    });
    const writes: string[] = [];
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));
    const internal = adapter as unknown as {
      pty: { write(value: string): void };
      state: { status: string };
      pendingResume: unknown;
      isClaudeSessionActiveElsewhere(sessionId: string): boolean;
      resolveClaudeResumeSessionFile(sessionId: string): string | null;
      handleClaudeSessionEnd(payload: { reason?: string }): void;
      handleClaudeSessionStart(payload: {
        session_id?: string;
        source?: string;
        transcript_path?: string;
      }): void;
    };
    internal.pty = { write: (value) => writes.push(value) };
    internal.state.status = "idle";
    internal.isClaudeSessionActiveElsewhere = () => false;
    internal.resolveClaudeResumeSessionFile = () => targetPath;

    const resumePromise = adapter.resumeSession(targetId);
    await waitFor(() => internal.pendingResume !== null);
    internal.handleClaudeSessionEnd({ reason: "resume" });
    internal.handleClaudeSessionStart({
      session_id: targetId,
      source: "resume",
      transcript_path: targetPath,
    });
    await resumePromise;

    expect(writes.join("")).toBe(`/resume ${targetId}\r`);
    expect(adapter.getState()).toEqual(
      expect.objectContaining({
        status: "idle",
        sharedSessionId: targetId,
        resumeConversationId: targetId,
        transcriptPath: targetPath,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session_switched",
        sessionId: targetId,
        source: "wechat",
        reason: "wechat_resume",
      }),
    );
  });

  test("interrupts a WeChat turn and follows an interactive local resume", () => {
    const cwd = makeTempDirectory();
    const adapter = new ClaudeCompanionAdapter({
      kind: "claude",
      command: "claude",
      cwd,
      renderMode: "companion",
      initialSharedSessionId: "runtime-old",
      initialResumeConversationId: "99999999-9999-4999-8999-999999999999",
    });
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));
    const targetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const targetPath = path.join(cwd, `${targetId}.jsonl`);
    fs.writeFileSync(targetPath, "", "utf8");
    const internal = adapter as unknown as {
      state: {
        status: string;
        activeTurnOrigin?: string;
      };
      hasAcceptedInput: boolean;
      currentPreview: string;
      handleClaudeSessionEnd(payload: { reason?: string }): void;
      handleClaudeSessionStart(payload: {
        session_id?: string;
        source?: string;
        transcript_path?: string;
      }): void;
      handleClaudeStop(payload: {
        session_id?: string;
        last_assistant_message?: string;
      }): void;
    };
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.hasAcceptedInput = true;
    internal.currentPreview = "Old WeChat request";

    internal.handleClaudeSessionEnd({ reason: "resume" });
    internal.handleClaudeSessionStart({
      session_id: targetId,
      source: "resume",
      transcript_path: targetPath,
    });
    internal.handleClaudeStop({
      session_id: "runtime-old",
      last_assistant_message: "Late old answer",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task_failed",
        message: expect.stringContaining("local Claude terminal switched sessions"),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session_switched",
        sessionId: targetId,
        source: "local",
        reason: "local_follow",
      }),
    );
    expect(
      events.filter(
        (event) => event.type === "final_reply" && event.text === "Late old answer",
      ),
    ).toHaveLength(0);
  });
});
