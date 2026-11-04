// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import type { QueueDeliveryStatus } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  isStallNudgeDelivery,
  isWaitWakeDelivery,
  STALL_NUDGE_HEADER,
  stallNudgeText,
} from "../agent/delivery-content";
import { applyForkSchema } from "../database/fork-schema";
import { migrateOpenBotDatabase } from "../openbot-database-schema";
import { StallCheckStore } from "./stall-check-store";
import { detectStall, followUpPromise, type StallInput } from "./stall-detection";
import {
  STALL_DAILY_LIMIT,
  STALL_GRACE_MS,
  STALL_NUDGE_LIMIT,
  STALL_REPEAT_MS,
  StallSweep,
  type StallSweepHooks,
  type StallTurn,
  stallSweepEnabled,
} from "./stall-sweep";

describe("followUpPromise", () => {
  it.each([
    "I've emailed the vendors. I'll let you know when they reply.",
    "Sent. I will follow up tomorrow morning.",
    "I'll keep an eye on the build and report back.",
    "I'll monitor the deploy.",
    "We'll keep you posted.",
    "Once the vendors reply, I'll compare the quotes.",
    "I'll compare the quotes as soon as they respond.",
    "Done with step one.\n\nI'll check back in an hour.",
    "**I'll get back to you** with the numbers.",
    "Will update you when the job finishes.",
    "I'm going to circle back after lunch.",
  ])("finds a promise in %j", (answer) => {
    expect(followUpPromise(answer)).not.toBeNull();
  });

  it.each([
    "Let me know if you need anything.",
    "I'll wait for your approval.",
    "I followed up with the vendor yesterday.",
    "Should I follow up with them?",
    "If you want, I'll follow up tomorrow.",
    "Would you like me to keep an eye on it?",
    "I will not follow up on this.",
    "I'll let you know if I find anything else, but the task is done.",
    "The report is attached.",
    "I'll now run the tests.",
    "",
  ])("finds no promise in %j", (answer) => {
    expect(followUpPromise(answer)).toBeNull();
  });

  it("reads only the final part of a long answer", () => {
    const answer = `I'll let you know when they reply.\n\n${"The table below lists every quote. ".repeat(20)}\n\nAll done.`;
    expect(followUpPromise(answer)).toBeNull();
  });
});

describe("detectStall", () => {
  const base: StallInput = {
    outcome: "completed",
    stopped: false,
    continued: false,
    excluded: false,
    waitOpen: false,
    waitsForAttention: false,
    answer: "I emailed the vendors. I'll let you know when they reply.",
    openSteps: [],
  };

  it("finds an unbacked promise", () => {
    expect(detectStall(base)).toMatchObject({ kind: "promise" });
  });

  it("finds open plan steps", () => {
    expect(detectStall({ ...base, answer: "Step one is done.", openSteps: ["Compare quotes"] })).toEqual({
      kind: "openSteps",
      reason: 'Your plan has open steps: "Compare quotes"',
    });
  });

  it.each<[string, Partial<StallInput>]>([
    ["a failed turn", { outcome: "failed" }],
    ["an interrupted turn", { outcome: "interrupted" }],
    ["a stopped turn", { stopped: true }],
    ["a continued plan", { continued: true }],
    ["an excluded lane", { excluded: true }],
    ["an open wait", { waitOpen: true }],
    ["a question of the agent", { waitsForAttention: true }],
    ["an answer that asks the user", { answer: "I'll follow up once you reply. Which vendor do you prefer?" }],
    ["an answer that waits for the user", { answer: "I'll wait for your approval." }],
    ["an answer with no promise and no plan", { answer: "All done. The report is attached." }],
  ])("is no stall for %s", (_name, change) => {
    expect(detectStall({ ...base, ...change })).toBeNull();
  });
});

