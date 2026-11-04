// Checks the stall sweep: an agent whose turn ends with an unbacked promise or open plan steps, and with
// nothing that brings it back, gets a nudge. Runs the real agent service on a temporary profile with a
// fake Codex app-server, as `timed-waits-followup-e2e.ts` does. The current message names its turns in
// `<<PLAN[...]PLAN>>`, and the turns of each nudge in `<<NUDGE[[...], [...]]NUDGE>>`.
// Checks:
//   S1   An unbacked promise gets one nudge after the 15-minute grace. The nudge turn opens a wait: no more.
//   S2   Open plan steps after the plan continuation stops with no progress: a nudge.
//   S3   An answer that asks the user a question: no nudge.
//   S4   The user replies before the grace time: no nudge.
//   S5   The agent ignores the nudges: exactly 2 nudges, then 1 alert line, then silence.
//   S6   A restart before the time: the check survives and fires once.
//   S7   A hidden agent gets no nudge until it is visible.
//   S8   A routine run and a channel turn that promise get no check.
//   S9   The user stops the nudge turn: the check ends.
//   S10  A promise in a task: the nudge lands in that task.
// No provider, account or network is used. `bun run test:stall-sweep`. `ONLY=S1,S5` runs some.
// Writes .openbot-build/stall-sweep-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent, PLAN_CONTINUATION_ITEM_TYPE } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/stall-sweep-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-stall-sweep-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");
const NOTE_MARKER = "OpenBot note, not a message from the user";
const NUDGE_HEADER = "OpenBot check: your last turn ended with work still open.";

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
  calls?: { tool: string; arguments: Record<string, string | number | string[]> }[];
}

// "<" and ">" are escaped, so a plan in a message that a turn sends does not end the plan around it.
const plan = (...turns: FakeTurn[]) =>
  `<<PLAN${JSON.stringify(turns).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}PLAN>>`;
