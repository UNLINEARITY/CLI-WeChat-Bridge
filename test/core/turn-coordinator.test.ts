import { describe, expect, test } from "bun:test";

import { TurnCoordinator } from "../../src/core/turn-coordinator.ts";

type Task = { id: number };
type Conversation = { conversationId: string };

const conv = (id: string): Conversation => ({ conversationId: id });
const task = (id: number): Task => ({ id });
const fallback = conv("fallback");

function coordinator(initialLast?: Conversation | null) {
  return new TurnCoordinator<Task>(
    initialLast ? { initialLastConversation: initialLast } : {},
  );
}

describe("TurnCoordinator ownership", () => {
  test("begins a turn and reports active state", () => {
    const turns = coordinator();
    expect(turns.hasActiveTask).toBe(false);

    const lease = turns.beginTurn(task(1), conv("a"));
    expect(lease).not.toBeNull();
    expect(turns.hasActiveTask).toBe(true);
    expect(turns.activeTask).toEqual(task(1));
    expect(turns.activeConversation).toEqual(conv("a"));
    expect(turns.lastConversation).toEqual(conv("a"));
  });

  test("rejects a second concurrent turn", () => {
    const turns = coordinator();
    expect(turns.beginTurn(task(1))).not.toBeNull();
    expect(turns.beginTurn(task(2))).toBeNull();
    expect(turns.activeTask).toEqual(task(1));
  });

  test("rollback restores the conversation snapshot from begin time", () => {
    const turns = coordinator();
    turns.beginTurn(task(1), conv("first"));
    turns.complete(); // clears activeConversation to undefined

    const lease = turns.beginTurn(task(2), conv("second"))!;
    const rolledBack = turns.rollback(lease);
    expect(rolledBack).toBe(true);
    expect(turns.activeTask).toBeNull();
    // complete() already cleared the active conversation, while the generic
    // coordinator keeps the failed request as its remembered target.
    expect(turns.activeConversation).toBeUndefined();
    expect(turns.lastConversation).toEqual(conv("second"));
  });

  test("complete only clears the expected task reference", () => {
    const turns = coordinator();
    const first = task(1);
    turns.beginTurn(first);

    expect(turns.complete(task(999))).toBe(false);
    expect(turns.activeTask).toBe(first);

    expect(turns.complete(first)).toBe(true);
    expect(turns.activeTask).toBeNull();
  });

  test("setActiveTask replaces the task unconditionally", () => {
    const turns = coordinator();
    turns.beginTurn(task(1), conv("a"));
    turns.setActiveTask(task(2));

    expect(turns.activeTask).toEqual(task(2));
    expect(turns.activeConversation).toEqual(conv("a"));
  });

  test("conversation binding and observation", () => {
    const turns = coordinator();
    turns.observeConversation(conv("seen"));
    expect(turns.activeConversation).toBeUndefined();
    expect(turns.lastConversation).toEqual(conv("seen"));

    turns.bindConversation(conv("bound"));
    expect(turns.activeConversation).toEqual(conv("bound"));
    expect(turns.lastConversation).toEqual(conv("bound"));
  });

  test("resolveTarget prefers active, then last, then fallback", () => {
    const turns = coordinator(conv("initial"));
    expect(turns.resolveTarget(fallback)).toEqual(conv("initial"));

    turns.observeConversation(conv("observed"));
    expect(turns.resolveTarget(fallback)).toEqual(conv("observed"));

    turns.beginTurn(task(1), conv("active"));
    expect(turns.resolveTarget(fallback)).toEqual(conv("active"));

    turns.complete();
    expect(turns.resolveTarget(fallback)).toEqual(conv("active"));
  });
});

describe("TurnCoordinator dispatch transaction", () => {
  test("dispatches input and reports the task", async () => {
    const turns = coordinator();
    const forwarded: number[] = [];

    const result = await turns.dispatch({
      task: task(1),
      conversation: conv("a"),
      forward: async () => {
        forwarded.push(1);
      },
    });

    expect(result).toEqual({ status: "dispatched", task: task(1) });
    expect(forwarded).toEqual([1]);
    expect(turns.activeTask).toEqual(task(1));
  });

  test("busy input runs the reminder and keeps ownership", async () => {
    const turns = coordinator();
    turns.beginTurn(task(1), conv("first"));

    let reminders = 0;
    const result = await turns.dispatch({
      task: task(2),
      conversation: conv("second"),
      onBusy: async () => {
        reminders += 1;
      },
      forward: async () => {
        throw new Error("must not forward while busy");
      },
    });

    expect(result).toEqual({ status: "busy" });
    expect(reminders).toBe(1);
    expect(turns.activeTask).toEqual(task(1));
    expect(turns.activeConversation).toEqual(conv("first"));
  });

  test("forward failure rolls the lease back and rethrows", async () => {
    const turns = coordinator(conv("seed"));
    const first = task(0);
    turns.beginTurn(first, conv("first"));
    turns.complete(); // activeConversation is undefined afterwards

    let error: unknown = null;
    try {
      await turns.dispatch({
        task: task(1),
        conversation: conv("second"),
        forward: async () => {
          throw new Error("send failed");
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("send failed");
    expect(turns.activeTask).toBeNull();
    expect(turns.activeConversation).toBeUndefined();
    expect(turns.lastConversation).toEqual(conv("second"));
  });

  test("dispatch can start without a conversation binding", async () => {
    const turns = coordinator();
    const result = await turns.dispatch({
      task: task(1),
      forward: async () => undefined,
    });

    expect(result.status).toBe("dispatched");
    expect(turns.activeConversation).toBeUndefined();
    expect(turns.lastConversation).toBeNull();
  });
});
