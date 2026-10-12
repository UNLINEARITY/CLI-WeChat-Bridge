// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "bun:test";

import { createOpenCodeV2CompatClient } from "../../src/bridge/opencode-v2-compat.ts";

test("OpenCode 2 submits option values instead of displayed labels through the real SDK", async () => {
  const fields = [
    { key: "mode", type: "string", options: [{ label: "Safe mode", value: "safe" }] },
    {
      key: "targets", type: "multiselect", custom: true,
      options: [{ label: "Command line", value: "cli" }, { label: "Documentation", value: "docs" }],
    },
    { key: "note", type: "string" },
    { key: "confirm", type: "boolean" },
    { key: "count", type: "integer" },
  ];
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === "/api/event") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({
        type: "form.created",
        location: { directory: process.cwd() },
        data: { form: { id: "frm_choice", sessionID: "ses_choice", title: "Choose", fields } },
      })}\n\n`);
      return;
    }
    if (request.method === "POST" && request.url === "/api/session/ses_choice/form/frm_choice/reply") {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      requests.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const client = await createOpenCodeV2CompatClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      directory: process.cwd(),
      headers: {},
    }) as unknown as {
      event: { subscribe(): Promise<{ stream: AsyncIterable<{ properties?: unknown }> }> };
      question: { reply(input: Record<string, unknown>): Promise<{ error?: unknown }> };
    };
    const { stream } = await client.event.subscribe();
    const questions: unknown[] = [];
    for await (const event of stream) questions.push(event.properties);
    expect(questions).toEqual([expect.objectContaining({
      requestID: "frm_choice",
      questions: expect.arrayContaining([
        expect.objectContaining({ id: "mode", options: [{ label: "Safe mode", description: "" }] }),
      ]),
    })]);

    const result = await client.question.reply({
      requestID: "frm_choice",
      answers: [["Safe mode"], ["Command line", "Documentation", "custom-target"], ["free text"], ["Yes"], ["3"]],
    });
    expect(result.error).toBeUndefined();
    expect(requests).toEqual([{
      path: "/api/session/ses_choice/form/frm_choice/reply",
      body: { answer: { mode: "safe", targets: ["cli", "docs", "custom-target"], note: "free text", confirm: true, count: 3 } },
    }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
