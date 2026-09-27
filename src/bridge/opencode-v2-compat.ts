// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.

type RecordValue = Record<string, unknown>;
type CompatResult<T> = { data?: T; error?: unknown };

type OpenCodeV2Client = {
  server: { info(): Promise<unknown> };
  agent: { list(input?: unknown, options?: unknown): Promise<unknown> };
  model: { list(input?: unknown, options?: unknown): Promise<unknown> };
  provider: { list(input?: unknown, options?: unknown): Promise<unknown> };
  session: {
    create(input?: unknown, options?: unknown): Promise<unknown>;
    list(input?: unknown, options?: unknown): Promise<unknown>;
    get(input: unknown, options?: unknown): Promise<unknown>;
    switchAgent(input: unknown, options?: unknown): Promise<unknown>;
    switchModel(input: unknown, options?: unknown): Promise<unknown>;
    prompt(input: unknown, options?: unknown): Promise<unknown>;
    interrupt(input: unknown, options?: unknown): Promise<unknown>;
    form: {
      reply(input: unknown, options?: unknown): Promise<unknown>;
      cancel(input: unknown, options?: unknown): Promise<unknown>;
    };
  };
  permission: { reply(input: unknown, options?: unknown): Promise<unknown> };
  event: { subscribe(input?: unknown): AsyncIterable<unknown> };
};

type CompatEvent = {
  type: string;
  properties?: unknown;
  directory?: string;
};

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ok<T>(data: T): CompatResult<T> {
  return { data };
}

async function result<T>(operation: () => Promise<T>): Promise<CompatResult<T>> {
  try {
    return ok(await operation());
  } catch (error) {
    return { error };
  }
}

function location(directory: unknown): { directory: string } | undefined {
  return typeof directory === "string" && directory
    ? { directory }
    : undefined;
}

export function normalizeOpenCodeV2Session(value: unknown): RecordValue {
  const session = isRecord(value) ? value : {};
  const sessionLocation = isRecord(session.location) ? session.location : {};
  const time = isRecord(session.time) ? session.time : {};
  const model = isRecord(session.model) ? session.model : undefined;
  return {
    ...session,
    id: typeof session.id === "string" ? session.id : "",
    directory:
      typeof sessionLocation.directory === "string"
        ? sessionLocation.directory
        : "",
    workspaceID:
      typeof session.projectID === "string" ? session.projectID : undefined,
    parentID:
      typeof session.parentID === "string" ? session.parentID : undefined,
    time: {
      ...time,
      created: typeof time.created === "number" ? time.created : Date.now(),
      updated: typeof time.updated === "number" ? time.updated : Date.now(),
    },
    model: model
      ? {
          ...model,
          id: typeof model.id === "string" ? model.id : "",
          providerID:
            typeof model.providerID === "string" ? model.providerID : "",
          variant: typeof model.variant === "string" ? model.variant : "default",
        }
      : undefined,
  };
}

function sessionFromCreatedEvent(data: RecordValue): RecordValue {
  const eventLocation = isRecord(data.location) ? data.location : {};
  return normalizeOpenCodeV2Session({
    id: data.sessionID,
    projectID: data.projectID,
    parentID: data.parentID,
    title: data.title,
    agent: data.agent,
    model: data.model,
    location: eventLocation,
    time: { created: Date.now(), updated: Date.now() },
  });
}

function textPart(data: RecordValue, text?: string): RecordValue {
  const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
  return {
    id: `${String(data.assistantMessageID ?? "message")}:text:${ordinal}`,
    sessionID: data.sessionID,
    messageID: data.assistantMessageID,
    type: "text",
    ...(text === undefined ? {} : { text }),
  };
}

function normalizeFormQuestions(form: RecordValue): Array<RecordValue> {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  return fields.flatMap((field) => {
    if (!isRecord(field) || typeof field.key !== "string") return [];
    const configuredOptions = Array.isArray(field.options)
      ? field.options.filter(isRecord).map((option) => ({
          label: typeof option.label === "string" ? option.label : String(option.value ?? ""),
          description: typeof option.description === "string" ? option.description : "",
        }))
      : [];
    const options = field.type === "boolean" && configuredOptions.length === 0
      ? [
          { label: "Yes", description: "Answer true." },
          { label: "No", description: "Answer false." },
        ]
      : configuredOptions;
    return [{
      id: field.key,
      header:
        typeof field.title === "string"
          ? field.title
          : typeof form.title === "string"
            ? form.title
            : "OpenCode question",
      question:
        typeof field.description === "string"
          ? field.description
          : typeof field.title === "string"
            ? field.title
            : field.key,
      options,
      multiple: field.type === "multiselect",
      custom: field.custom === true || options.length === 0,
    }];
  });
}