describe("stall nudge text", () => {
  it("names the reason, the four actions and the request, and is not a wait wake prompt", () => {
    const text = stallNudgeText({
      reason: 'You wrote: "I\'ll check back."',
      requestText: "Find 3 quotes.",
      nudge: 1,
      limit: 2,
    });
    expect(text.startsWith(STALL_NUDGE_HEADER)).toBe(true);
    for (const part of [
      "openbot.await_event",
      "wakeAfterMinutes",
      "openbot.ask_user",
      "Find 3 quotes.",
      "check 1 of 2",
    ])
      expect(text).toContain(part);
    const delivery = {
      sender: { kind: "agent" as const, agentId: "a" },
      recipientAgentId: "a",
      expectsReply: false,
      text,
    };
    expect(isWaitWakeDelivery(delivery)).toBe(true);
    expect(isStallNudgeDelivery(delivery)).toBe(true);
    expect(isStallNudgeDelivery({ ...delivery, text: "Check vendor replies" })).toBe(false);
  });

  it("is on unless OPENBOT_STALL_SWEEP is 0", () => {
    expect(stallSweepEnabled({})).toBe(true);
    expect(stallSweepEnabled({ OPENBOT_STALL_SWEEP: "1" })).toBe(true);
    expect(stallSweepEnabled({ OPENBOT_STALL_SWEEP: "0" })).toBe(false);
  });
});

