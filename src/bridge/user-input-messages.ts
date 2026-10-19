// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { t } from "../i18n/index.ts";
import type {
  BridgeAdapterState,
  PendingUserInputRequest,
  UserInputRequestQuestion,
} from "./bridge-types.ts";
import { normalizeOutput, truncatePreview } from "../core/text-utils.ts";

function formatUserInputQuestionLabel(
  question: UserInputRequestQuestion,
  index: number,
): string {
  return `${index + 1}. ${question.header} [id: ${question.id}]`;
}

function resolveUserInputQuestion(
  pending: PendingUserInputRequest,
  reference: string,
): UserInputRequestQuestion | null {
  const trimmed = reference.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    return pending.questions[index] ?? null;
  }

  const normalized = trimmed.toLowerCase();
  return (
    pending.questions.find((question) => question.id.toLowerCase() === normalized) ?? null
  );
}

function resolveUserInputOptionLabel(
  question: UserInputRequestQuestion,
  value: string,
): string | null {
  if (!question.options?.length) {
    return null;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    return question.options[index]?.label ?? null;
  }

  const normalized = trimmed.toLowerCase();
  return question.options.find((option) => option.label.toLowerCase() === normalized)?.label ?? null;
}

function parseSingleUserInputAnswer(
  question: UserInputRequestQuestion,
  rawValue: string,
): { answers: string[] } | { error: string } {
  const trimmed = normalizeOutput(rawValue).trim();
  if (!trimmed) {
    return {
      error: t("input.answer.required", { question: question.header }),
    };
  }

  if (!question.options?.length) {
    return {
      answers: [trimmed],
    };
  }

  const customAnswerMode = question.customAnswerMode ?? "note";
  const separatorIndex = customAnswerMode === "note" ? trimmed.indexOf("|") : -1;
  const selection = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex).trim() : trimmed;
  let note = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1).trim() : "";
  const answers: string[] = [];

  if (selection) {
    const selections = question.multiple
      ? selection.split(",").map((value) => value.trim()).filter(Boolean)
      : [selection];
    for (const value of selections) {
      const selectedLabel = resolveUserInputOptionLabel(question, value);
      if (selectedLabel) {
        if (!answers.includes(selectedLabel)) {
          answers.push(selectedLabel);
        }
      } else if (question.isOther && customAnswerMode === "value") {
        if (!answers.includes(value)) {
          answers.push(value);
        }
      } else if (question.isOther) {
        note = note ? `${value}; ${note}` : value;
      } else {
        return {
          error: t("input.answer.optionRequired", { question: question.header }),
        };
      }
    }
  }

  if (note) {
    answers.push(`user_note: ${note}`);
  }

  if (answers.length === 0) {
    return {
      error: t("input.answer.required", { question: question.header }),
    };
  }

  return {
    answers,
  };
}

export function parsePendingUserInputAnswerCommand(
  raw: string,
  pending: PendingUserInputRequest,
): { answers: Record<string, string[]>; preview: string } | { error: string } {
  const input = normalizeOutput(raw).trim();
  if (!input) {
    return {
      error: t("input.answer.empty"),
    };
  }

  const answers: Record<string, string[]> = {};

  if (pending.questions.length === 1) {
    const question = pending.questions[0];
    if (!question) {
      return {
        error: t("input.answer.missingQuestion"),
      };
    }
    const parsed = parseSingleUserInputAnswer(question, input);
    if ("error" in parsed) {
      return parsed;
    }
    answers[question.id] = parsed.answers;
  } else {
    const segments = input
      .split(/\s*(?:;|\n)\s*/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      return {
        error: t("input.answer.ordered"),
      };
    }

    for (const segment of segments) {
      const separatorIndex = segment.indexOf("=");
      if (separatorIndex <= 0) {
        return {
          error: `Each answer must use questionId=value. Invalid segment: ${segment}`,
        };
      }

      const reference = segment.slice(0, separatorIndex).trim();
      const rawValue = segment.slice(separatorIndex + 1).trim();
      const question = resolveUserInputQuestion(pending, reference);
      if (!question) {
        return {
          error: t("input.answer.unknownQuestion", { reference }),
        };
      }
      if (answers[question.id]) {
        return {
          error: t("input.answer.duplicate", { question: question.id }),
        };
      }

      const parsed = parseSingleUserInputAnswer(question, rawValue);
      if ("error" in parsed) {
        return parsed;
      }
      answers[question.id] = parsed.answers;
    }

    const missing = pending.questions.filter((question) => !answers[question.id]);
    if (missing.length > 0) {
      return {
        error: t("input.answer.missing", { questions: missing.map((question) => question.id).join(", ") }),
      };
    }
  }

  return {
    answers,
    preview: truncatePreview(
      pending.questions
        .map((question) => `${question.id}=${(answers[question.id] ?? []).join(", ")}`)
        .join("; "),
      180,
    ),
  };
}

export function formatUserInputRequestMessage(
  pending: PendingUserInputRequest,
  adapterState: BridgeAdapterState,
): string {
  const lines = [
    pending.summary,
    `${t("approval.adapter")}: ${adapterState.kind}`,
  ];

  const hasSecretQuestion = pending.questions.some((question) => question.isSecret);
  if (hasSecretQuestion) {
    lines.push(t("input.secretWarning"));
  }

  pending.questions.forEach((question, index) => {
    lines.push("");
    lines.push(formatUserInputQuestionLabel(question, index));
    lines.push(question.question);
    if (question.options?.length) {
      lines.push(t("input.options"));
      question.options.forEach((option, optionIndex) => {
        lines.push(`  ${optionIndex + 1}. ${option.label} - ${truncatePreview(option.description, 160)}`);
        if (option.preview) lines.push(`     ${t("input.preview")}\n${truncatePreview(option.preview, 1500)}`);
      });
    }
    if (question.multiple) {
      lines.push(t("input.multiple"));
    }
    if (question.isOther) {
      lines.push(
        question.customAnswerMode === "value"
          ? t("input.customAnswer")
          : t("input.customNote"),
      );
    }
  });

  lines.push("");
  if (pending.questions.length === 1) {
    const question = pending.questions[0];
    if (!question) {
      return lines.join("\n");
    }
    if (question.options?.length) {
      lines.push(
        question.multiple
          ? t("input.answer.multiple")
          : t("input.answer.single"),
      );
      if (question.isOther && question.customAnswerMode === "value") {
        lines.push(t("input.answer.custom"));
      } else if (question.isOther) {
        lines.push(t("input.answer.note"));
      }
    } else {
      lines.push(t("input.answer.text"));
    }
  } else {
    lines.push(t("input.answer.ordered"));
    lines.push(t("input.answer.numbers"));
    lines.push(t("input.answer.optionValue"));
    lines.push(t("input.answer.multipleValue"));
    if (pending.questions.some((question) => question.customAnswerMode !== "value")) {
      lines.push(t("input.answer.optionNote"));
    }
  }
  lines.push(t("input.answer.stop"));

  return lines.join("\n");
}

export function formatPendingUserInputReminder(
  pending: PendingUserInputRequest,
): string {
  if (pending.questions.length === 1) {
    const question = pending.questions[0];
    if (!question) {
      return t("input.pending.generic");
    }
    return t("input.pending.single", { question: question.header });
  }

  return t("input.pending.multiple", { count: pending.questions.length });
}