function normalizeFormAnswer(field: RecordValue, values: unknown[]): unknown {
  if (field.type === "multiselect") return values;
  const value = values[0] ?? "";
  if (field.type === "boolean") {
    return /^(1|true|yes|y)$/i.test(String(value));
  }
  if (field.type === "number" || field.type === "integer") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  return value;
}

/** Convert OpenCode 2 events to the stable event vocabulary consumed by the adapter. */
export function normalizeOpenCodeV2Event(value: unknown): CompatEvent[] {
  if (!isRecord(value) || typeof value.type !== "string") return [];
  const data = isRecord(value.data) ? value.data : {};
  const eventLocation = isRecord(value.location) ? value.location : {};
  const directory =
    typeof eventLocation.directory === "string"
      ? eventLocation.directory
      : undefined;

  switch (value.type) {
    case "session.created":
      return [{ type: "session.created", directory, properties: { info: sessionFromCreatedEvent(data) } }];
    case "session.deleted":
      return [{ type: "session.deleted", directory, properties: { sessionID: data.sessionID } }];
    case "session.status":
      return [{ type: "session.status", directory, properties: data }];
    case "session.execution.started":
      return [{ type: "session.status", directory, properties: { sessionID: data.sessionID, status: { type: "busy" } } }];
    case "session.execution.succeeded":
    case "session.execution.interrupted":
      return [{ type: "session.idle", directory, properties: { sessionID: data.sessionID } }];
    case "session.execution.failed":
      return [
        { type: "session.error", directory, properties: { sessionID: data.sessionID, error: data.error } },
        { type: "session.idle", directory, properties: { sessionID: data.sessionID } },
      ];
    case "session.text.started":
      return [{
        type: "message.part.updated",
        directory,
        properties: { part: textPart(data, "") },
      }];
    case "session.text.delta":
      return [{
        type: "message.part.delta",
        directory,
        properties: {
          sessionID: data.sessionID,
          messageID: data.assistantMessageID,
          partID: textPart(data).id,
          field: "text",
          delta: data.delta,
        },
      }];
    case "session.text.ended":
      return [{
        type: "message.part.updated",
        directory,
        properties: { part: textPart(data, typeof data.text === "string" ? data.text : "") },
      }];
    case "session.inbox.enqueued": {
      const item = isRecord(data.item) ? data.item : {};
      const payload = isRecord(item.payload) ? item.payload : {};
      if (item.type !== "user" || typeof payload.text !== "string") return [];
      const messageID = typeof data.inboxID === "string" ? data.inboxID : String(value.id ?? "user");
      return [
        {
          type: "message.updated",
          directory,
          properties: {
            sessionID: data.sessionID,
            info: { id: messageID, sessionID: data.sessionID, role: "user" },
          },
        },
        {
          type: "message.part.updated",
          directory,
          properties: {
            sessionID: data.sessionID,
            part: {
              id: `${messageID}:text:0`,
              sessionID: data.sessionID,
              messageID,
              type: "text",
              text: payload.text,
            },
          },
        },
      ];
    }
    case "permission.asked":
      return [{
        type: "permission.asked",
        directory,
        properties: {
          ...data,
          requestID: data.id,
          permission: data.action,
          patterns: data.resources,
        },
      }];
    case "permission.replied":
      return [{ type: "permission.replied", directory, properties: data }];
    case "form.created": {
      const form = isRecord(data.form) ? data.form : {};
      return [{
        type: "question.asked",
        directory,
        properties: {
          sessionID: form.sessionID,
          id: form.id,
          requestID: form.id,
          questions: normalizeFormQuestions(form),
        },
      }];
    }
    case "form.replied": {
      const form = isRecord(data.form) ? data.form : data;
      return [{
        type: "question.replied",
        directory,
        properties: { sessionID: form.sessionID, requestID: form.id ?? data.formID },
      }];
    }
    case "form.cancelled": {
      const form = isRecord(data.form) ? data.form : data;
      return [{
        type: "question.rejected",
        directory,
        properties: { sessionID: form.sessionID, requestID: form.id ?? data.formID },
      }];
    }
    case "server.connected":
    case "session.idle":
    case "tui.prompt.append":
    case "tui.command.execute":
    case "tui.session.select":
    case "tui.toast.show":
      return [{ type: value.type, directory, properties: data }];
    default:
      return [];
  }
}

