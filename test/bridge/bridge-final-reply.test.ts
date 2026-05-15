import { describe, expect, test } from "bun:test";

import {
  OPENCODE_EMPTY_VISIBLE_REPLY_MESSAGE,
  forwardWechatFinalReply,
} from "../../src/bridge/bridge-final-reply.ts";

describe("forwardWechatFinalReply", () => {
  test("sends stripped text before attachments in listed order", async () => {
    const calls: string[] = [];

    await forwardWechatFinalReply({
      adapter: "codex",
      rawText: [
        "Artifacts are ready.",
        "```wechat-attachments",
        "image C:\\Users\\unlin\\Desktop\\photo.jpg",
        "file C:\\Users\\unlin\\Desktop\\report.pdf",
        "```",
      ].join("\n"),
      sender: {
        sendText: async (text) => {
          calls.push(`text:${text}`);
        },
        sendImage: async (imagePath) => {
          calls.push(`image:${imagePath}`);
        },
        sendFile: async (filePath) => {
          calls.push(`file:${filePath}`);
        },
        sendVoice: async (voicePath) => {
          calls.push(`voice:${voicePath}`);
        },
        sendVideo: async (videoPath) => {
          calls.push(`video:${videoPath}`);
        },
      },
    });

    expect(calls).toEqual([
      "text:Artifacts are ready.",
      "image:C:\\Users\\unlin\\Desktop\\photo.jpg",
      "file:C:\\Users\\unlin\\Desktop\\report.pdf",
    ]);
  });

  test("continues after attachment failures and reports the error in text", async () => {
    const calls: string[] = [];

    await forwardWechatFinalReply({
      adapter: "claude",
      rawText: [
        "```wechat-attachments",
        "image C:\\Users\\unlin\\Desktop\\broken.jpg",
        "file C:\\Users\\unlin\\Desktop\\report.pdf",
        "```",
      ].join("\n"),
      sender: {
        sendText: async (text) => {
          calls.push(`text:${text}`);
        },
        sendImage: async () => {
          throw new Error("upload failed");
        },
        sendFile: async (filePath) => {
          calls.push(`file:${filePath}`);
        },
        sendVoice: async (voicePath) => {
          calls.push(`voice:${voicePath}`);
        },
        sendVideo: async (videoPath) => {
          calls.push(`video:${videoPath}`);
        },
      },
    });

    expect(calls).toEqual([
      "text:Failed to send image attachment: C:\\Users\\unlin\\Desktop\\broken.jpg\nupload failed",
      "file:C:\\Users\\unlin\\Desktop\\report.pdf",
    ]);
  });

  test("auto-sends inline local text files as file attachments", async () => {
    const calls: string[] = [];

    await forwardWechatFinalReply({
      adapter: "codex",
      rawText: [
        "Saved note to `C:\\Users\\unlin\\Desktop\\exports\\summary.txt`.",
        "Review it.",
      ].join("\n"),
      sender: {
        sendText: async (text) => {
          calls.push(`text:${text}`);
        },
        sendImage: async (imagePath) => {
          calls.push(`image:${imagePath}`);
        },
        sendFile: async (filePath) => {
          calls.push(`file:${filePath}`);
        },
        sendVoice: async (voicePath) => {
          calls.push(`voice:${voicePath}`);
        },
        sendVideo: async (videoPath) => {
          calls.push(`video:${videoPath}`);
        },
      },
    });

    expect(calls).toEqual([
      "text:Saved note to .\nReview it.",
      "file:C:\\Users\\unlin\\Desktop\\exports\\summary.txt",
    ]);
  });

  test("keeps source code paths in text instead of auto-sending them as files", async () => {
    const calls: string[] = [];

    await forwardWechatFinalReply({
      adapter: "codex",
      rawText: [
        "Reference only:",
        "`C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel\\src\\bridge\\bridge-adapters.test.ts`",
        "Do not upload this file.",
      ].join("\n"),
      sender: {
        sendText: async (text) => {
          calls.push(`text:${text}`);
        },
        sendImage: async (imagePath) => {
          calls.push(`image:${imagePath}`);
        },
        sendFile: async (filePath) => {
          calls.push(`file:${filePath}`);
        },
        sendVoice: async (voicePath) => {
          calls.push(`voice:${voicePath}`);
        },
        sendVideo: async (videoPath) => {
          calls.push(`video:${videoPath}`);
        },
      },
    });

    expect(calls).toEqual([
      "text:Reference only:\n`C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel\\src\\bridge\\bridge-adapters.test.ts`\nDo not upload this file.",
    ]);
  });

  test("keeps OpenCode answers when inline reasoning shares the same line", async () => {
    const calls: string[] = [];

    await forwardWechatFinalReply({
      adapter: "opencode",
      rawText: "hiThe user is just saying hi. I should respond briefly.Hello! How can I help?",
      sender: {
        sendText: async (text) => {
          calls.push(`text:${text}`);
        },
        sendImage: async (imagePath) => {
          calls.push(`image:${imagePath}`);
        },
        sendFile: async (filePath) => {
          calls.push(`file:${filePath}`);
        },
        sendVoice: async (voicePath) => {
          calls.push(`voice:${voicePath}`);
        },
        sendVideo: async (videoPath) => {
          calls.push(`video:${videoPath}`);
        },
      },
    });

    expect(calls).toEqual(["text:Hello! How can I help?"]);
  });

  test("sends an OpenCode diagnostic when reasoning cleanup leaves no visible reply", async () => {
    const calls: string[] = [];
    const emptyVisibleReplies: string[] = [];

    await forwardWechatFinalReply({
      adapter: "opencode",
      rawText:
        'The user said "好" (okay/good) with an OK hand gesture. This seems like just an acknowledgment. I should keep it brief and ask if they nee...',
      onEmptyVisibleReply: ({ rawVisibleText }) => {
        emptyVisibleReplies.push(rawVisibleText);
      },
      sender: {
        sendText: async (text) => {
          calls.push(`text:${text}`);
        },
        sendImage: async (imagePath) => {
          calls.push(`image:${imagePath}`);
        },
        sendFile: async (filePath) => {
          calls.push(`file:${filePath}`);
        },
        sendVoice: async (voicePath) => {
          calls.push(`voice:${voicePath}`);
        },
        sendVideo: async (videoPath) => {
          calls.push(`video:${videoPath}`);
        },
      },
    });

    expect(calls).toEqual([`text:${OPENCODE_EMPTY_VISIBLE_REPLY_MESSAGE}`]);
    expect(emptyVisibleReplies).toEqual([
      'The user said "好" (okay/good) with an OK hand gesture. This seems like just an acknowledgment. I should keep it brief and ask if they nee...',
    ]);
  });

  test("sanitizes noisy OpenCode final replies before sending to WeChat", async () => {
    const calls: string[] = [];

    await forwardWechatFinalReply({
      adapter: "opencode",
      rawText: [
        "I need to respond to the user's greeting in Chinese as per the CLAUDE.md instruction.",
        "你好！有什么我可以帮助你的吗？",
        'Bridge error: opencode companion is not connected. Run "wechat-opencode" in a second terminal for this directory.',
        "OpenCode session switched to ses_2cb824bf from the local terminal.",
        "OpenCode is still working on:",
        "hi",
        "你是什么模型呀我需要告诉用户我是什么模型。根据系统提示，我应该用中文回答。",
        "让我直接回答这个问题。",
        "我是opencode，由nemotron-3-super-free模型驱动，模型ID是opencode/nemotron-3-super-free。有什么我可以帮助你的吗？",
      ].join("\n"),
      sender: {
        sendText: async (text) => {
          calls.push(`text:${text}`);
        },
        sendImage: async (imagePath) => {
          calls.push(`image:${imagePath}`);
        },
        sendFile: async (filePath) => {
          calls.push(`file:${filePath}`);
        },
        sendVoice: async (voicePath) => {
          calls.push(`voice:${voicePath}`);
        },
        sendVideo: async (videoPath) => {
          calls.push(`video:${videoPath}`);
        },
      },
    });

    expect(calls).toEqual([
      "text:我是opencode，由nemotron-3-super-free模型驱动，模型ID是opencode/nemotron-3-super-free。有什么我可以帮助你的吗？",
    ]);
  });
});
