// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import type { AgentWait, QueueDeliveryStatus } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  isStallNudgeDelivery,
  isWaitWakeDelivery,
  STALL_NUDGE_HEADER,
  STALL_NUDGE_REQUEST_MAX,
  stallNudgeText,
} from "../agent/delivery-content";
import { applyForkSchema } from "../database/fork-schema";
import { migrateOpenBotDatabase } from "../openbot-database-schema";
import { StallCheckStore } from "./stall-check-store";
import { detectStall, followUpPromise, type StallInput } from "./stall-detection";
import {
  STALL_DAILY_LIMIT,
  STALL_GRACE_MS,
  STALL_MAX_AGE_MS,
  STALL_NUDGE_LIMIT,
  STALL_REPEAT_MS,
  StallSweep,
  type StallSweepHooks,
  type StallTurn,
  stallSweepEnabled,
  waitBacksStallCheck,
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
    // Common phrasings (review 4, M4).
    "I'll check on it in 10 minutes.",
    "I'll be back with the numbers.",
    "I'll get back to you on the price.",
    "Done for today; tomorrow I'll compare the quotes.",
    "Later today I'll send the summary.",
    "I will report back.",
    "I'll keep you posted.",
    "I'll keep you updated.",
    "I'll circle back.",
    "Gonna check back in an hour.",
    // The agent's own prose after a quoted draft still counts.
    "Here is the draft:\n\n> I'll follow up next week.\n\nI'll let you know when Sam replies.",
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
    // Conditional on the user (review 4, H1).
    "Here is the migration plan. When you are ready, I'll start the migration.",
    "Once you reply with the dates, I'll book it.",
    "As soon as you confirm, I'll send it.",
    "After you approve, I'll deploy.",
    "If you want, I'll keep an eye on it.",
    "Let me know and I'll follow up with Sam.",
    "As soon as you answer, I'll continue with the rollout.",
    "I'll check back once you have looked at it.",
    // Text that the agent drafts for someone else (review 4, M1).
    "Here's a draft reply to Sam:\n\n> Thanks for the quote. I'll get back to you by Friday.\n> Cheers,\n> Andrew",
    "Hi team, we will keep you posted on the launch.\n\nRegards,\nAndrew",
    "Draft:\n\nHi Sam, I'll follow up next week.",
    "Subject: Launch update\n\nWe'll keep you posted.",
    'Done:\n\n```\necho "I\'ll let you know"\n```',
    'You wrote: "I\'ll let you know when they reply." I fixed the typo.',
    // Past tense, questions, a day off.
    "I checked on it yesterday and got back to the vendor.",
    "Should I check on it in 10 minutes?",
    "Do you want me to circle back tomorrow?",
    "Tomorrow I'll be off.",
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
    // The first instruction stops an agent that waits for the user, before any action.
    const lines = text.split("\n");
    const waitLine = lines.findIndex((line) => line.includes("if you wait for the user's answer or approval"));
    expect(waitLine).toBe(3);
    expect(lines[waitLine]).toContain("stop");
    expect(lines.findIndex((line) => line.startsWith("- Finish"))).toBeGreaterThan(waitLine);
    expect(text).toContain("Never do an action that the user did not approve");
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

  it("cuts a long request", () => {
    const text = stallNudgeText({ reason: "r", requestText: "x".repeat(50_000), nudge: 1, limit: 2 });
    expect(text.endsWith("…(cut)")).toBe(true);
    expect(text.length).toBeLessThan(STALL_NUDGE_REQUEST_MAX + 2000);
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
      waitBacks: false,
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
      waitBacksCheck: () => state.waitBacks,
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
      "a wait backs the check",
      (state) => {
        state.waitBacks = true;
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

  it.each<[string, Partial<StallTurn>]>([
    [
      "a teammate's message",
      {
        deliveries: [
          { id: "fyi", sender: { kind: "agent", agentId: "helper" }, recipientAgentId: "chief", text: "FYI" },
        ],
      },
    ],
    ["a turn with no delivery", { deliveries: [] }],
    [
      "a teammate's message that continues a plan",
      {
        continued: true,
        deliveries: [
          { id: "fyi", sender: { kind: "agent", agentId: "helper" }, recipientAgentId: "chief", text: "FYI" },
        ],
      },
    ],
  ])("keeps the lane's check after %s, and still nudges", async (_name, change) => {
    const { store, state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn());
    const before = store.forLane("chief", null);
    sweep.turnEnded(userTurn({ turnId: "turn-2", answer: "Noted.", ...change }));
    expect(store.forLane("chief", null)).toEqual(before);
    advance(STALL_GRACE_MS);
    await fire();
    expect(state.nudges).toHaveLength(1);
  });

  it("ends a check older than the age limit with no nudge, also while the agent is hidden", async () => {
    const { store, state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn());
    state.mayWake = false;
    advance(STALL_MAX_AGE_MS + 60_000);
    await fire();
    expect(store.all()).toEqual([]);
    state.mayWake = true;
    await fire();
    expect(state.nudges).toEqual([]);
    expect(store.all()).toEqual([]);
  });

  it("nudges a check just inside the age limit", async () => {
    const { state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn());
    state.mayWake = false;
    advance(STALL_MAX_AGE_MS - 60_000);
    await fire();
    state.mayWake = true;
    await fire();
    expect(state.nudges).toHaveLength(1);
  });

  it("keeps a cut request in the check", () => {
    const { store, sweep } = setup();
    sweep.turnEnded(
      userTurn({
        deliveries: [
          { id: "request-1", sender: { kind: "user" }, recipientAgentId: "chief", text: "y".repeat(50_000) },
        ],
      }),
    );
    expect(store.forLane("chief", null)?.requestText.length).toBeLessThan(STALL_NUDGE_REQUEST_MAX + 10);
  });
});

describe("waitBacksStallCheck", () => {
  const check = {
    agentId: "chief",
    taskId: null,
    requestDeliveryId: "request-1",
    nudgeDeliveryId: "nudge-1",
    createdAt: "2026-11-01T10:00:00.000Z",
  };
  const wait = (change: Partial<AgentWait>): AgentWait => ({
    id: "w",
    agentId: "chief",
    note: "Check the domain renewal",
    requestMessageId: "old-request",
    requestText: "Renew the domain.",
    routineId: null,
    createdAt: "2026-11-01T08:00:00.000Z",
    wokenAt: null,
    wakeDeliveryId: null,
    wakeAt: null,
    ...change,
  });
  const inChat = () => null;

  it.each<[string, Partial<AgentWait>, boolean]>([
    ["an older wait of other work, as one that a Stop left with no time", {}, false],
    ["a wait of the check's request", { requestMessageId: "request-1" }, true],
    ["a wait that the nudge opened", { requestMessageId: "nudge-1" }, true],
    ["a wait that the nudge woke", { wakeDeliveryId: "nudge-1" }, true],
    ["a wait opened after the check", { createdAt: "2026-11-01T10:05:00.000Z" }, true],
  ])("%s: %s", (_name, change, backs) => {
    expect(waitBacksStallCheck([wait(change)], check, inChat)).toBe(backs);
  });

  it("ignores a wait of another lane", () => {
    expect(waitBacksStallCheck([wait({ requestMessageId: "request-1" })], check, () => "task-1")).toBe(false);
  });
});
