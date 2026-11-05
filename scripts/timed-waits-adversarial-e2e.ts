// Adversarial checks of timed waits (third review, R1-R7). Runs the real agent service on a temporary
// profile with a fake Codex app-server, as `timed-waits-followup-e2e.ts` does. The current message
// names its turns in `<<PLAN[...]PLAN>>`; a wait note names the turns of the wake. A turn with
// `fail: true` ends failed, as a provider error does.
// Checks:
//   R1  A wake turn that sets a new time and runs past it keeps that time, and the wait wakes once
//       more after the turn.
//   R2  An agent that sets a new time in every wake turn stops at the limit of 20 wakes.
//   R3  A wake turn that fails gets a new time with backoff (5, 10, 20 min), stops at the limit, and
//       the timer does not spin.
//   R4  Two waits due at once: one wake for one agent, one wake each for two agents.
//   R5  An agent deleted while its wait is due: no wake, no error, no timer rows.
//   R6  A restart between the wake enqueue and `markWokenByTime`: the wake still names the wait.
//   R7  The user stops a wake turn: the wait stays open with no time and does not wake again by
//       itself. Then the user cancels it.
// No provider, account or network is used. `bun run test:timed-waits-adversarial`. `ONLY=R1,R7` runs
// some. Writes .openbot-build/timed-waits-adversarial-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/timed-waits-adversarial-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-timed-waits-adversarial-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");
const NOTE_MARKER = "OpenBot note, not a message from the user";

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

type StepStatus = "pending" | "inProgress" | "completed";

/** One turn of the fake: its plan, its answer, its delay and its OpenBot tool calls. */
interface FakeTurn {
  steps: [string, StepStatus][];
  answer?: string;
  delayMs?: number;
  /** Sends the plan when the turn starts, as well as at its end. */
  planEarly?: boolean;
  fail?: boolean;
  calls?: { tool: string; arguments: Record<string, string | number | string[]> }[];
}

