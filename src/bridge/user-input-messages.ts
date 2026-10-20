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

/** Separators between multi-select choices: commas (both widths) and 、. */
const CHOICE_SEPARATOR = /[,，、]/;
/** An option number followed by a note: `2 not yet`, `2 | not yet`, `1 3：later`. */
const OPTION_WITH_NOTE = /^(\d+(?:\s*[,，、\s]\s*\d+)*)(?:\s*[|｜:：]\s*|\s+)(\D[\s\S]*)$/;

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

/** An option number or exact label (case-insensitive) to its label. */
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

/** The options a reply selects, or null when it is not purely a selection. */
function resolveSelections(question: UserInputRequestQuestion, text: string): string[] | null {
  const whole = resolveUserInputOptionLabel(question, text);
  if (whole) return [whole];
  if (!question.multiple) return null;
  // Labels may contain spaces, so try comma-like separators before spaces.
  for (const separator of [CHOICE_SEPARATOR, /[,，、\s]+/]) {
    const tokens = text.split(separator).map((token) => token.trim()).filter(Boolean);
    const labels = tokens.map((token) => resolveUserInputOptionLabel(question, token));
    if (tokens.length > 1 && labels.every((label): label is string => label !== null)) {
      return Array.from(new Set(labels));
    }
  }
  return null;
}

/**
 * Answer one question. Option numbers or exact labels select options (several,
 * separated by commas, 、 or spaces, for multi-select); numbers followed by
 * text select those options and add the text as a note; any other text is the
 * operator's own answer when the question allows one.
 */
export function parseUserInputQuestionAnswer(
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

  const selections = resolveSelections(question, trimmed);
  if (selections) {
    return { answers: selections };
  }

  // "note" mode (Codex) carries extra text as a separate user_note answer;
  // "value" mode (Claude, OpenCode) takes the text as the answer itself.
  const noteMode = (question.customAnswerMode ?? "note") === "note";
  const withNote = OPTION_WITH_NOTE.exec(trimmed);
  const noted = withNote ? resolveSelections(question, withNote[1]!) : null;
  if (withNote && noted && (question.multiple || noted.length === 1)) {
    const note = withNote[2]!.trim();
    if (noteMode) return { answers: [...noted, `user_note: ${note}`] };
    if (!question.isOther) {
      return { error: t("input.answer.noteNotAllowed", { question: question.header }) };
    }
    return { answers: question.multiple ? [...noted, note] : [`${noted[0]} (${note})`] };
  }

  if (!question.isOther) {
    return {
      error: t("input.answer.optionRequired", { question: question.header }),
    };
  }

  // A comma-separated multi-select may mix options with the operator's own values.
  if (question.multiple && CHOICE_SEPARATOR.test(trimmed)) {
    const tokens = trimmed.split(CHOICE_SEPARATOR).map((token) => token.trim()).filter(Boolean);
    const labels = tokens.map((token) => resolveUserInputOptionLabel(question, token));
    if (labels.some((label) => label !== null)) {
      const chosen = Array.from(new Set(labels.filter((label): label is string => label !== null)));
      const own = tokens.filter((_, index) => labels[index] === null);
      return { answers: noteMode ? [...chosen, `user_note: ${own.join("; ")}`] : [...chosen, ...own] };
    }
  }
  return { answers: [noteMode ? `user_note: ${trimmed}` : trimmed] };
}

/** True when a reply uses the keyed `q1=value; q2=value` form for every segment. */
export function isKeyedUserInputAnswer(raw: string, pending: PendingUserInputRequest): boolean {
  const segments = normalizeOutput(raw).trim().split(/\s*(?:;|\n)\s*/).filter(Boolean);
  return segments.length > 0 && segments.every((segment) => {
    const separatorIndex = segment.indexOf("=");
    return separatorIndex > 0 && resolveUserInputQuestion(pending, segment.slice(0, separatorIndex)) !== null;
  });
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
    const parsed = parseUserInputQuestionAnswer(question, input);
    if ("error" in parsed) {
      return parsed;
    }
    answers[question.id] = parsed.answers;
  } else {
    if (!isKeyedUserInputAnswer(input, pending)) {
      return {
        error: t("input.answer.ordered"),
      };
    }

    for (const segment of input.split(/\s*(?:;|\n)\s*/).filter(Boolean)) {
      const separatorIndex = segment.indexOf("=");
      const reference = segment.slice(0, separatorIndex).trim();
      const question = resolveUserInputQuestion(pending, reference)!;
      if (answers[question.id]) {
        return {
          error: t("input.answer.duplicate", { question: question.id }),
        };
      }

      const parsed = parseUserInputQuestionAnswer(question, segment.slice(separatorIndex + 1));
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
    preview: formatUserInputAnswerPreview(pending, answers),
  };
}

export function formatUserInputAnswerPreview(
  pending: PendingUserInputRequest,
  answers: Record<string, string[]>,
): string {
  return truncatePreview(
    pending.questions
      .map((question) => `${question.id}=${(answers[question.id] ?? []).join(", ")}`)
      .join("; "),
    180,
  );
}

function formatQuestionBody(question: UserInputRequestQuestion): string[] {
  const lines = [question.header && question.header !== question.question ? question.header : null, question.question]
    .filter((line): line is string => Boolean(line));
  if (question.options?.length) {
    lines.push(t("input.options"));
    question.options.forEach((option, optionIndex) => {
      lines.push(`  ${optionIndex + 1}. ${option.label}${option.description ? ` - ${truncatePreview(option.description, 160)}` : ""}`);
      if (option.preview) lines.push(`     ${t("input.preview")}\n${truncatePreview(option.preview, 1500)}`);
    });
    lines.push("");
    lines.push(t(question.multiple ? "input.answer.multiple" : "input.answer.single"));
    if (question.isOther) lines.push(t("input.answer.custom"));
    if (question.isOther || (question.customAnswerMode ?? "note") === "note") lines.push(t("input.answer.note"));
  } else {
    lines.push("");
    lines.push(t("input.answer.text"));
  }
  return lines;
}

/**
 * One question of a request, numbered when the request has several; the
 * operator answers them one at a time and the bridge submits them together.
 */
export function formatUserInputQuestionMessage(
  pending: PendingUserInputRequest,
  index: number,
  adapterState: BridgeAdapterState,
): string {
  const question = pending.questions[index];
  if (!question) return t("input.answer.missingQuestion");
  const lines = [
    pending.summary,
    `${t("approval.adapter")}: ${adapterState.kind}`,
  ];
  if (question.isSecret) {
    lines.push(t("input.secretWarning"));
  }
  lines.push("");
  if (pending.questions.length > 1) {
    lines.push(t("input.step", { current: index + 1, count: pending.questions.length }));
  }
  lines.push(...formatQuestionBody(question));
  lines.push(t("input.answer.stop"));
  return lines.join("\n");
}

export function formatUserInputRequestMessage(
  pending: PendingUserInputRequest,
  adapterState: BridgeAdapterState,
): string {
  return formatUserInputQuestionMessage(pending, 0, adapterState);
}

export function formatPendingUserInputReminder(
  pending: PendingUserInputRequest,
  index = 0,
): string {
  const question = pending.questions[index];
  if (!question) {
    return t("input.pending.generic");
  }
  if (pending.questions.length === 1) {
    return t("input.pending.single", { question: question.header });
  }
  return t("input.pending.step", { current: index + 1, count: pending.questions.length, question: question.header });
}
