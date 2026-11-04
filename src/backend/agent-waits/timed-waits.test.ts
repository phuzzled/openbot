// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import type { ConversationSnapshot, QueueDelivery } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { deliveryPromptInput, deliveryWakesWaits, isWaitWakeDelivery } from "../agent/delivery-content";
import type { OpenBotToolResponse } from "../agent/routine-tools";
import type { DeliveryContext } from "../mailbox-store";
import { migrateOpenBotDatabase } from "../openbot-database-schema";
import { AgentWaitStore } from "./agent-wait-store";
import { AgentWaits, AWAIT_EVENT_TOOL, awaitEventToolSchema, TIME_WAKES_MAX, turnLeavesWaitOpen } from "./agent-waits";
import { TimedWaitWakes } from "./timed-wait-wakes";

const AGENT = "agent-1";
const START = new Date("2026-05-01T00:00:00.000Z");
const MINUTE = 60_000;

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function delivery(id: string, overrides: Partial<QueueDelivery> = {}): DeliveryContext {
  return {
    delivery: {
      id,
      messageId: `message-${id}`,
      recipientAgentId: AGENT,
      sender: { kind: "user" },
      text: "Deploy the site and tell me when it is live.",
      attachments: [],
      replyToMessageId: null,
      status: "running",
      position: null,
      turnId: null,
      error: null,
      createdAt: START.toISOString(),
      ...overrides,
    },
    managedAttachments: [],
  };
}

