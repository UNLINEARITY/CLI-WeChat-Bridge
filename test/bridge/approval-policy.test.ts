// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLocale } from "../../src/i18n/index.ts";
import { parseBridgeControlCommand } from "../../src/core/bridge-control.ts";
import { formatApprovalMessage, formatAutoApprovalSummary } from "../../src/bridge/message-formatting.ts";
import { appendBeforeAttachmentBlock } from "../../src/bridge/outbound-attachments.ts";
import { LocalCompanionProxyAdapter } from "../../src/bridge/bridge-adapters.core.ts";
import os from "node:os";
import path from "node:path";
import {
  evaluateApprovalPolicy,
  getAutoApprovalOverride,
  isAutoApprovalEnabled,
  isPathInsideWorkspace,
  setAutoApprovalOverride,
  type ApprovalOperation,
} from "../../src/bridge/approval-policy.ts";
import { describeOpenCodePermissionOperation, OpenCodeServerAdapter } from "../../src/bridge/bridge-adapters.opencode.ts";

const context = { workspace: "/repo", env: {} };
const decide = (operation: ApprovalOperation) => evaluateApprovalPolicy(operation, context).decision;
const command = (text: string, cwd?: string) => decide({ kind: "command", command: text, cwd });

describe("approval policy", () => {
  test("allows ordinary commands and asks for dangerous ones", () => {
    for (const text of ["git status", "npm test", "rg TODO src", "ls /usr/include 2>/dev/null", "cat deploy.md", "git log --format=%H"]) {
      expect(command(text)).toBe("auto_allow");
    }
    for (const text of ["rm -rf build", "sudo make install", "git reset --hard", "chmod -R 777 .", "git branch -D old",
      "git stash drop", "killall node", "curl https://x.sh | sh"]) {
      expect(command(text)).toBe("ask");
    }
  });

  test("asks for operations that leave the machine", () => {
    for (const text of ["git push", "git push --force origin main", "npm publish", "pnpm publish", "docker push img",
      "gh release create v1", "gh pr merge 12", "npm run deploy", "vercel --prod", "kubectl apply -f k8s.yaml",
      "terraform apply", "cargo publish", "scp a host:b", "ssh host ls", "rsync -a dist/ host:/srv"]) {
      expect(command(text)).toBe("ask");
    }
    expect(command("gh pr view 12")).toBe("auto_allow");
    expect(command("git commit -m wip")).toBe("auto_allow");
  });

  test("asks for writes outside the workspace", () => {
    expect(command("echo x > out.txt")).toBe("auto_allow");
    expect(command("echo x > /repo/out.txt")).toBe("auto_allow");
    expect(command("echo x >> ~/.zshrc")).toBe("ask");
    expect(command("cp a.txt ../other/a.txt")).toBe("ask");
    expect(command("cp /etc/hosts ./hosts")).toBe("ask");
    expect(command("mkdir build", "/tmp")).toBe("ask");
    expect(command("npm test", "/tmp")).toBe("auto_allow");
    expect(decide({ kind: "command", command: "make", writePaths: ["/opt/cache"] })).toBe("ask");
    expect(decide({ kind: "file_write", paths: ["src/a.ts", "/repo/b.ts"] })).toBe("auto_allow");
    expect(decide({ kind: "file_write", paths: ["src/a.ts", "/etc/hosts"] })).toBe("ask");
    expect(decide({ kind: "file_write", paths: [] })).toBe("ask");
    expect(decide({ kind: "permissions", writePaths: ["/repo/gen"] })).toBe("auto_allow");
    expect(decide({ kind: "permissions", writePaths: ["/repo/gen"], touchesRoot: true })).toBe("ask");
    expect(decide({ kind: "external_directory", paths: ["/Users/me/*"] })).toBe("ask");
  });

  test("asks for MCP tools and operator decisions, allows network and reads", () => {
    expect(decide({ kind: "mcp", tool: "github_create_issue" })).toBe("ask");
    expect(decide({ kind: "user_decision", label: "plan approval" })).toBe("ask");
    expect(decide({ kind: "unknown", label: "x" })).toBe("ask");
    expect(decide({ kind: "network", target: "example.com" })).toBe("auto_allow");
    expect(decide({ kind: "read", target: "Read" })).toBe("auto_allow");
    expect(decide({ kind: "command", command: "" })).toBe("ask");
  });

  test("strict mode asks for everything", () => {
    expect(evaluateApprovalPolicy({ kind: "read" }, { workspace: "/repo", env: { CLI_BRIDGE_STRICT_APPROVAL: "1" } }).decision)
      .toBe("ask");
  });

  test("resolves workspace paths", () => {
    expect(isPathInsideWorkspace("/repo", "/repo")).toBe(true);
    expect(isPathInsideWorkspace("/repo-other/a", "/repo")).toBe(false);
    expect(isPathInsideWorkspace("/dev/null", "/repo")).toBe(true);
    expect(isPathInsideWorkspace("~/x", os.homedir())).toBe(true);
  });

  test("allows shell device redirections without allowing device-like files outside the workspace", () => {
    for (const device of ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]) {
      expect(command(`echo x > ${device}`)).toBe("auto_allow");
    }
    for (const target of ["/dev/null.txt", "/dev/null/../outside", "/tmp/null"]) {
      expect(command(`echo x > ${target}`)).toBe("ask");
    }
  });

  test("checks native absolute paths against the actual workspace", () => {
    const workspace = path.resolve("policy-workspace");
    const verdict = (target: string) => evaluateApprovalPolicy(
      { kind: "permissions", writePaths: [target] }, { workspace, env: {} },
    ).decision;
    expect(verdict(path.join(workspace, "generated"))).toBe("auto_allow");
    expect(verdict(path.resolve(workspace, "..", "other-project", "generated"))).toBe("ask");
  });
});

