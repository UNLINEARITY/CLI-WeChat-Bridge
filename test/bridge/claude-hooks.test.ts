import { describe, expect, test } from "bun:test";

import {
  buildClaudeFailureMessage,
  buildClaudeHookScript,
  buildClaudeHookSettings,
  buildClaudePermissionDecisionHookOutput,
  buildClaudePermissionApprovalRequest,
  CLAUDE_WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE,
  extractClaudeAssistantMessageText,
  extractClaudeResumeConversationId,
  extractClaudeTranscriptFinalReply,
  findInjectedClaudePromptIndex,
  getClaudePermissionAutoResponse,
  getClaudeWechatOutboundAttachmentDenyMessage,
  normalizeClaudeAssistantMessage,
  parseClaudeHookPayload,
} from "../../src/bridge/claude-hooks.ts";

describe("parseClaudeHookPayload", () => {
  test("parses JSON hook payloads", () => {
    expect(
      parseClaudeHookPayload(
        JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "session-123",
        }),
      ),
    ).toEqual({
      hook_event_name: "SessionStart",
      session_id: "session-123",
    });
  });

  test("returns null for invalid payloads", () => {
    expect(parseClaudeHookPayload("not-json")).toBeNull();
  });
});

describe("buildClaudeHookSettings", () => {
  test("registers the expected hook events", () => {
    const settings = buildClaudeHookSettings('"C:\\hook.cmd"') as {
      hooks: Record<string, unknown>;
    };

    expect(Object.keys(settings.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PermissionRequest",
      "Notification",
      "Stop",
      "StopFailure",
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SubagentStop",
    ]);
  });
});

describe("buildClaudeHookScript", () => {
  test("preserves stdout on Windows so Claude can read remote approval decisions", () => {
    const script = buildClaudeHookScript({
      platform: "win32",
      runtimeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      hookEntryPath: "C:\\repo\\src\\bridge\\claude-hook.ts",
      hookPort: 43123,
      hookToken: "token-123",
    });

    expect(script).toContain('set "CLAUDE_WECHAT_HOOK_PORT=43123"');
    expect(script).toContain('set "CLAUDE_WECHAT_HOOK_TOKEN=token-123"');
    expect(script).toContain('2>nul');
    expect(script).not.toContain('>nul 2>nul');
  });

  test("preserves stdout on POSIX so Claude can read remote approval decisions", () => {
    const script = buildClaudeHookScript({
      platform: "linux",
      runtimeExecPath: "/usr/local/bin/node",
      hookEntryPath: "/repo/src/bridge/claude-hook.ts",
      hookPort: 43123,
      hookToken: "token-123",
    });

    expect(script).toContain("export CLAUDE_WECHAT_HOOK_PORT='43123'");
    expect(script).toContain("export CLAUDE_WECHAT_HOOK_TOKEN='token-123'");
    expect(script).toContain("2>/dev/null || true");
    expect(script).not.toContain(">/dev/null 2>&1");
  });

  test("runs compiled hook entries without TypeScript stripping", () => {
    const script = buildClaudeHookScript({
      platform: "linux",
      runtimeExecPath: "/usr/local/bin/node",
      hookEntryPath: "/repo/dist/bridge/claude-hook.js",
      hookPort: 43123,
      hookToken: "token-123",
    });

    expect(script).toContain("/repo/dist/bridge/claude-hook.js");
    expect(script).not.toContain("--experimental-strip-types");
  });
});