/** The wait tools on a real migrated SQLite database, with a mailbox of fixed deliveries. */
function harness(options: { hasRoutine?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  migrateOpenBotDatabase(db);
  const database = { connection: db };
  let now = START;
  const clock = () => now;
  const store = new AgentWaitStore({ database, now: clock });
  /** The deliveries of each turn, and every delivery by id. */
  const turns = new Map<string, DeliveryContext[]>([["turn-1", [delivery("request-1")]]]);
  const deliveries = new Map<string, DeliveryContext>([["request-1", delivery("request-1")]]);
  const mailbox = {
    findDeliveriesByTurn: (_agentId: string, turnId: string) => turns.get(turnId) ?? [],
    getDelivery: (deliveryId: string) => deliveries.get(deliveryId) ?? null,
  };
  let armed = 0;
  const waits = new AgentWaits({
    store,
    mailbox,
    now: clock,
    hooks: {
      emit: () => {},
      ownsRoutine: () => true,
      hasRoutine: () => options.hasRoutine ?? false,
      wakeTimesChanged: () => {
        armed += 1;
      },
      requireKnownAgent: () => {},
    },
  });
  const enqueued: Array<{ agentId: string; text: string; key: string }> = [];
  let hidden = false;
  const wakes = () =>
    new TimedWaitWakes({
      store,
      mailbox,
      hooks: {
        mayWake: () => !hidden,
        enqueueWake: (agentId, text, key) =>
          Effect.sync(() => {
            const id = `wake-${enqueued.length + 1}`;
            enqueued.push({ agentId, text, key });
            deliveries.set(
              id,
              delivery(id, { sender: { kind: "agent", agentId }, text, expectsReply: false, status: "queued" }),
            );
            return id;
          }),
        changed: () => {},
        emitError: () => {},
      },
    });
  const call = (args: unknown, turnId = "turn-1") =>
    body(
      waits.handleTool(
        {
          threadId: "thread-1",
          turnId,
          callId: crypto.randomUUID(),
          namespace: "openbot",
          tool: AWAIT_EVENT_TOOL,
          arguments: args,
        },
        { agentId: AGENT, inExecutionThread: false },
      ),
    );
  return {
    db,
    store,
    waits,
    wakes,
    call,
    enqueued,
    turns,
    deliveries,
    armed: () => armed,
    setNow: (value: Date) => {
      now = value;
    },
    setHidden: (value: boolean) => {
      hidden = value;
    },
  };
}

function body(response: OpenBotToolResponse | null): { success: boolean; value: DynamicRecord } {
  const item = response?.contentItems[0];
  if (!response || item?.type !== "inputText") throw new Error("The tool gave no text answer.");
  const value = JSON.parse(item.text);
  if (!isDynamicRecord(value)) throw new Error("The tool answer is not a JSON object.");
  return { success: response.success, value };
}

describe("await_event wake time", () => {
  it("validates wakeAfterMinutes and wakeAt in the tool schema", () => {
    expect(awaitEventToolSchema.safeParse({ note: "Deploy", wakeAfterMinutes: 120 }).success).toBe(true);
    expect(awaitEventToolSchema.safeParse({ note: "Deploy", wakeAt: "2026-05-01T09:00:00+10:00" }).success).toBe(true);
    expect(awaitEventToolSchema.safeParse({ note: "Deploy", wakeAfterMinutes: 4 }).success).toBe(false);
    expect(awaitEventToolSchema.safeParse({ note: "Deploy", wakeAfterMinutes: 43_201 }).success).toBe(false);
    expect(awaitEventToolSchema.safeParse({ note: "Deploy", wakeAfterMinutes: 7.5 }).success).toBe(false);
    expect(awaitEventToolSchema.safeParse({ note: "Deploy", wakeAfterMinutes: "60" }).success).toBe(false);
  });

  it("opens a timed wait for an agent with no routine and says when it wakes", () => {
    const test = harness();
    const result = test.call({ note: "Check the deploy", wakeAfterMinutes: 120 });
    const wakeAt = new Date(START.getTime() + 120 * MINUTE).toISOString();
    expect(result.success).toBe(true);
    expect(result.value.wakeAt).toBe(wakeAt);
    expect(String(result.value.wakes)).toContain(wakeAt);
    expect(test.store.list(AGENT)).toMatchObject([{ note: "Check the deploy", wakeAt, routineId: null }]);
    expect(test.armed()).toBe(1);
  });

  it("keeps the routine rule for a wait with no wake time, and names wakeAfterMinutes", () => {
    const test = harness();
    const result = test.call({ note: "Check the deploy" });
    expect(result.success).toBe(false);
    expect(String(result.value.error)).toContain("wakeAfterMinutes");
    expect(test.store.list(AGENT)).toEqual([]);
    const withRoutine = harness({ hasRoutine: true });
    expect(withRoutine.call({ note: "Check the deploy" }).success).toBe(true);
    expect(withRoutine.store.list(AGENT)).toMatchObject([{ wakeAt: null }]);
  });

  it("refuses both times at once, a past time, a time past 30 days and a time with no zone", () => {
    const test = harness();
    for (const args of [
      { note: "Deploy", wakeAfterMinutes: 60, wakeAt: "2026-05-01T09:00:00Z" },
      { note: "Deploy", wakeAt: "2026-04-30T23:59:00Z" },
      { note: "Deploy", wakeAt: "2026-06-01T00:00:01Z" },
      { note: "Deploy", wakeAt: "2026-05-01T09:00:00" },
      { note: "Deploy", wakeAt: "tomorrow" },
      { note: "Deploy", wakeAfterMinutes: 1 },
    ])
      expect(test.call(args).success, JSON.stringify(args)).toBe(false);
    expect(test.store.list(AGENT)).toEqual([]);
  });

  it("stores a wakeAt with an offset in UTC", () => {
    const test = harness();
    expect(test.call({ note: "Deploy", wakeAt: "2026-05-01T19:00:00+10:00" }).success).toBe(true);
    expect(test.store.list(AGENT)[0]?.wakeAt).toBe("2026-05-01T09:00:00.000Z");
  });
});

describe("timed wait wakes", () => {
  it("wakes a due wait once, in one delivery that names it", async () => {
    const test = harness();
    test.call({ note: "Check the deploy", wakeAfterMinutes: 30 });
    const wakes = test.wakes();
    const [wait] = test.store.list(AGENT);
    expect(wakes.nextDueAt()).toBe(wait?.wakeAt);
    await Effect.runPromise(wakes.processDue(new Date(START.getTime() + 29 * MINUTE), () => true));
    expect(test.enqueued).toEqual([]);
    const due = new Date(START.getTime() + 31 * MINUTE);
    test.setNow(due);
    await Effect.runPromise(wakes.processDue(due, () => true));
    await Effect.runPromise(wakes.processDue(due, () => true));
    expect(test.enqueued).toEqual([
      { agentId: AGENT, text: "Check the deploy", key: `wait-wake:${wait?.id}:${wait?.wakeAt}` },
    ]);
    expect(test.store.list(AGENT)).toMatchObject([
      { id: wait?.id, wakeAt: null, wakeDeliveryId: "wake-1", wokenAt: due.toISOString() },
    ]);
    expect(test.waits.wokenBy("wake-1").map((woken) => woken.id)).toEqual([wait?.id]);
    expect(wakes.nextDueAt()).toBeNull();
  });

  it("wakes a wait that came due while the app was closed once, at the first pass after start", async () => {
    const test = harness();
    test.call({ note: "Check the deploy", wakeAfterMinutes: 30 });
    test.call({ note: "Check the build", wakeAfterMinutes: 60 });
    // A new scheduler on the same database is what a restart builds. Three days passed.
    const restarted = test.wakes();
    const later = new Date(START.getTime() + 3 * 24 * 60 * MINUTE);
    expect(restarted.nextDueAt()).toBe(new Date(START.getTime() + 30 * MINUTE).toISOString());
    await Effect.runPromise(restarted.processDue(later, () => true));
    await Effect.runPromise(restarted.processDue(later, () => true));
    expect(test.enqueued).toHaveLength(1);
    expect(test.enqueued[0]?.text).toBe("Check the deploy\n\nCheck the build");
    expect(test.waits.wokenBy("wake-1")).toHaveLength(2);
    expect(restarted.nextDueAt()).toBeNull();
  });

  it("holds the wake of a hidden agent until it can take it", async () => {
    const test = harness();
    test.call({ note: "Check the deploy", wakeAfterMinutes: 30 });
    const wakes = test.wakes();
    const due = new Date(START.getTime() + 31 * MINUTE);
    test.setHidden(true);
    expect(wakes.nextDueAt()).toBeNull();
    await Effect.runPromise(wakes.processDue(due, () => true));
    expect(test.enqueued).toEqual([]);
    test.setHidden(false);
    await Effect.runPromise(wakes.processDue(due, () => true));
    expect(test.enqueued).toHaveLength(1);
  });

  it("spends the time of a wait that a pending run already continues", async () => {
    const test = harness({ hasRoutine: true });
    test.call({ note: "Check the deploy", wakeAfterMinutes: 30 });
    const [wait] = test.store.list(AGENT);
    test.deliveries.set("routine-run", delivery("routine-run", { status: "queued" }));
    test.store.markWoken(AGENT, [wait?.id ?? ""], "routine-run");
    const wakes = test.wakes();
    await Effect.runPromise(wakes.processDue(new Date(START.getTime() + 31 * MINUTE), () => true));
    expect(test.enqueued).toEqual([]);
    expect(test.store.list(AGENT)).toMatchObject([{ wakeAt: null, wakeDeliveryId: "routine-run" }]);
  });

  it("lets the run that a wake started set the next wake of the same wait", async () => {
    const test = harness();
    test.call({ note: "Check the deploy", wakeAfterMinutes: 30 });
    const wakes = test.wakes();
    const due = new Date(START.getTime() + 31 * MINUTE);
    test.setNow(due);
    await Effect.runPromise(wakes.processDue(due, () => true));
    const wake = test.deliveries.get("wake-1");
    if (!wake) throw new Error("The wake delivery is missing.");
    test.turns.set("turn-2", [wake]);
    const result = test.call({ note: "Check again", wakeAfterMinutes: 60 }, "turn-2");
    const next = new Date(due.getTime() + 60 * MINUTE).toISOString();
    expect(result).toMatchObject({ success: true, value: { wakeAt: next } });
    expect(test.store.list(AGENT)).toHaveLength(1);
    expect(test.store.list(AGENT)[0]?.wakeAt).toBe(next);
    expect(wakes.nextDueAt()).toBe(next);
    // Without a time, the run keeps the wait open and gives it no new wake.
    const kept = test.call({ note: "Check again" }, "turn-2");
    expect(kept.success).toBe(true);
    expect(String(kept.value.note)).toContain("wakeAfterMinutes");
  });

  it("counts a wake turn that leaves its wait open as a turn that waits, so its plan does not continue", async () => {
    const test = harness();
    test.call({ note: "Check the deploy", wakeAfterMinutes: 30 });
    const due = new Date(START.getTime() + 31 * MINUTE);
    test.setNow(due);
    await Effect.runPromise(test.wakes().processDue(due, () => true));
    // The turn of the original request, and the wake turn that rescheduled the wait.
    expect(turnLeavesWaitOpen(test.store.list(AGENT), ["request-1"])).toBe(true);
    test.turns.set("turn-2", [test.deliveries.get("wake-1") ?? delivery("wake-1")]);
    expect(test.call({ note: "Check again", wakeAfterMinutes: 60 }, "turn-2").success).toBe(true);
    expect(turnLeavesWaitOpen(test.store.list(AGENT), ["wake-1"])).toBe(true);
    // Another turn does not wait for it, and a closed wait holds no turn.
    expect(turnLeavesWaitOpen(test.store.list(AGENT), ["user-2"])).toBe(false);
    test.store.delete(AGENT, test.store.list(AGENT)[0]?.id ?? "");
    expect(turnLeavesWaitOpen(test.store.list(AGENT), ["wake-1"])).toBe(false);
  });
});

describe("time wake limit", () => {
  it("refuses a new time after the wait woke at its time the most times, and tells the agent to report", async () => {
    const test = harness();
    test.call({ note: "Check vendor replies", wakeAfterMinutes: 5 });
    let now = START.getTime();
    for (let wake = 1; wake <= TIME_WAKES_MAX; wake += 1) {
      now += 6 * MINUTE;
      const due = new Date(now);
      test.setNow(due);
      await Effect.runPromise(test.wakes().processDue(due, () => true));
      const deliveryId = `wake-${wake}`;
      const woken = test.deliveries.get(deliveryId);
      if (!woken) throw new Error(`Wake ${wake} is missing.`);
      test.turns.set(`wake-turn-${wake}`, [woken]);
      test.deliveries.set(deliveryId, { ...woken, delivery: { ...woken.delivery, status: "completed" } });
      const again = test.call({ note: "Check again", wakeAfterMinutes: 5 }, `wake-turn-${wake}`);
      if (wake < TIME_WAKES_MAX) expect(again.success, `wake ${wake}`).toBe(true);
      else {
        expect(again.success).toBe(false);
        expect(String(again.value.error)).toContain("openbot.close_wait");
      }
    }
    expect(test.store.list(AGENT)).toMatchObject([{ timeWakes: TIME_WAKES_MAX, wakeAt: null }]);
    expect(test.enqueued).toHaveLength(TIME_WAKES_MAX);
  });
});

describe("routine runs and timed waits", () => {
  it("wakes a timed wait only at its time, its own routine or a script event, also after its time is spent", async () => {
    const test = harness({ hasRoutine: true });
    test.db
      .prepare(`INSERT INTO projection_agent_routines
      (routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at, last_event_sequence)
      VALUES ('inbox', ?, 'Inbox', 'Check the inbox.', 1, 'UTC', '2026-01-01', '2026-01-01', 1)`)
      .run(AGENT);
    test.call({ note: "Check vendor replies", wakeAfterMinutes: 2880 });
    test.call({ note: "Wait for the inbox routine" });
    test.call({ note: "Check the build", wakeAfterMinutes: 60, routineId: "inbox" });
    const byNote = (note: string) => test.store.list(AGENT).find((wait) => wait.note === note);
    const [timed, untimed, named] = [
      byNote("Check vendor replies"),
      byNote("Wait for the inbox routine"),
      byNote("Check the build"),
    ];
    const woken = (deliveryId: string) =>
      test.waits
        .wokenBy(deliveryId)
        .map((wait) => wait.id)
        .sort();
    const run = (deliveryId: string, waitId: string | null = null) => {
      test.deliveries.set(
        deliveryId,
        delivery(deliveryId, {
          sender: {
            kind: "routine",
            routineId: "inbox",
            runId: deliveryId,
            routineName: "Inbox",
            scheduledFor: START.toISOString(),
          },
          status: "completed",
        }),
      );
      test.waits.wakeForRun({ agentId: AGENT, routineId: "inbox" }, deliveryId, waitId);
    };
    run("run-1");
    expect(woken("run-1")).toEqual([untimed?.id, named?.id].sort());
    // The wake time of the first wait wakes it, and clears its time. A routine run still does not wake it.
    const due = new Date(START.getTime() + 2881 * MINUTE);
    test.setNow(due);
    await Effect.runPromise(test.wakes().processDue(due, () => true));
    expect(test.store.get(AGENT, timed?.id ?? "")).toMatchObject({ wakeAt: null, timeWakes: 1 });
    run("run-2");
    expect(woken("run-2")).not.toContain(timed?.id);
    // A script event that names the wait wakes it, once its wake run has ended.
    test.deliveries.set("wake-1", delivery("wake-1", { status: "completed" }));
    run("run-3", timed?.id ?? null);
    expect(woken("run-3")).toEqual([timed?.id]);
  });

  it("says that a timed wait does not wake on a routine run", () => {
    const test = harness({ hasRoutine: true });
    const result = test.call({ note: "Check vendor replies", wakeAfterMinutes: 2880 });
    expect(String(result.value.wakes)).not.toContain("routines");
  });
});

describe("wait wake delivery", () => {
  const snapshot: ConversationSnapshot = {
    agentId: AGENT,
    threadId: "thread-1",
    activeTurnId: null,
    revision: 0,
    messages: [],
  };

  it("is a message of the agent to itself with no answer, and continues the waits it woke", () => {
    const wake = delivery("wake-1", {
      sender: { kind: "agent", agentId: AGENT },
      text: "Check the deploy",
      expectsReply: false,
    });
    const brief = delivery("brief-1", { sender: { kind: "agent", agentId: AGENT }, text: "Do the task" });
    expect(isWaitWakeDelivery(wake.delivery)).toBe(true);
    expect(isWaitWakeDelivery(brief.delivery)).toBe(false);
    expect(deliveryWakesWaits(wake.delivery)).toBe(true);
    expect(deliveryWakesWaits(delivery("user-1").delivery)).toBe(false);
    const [input] = deliveryPromptInput(wake, {
      agentNames: new Map(),
      snapshot,
      routineRun: null,
      wokenWaits: [
        {
          id: "wait-1",
          agentId: AGENT,
          note: "Check the deploy",
          requestMessageId: "request-1",
          requestText: "Deploy the site.",
          routineId: null,
          createdAt: START.toISOString(),
          wokenAt: START.toISOString(),
          wakeDeliveryId: "wake-1",
          wakeAt: null,
        },
      ],
    });
    expect(input?.type === "text" ? input.text : "").toContain("Wait ID: wait-1");
    expect(input?.type === "text" ? input.text : "").toContain("Deploy the site.");
    expect(input?.type === "text" ? input.text : "").not.toContain("openbot.start_task");
  });
});