// "<" and ">" are escaped, so a plan in a message that a turn sends does not end the plan around it.
const plan = (...turns: FakeTurn[]) =>
  `<<PLAN${JSON.stringify(turns).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}PLAN>>`;

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const NOTE = ${JSON.stringify(NOTE_MARKER)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
const waiting = new Map();
const timers = new Map();
/** The turns that each thread has still to run, from the message that named them. */
const scripts = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (turn) => {
  timers.delete(turn.turnId);
  if (turn.script.fail) {
    write({ method: "error", params: { threadId: turn.threadId, turnId: turn.turnId, willRetry: false, error: { message: "fake provider failure", codexErrorInfo: null, additionalDetails: null } } });
    write({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "failed", error: { message: "fake provider failure" } } } });
    return;
  }
  const plan = (turn.script.steps || []).map(([step, status]) => ({ step, status }));
  if (plan.length > 0) write({ method: "turn/plan/updated", params: { threadId: turn.threadId, turnId: turn.turnId, plan } });
  const item = { type: "agentMessage", id: "message-" + turn.turnId, text: turn.script.answer || "Done.", phase: "final_answer" };
  write({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.turnId, item } });
  write({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "completed" } } });
};
const callNext = (turn) => {
  const call = turn.calls.shift();
  if (!call) return timers.set(turn.turnId, setTimeout(() => finish(turn), turn.script.delayMs || 5));
  const id = "tool-" + turn.turnId + "-" + turn.calls.length;
  const waitMatch = /Wait ID: (\\S+)/.exec(turn.text || "");
  for (const key of Object.keys(call.arguments)) if (call.arguments[key] === "$WAIT") call.arguments[key] = waitMatch ? waitMatch[1] : "missing";
  waiting.set(id, turn);
  write({ id, method: "item/tool/call", params: { threadId: turn.threadId, turnId: turn.turnId, callId: "call-" + id, namespace: "openbot", tool: call.tool, arguments: call.arguments } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    // With the process id, so a fake that runs after a restart does not reuse an earlier session id.
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + process.pid + "-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe":
      log({ method: "unsubscribe", threadId: params.threadId });
      return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const note = text.includes(NOTE);
      if (!note) {
        const named = /<<PLAN([\\s\\S]*?)PLAN>>/.exec(text.split("--- current message ---").at(-1));
        scripts.set(params.threadId, named ? JSON.parse(named[1]) : []);
      }
      const script = (scripts.get(params.threadId) || []).shift() || { steps: [] };
      log({ method: "turn", threadId: params.threadId, turnId, note, text });
      const turn = { threadId: params.threadId, turnId, script, text, calls: (script.calls || []).map((c) => ({ ...c, arguments: { ...c.arguments } })) };
      if (script.planEarly) setTimeout(() => write({ method: "turn/plan/updated", params: { threadId: params.threadId, turnId, plan: (script.steps || []).map(([step, status]) => ({ step, status })) } }), 50);
      return callNext(turn);
    }
    case "turn/interrupt": {
      clearTimeout(timers.get(params.turnId));
      timers.delete(params.turnId);
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
      else if (!message.method && waiting.has(message.id)) {
        const turn = waiting.get(message.id);
        waiting.delete(message.id);
        log({ method: "toolResult", result: message.result });
        callNext(turn);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const report: {
  checks: { name: string; passed: boolean; detail?: unknown }[];
  notChecked: string[];
  passed: boolean;
  checkedAt?: string;
  error?: string;
} = {
  checks: [],
  notChecked: ["a wake while the computer sleeps: the shared routine timer holds it, as it holds the routines"],
  passed: false,
};

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
  shareTab: () => undefined,
  unshareThread: () => undefined,
  agentTab: () => null,
};

/** Waits for a state of the service, its database or the fake's log. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

interface LoggedTurn {
  method: string;
  threadId: string;
  turnId: string;
  note: boolean;
  text: string;
}

function loggedEntries(): LoggedTurn[] {
  let text = "";
  try {
    text = readFileSync(fakeLog, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line): LoggedTurn => JSON.parse(line));
}

function loggedTurns(): LoggedTurn[] {
  return loggedEntries().filter((entry) => entry.method === "turn");
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });

function openService() {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const service = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  });
  const events: AgentEvent[] = [];
  service.on("event", (event) => events.push(event));
  return { database, store, mailbox, service, events };
}

let current = openService();

const ended = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

async function createAgent(name: string) {
  const { service } = current;
  const agent = await runCauseEffect(
    service.createAgent({
      name,
      description: "Checks the automatic plan continuation.",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor(`${name}'s first turn`, () =>
    service.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)),
  );
  return agent;
}

/** Sends a message, to the agent's own chat or to its side thread. Answers its delivery id. */
async function send(agentId: string, text: string, taskId?: string): Promise<string> {
  const receipt = await runCauseEffect(
    current.service.sendMessage({ agentId, text, attachmentDraftIds: [], ...(taskId ? { taskId } : {}) }),
  );
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, "The message has a delivery.");
  return deliveryId;
}

/** Waits for the delivery to end, with all of its continuations, and answers its status. */
function settled(deliveryId: string, timeoutMs?: number) {
  return waitFor(
    `delivery ${deliveryId} to end`,
    () => {
      const value = current.mailbox.getDelivery(deliveryId)?.delivery.status;
      return ended(value) ? value : null;
    },
    timeoutMs,
  );
}

const turnsSince = (mark: number) => loggedTurns().slice(mark);

try {
  await runCauseEffect(current.service.initialize());
  const selfWakes = (agentId: string) =>
    current.service
      .listQueue(agentId)
      .deliveries.filter((delivery) => delivery.sender.kind === "agent" && delivery.sender.agentId === agentId);
  /** Moves the wake time of every wait of the agent into the past. The next timer pass finds it due. */
  const makeDue = (agentId: string) =>
    current.database.connection
      .prepare("UPDATE fork_agent_wait_timers SET wake_at = ? WHERE agent_id = ? AND wake_at IS NOT NULL")
      .run("2020-01-01T00:00:00.000Z", agentId);
  const results: { name: string; ok: boolean; detail: unknown }[] = [];
  async function probe(name: string, run: () => Promise<unknown>) {
    if (process.env.ONLY && !process.env.ONLY.split(",").some((k) => name.startsWith(`${k} `))) return;
    try {
      const detail = await run();
      results.push({ name, ok: true, detail });
      process.stdout.write(`PROBE-OK ${name} ${JSON.stringify(detail)}\n`);
    } catch (error) {
      const detail = {
        error: error instanceof Error ? error.message : String(error),
        lastTurns: loggedEntries()
          .slice(-8)
          .map((e) => (e.method === "turn" ? { turn: e.turnId, note: e.note, text: e.text.slice(-700) } : e)),
      };
      results.push({ name, ok: false, detail });
      process.stdout.write(`PROBE-FAIL ${name} :: ${JSON.stringify(detail)}\n`);
    }
  }

  const armer = await createAgent("Armer");
  /** Arms the shared routine timer without a restart: hiding and showing an agent arms it. */
  const arm = async () => {
    await runCauseEffect(current.service.setAgentHidden({ agentId: armer.id, hidden: true }));
    await runCauseEffect(current.service.setAgentHidden({ agentId: armer.id, hidden: false }));
  };
  const timers = (agentId: string) =>
    current.database.connection
      .prepare("SELECT wait_id, wake_at, time_wakes FROM fork_agent_wait_timers WHERE agent_id = ?")
      .all(agentId)
      .map((row) => ({
        wait_id: String(row.wait_id),
        wake_at: row.wake_at === null ? null : String(row.wake_at),
        time_wakes: Number(row.time_wakes),
      }));
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  async function openWait(agentId: string, wakeTurns: FakeTurn[], minutes = 60, extraCalls = 0) {
    const calls = Array.from({ length: 1 + extraCalls }, (_, i) => ({
      tool: "await_event",
      arguments: { note: `Check item ${i} ${plan(...wakeTurns)}`, wakeAfterMinutes: minutes },
    }));
    const id = await send(
      agentId,
      `Watch the build and tell me when it is green. ${plan({ steps: [], calls, answer: "I check back later." })}`,
    );
    assert.equal(await settled(id), "completed");
    return current.service.listWaits(agentId).waits;
  }

  await probe("R1 a reschedule made in a wake turn that runs past the new time is not lost", async () => {
    const agent = await createAgent("Resched");
    const mark = loggedEntries().length;
    await openWait(agent.id, [
      {
        steps: [],
        delayMs: 4_000,
        calls: [{ tool: "await_event", arguments: { note: "again", wakeAfterMinutes: 5 } }],
        answer: "Still red; I rescheduled.",
      },
    ]);
    makeDue(agent.id);
    await arm();
    const wake = await waitFor("wake", () => selfWakes(agent.id)[0]);
    await waitFor("reschedule tool result", () =>
      loggedEntries()
        .slice(mark)
        .some((e) => e.method === "toolResult" && JSON.stringify(e).includes("wake again at")),
    );
    const afterReschedule = timers(agent.id);
    // The turn is still running (4 s). The new time passes while it runs, as a 5-minute time does in a long turn.
    makeDue(agent.id);
    await arm();
    await sleep(300);
    const duringTurn = timers(agent.id);
    assert.equal(await settled(wake.id, 30_000), "completed");
    await sleep(800);
    const after = timers(agent.id);
    const waits = current.service.listWaits(agent.id).waits;
    const detail = { afterReschedule, duringTurn, after, open: waits.length, wakes: selfWakes(agent.id).length };
    assert.ok(
      duringTurn.every((t) => t.wake_at !== null),
      `the running wake turn lost its new time: ${JSON.stringify(detail)}`,
    );
    assert.equal(detail.wakes, 2, `the wait did not wake once more after the turn: ${JSON.stringify(detail)}`);
    return detail;
  });

  await probe("R2 an agent that reschedules in every wake turn stops at the cap of 20 wakes", async () => {
    const agent = await createAgent("Capper");
    await openWait(
      agent.id,
      [
        {
          steps: [],
          calls: [{ tool: "await_event", arguments: { note: "again", wakeAfterMinutes: 5 } }],
          answer: "Not yet.",
        },
      ],
      5,
    );
    let wakes = 0;
    for (let i = 0; i < 24; i++) {
      makeDue(agent.id);
      await arm();
      const before = wakes;
      try {
        await waitFor("next wake", () => selfWakes(agent.id).length > before, 2_500);
      } catch {
        break;
      }
      wakes = selfWakes(agent.id).length;
      const last = selfWakes(agent.id).at(-1);
      if (last) await settled(last.id, 20_000);
      await sleep(150);
    }
    await sleep(1_000);
    const t = timers(agent.id);
    const refusals = loggedEntries().filter(
      (e) => e.method === "toolResult" && JSON.stringify(e).includes("the most it can"),
    ).length;
    const detail = { wakes: selfWakes(agent.id).length, timers: t, refusals };
    assert.equal(selfWakes(agent.id).length, 20, `wakes: ${JSON.stringify(detail)}`);
    assert.ok(
      t.every((r) => r.wake_at === null),
      "no time left after the cap",
    );
    return detail;
  });

  await probe("R3 a wake turn that fails re-arms with backoff, stops at the cap, and does not spin", async () => {
    const agent = await createAgent("Failer");
    await openWait(agent.id, [{ steps: [], fail: true }]);
    const deltas: (number | null)[] = [];
    const statuses: string[] = [];
    for (let i = 0; i < 3; i++) {
      makeDue(agent.id);
      const n = selfWakes(agent.id).length;
      await arm();
      const wake = await waitFor("wake", () => selfWakes(agent.id).length > n && selfWakes(agent.id).at(-1));
      statuses.push(await settled(wake.id, 20_000));
      const row = await waitFor("re-armed", () => timers(agent.id).find((r) => r.wake_at !== null), 5_000).catch(
        () => null,
      );
      deltas.push(row?.wake_at ? Math.round((Date.parse(row.wake_at) - Date.now()) / 60_000) : null);
    }
    current.database.connection
      .prepare("UPDATE fork_agent_wait_timers SET time_wakes = 19 WHERE agent_id = ?")
      .run(agent.id);
    makeDue(agent.id);
    const n = selfWakes(agent.id).length;
    await arm();
    const last = await waitFor("20th wake", () => selfWakes(agent.id).length > n && selfWakes(agent.id).at(-1));
    statuses.push(await settled(last.id, 20_000));
    await sleep(2_000);
    const final = timers(agent.id);
    const wakesAfter = selfWakes(agent.id).length;
    await arm();
    await sleep(1_500);
    const detail = { statuses, deltasMinutes: deltas, final, wakesAfter, wakesLater: selfWakes(agent.id).length };
    assert.deepEqual(deltas, [5, 10, 20], `backoff: ${JSON.stringify(detail)}`);
    assert.ok(final.every((r) => r.wake_at === null) && final[0]?.time_wakes === 20, `cap: ${JSON.stringify(detail)}`);
    assert.equal(wakesAfter, detail.wakesLater, "no spin");
    return detail;
  });

  await probe("R4 two waits due at once: one wake for one agent, one each for two agents", async () => {
    const one = await createAgent("Twin");
    const waits = await openWait(one.id, [{ steps: [], answer: "Both checked." }], 60, 1);
    assert.equal(waits.length, 2, "two waits opened");
    const a = await createAgent("PairA");
    const b = await createAgent("PairB");
    await openWait(a.id, [{ steps: [], answer: "A checked." }]);
    await openWait(b.id, [{ steps: [], answer: "B checked." }]);
    const mark = loggedTurns().length;
    makeDue(one.id);
    makeDue(a.id);
    makeDue(b.id);
    await arm();
    for (const id of [one.id, a.id, b.id]) {
      const w = await waitFor("wake", () => selfWakes(id)[0]);
      await settled(w.id, 20_000);
    }
    await sleep(1_000);
    const twinTurn = turnsSince(mark).find((t) => (t.text.match(/Wait ID:/g) ?? []).length === 2);
    const detail = {
      twinWakes: selfWakes(one.id).length,
      twinTurnNamesBoth: twinTurn !== undefined,
      aWakes: selfWakes(a.id).length,
      bWakes: selfWakes(b.id).length,
    };
    assert.deepEqual(detail, { twinWakes: 1, twinTurnNamesBoth: true, aWakes: 1, bWakes: 1 });
    return detail;
  });

  await probe("R5 an agent deleted while its wait is due: no wake, no error, timer rows gone", async () => {
    const agent = await createAgent("Doomed");
    await openWait(agent.id, [{ steps: [], answer: "NOT REACHED" }]);
    makeDue(agent.id);
    const errorsBefore = current.events.filter((e) => e.type === "error").length;
    await runCauseEffect(current.service.deleteAgent(agent.id));
    await arm();
    await sleep(1_500);
    const errors = current.events.filter((e) => e.type === "error").slice(errorsBefore);
    const detail = {
      timerRows: timers(agent.id).length,
      waitRows: current.database.connection
        .prepare("SELECT COUNT(*) AS n FROM agent_waits WHERE agent_id = ?")
        .get(agent.id),
      errors: errors.map((e) => JSON.stringify(e).slice(0, 200)),
    };
    assert.equal(detail.timerRows, 0);
    assert.equal(errors.length, 0, JSON.stringify(detail));
    return detail;
  });

  await probe("R6 restart between the wake enqueue and markWokenByTime: the wake still names the wait", async () => {
    const agent = await createAgent("Crash");
    const [wait] = await openWait(agent.id, [{ steps: [], answer: "WAKE HANDLED" }]);
    assert.ok(wait);
    makeDue(agent.id);
    const mark = loggedTurns().length;
    await runCauseEffect(current.service.stop());
    current.database.close();
    // As the timer pass would, before the crash: the delivery is stored, the wait is not marked.
    const side = openService();
    await runCauseEffect(side.database.initialize());
    await runCauseEffect(side.store.initialize());
    await runCauseEffect(side.mailbox.initialize());
    await runCauseEffect(
      side.mailbox.enqueue({
        sender: { kind: "agent", agentId: agent.id },
        recipientAgentIds: [agent.id],
        text: wait.note,
        replyToMessageId: null,
        expectsReply: false,
        idempotencyKey: `wait-wake:${wait.id}:0`,
      }),
    );
    side.database.close();
    current = openService();
    await runCauseEffect(current.service.initialize());
    const wake = await waitFor("wake", () => selfWakes(agent.id)[0]);
    await settled(wake.id, 20_000);
    await sleep(1_500);
    const turns = turnsSince(mark);
    const detail = {
      turns: turns.length,
      namesWait: turns.some((t) => t.text.includes(`Wait ID: ${wait.id}`)),
      saysClosed: turns.some((t) => t.text.includes("closed or cancelled before this run started")),
      waits: current.service
        .listWaits(agent.id)
        .waits.map((w) => ({ wakeAt: w.wakeAt, timeWakes: w.timeWakes, wake: w.wakeDeliveryId === wake.id })),
      selfWakes: selfWakes(agent.id).length,
    };
    assert.ok(detail.namesWait && !detail.saysClosed, `lost wake: ${JSON.stringify(detail)}`);
    return detail;
  });

  await probe("R7 the user stops a wake turn: the wait stays open with no time, then the user cancels it", async () => {
    const agent = await createAgent("Stopper");
    const [wait] = await openWait(agent.id, [{ steps: [], delayMs: 15_000, answer: "NOT REACHED" }]);
    assert.ok(wait);
    makeDue(agent.id);
    await arm();
    const wake = await waitFor("wake running", () => {
      const d = selfWakes(agent.id)[0];
      return d && d.status === "running" && current.mailbox.getDelivery(d.id)?.delivery.turnId ? d : null;
    });
    const turnId = current.mailbox.getDelivery(wake.id)?.delivery.turnId ?? "";
    await runCauseEffect(current.service.interrupt(agent.id, turnId));
    const status = await settled(wake.id, 20_000);
    await sleep(1_500);
    const afterStop = timers(agent.id);
    // A further timer pass gives it no time and no wake.
    await arm();
    await sleep(1_000);
    const afterPass = timers(agent.id);
    const openAfterStop = current.service.listWaits(agent.id).waits.length;
    const wakesAfterStop = selfWakes(agent.id).length;
    current.service.cancelWait(agent.id, wait.id);
    makeDue(agent.id);
    await arm();
    await sleep(1_000);
    const detail = {
      status,
      reArmedMinutes: afterStop[0]?.wake_at
        ? Math.round((Date.parse(afterStop[0].wake_at) - Date.now()) / 60_000)
        : null,
      afterPass,
      openAfterStop,
      wakesAfterStop,
      afterCancelTimers: timers(agent.id).length,
      wakes: selfWakes(agent.id).length,
    };
    assert.equal(detail.status, "interrupted");
    assert.equal(detail.reArmedMinutes, null, `a Stop re-armed the wait: ${JSON.stringify(detail)}`);
    assert.ok(
      afterPass.every((t) => t.wake_at === null),
      `a Stop re-armed the wait: ${JSON.stringify(detail)}`,
    );
    assert.equal(openAfterStop, 1, "the wait stays open after the Stop");
    assert.equal(wakesAfterStop, 1);
    assert.equal(detail.afterCancelTimers, 0);
    assert.equal(detail.wakes, 1);
    return detail;
  });

  report.checks.push(...results.map((r) => ({ name: r.name, passed: r.ok, detail: r.detail })));
  report.passed = results.length > 0 && results.every((r) => r.ok);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(current.service.stop()).catch(() => {});
  report.checkedAt = new Date().toISOString();
  current.database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const entry of report.checks) process.stdout.write(`${entry.passed ? "PASS" : "FAIL"} ${entry.name}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