describe("StallSweep", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function setup(options: { enabled?: boolean } = {}) {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateOpenBotDatabase(db);
    applyForkSchema(db);
    let clock = new Date("2026-11-01T10:00:00.000Z");
    let ids = 0;
    const store = new StallCheckStore({ database: { connection: db }, createId: () => `check-${++ids}` });
    const nudges: { agentId: string; taskId: string | null; text: string; key: string }[] = [];
    const alerts: { agentId: string; taskId: string | null }[] = [];
    const state = {
      mayWake: true,
      providerReady: true,
      laneOpen: true,
      laneBusy: false,
      laneHasOpenWait: false,
      userMessaged: false,
      statuses: new Map<string, QueueDeliveryStatus>(),
      nudges,
      alerts,
      failEnqueue: false,
    };
    const hooks: StallSweepHooks = {
      mayWake: () => state.mayWake,
      providerReady: () => state.providerReady,
      laneOpen: () => state.laneOpen,
      laneBusy: () => state.laneBusy,
      laneHasOpenWait: () => state.laneHasOpenWait,
      userMessagedSince: () => state.userMessaged,
      deliveryStatus: (id) => state.statuses.get(id),
      enqueueNudge: (agentId, taskId, text, key) => {
        if (state.failEnqueue) return Effect.fail({ cause: new Error("no queue") });
        const id = `nudge-${state.nudges.length + 1}`;
        state.nudges.push({ agentId, taskId, text, key });
        state.statuses.set(id, "queued");
        return Effect.succeed(id);
      },
      nudgeQueued: () => {},
      alert: (agentId, taskId) => state.alerts.push({ agentId, taskId }),
      changed: () => {},
      emitError: () => {},
    };
    const sweep = new StallSweep({ store, hooks, enabled: options.enabled ?? true, now: () => clock });
    const advance = (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    };
    const fire = () => Effect.runPromise(sweep.processDue(clock, () => true));
    return { db, store, state, sweep, advance, fire };
  }

  const userTurn = (change: Partial<StallTurn> = {}): StallTurn => ({
    agentId: "chief",
    taskId: null,
    turnId: "turn-1",
    outcome: "completed",
    stopped: false,
    continued: false,
    excludedLane: false,
    waitOpen: false,
    waitsForAttention: false,
    answer: "I emailed the vendors. I'll let you know when they reply.",
    openSteps: [],
    deliveries: [
      { id: "request-1", sender: { kind: "user" }, recipientAgentId: "chief", text: "Get 3 printer quotes." },
    ],
    ...change,
  });
  const nudgeTurn = (deliveryId: string, change: Partial<StallTurn> = {}): StallTurn =>
    userTurn({
      turnId: `turn-${deliveryId}`,
      deliveries: [
        {
          id: deliveryId,
          sender: { kind: "agent", agentId: "chief" },
          recipientAgentId: "chief",
          text: STALL_NUDGE_HEADER,
        },
      ],
      ...change,
    });

  it("checks a stalled turn after the grace time, once, with the request", async () => {
    const { store, state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn());
    const check = store.forLane("chief", null);
    expect(check).toMatchObject({ requestDeliveryId: "request-1", nudges: 0 });
    expect(sweep.nextDueAt()).toBe(new Date(Date.parse("2026-11-01T10:00:00.000Z") + STALL_GRACE_MS).toISOString());
    advance(STALL_GRACE_MS - 1000);
    await fire();
    expect(state.nudges).toEqual([]);
    advance(1000);
    await fire();
    await fire();
    expect(state.nudges).toHaveLength(1);
    expect(state.nudges[0]?.key).toBe(`stall-nudge:${check?.id}:1`);
    expect(state.nudges[0]?.text).toContain("Get 3 printer quotes.");
    expect(store.forLane("chief", null)).toMatchObject({ nudges: 1, nudgeDeliveryId: "nudge-1", dueAt: null });
  });

  it("does nothing when it is off", () => {
    const { store, sweep } = setup({ enabled: false });
    sweep.turnEnded(userTurn());
    expect(store.all()).toEqual([]);
    expect(sweep.nextDueAt()).toBeNull();
  });

  it.each<[string, Partial<StallTurn>]>([
    ["a turn that asks the user", { answer: "Which vendor do you want?" }],
    ["a turn that opened a wait", { waitOpen: true }],
    ["an excluded lane", { excludedLane: true }],
    [
      "a teammate's message",
      { deliveries: [{ id: "d", sender: { kind: "agent", agentId: "helper" }, recipientAgentId: "chief", text: "x" }] },
    ],
    [
      "a routine run",
      {
        deliveries: [
          {
            id: "d",
            sender: { kind: "routine", routineId: "r", runId: "u", routineName: "n", scheduledFor: "s" },
            recipientAgentId: "chief",
            text: "x",
          },
        ],
      },
    ],
  ])("gives no check for %s", (_name, change) => {
    const { store, sweep } = setup();
    sweep.turnEnded(userTurn(change));
    expect(store.all()).toEqual([]);
  });

  it("ends the check when a newer turn of the lane does not stall", () => {
    const { store, sweep } = setup();
    sweep.turnEnded(userTurn());
    sweep.turnEnded(
      userTurn({
        turnId: "turn-2",
        answer: "All done.",
        deliveries: [{ id: "request-2", sender: { kind: "user" }, recipientAgentId: "chief", text: "Thanks." }],
      }),
    );
    expect(store.all()).toEqual([]);
  });

  it("keeps one check per lane, and a task has its own", () => {
    const { store, sweep } = setup();
    sweep.turnEnded(userTurn());
    sweep.turnEnded(
      userTurn({
        turnId: "turn-2",
        deliveries: [{ id: "request-2", sender: { kind: "user" }, recipientAgentId: "chief", text: "Other." }],
      }),
    );
    sweep.turnEnded(userTurn({ taskId: "task-1", turnId: "turn-3" }));
    expect(store.all().map((check) => [check.taskId, check.requestDeliveryId])).toEqual([
      [null, "request-2"],
      ["task-1", "request-1"],
    ]);
  });

  it.each<[string, (state: ReturnType<typeof setup>["state"]) => void]>([
    [
      "the lane is busy",
      (state) => {
        state.laneBusy = true;
      },
    ],
    [
      "a wait is open in the lane",
      (state) => {
        state.laneHasOpenWait = true;
      },
    ],
    [
      "the user wrote since",
      (state) => {
        state.userMessaged = true;
      },
    ],
    [
      "the task is closed",
      (state) => {
        state.laneOpen = false;
      },
    ],
  ])("cancels a due check when %s", async (_name, change) => {
    const { store, state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn());
    change(state);
    advance(STALL_GRACE_MS);
    await fire();
    expect(state.nudges).toEqual([]);
    expect(store.all()).toEqual([]);
  });

  it("keeps the check of a hidden agent until it can wake, and waits for a provider", async () => {
    const { store, state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn());
    advance(STALL_GRACE_MS);
    state.mayWake = false;
    expect(sweep.nextDueAt()).toBeNull();
    await fire();
    expect(state.nudges).toEqual([]);
    expect(store.all()).toHaveLength(1);
    state.mayWake = true;
    state.providerReady = false;
    await fire();
    expect(state.nudges).toEqual([]);
    expect(store.forLane("chief", null)?.nudges).toBe(0);
    state.providerReady = true;
    advance(15 * 60_000);
    await fire();
    expect(state.nudges).toHaveLength(1);
  });

  it("nudges a request at most twice, then alerts the user once and stops", async () => {
    const { store, state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn());
    advance(STALL_GRACE_MS);
    await fire();
    sweep.turnEnded(nudgeTurn("nudge-1"));
    expect(store.forLane("chief", null)).toMatchObject({ nudges: 1, requestDeliveryId: "request-1" });
    advance(STALL_REPEAT_MS - 1000);
    await fire();
    expect(state.nudges).toHaveLength(1);
    advance(1000);
    await fire();
    expect(state.nudges).toHaveLength(2);
    expect(state.nudges[1]?.text).toContain(`check 2 of ${STALL_NUDGE_LIMIT}`);
    sweep.turnEnded(nudgeTurn("nudge-2"));
    expect(state.alerts).toEqual([{ agentId: "chief", taskId: null }]);
    expect(store.all()).toEqual([]);
    advance(STALL_REPEAT_MS * 3);
    await fire();
    expect(state.nudges).toHaveLength(2);
    expect(state.alerts).toHaveLength(1);
  });

  it("ends the check when a nudge turn opens a wait, is stopped, or finishes", () => {
    for (const change of [
      { waitOpen: true },
      { stopped: true, outcome: "interrupted" },
      { answer: "All 3 quotes are in. Vendor B is cheapest." },
    ]) {
      const { store, sweep } = setup();
      sweep.turnEnded(userTurn());
      const check = store.forLane("chief", null);
      if (check) store.markNudged(check.id, "nudge-1", 1);
      sweep.turnEnded(nudgeTurn("nudge-1", change));
      expect(store.all()).toEqual([]);
    }
  });

  it("keeps the count while a nudge turn continues its plan", () => {
    const { store, sweep } = setup();
    sweep.turnEnded(userTurn());
    const check = store.forLane("chief", null);
    if (check) store.markNudged(check.id, "nudge-1", 1);
    sweep.turnEnded(nudgeTurn("nudge-1", { continued: true }));
    expect(store.forLane("chief", null)).toMatchObject({ nudges: 1, dueAt: null });
    sweep.turnEnded(nudgeTurn("nudge-1", { turnId: "turn-cont" }));
    expect(store.forLane("chief", null)).toMatchObject({ nudges: 1, requestDeliveryId: "request-1" });
  });

  it("ends a check whose nudge delivery ended with no turn end", async () => {
    const { store, state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn());
    advance(STALL_GRACE_MS);
    await fire();
    state.statuses.set("nudge-1", "interrupted");
    expect(sweep.nextDueAt()).not.toBeNull();
    await fire();
    expect(store.all()).toEqual([]);
    expect(sweep.nextDueAt()).toBeNull();
  });

  it("tries a failed enqueue again later", async () => {
    const { store, state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn());
    advance(STALL_GRACE_MS);
    state.failEnqueue = true;
    await fire();
    expect(store.forLane("chief", null)).toMatchObject({ nudges: 0 });
    expect(store.forLane("chief", null)?.dueAt).not.toBeNull();
  });

  it("stops at the daily limit of the agent and alerts the user", async () => {
    const { store, state, sweep, advance, fire } = setup();
    for (let index = 0; index < STALL_DAILY_LIMIT; index += 1)
      store.logNudge("chief", new Date("2026-11-01T09:00:00.000Z"));
    sweep.turnEnded(userTurn());
    advance(STALL_GRACE_MS);
    await fire();
    expect(state.nudges).toEqual([]);
    expect(state.alerts).toHaveLength(1);
    expect(store.all()).toEqual([]);
  });
});