describe("buildClaudePermissionApprovalRequest", () => {
  test("formats Bash permission requests", () => {
    expect(
      buildClaudePermissionApprovalRequest({
        tool_name: "Bash",
        tool_input: {
          command: "npm test",
        },
      }),
    ).toMatchObject({
      source: "cli",
      summary: "Claude permission is required for Bash.",
      commandPreview: "Bash: npm test",
      toolName: "Bash",
      detailLabel: "command",
      detailPreview: "npm test",
    });
  });

  test("summarizes ExitPlanMode plans instead of dumping raw JSON", () => {
    expect(
      buildClaudePermissionApprovalRequest({
        tool_name: "ExitPlanMode",
        tool_input: {
          plan: "# 示例任务：创建项目初始化脚本\n\n创建一个 Python 项目初始化脚本，用于快速设置新项目的基础结构。\n\n## 实现方案\n1. 创建主脚本",
        },
      }),
    ).toMatchObject({
      source: "cli",
      summary: "Claude permission is required for ExitPlanMode.",
      toolName: "ExitPlanMode",
      detailLabel: "plan",
      detailPreview:
        "示例任务：创建项目初始化脚本 - 创建一个 Python 项目初始化脚本，用于快速设置新项目的基础结构。",
      commandPreview:
        "ExitPlanMode: 示例任务：创建项目初始化脚本 - 创建一个 Python 项目初始化脚本，用于快速设置新项目的基础结构。",
    });
  });
});

describe("buildClaudePermissionDecisionHookOutput", () => {
  test("builds an allow decision for remote confirmation", () => {
    expect(JSON.parse(buildClaudePermissionDecisionHookOutput("confirm"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
        },
      },
    });
  });

  test("builds a deny decision for remote rejection", () => {
    expect(JSON.parse(buildClaudePermissionDecisionHookOutput("deny"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: "Permission denied from WeChat bridge.",
          interrupt: false,
        },
      },
    });
  });

  test("uses a custom deny message when provided", () => {
    expect(JSON.parse(buildClaudePermissionDecisionHookOutput("deny", "Use the source path."))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: "Use the source path.",
          interrupt: false,
        },
      },
    });
  });
});

describe("getClaudeWechatOutboundAttachmentDenyMessage", () => {
  test("denies file mutation tools targeting legacy WeChat outbound directories", () => {
    expect(
      getClaudeWechatOutboundAttachmentDenyMessage({
        tool_name: "Write",
        tool_input: {
          file_path:
            "C:\\Users\\unlin\\.claude\\channels\\wechat\\outbound-attachments\\2026-05-22\\report.docx",
        },
      }),
    ).toBe(CLAUDE_WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE);
  });

  test("denies write-like Bash commands targeting outbound directories", () => {
    expect(
      getClaudeWechatOutboundAttachmentDenyMessage({
        tool_name: "Bash",
        tool_input: {
          command:
            'cp "C:/Users/unlin/Desktop/report.docx" "C:/Users/unlin/.cli-bridge/outbound-attachments/2026-05-22/report.docx"',
        },
      }),
    ).toBe(CLAUDE_WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE);
  });

  test("allows source file references and non-mutating commands", () => {
    expect(
      getClaudeWechatOutboundAttachmentDenyMessage({
        tool_name: "Write",
        tool_input: {
          file_path: "C:\\Users\\unlin\\Desktop\\report.docx",
        },
      }),
    ).toBeNull();
    expect(
      getClaudeWechatOutboundAttachmentDenyMessage({
        tool_name: "Bash",
        tool_input: {
          command:
            'ls "C:/Users/unlin/.cli-bridge/outbound-attachments/2026-05-22"',
        },
      }),
    ).toBeNull();
  });
});