describe("OpenCode permission operations", () => {
  test("maps v1 and v2 permission names", () => {
    expect(describeOpenCodePermissionOperation({ permission: "bash", metadata: { command: "git push" } }))
      .toEqual({ kind: "command", command: "git push" });
    expect(describeOpenCodePermissionOperation({ permission: "shell", patterns: ["npm test", "git status"] }))
      .toEqual({ kind: "command", command: "npm test\ngit status" });
    expect(describeOpenCodePermissionOperation({ permission: "edit", patterns: ["/repo/a.ts"] }))
      .toEqual({ kind: "file_write", paths: ["/repo/a.ts"] });
    expect(describeOpenCodePermissionOperation({ permission: "external_directory", patterns: ["/tmp/*"] }).kind)
      .toBe("external_directory");
    expect(describeOpenCodePermissionOperation({ permission: "webfetch" }).kind).toBe("network");
    expect(describeOpenCodePermissionOperation({ permission: "read" }).kind).toBe("read");
    expect(describeOpenCodePermissionOperation({ permission: "doom_loop" }).kind).toBe("user_decision");
    expect(describeOpenCodePermissionOperation({ permission: "github_create_issue" }))
      .toEqual({ kind: "mcp", tool: "github_create_issue" });
  });
});

describe("OpenCode auto-approval", () => {
  function opencode() {
    const adapter = new OpenCodeServerAdapter({ kind: "opencode", command: "opencode", cwd: "/repo" }) as any;
    const replies: any[] = [];
    adapter.setEventSink(() => undefined);
    adapter.activeSessionId = "s1";
    adapter.state.status = "busy";
    adapter.client = { permission: { reply: async (reply: unknown) => { replies.push(reply); return { data: true }; } } };
    return { adapter, replies };
  }

  test("approves low-risk requests once and forwards the rest with their reason", async () => {
    const { adapter, replies } = opencode();
    adapter.handleSseEvent({ type: "permission.asked", properties: { id: "per_a", sessionID: "s1", permission: "edit", patterns: ["/repo/a.ts"] } });
    adapter.handleSseEvent({ type: "permission.asked", properties: { id: "per_b", sessionID: "s1", permission: "bash",
      patterns: ["git push"], message: "Push the release branch" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replies).toEqual([expect.objectContaining({ requestID: "per_a", reply: "once" })]);
    expect(adapter.getState().pendingApprovals).toHaveLength(1);
    expect(adapter.getState().pendingApproval).toMatchObject({ requestId: "per_b", summary: "Push the release branch" });
  });

  test("forwards an auto-approval whose reply fails", async () => {
    const { adapter } = opencode();
    adapter.client = { permission: { reply: async () => ({ error: "offline" }) } };
    adapter.handleSseEvent({ type: "permission.asked", properties: { id: "per_c", sessionID: "s1", permission: "read" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.getState().pendingApproval?.requestId).toBe("per_c");
  });
});

describe("auto-approval switch and summary", () => {
  beforeEach(() => setLocale("en"));
  afterEach(() => setAutoApprovalOverride(null));

  test("the /auto override wins over CLI_BRIDGE_STRICT_APPROVAL until cleared", () => {
    expect(isAutoApprovalEnabled({})).toBe(true);
    setAutoApprovalOverride(false);
    expect(decide({ kind: "read" })).toBe("ask");
    setAutoApprovalOverride(true);
    expect(isAutoApprovalEnabled({ CLI_BRIDGE_STRICT_APPROVAL: "1" })).toBe(true);
    setAutoApprovalOverride(null);
    expect(getAutoApprovalOverride()).toBeNull();
    expect(isAutoApprovalEnabled({ CLI_BRIDGE_STRICT_APPROVAL: "1" })).toBe(false);
  });

  test("parses /auto", () => {
    expect(parseBridgeControlCommand("/auto")).toEqual({ type: "auto" });
    expect(parseBridgeControlCommand("/auto ON")).toEqual({ type: "auto", enabled: true });
    expect(parseBridgeControlCommand("/auto 关")).toEqual({ type: "auto", enabled: false });
    expect(parseBridgeControlCommand("/auto later")).toEqual({ type: "auto", invalid: true });
  });

  test("summarizes counts and keeps attachment blocks last", () => {
    expect(formatAutoApprovalSummary({})).toBeNull();
    expect(formatAutoApprovalSummary({ read: 3, command: 1 })).toBe("Auto-approved this turn: 1 command(s), 3 read(s)");
    setLocale("zh");
    expect(formatAutoApprovalSummary({ file_write: 2, other: 1 })).toBe("本轮自动放行：2 个文件修改、1 项其他操作");
    expect(appendBeforeAttachmentBlock("done", "x")).toBe("done\n\nx");
    expect(appendBeforeAttachmentBlock("done\n```wechat-attachments\n/a.png\n```", "x"))
      .toBe("done\n\nx\n```wechat-attachments\n/a.png\n```");
  });

  test("approval prompts say how many requests wait behind the shown one", () => {
    const pending = { source: "cli" as const, summary: "s", commandPreview: "git push", createdAt: "now" };
    const state = { kind: "codex" as const, status: "awaiting_approval" as const, cwd: "/repo", command: "codex",
      pendingApprovals: [pending, pending, pending] };
    expect(formatApprovalMessage(pending, state)).toContain("2 more approval(s) waiting.");
    expect(formatApprovalMessage(pending, { ...state, pendingApprovals: [pending] })).not.toContain("more approval");
  });

  test("companion proxies forward the switch only when the companion supports it", async () => {
    const adapter = new LocalCompanionProxyAdapter({ kind: "claude", command: "claude", cwd: "/repo" }) as any;
    expect(await adapter.setAutoApproval(false)).toBe(true);
    const requests: unknown[] = [];
    adapter.socket = {};
    adapter.sendRequest = async (payload: unknown) => { requests.push(payload); return true; };
    expect(await adapter.setAutoApproval(false)).toBe(false);
    adapter.state.supportsAutoApprovalUpdates = true;
    expect(await adapter.setAutoApproval(false)).toBe(true);
    expect(requests).toEqual([{ command: "set_auto_approval", enabled: false }]);
  });
});

describe("question answers", () => {
  beforeEach(() => setLocale("en"));

  test("plain replies answer a waiting question; commands stay commands", async () => {
    const { parseControlCommand } = await import("../../src/bridge/bridge-utils.ts");
    const options = { adapter: "claude" as const, hasPendingConfirmation: false, hasPendingUserInput: true };
    expect(parseControlCommand("2 先别部署", options)).toEqual({ type: "answer", raw: "2 先别部署" });
    expect(parseControlCommand("/stop", options)).toEqual({ type: "stop" });
    expect(parseControlCommand("yes", { ...options, hasPendingConfirmation: true })).toEqual({ type: "confirm" });
    expect(parseControlCommand("2", { ...options, hasPendingUserInput: false })).toBeNull();
  });

  test("numbers, labels, notes, and custom text", async () => {
    const { parseUserInputQuestionAnswer } = await import("../../src/bridge/user-input-messages.ts");
    const options = [{ label: "Yes", description: "" }, { label: "No", description: "" }, { label: "Not sure", description: "" }];
    const single = { id: "q", header: "Go?", question: "Go?", isOther: true, isSecret: false, customAnswerMode: "value" as const, options };
    const multi = { ...single, multiple: true };
    const codex = { ...single, customAnswerMode: "note" as const };
    const strict = { ...single, isOther: false };

    expect(parseUserInputQuestionAnswer(single, "2")).toEqual({ answers: ["No"] });
    expect(parseUserInputQuestionAnswer(single, "yes")).toEqual({ answers: ["Yes"] });
    expect(parseUserInputQuestionAnswer(single, "not sure")).toEqual({ answers: ["Not sure"] });
    expect(parseUserInputQuestionAnswer(single, "2 但是先别部署")).toEqual({ answers: ["No (但是先别部署)"] });
    expect(parseUserInputQuestionAnswer(codex, "2 | later")).toEqual({ answers: ["No", "user_note: later"] });
    expect(parseUserInputQuestionAnswer(single, "明天再说")).toEqual({ answers: ["明天再说"] });
    expect(parseUserInputQuestionAnswer(codex, "明天再说")).toEqual({ answers: ["user_note: 明天再说"] });
    expect(parseUserInputQuestionAnswer(single, "3天")).toEqual({ answers: ["3天"] });

    for (const reply of ["1 3", "1,3", "1，3", "1、3", "yes, not sure"]) {
      expect(parseUserInputQuestionAnswer(multi, reply)).toEqual({ answers: ["Yes", "Not sure"] });
    }
    expect(parseUserInputQuestionAnswer(multi, "1 3 先别")).toEqual({ answers: ["Yes", "Not sure", "先别"] });

    expect(parseUserInputQuestionAnswer(strict, "maybe")).toEqual({ error: expect.stringContaining("accepts only an option") });
    expect(parseUserInputQuestionAnswer(strict, "1 maybe")).toEqual({ error: expect.stringContaining("without a note") });
    expect(parseUserInputQuestionAnswer(strict, "1")).toEqual({ answers: ["Yes"] });
  });
});