function mapProviders(providersValue: unknown, modelsValue: unknown): {
  all: RecordValue[];
  connected: string[];
} {
  const providers = isRecord(providersValue) && Array.isArray(providersValue.data)
    ? providersValue.data.filter(isRecord)
    : [];
  const models = isRecord(modelsValue) && Array.isArray(modelsValue.data)
    ? modelsValue.data.filter(isRecord)
    : [];
  const providerById = new Map<string, RecordValue>();
  for (const provider of providers) {
    if (typeof provider.id === "string") providerById.set(provider.id, provider);
  }
  for (const model of models) {
    if (typeof model.providerID !== "string" || providerById.has(model.providerID)) continue;
    providerById.set(model.providerID, {
      id: model.providerID,
      name: model.providerID,
      activation: "enabled",
    });
  }

  const all: RecordValue[] = Array.from(providerById.values()).map((provider): RecordValue => {
    const providerID = typeof provider.id === "string" ? provider.id : "";
    const providerModels = Object.fromEntries(
      models
        .filter((model) => model.providerID === providerID && typeof model.id === "string")
        .map((model) => {
          const variants = Array.isArray(model.variants)
            ? Object.fromEntries(model.variants.filter(isRecord).flatMap((variant) =>
                typeof variant.id === "string" ? [[variant.id, variant]] : [],
              ))
            : isRecord(model.variants)
              ? model.variants
              : {};
          return [model.id as string, {
            ...model,
            name: typeof model.name === "string" ? model.name : model.id,
            variants,
          }];
        }),
    );
    return { ...provider, models: providerModels };
  });

  return {
    all,
    connected: all
      .filter((provider) => provider.activation !== "disabled" && typeof provider.id === "string")
      .map((provider) => provider.id as string),
  };
}