describe("getClaudePermissionAutoResponse", () => {
  test("auto-approves low-risk Claude Bash searches and listings", () => {
    expect(
      getClaudePermissionAutoResponse({
        tool_name: "Bash",
        tool_input: {
          command:
            'find /c/Nonlinear/ob/ -type f -name "*.md" 2>/dev/null | xargs grep -l -i -E "reinforcement|RL" 2>/dev/null | head -10',
        },
      }),
    ).toMatchObject({
      action: "confirm",
    });
    expect(
      getClaudePermissionAutoResponse({
        tool_name: "Bash",
        tool_input: {
          command: "ls -la /c/Nonlinear/ob 2>/dev/null | head -30",
        },
      }),
    ).toMatchObject({
      action: "confirm",
    });
    expect(
      getClaudePermissionAutoResponse({
        tool_name: "Bash",
        tool_input: {
          command:
            "Get-ChildItem -Path C:\\Nonlinear\\ob -Recurse -File -Include *.png,*.jpg | Select-Object -First 20",
        },
      }),
    ).toMatchObject({
      action: "confirm",
    });
  });

  test("auto-approves low-risk Claude read tools", () => {
    expect(
      getClaudePermissionAutoResponse({
        tool_name: "Read",
        tool_input: {
          file_path: "C:\\Nonlinear\\ob\\note.md",
        },
      }),
    ).toEqual({
      action: "confirm",
      reason: "low-risk Read permission",
    });
    expect(
      getClaudePermissionAutoResponse({
        tool_name: "Glob",
        tool_input: {
          pattern: "**/*.md",
        },
      }),
    ).toMatchObject({
      action: "confirm",
    });
  });

  test("keeps high-risk and mutating Claude requests on the approval path", () => {
    expect(
      getClaudePermissionAutoResponse({
        tool_name: "Bash",
        tool_input: {
          command: "rm -rf /tmp/demo",
        },
      }),
    ).toBeNull();
    expect(
      getClaudePermissionAutoResponse({
        tool_name: "Bash",
        tool_input: {
          command: 'find /tmp/demo -type f -delete',
        },
      }),
    ).toBeNull();
    expect(
      getClaudePermissionAutoResponse({
        tool_name: "Write",
        tool_input: {
          file_path: "C:\\tmp\\note.md",
        },
      }),
    ).toMatchObject({ action: "confirm" });
  });
});

describe("extractClaudeResumeConversationId", () => {
  test("extracts the resume conversation id from a transcript path", () => {
    expect(
      extractClaudeResumeConversationId(
        "C:\\Users\\tester\\.claude\\projects\\repo\\3622cdda-de96-4ba3-9982-66f1dd56c676.jsonl",
      ),
    ).toBe("3622cdda-de96-4ba3-9982-66f1dd56c676");
  });

  test("returns null when the transcript path is missing or malformed", () => {
    expect(extractClaudeResumeConversationId(undefined)).toBeNull();
    expect(extractClaudeResumeConversationId("C:\\tmp\\session.txt")).toBeNull();
  });
});

describe("normalizeClaudeAssistantMessage", () => {
  test("normalizes final replies", () => {
    expect(
      normalizeClaudeAssistantMessage({
        last_assistant_message: "Done.\r\n\r\nSummary",
      }),
    ).toBe("Done.\n\nSummary");
  });

  test("returns the placeholder when the hook omits the final reply", () => {
    expect(normalizeClaudeAssistantMessage({})).toBe("(no final reply)");
  });
});

describe("extractClaudeAssistantMessageText", () => {
  test("returns an empty string when the hook omits the final reply", () => {
    expect(extractClaudeAssistantMessageText({})).toBe("");
  });
});

describe("extractClaudeTranscriptFinalReply", () => {
  test("extracts the last end-turn assistant text from a Claude transcript", () => {
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Inspecting files" }],
          stop_reason: null,
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }],
          stop_reason: "tool_use",
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Recovered.\r\n\r\nSummary" }],
          stop_reason: "end_turn",
        },
      }),
      JSON.stringify({
        type: "last-prompt",
        lastPrompt: "hello",
      }),
    ].join("\n");

    expect(extractClaudeTranscriptFinalReply(transcript)).toBe("Recovered.\n\nSummary");
  });
});

describe("buildClaudeFailureMessage", () => {
  test("prefers rendered error text when present", () => {
    expect(
      buildClaudeFailureMessage({
        last_assistant_message: "API Error: Rate limit reached",
        error_details: "429 Too Many Requests",
      }),
    ).toContain("API Error: Rate limit reached");
  });
});

describe("findInjectedClaudePromptIndex", () => {
  test("matches recent injected prompts", () => {
    const now = Date.now();
    expect(
      findInjectedClaudePromptIndex(
        "Review the README",
        [{ normalizedText: "Review the README", createdAtMs: now - 1000 }],
        now,
      ),
    ).toBe(0);
  });

  test("ignores stale prompts", () => {
    const now = Date.now();
    expect(
      findInjectedClaudePromptIndex(
        "Review the README",
        [{ normalizedText: "Review the README", createdAtMs: now - 20_000 }],
        now,
      ),
    ).toBe(-1);
  });
});