/** The turns of each nudge of a request: the first list runs on the first nudge, and so on. */
const nudges = (...lists: FakeTurn[][]) =>
  `<<NUDGE${JSON.stringify(lists).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}NUDGE>>`;

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const NOTE = ${JSON.stringify(NOTE_MARKER)};
const NUDGE = ${JSON.stringify(NUDGE_HEADER)};
/** How many nudges of each request the fake has seen, by the text of its nudge scripts. */
const nudgeCounts = new Map();
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
      const current = text.split("--- current message ---").at(-1);
      if (current.includes(NUDGE)) {
        // A stall nudge repeats the request. Its turns come from the request's nudge scripts, one list each.
        const named = /<<NUDGE([\\s\\S]*?)NUDGE>>/.exec(current);
        const index = nudgeCounts.get(named ? named[1] : "") || 0;
        nudgeCounts.set(named ? named[1] : "", index + 1);
        scripts.set(params.threadId, ((named ? JSON.parse(named[1]) : [])[index] || []).slice());
      } else if (!note) {
        const named = /<<PLAN([\\s\\S]*?)PLAN>>/.exec(current);
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
  notChecked: [
    "a nudge while the computer sleeps: the shared routine timer holds it, as it holds the routines",
    "a scheduled quiet routine run: S8 runs a Test run, which is stricter (not quiet), and every routine run is excluded by its sender",
    "the 12-a-day limit of an agent: unit test only (stall-sweep.test.ts)",
  ],
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

/** Stops the service as the app does when it quits, and starts it again on the same profile. */
async function restart() {
  await runCauseEffect(current.service.stop());
  current.database.close();
  current = openService();
  await runCauseEffect(current.service.initialize());
}

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

/** The messages of the agent's own chat or of one side thread, as the database holds them. */
function chatMessages(agentId: string, sideThreadId?: string) {
  const threadId = sideThreadId ?? current.store.list().find((agent) => agent.id === agentId)?.threadId ?? null;
  return current.database.readConversation(agentId, threadId).messages;
}

/** The continuation lines of the agent's own chat or of one side thread, as the database holds them. */
function continuationLines(agentId: string, sideThreadId?: string) {
  return chatMessages(agentId, sideThreadId).filter((message) => message.itemType === PLAN_CONTINUATION_ITEM_TYPE);
}

const turnsSince = (mark: number) => loggedTurns().slice(mark);

const STALL_ALERT = "stall-alert";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

try {
  await runCauseEffect(current.service.initialize());
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
        checks: current.database.connection.prepare("SELECT * FROM fork_stall_checks").all(),
        lastTurns: loggedEntries()
          .slice(-6)
          .map((e) => (e.method === "turn" ? { turn: e.turnId, note: e.note, text: e.text.slice(-500) } : e)),
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
  const checks = (agentId: string) =>
    current.database.connection
      .prepare(
        "SELECT check_id, task_id, request_delivery_id, due_at, nudges, nudge_delivery_id, created_at, reason FROM fork_stall_checks WHERE agent_id = ?",
      )
      .all(agentId)
      .map((row) => ({
        checkId: String(row.check_id),
        taskId: row.task_id === null ? null : String(row.task_id),
        requestDeliveryId: String(row.request_delivery_id),
        dueAt: row.due_at === null ? null : String(row.due_at),
        nudges: Number(row.nudges),
        nudgeDeliveryId: row.nudge_delivery_id === null ? null : String(row.nudge_delivery_id),
        createdAt: String(row.created_at),
        reason: String(row.reason),
      }));
  /** Moves the time of every stall check of the agent into the past. The next timer pass finds it due. */
  const makeDue = (agentId: string) =>
    current.database.connection
      .prepare("UPDATE fork_stall_checks SET due_at = ? WHERE agent_id = ? AND due_at IS NOT NULL")
      .run("2020-01-01T00:00:00.000Z", agentId);
  const nudgeTurns = (mark: number) => turnsSince(mark).filter((turn) => turn.text.includes(NUDGE_HEADER));
  const alerts = (agentId: string, sideThreadId?: string) =>
    chatMessages(agentId, sideThreadId).filter((message) => message.itemType === STALL_ALERT);
  /** Makes the checks of the agent due, arms the timer, and waits for a nudge turn to end, or for quiet. */
  async function fireAndSettle(agentId: string, mark: number, expectNudges: number) {
    makeDue(agentId);
    await arm();
    if (expectNudges > nudgeTurns(mark).length) {
      await waitFor(`nudge ${expectNudges}`, () => nudgeTurns(mark).length >= expectNudges);
    }
    // The nudge turn ends, and its plan continuation, if any.
    await waitFor("the agent to be idle", () =>
      current.service.listQueue(agentId).deliveries.every((delivery) => ended(delivery.status)),
    );
    await sleep(800);
  }
  const PROMISE = "I emailed the 3 vendors. I'll let you know when they reply.";
  const REQUEST = "Find 3 printer quotes from local vendors.";
  const promiseTurn: FakeTurn = { steps: [], answer: PROMISE };

  // S1: an unbacked promise gets one nudge after the grace time. The nudge turn opens a wait: no more nudges.
  await probe(
    "S1 unbacked promise: one nudge after grace, then the agent opens a wait and is not nudged again",
    async () => {
      const agent = await createAgent("Promiser");
      const mark = loggedTurns().length;
      const id = await send(
        agent.id,
        `${REQUEST} ${plan(promiseTurn)} ${nudges([
          {
            steps: [],
            calls: [{ tool: "await_event", arguments: { note: "Check vendor replies.", wakeAfterMinutes: 120 } }],
            answer: "I opened a wait. I check the replies in 2 hours.",
          },
        ])}`,
      );
      assert.equal(await settled(id), "completed");
      const [check] = checks(agent.id);
      assert.ok(check?.dueAt, "the turn has a stall check with a time");
      const graceMinutes = (Date.parse(check.dueAt) - Date.parse(check.createdAt)) / 60_000;
      assert.equal(Math.round(graceMinutes), 15, "the first check is 15 minutes after the turn");
      assert.equal(check.requestDeliveryId, id);
      await arm();
      await sleep(800);
      assert.equal(nudgeTurns(mark).length, 0, "no nudge before the grace time");
      await fireAndSettle(agent.id, mark, 1);
      const [nudge] = nudgeTurns(mark);
      assert.ok(nudge?.text.includes(REQUEST), "the nudge repeats the request");
      assert.ok(nudge?.text.includes("I'll let you know when they reply."), "the nudge quotes the promise");
      assert.ok(nudge?.text.includes("openbot.await_event"), "the nudge names the wait tool");
      assert.deepEqual(checks(agent.id), [], "the wait ends the check");
      assert.equal(current.service.listWaits(agent.id).waits.length, 1, "the nudge turn opened a wait");
      await fireAndSettle(agent.id, mark, 1);
      await restart();
      await sleep(1_500);
      assert.equal(nudgeTurns(mark).length, 1, "exactly one nudge");
      return { graceMinutes, nudges: nudgeTurns(mark).length, waits: current.service.listWaits(agent.id).waits.length };
    },
  );

  // S2: the plan has open steps, and the continuation ends with no progress: a nudge.
  await probe("S2 open plan steps after the continuation stops: a nudge", async () => {
    const agent = await createAgent("Planner");
    const mark = loggedTurns().length;
    const stuck: FakeTurn = {
      steps: [
        ["Draft the report", "completed"],
        ["Send the report", "pending"],
      ],
      answer: "The draft is ready.",
    };
    const id = await send(
      agent.id,
      `Write and send the report. ${plan(stuck, stuck)} ${nudges([
        {
          steps: [
            ["Draft the report", "completed"],
            ["Send the report", "completed"],
          ],
          answer: "The report is sent. All work is done.",
        },
      ])}`,
    );
    assert.equal(await settled(id), "completed");
    const continued = turnsSince(mark).filter((turn) => turn.note).length;
    assert.equal(continued, 1, "the plan continued once and stopped with no progress");
    assert.equal(continuationLines(agent.id).length, 1, "one continuation line shows");
    const [check] = checks(agent.id);
    assert.ok(check?.reason.includes("Send the report"), "the check names the open step");
    await fireAndSettle(agent.id, mark, 1);
    assert.equal(nudgeTurns(mark).length, 1);
    assert.ok(chatMessages(agent.id).some((message) => message.text === "The report is sent. All work is done."));
    assert.deepEqual(checks(agent.id), [], "the finished nudge turn ends the check");
    return { continued, nudges: nudgeTurns(mark).length };
  });

  // S3: an answer that asks the user waits for the user: no check.
  await probe("S3 the answer asks the user a question: no nudge", async () => {
    const agent = await createAgent("Asker");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${REQUEST} ${plan({ steps: [], answer: "I found 3 vendors. I'll follow up once you pick one. Which one do you want?" })}`,
    );
    assert.equal(await settled(id), "completed");
    assert.deepEqual(checks(agent.id), []);
    await fireAndSettle(agent.id, mark, 0);
    assert.equal(nudgeTurns(mark).length, 0);
    return { checks: 0, nudges: 0 };
  });

  // S4: the user writes before the grace time ends: no nudge.
  await probe("S4 the user replies before the grace time: no nudge", async () => {
    const agent = await createAgent("Replied");
    const mark = loggedTurns().length;
    const id = await send(agent.id, `${REQUEST} ${plan(promiseTurn)}`);
    assert.equal(await settled(id), "completed");
    assert.equal(checks(agent.id).length, 1, "the promise has a check");
    const reply = await send(agent.id, "Thanks. Skip vendor C.");
    assert.equal(await settled(reply), "completed");
    assert.deepEqual(checks(agent.id), [], "the newer turn ends the check");
    await fireAndSettle(agent.id, mark, 0);
    assert.equal(nudgeTurns(mark).length, 0);
    return { nudges: 0 };
  });

  // S5: the agent ignores the nudges: exactly 2 nudges, then one alert line, then silence.
  await probe("S5 the agent ignores the nudges: 2 nudges, then 1 alert, then silence", async () => {
    const agent = await createAgent("Ignorer");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${REQUEST} ${plan(promiseTurn)} ${nudges(
        [{ steps: [], answer: "Still waiting. I'll let you know when they reply." }],
        [{ steps: [], answer: "I'll keep you posted." }],
        [{ steps: [], answer: "NOT REACHED" }],
      )}`,
    );
    assert.equal(await settled(id), "completed");
    await fireAndSettle(agent.id, mark, 1);
    const [second] = checks(agent.id);
    assert.equal(second?.nudges, 1, "the nudge turn keeps the count of its request");
    assert.equal(second?.requestDeliveryId, id, "the nudge turn keeps the request");
    assert.equal(
      Math.round((Date.parse(second?.dueAt ?? "") - Date.now()) / 60_000),
      60,
      "the second check is 60 minutes after the nudge turn",
    );
    await fireAndSettle(agent.id, mark, 2);
    assert.deepEqual(checks(agent.id), [], "no check after the limit");
    assert.equal(alerts(agent.id).length, 1, "one alert line for the user");
    await fireAndSettle(agent.id, mark, 2);
    await restart();
    await sleep(1_500);
    assert.equal(nudgeTurns(mark).length, 2, "exactly 2 nudges");
    assert.equal(alerts(agent.id).length, 1, "exactly 1 alert");
    return { nudges: nudgeTurns(mark).length, alerts: alerts(agent.id).length, alert: alerts(agent.id)[0]?.text };
  });

  // S6: a restart before the time: the check survives and fires once.
  await probe("S6 a restart before the time: the check survives and fires once", async () => {
    const agent = await createAgent("Restarted");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${REQUEST} ${plan(promiseTurn)} ${nudges([{ steps: [], answer: "All 3 vendors replied. Vendor B is cheapest." }])}`,
    );
    assert.equal(await settled(id), "completed");
    const before = checks(agent.id);
    assert.equal(before.length, 1);
    await restart();
    assert.deepEqual(checks(agent.id), before, "the check survives the restart");
    makeDue(agent.id);
    await restart();
    await waitFor("the nudge after the restart", () => nudgeTurns(mark).length >= 1);
    await waitFor("the agent to be idle", () =>
      current.service.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)),
    );
    await restart();
    await sleep(1_500);
    assert.equal(nudgeTurns(mark).length, 1, "exactly one nudge");
    assert.deepEqual(checks(agent.id), []);
    return { nudges: nudgeTurns(mark).length };
  });

  // S7: a hidden agent gets no nudge until it shows again.
  await probe("S7 a hidden agent gets no nudge until it is visible", async () => {
    const agent = await createAgent("Hidden");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${REQUEST} ${plan(promiseTurn)} ${nudges([{ steps: [], answer: "All 3 vendors replied. Vendor A is cheapest." }])}`,
    );
    assert.equal(await settled(id), "completed");
    await runCauseEffect(current.service.setAgentHidden({ agentId: agent.id, hidden: true }));
    makeDue(agent.id);
    await arm();
    await sleep(1_500);
    assert.equal(nudgeTurns(mark).length, 0, "no nudge while hidden");
    assert.equal(checks(agent.id).length, 1, "the check waits");
    await runCauseEffect(current.service.setAgentHidden({ agentId: agent.id, hidden: false }));
    await waitFor("the nudge after the agent shows", () => nudgeTurns(mark).length >= 1);
    await waitFor("the agent to be idle", () =>
      current.service.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)),
    );
    await sleep(500);
    assert.equal(nudgeTurns(mark).length, 1);
    return { nudges: nudgeTurns(mark).length };
  });

  // S8: a routine run and a channel turn get no check.
  await probe("S8 a routine run and a channel turn that promise get no check", async () => {
    const agent = await createAgent("Excluded");
    const routine = current.service.createRoutine(
      {
        agentId: agent.id,
        name: "Vendor check",
        instruction: `Check the vendors. ${plan(promiseTurn)}`,
        active: false,
        timezone: "UTC",
        schedule: { kind: "custom", expression: "0 9 * * *" },
      },
      { recordConversationEvent: false },
    );
    await runCauseEffect(current.service.testRoutine({ agentId: agent.id, routineId: routine.id }));
    await waitFor("the routine run to end", () => {
      const [run] = current.service.listRoutineRuns({ agentId: agent.id, routineId: routine.id });
      return run && (run.status === "succeeded" || ended(run.status)) ? run : null;
    });
    await sleep(500);
    assert.deepEqual(checks(agent.id), [], "no check for a routine run");
    const channelId = randomUUID();
    const actor = { id: "local", name: "Alex" };
    await runCauseEffect(
      current.service.channels.command(
        {
          type: "save",
          operationId: randomUUID(),
          channelId,
          draft: {
            name: "Vendors",
            title: "",
            instructions: "Do the assigned work.",
            members: [{ agentId: agent.id }],
            leadAgentId: agent.id,
          },
        },
        actor,
      ),
    );
    const mark = loggedTurns().length;
    await runCauseEffect(
      current.service.channels.command(
        {
          type: "send",
          operationId: randomUUID(),
          channelId,
          text: `${REQUEST} ${plan(promiseTurn)}`,
          recipientAgentId: agent.id,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        actor,
      ),
    );
    await waitFor("the channel turn", () => turnsSince(mark).some((turn) => turn.text.includes(REQUEST)), 30_000);
    await waitFor("the channel task to end", () =>
      current.service.channels.store
        .tasks(channelId)
        .find((task) => ["completed", "failed", "paused"].includes(task.state)),
    );
    await sleep(800);
    assert.deepEqual(checks(agent.id), [], "no check for a channel turn");
    return { checks: 0 };
  });

  // S9: the user stops the nudge turn: the check ends.
  await probe("S9 the user stops the nudge turn: the check ends", async () => {
    const agent = await createAgent("Stopper");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${REQUEST} ${plan(promiseTurn)} ${nudges([{ steps: [], delayMs: 60_000, answer: "NOT REACHED" }])}`,
    );
    assert.equal(await settled(id), "completed");
    makeDue(agent.id);
    await arm();
    const nudge = await waitFor("the nudge turn", () => nudgeTurns(mark)[0]);
    await runCauseEffect(current.service.interrupt(agent.id, nudge.turnId));
    await waitFor("the agent to be idle", () =>
      current.service.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)),
    );
    await sleep(500);
    assert.deepEqual(checks(agent.id), [], "Stop ends the check");
    await fireAndSettle(agent.id, mark, 1);
    await restart();
    await sleep(1_500);
    assert.equal(nudgeTurns(mark).length, 1, "no nudge after the Stop");
    return { nudges: nudgeTurns(mark).length };
  });

  // S10: a promise in a task side thread: the nudge runs in that task.
  await probe("S10 a promise in a task: the nudge lands in that task", async () => {
    const agent = await createAgent("Tasker");
    const mark = loggedTurns().length;
    const task = await runCauseEffect(
      current.service.startTask({
        agentId: agent.id,
        text: `${REQUEST} ${plan({ steps: [], answer: PROMISE })} ${nudges([
          { steps: [], answer: "TASK REPORT: all 3 vendors replied. Vendor C is cheapest." },
        ])}`,
      }),
    );
    await waitFor("the task answer", () =>
      current.service.readTask(agent.id, task.id).messages.some((message) => message.text === PROMISE),
    );
    await sleep(800);
    const [check] = checks(agent.id);
    assert.equal(check?.taskId, task.id, "the check is in the task lane");
    await fireAndSettle(agent.id, mark, 1);
    await waitFor("the task report", () =>
      current.service
        .readTask(agent.id, task.id)
        .messages.some((message) => message.text === "TASK REPORT: all 3 vendors replied. Vendor C is cheapest."),
    );
    const turns = turnsSince(mark);
    const [nudge] = nudgeTurns(mark);
    assert.equal(nudge?.threadId, turns[0]?.threadId, "the nudge runs in the task's session");
    assert.ok(!chatMessages(agent.id).some((message) => message.text?.includes("TASK REPORT")), "not in the own chat");
    assert.deepEqual(checks(agent.id), []);
    return { nudges: nudgeTurns(mark).length };
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