export async function createOpenCodeV2CompatClient(options: {
  baseUrl: string;
  directory: string;
  headers: Record<string, string>;
}): Promise<RecordValue> {
  const { OpenCode } = await import("@opencode/client");
  const client = OpenCode.make({ baseUrl: options.baseUrl, headers: options.headers }) as unknown as OpenCodeV2Client;
  const formFields = new Map<string, RecordValue[]>();
  const formSessions = new Map<string, string>();
  const permissionSessions = new Map<string, string>();
  const sessionStatuses = new Map<string, "busy" | "idle">();

  const waitForPopulatedList = async (
    load: () => Promise<unknown>,
  ): Promise<unknown> => {
    let response: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      response = await load();
      if (isRecord(response) && Array.isArray(response.data) && response.data.length > 0) {
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return response;
  };

  const listAvailableModels = (requestOptions?: unknown): Promise<unknown> =>
    waitForPopulatedList(() =>
      client.model.list({ location: directoryLocation }, requestOptions),
    );

  async function* subscribe(input?: { signal?: AbortSignal }): AsyncIterable<CompatEvent> {
    for await (const event of client.event.subscribe(input)) {
      if (isRecord(event) && event.type === "form.created" && isRecord(event.data) && isRecord(event.data.form)) {
        const form = event.data.form;
        if (typeof form.id === "string" && Array.isArray(form.fields)) {
          formFields.set(form.id, form.fields.filter(isRecord).filter((field) =>
            typeof field.key === "string",
          ));
          if (typeof form.sessionID === "string") {
            formSessions.set(form.id, form.sessionID);
          }
        }
      }
      if (isRecord(event) && event.type === "permission.asked" && isRecord(event.data)) {
        if (typeof event.data.id === "string" && typeof event.data.sessionID === "string") {
          permissionSessions.set(event.data.id, event.data.sessionID);
        }
      }
      if (isRecord(event) && isRecord(event.data) && typeof event.data.sessionID === "string") {
        if (event.type === "session.execution.started") {
          sessionStatuses.set(event.data.sessionID, "busy");
        } else if (
          event.type === "session.execution.succeeded" ||
          event.type === "session.execution.failed" ||
          event.type === "session.execution.interrupted" ||
          event.type === "session.idle"
        ) {
          sessionStatuses.set(event.data.sessionID, "idle");
        }
      }
      for (const normalized of normalizeOpenCodeV2Event(event)) {
        yield normalized;
      }
    }
  }

  const directoryLocation = location(options.directory);
  return {
    server: client.server,
    app: {
      agents: (_input?: unknown, requestOptions?: unknown) => result(async () => {
        const response = await waitForPopulatedList(() =>
          client.agent.list({ location: directoryLocation }, requestOptions),
        );
        return isRecord(response) && Array.isArray(response.data)
          ? response.data.filter(isRecord).map((agent) => ({
              ...agent,
              name: typeof agent.id === "string" ? agent.id : agent.name,
            }))
          : [];
      }),
    },
    provider: {
      list: (_input?: unknown, requestOptions?: unknown) => result(async () =>
        mapProviders(
          await client.provider.list({ location: directoryLocation }, requestOptions),
          await listAvailableModels(requestOptions),
        ),
      ),
    },
    session: {
      create: (_input?: unknown, requestOptions?: unknown) => result(async () =>
        normalizeOpenCodeV2Session(await client.session.create({ location: directoryLocation }, requestOptions)),
      ),
      list: (_input?: unknown, requestOptions?: unknown) => result(async () => {
        const response = await client.session.list({ directory: options.directory, order: "desc" }, requestOptions);
        return isRecord(response) && Array.isArray(response.data)
          ? response.data.map(normalizeOpenCodeV2Session)
          : [];
      }),
      get: (input: RecordValue, requestOptions?: unknown) => result(async () =>
        normalizeOpenCodeV2Session(await client.session.get({ sessionID: input.sessionID }, requestOptions)),
      ),
      status: (_input?: unknown, requestOptions?: unknown) => result(async () => {
        const response = await client.session.list({ directory: options.directory, order: "desc" }, requestOptions);
        const sessions = isRecord(response) && Array.isArray(response.data) ? response.data.filter(isRecord) : [];
        return Object.fromEntries(sessions.flatMap((session) => {
          if (typeof session.id !== "string") return [];
          return [[session.id, { type: sessionStatuses.get(session.id) ?? "idle" }]];
        }));
      }),
      promptAsync: (input: RecordValue, requestOptions?: unknown) => result(async () => {
        const parts = Array.isArray(input.parts) ? input.parts.filter(isRecord) : [];
        const text = parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
        await client.session.prompt({ sessionID: input.sessionID, text }, requestOptions);
        return {};
      }),
      abort: (input: RecordValue, requestOptions?: unknown) => result(async () =>
        await client.session.interrupt({ sessionID: input.sessionID }, requestOptions),
      ),
    },
    v2: {
      session: {
        switchAgent: (input: RecordValue, requestOptions?: unknown) => result(async () =>
          await client.session.switchAgent(input, requestOptions),
        ),
        switchModel: (input: RecordValue, requestOptions?: unknown) => result(async () =>
          await client.session.switchModel(input, requestOptions),
        ),
      },
    },
    permission: {
      reply: (input: RecordValue, requestOptions?: unknown) => result(async () =>
        await client.permission.reply({
          sessionID: input.sessionID ?? permissionSessions.get(String(input.requestID)),
          requestID: input.requestID,
          decision: input.reply === "reject" ? "reject" : input.reply,
        }, requestOptions).finally(() => permissionSessions.delete(String(input.requestID))),
      ),
    },
    question: {
      reply: (input: RecordValue, requestOptions?: unknown) => result(async () => {
        const answers = Array.isArray(input.answers) ? input.answers : [];
        const fields = formFields.get(String(input.requestID)) ?? [];
        const answer = Object.fromEntries(fields.flatMap((field, index) => {
          if (typeof field.key !== "string") return [];
          const values = Array.isArray(answers[index]) ? answers[index] : [];
          return [[field.key, normalizeFormAnswer(field, values)]];
        }));
        await client.session.form.reply({
          sessionID: input.sessionID ?? formSessions.get(String(input.requestID)),
          formID: input.requestID,
          answer,
        }, requestOptions);
        formFields.delete(String(input.requestID));
        formSessions.delete(String(input.requestID));
        return {};
      }),
      reject: (input: RecordValue, requestOptions?: unknown) => result(async () => {
        await client.session.form.cancel({
          sessionID: input.sessionID ?? formSessions.get(String(input.requestID)),
          formID: input.requestID,
        }, requestOptions);
        formFields.delete(String(input.requestID));
        formSessions.delete(String(input.requestID));
        return {};
      }),
    },
    event: {
      subscribe: async (_input?: unknown, requestOptions?: { signal?: AbortSignal }) => ({
        stream: subscribe(requestOptions),
      }),
    },
    tui: {
      selectSession: async () => ok({}),
    },
  };
}
