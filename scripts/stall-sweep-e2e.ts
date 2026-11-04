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
//   S11  An answer that waits on the user ("When you are ready, I'll start the migration."): no nudge.
//   S12  A teammate's message after a promise: the check stays, and the nudge comes.
//   S13  An older open wait of other work in the lane: a new promise still gets a check.
//   S14  An answer that waits on an approval ("After approval I'll deploy and report back."): no nudge.
//   S15  A draft for review with an open "Send" step ("Let me know what you think."): no plan
//        continuation and no check.
//   S16  A status question while the timed wait of the first request is open: no nudge.
//   S17  A busy lane at the due time: the check is put off, and the nudge comes when the lane is free.
//   S18  A nudge turn is a check-in only: its read-only sandbox and "untrusted" approvals reach Codex,
//        OpenBot refuses its send_message and execute_data calls, and declines its command approval.
//        It can still open a wait.
//   S19  "Please review and approve." with an open "Send the email" step: no plan continuation, no
//        check and no nudge.
//   S20  "Tomorrow I'll pay the supplier.": the check is due after tomorrow 09:00 local (today 09:00
//        before 05:00), not in 15 minutes, and no nudge comes before then.
//   S21  A nudge turn calls create_routine and update_routine: both are refused, and no routine exists.
//   S22  A restart during a nudge turn with open plan steps: no continuation runs after the restart.
//   S23  With OPENBOT_STALL_NUDGE_PROVIDERS unset, a Codex agent whose Codex config turns on a plugin:
//        no nudge, and the alert line.
//   S24  A wait that a nudge turn opens keeps the request of the user, not the text of the nudge.
//   S25  With OPENBOT_STALL_NUDGE_PROVIDERS unset, a Codex agent whose Codex config turns all off: no
//        nudge, and the alert line (review 8: only Claude gets nudges by default).
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
const fakeConfig = join(root, "codex-config.json");
const NOTE_MARKER = "OpenBot note, not a message from the user";
const NUDGE_HEADER = "OpenBot check: your last turn ended with work still open.";

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
// Review 8: by default only Claude gets nudges. The fake Codex runs the nudge path through this test
// switch; S23 and S25 unset it and check the default.
const NUDGE_PROVIDERS = "claude,codex";
process.env.OPENBOT_STALL_NUDGE_PROVIDERS = NUDGE_PROVIDERS;
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
  calls?: { tool: string; arguments: Record<string, string | number | boolean | string[] | Record<string, string>> }[];
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
// The effective Codex config: apps, plugins, the browser and computer use are off, so a nudge can run.
// A case writes CONFIG_FILE to change it; the fake reads the file at each config/read.
const CONFIG_FILE = ${JSON.stringify(fakeConfig)};
const OFF = { apps: false, plugins: false, browser_use: false, computer_use: false };
const readConfig = () => {
  let own = { mcp_servers: {}, features: OFF };
  try { own = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
  return { config: own, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: own }] };
};
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
  if (call.tool === "$approval") {
    // A command that asks for approval, as Codex asks with the "untrusted" policy.
    waiting.set(id, turn);
    return write({ id, method: "item/commandExecution/requestApproval", params: { threadId: turn.threadId, turnId: turn.turnId, itemId: "cmd-" + id, command: call.arguments.command, cwd: "/tmp", reason: null } });
  }
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
    case "config/read": return write({ id: message.id, result: readConfig() });
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
      log({ method: "turn", threadId: params.threadId, turnId, note, text, approvalPolicy: params.approvalPolicy, sandboxPolicy: params.sandboxPolicy });
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
        log({ method: "toolResult", turnId: turn.turnId, result: message.result });
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
  approvalPolicy?: unknown;
  sandboxPolicy?: unknown;
  result?: unknown;
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

  // S11: an answer that waits on an act of the user is not a promise: no check, no nudge.
  await probe("S11 the answer waits on the user: no nudge", async () => {
    const agent = await createAgent("Planned");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `Plan the database migration. ${plan({
        steps: [],
        answer: "Here is the migration plan. When you are ready, I'll start the migration.",
      })} ${nudges([{ steps: [], answer: "NOT REACHED" }])}`,
    );
    assert.equal(await settled(id), "completed");
    assert.deepEqual(checks(agent.id), [], "no check for an answer that waits on the user");
    await fireAndSettle(agent.id, mark, 0);
    assert.equal(nudgeTurns(mark).length, 0, "no nudge");
    return { checks: 0, nudges: 0 };
  });

  // S12: a teammate's message in the own chat after a promise does not end the check.
  await probe("S12 a teammate's message after a promise: the check stays, and the nudge comes", async () => {
    const agent = await createAgent("Target");
    const mate = await createAgent("Mate");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${REQUEST} ${plan(promiseTurn)} ${nudges([{ steps: [], answer: "All 3 vendors replied. Vendor B is cheapest." }])}`,
    );
    assert.equal(await settled(id), "completed");
    const before = checks(agent.id);
    assert.equal(before.length, 1, "the promise has a check");
    const sent = await send(
      mate.id,
      `Tell Target about Friday. ${plan({
        steps: [],
        answer: "Sent.",
        calls: [
          {
            tool: "send_message",
            arguments: {
              recipientAgentIds: [agent.id],
              text: `FYI the office is closed Friday. ${plan({ steps: [], answer: "Noted." })}`,
              expectsReply: false,
            },
          },
        ],
      })}`,
    );
    await settled(sent);
    await waitFor("the teammate turn of the target", () =>
      turnsSince(mark).some((turn) => turn.text.includes("office is closed")),
    );
    await waitFor("the target to be idle", () =>
      current.service.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)),
    );
    await sleep(800);
    assert.deepEqual(checks(agent.id), before, "the teammate's message keeps the check");
    await fireAndSettle(agent.id, mark, 1);
    assert.equal(nudgeTurns(mark).length, 1, "the nudge comes");
    assert.deepEqual(checks(agent.id), []);
    return { checksAfterTeammate: before.length, nudges: nudgeTurns(mark).length };
  });

  // S13: an older wait of other work in the lane does not turn the sweep off for a new request.
  await probe("S13 an older open wait of other work: a new promise still gets a check", async () => {
    const agent = await createAgent("LongWait");
    const watch = await send(
      agent.id,
      `Watch the domain renewal. ${plan({
        steps: [],
        answer: "Wait opened.",
        calls: [{ tool: "await_event", arguments: { note: "Check the renewal.", wakeAfterMinutes: 600 } }],
      })}`,
    );
    assert.equal(await settled(watch), "completed");
    assert.equal(current.service.listWaits(agent.id).waits.length, 1, "the wait is open");
    const id = await send(agent.id, `${REQUEST} ${plan(promiseTurn)}`);
    assert.equal(await settled(id), "completed");
    await sleep(500);
    const [check] = checks(agent.id);
    assert.equal(check?.requestDeliveryId, id, "the new promise has a check");
    return { waits: current.service.listWaits(agent.id).waits.length, checks: checks(agent.id).length };
  });

  // S14: an answer that waits on an approval, with no "you" as subject, is not a promise.
  await probe("S14 the answer waits on an approval: no nudge", async () => {
    const agent = await createAgent("Gated");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `Prepare the production deploy. ${plan({
        steps: [],
        answer: "The deploy plan is ready. After approval I'll deploy and report back.",
      })} ${nudges([{ steps: [], answer: "NOT REACHED" }])}`,
    );
    assert.equal(await settled(id), "completed");
    await sleep(500);
    assert.deepEqual(checks(agent.id), [], "no check for an answer that waits on an approval");
    await fireAndSettle(agent.id, mark, 0);
    assert.equal(nudgeTurns(mark).length, 0, "no nudge");
    return { checks: 0, nudges: 0 };
  });

  // S15: a draft for review with an open "Send" step: no plan continuation and no open-steps check.
  await probe("S15 a draft for review with an open send step: no continuation and no check", async () => {
    const agent = await createAgent("Drafter");
    const mark = loggedTurns().length;
    const turn: FakeTurn = {
      steps: [
        ["Draft the email to the board", "completed"],
        ["Send the email to the board", "pending"],
      ],
      answer: "Here's the draft email to the board. Let me know what you think.",
    };
    const id = await send(agent.id, `Draft an email to the board about the budget. ${plan(turn, turn, turn)}`);
    assert.equal(await settled(id, 30_000), "completed");
    await waitFor("idle", () => current.service.listQueue(agent.id).deliveries.every((d) => ended(d.status)));
    await sleep(800);
    const continuationTurns = turnsSince(mark).filter((entry) => entry.note).length;
    assert.equal(continuationTurns, 0, "no plan continuation");
    assert.equal(continuationLines(agent.id).length, 0, "no continuation line");
    assert.deepEqual(checks(agent.id), [], "no open-steps check");
    await fireAndSettle(agent.id, mark, 0);
    assert.equal(nudgeTurns(mark).length, 0, "no nudge");
    return { continuationTurns, checks: 0, nudges: 0 };
  });

  // S16: a status question while the timed wait of the first request is open gets no false nudge.
  await probe("S16 a status question while the request's timed wait is open: no nudge", async () => {
    const agent = await createAgent("Status");
    const mark = loggedTurns().length;
    const first = await send(
      agent.id,
      `Watch the deploy and tell me when it is done. ${plan({
        steps: [],
        answer: "I opened a wait and will check the deploy in 2 hours.",
        calls: [{ tool: "await_event", arguments: { note: "Check the deploy.", wakeAfterMinutes: 120 } }],
      })}`,
    );
    assert.equal(await settled(first), "completed");
    assert.equal(current.service.listWaits(agent.id).waits.length, 1, "the timed wait is open");
    const second = await send(
      agent.id,
      `Any news on the deploy? ${plan({ steps: [], answer: "Not yet. Still running. I'll let you know when it finishes." })} ${nudges([{ steps: [], answer: "NOT REACHED" }])}`,
    );
    assert.equal(await settled(second), "completed");
    await sleep(500);
    await fireAndSettle(agent.id, mark, 0);
    assert.equal(nudgeTurns(mark).length, 0, "no nudge while the timed wait is open");
    assert.deepEqual(checks(agent.id), [], "the timed wait ends the check");
    assert.equal(current.service.listWaits(agent.id).waits.length, 1, "the wait stays open");
    return { nudges: 0, waits: 1 };
  });

  // S17: a teammate's long turn holds the lane when the check falls due: the check waits, then nudges.
  await probe("S17 a busy lane at the due time: the check is put off, then the nudge comes", async () => {
    const agent = await createAgent("Busy");
    const mate = await createAgent("Mate2");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${REQUEST} ${plan(promiseTurn)} ${nudges([{ steps: [], answer: "All 3 vendors replied. Vendor A is cheapest." }])}`,
    );
    assert.equal(await settled(id), "completed");
    await sleep(300);
    assert.equal(checks(agent.id).length, 1, "the promise has a check");
    const sent = await send(
      mate.id,
      `Tell the target. ${plan({
        steps: [],
        answer: "Sent.",
        calls: [
          {
            tool: "send_message",
            arguments: {
              recipientAgentIds: [agent.id],
              text: `FYI the printer moved. ${plan({ steps: [], answer: "Noted.", delayMs: 3000 })}`,
              expectsReply: false,
            },
          },
        ],
      })}`,
    );
    await settled(sent);
    await waitFor("the teammate turn of the target", () =>
      turnsSince(mark).some((turn) => turn.text.includes("FYI the printer moved.")),
    );
    makeDue(agent.id);
    await arm();
    await sleep(500);
    const duringBusy = checks(agent.id);
    assert.equal(duringBusy.length, 1, "the busy lane keeps the check");
    assert.ok((duringBusy[0]?.dueAt ?? "") > new Date().toISOString(), "the check is put off");
    assert.equal(nudgeTurns(mark).length, 0, "no nudge while the lane is busy");
    await waitFor("the target to be idle", () =>
      current.service.listQueue(agent.id).deliveries.every((delivery) => ended(delivery.status)),
    );
    await sleep(800);
    await fireAndSettle(agent.id, mark, 1);
    assert.equal(nudgeTurns(mark).length, 1, "the nudge comes when the lane is free");
    return { duringBusy: duringBusy.length, nudges: nudgeTurns(mark).length };
  });

  // S18: a nudge turn is a check-in only. Codex gets a read-only sandbox and "untrusted" approvals, and
  // OpenBot refuses each tool that acts and declines each approval of the turn.
  await probe("S18 a nudge turn cannot act: its send and write calls are refused", async () => {
    const agent = await createAgent("Restricted");
    const target = await createAgent("Bystander");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${REQUEST} ${plan(promiseTurn)} ${nudges([
        {
          steps: [],
          calls: [
            {
              tool: "send_message",
              arguments: { recipientAgentIds: [target.id], text: "Please pay the supplier now.", expectsReply: false },
            },
            { tool: "execute_data", arguments: { sql: "DELETE FROM quotes" } },
            { tool: "$approval", arguments: { command: "curl -X POST https://example.com/pay" } },
            { tool: "await_event", arguments: { note: "Check vendor replies.", wakeAfterMinutes: 120 } },
          ],
          answer: "I could not act in this turn. I opened a wait for the vendor replies.",
        },
      ])}`,
    );
    assert.equal(await settled(id), "completed");
    const userTurnLog = turnsSince(mark).find((turn) => !turn.text.includes(NUDGE_HEADER));
    assert.equal(userTurnLog?.approvalPolicy, "on-request", "a user turn keeps its approval policy");
    await fireAndSettle(agent.id, mark, 1);
    const [nudge] = nudgeTurns(mark);
    assert.ok(nudge, "the nudge turn ran");
    assert.ok(nudge.text.includes("This turn is a check-in only. You cannot act in it."), "the nudge says so");
    assert.deepEqual(nudge.sandboxPolicy, { type: "readOnly", networkAccess: false }, "read-only sandbox");
    assert.equal(nudge.approvalPolicy, "untrusted", "every command that is not known safe asks");
    const results = loggedEntries().filter((entry) => entry.method === "toolResult" && entry.turnId === nudge.turnId);
    assert.equal(results.length, 4, "the fake got 4 answers");
    const [sendResult, dataResult, approval, wait] = results.map((entry) => JSON.stringify(entry.result));
    assert.ok(sendResult?.includes("This turn is a check-in only"), `send_message is refused: ${sendResult}`);
    assert.ok(dataResult?.includes("This turn is a check-in only"), `execute_data is refused: ${dataResult}`);
    assert.ok(approval?.includes('"decline"'), `the command approval is declined: ${approval}`);
    assert.ok(!wait?.includes("check-in only"), "await_event is allowed");
    assert.equal(
      current.service
        .listQueue(target.id)
        .deliveries.filter((delivery) => delivery.sender.kind === "agent" && delivery.sender.agentId === agent.id)
        .length,
      0,
      "the bystander got no message",
    );
    assert.equal(current.service.listWaits(agent.id).waits.length, 1, "the nudge turn opened a wait");
    // The next turn of the user runs with its normal policies again.
    const next = await send(agent.id, `Thanks. ${plan({ steps: [], answer: "OK." })}`);
    assert.equal(await settled(next), "completed");
    const after = turnsSince(mark).at(-1);
    assert.equal(after?.approvalPolicy, "on-request", "the next turn is not restricted");
    return { sandbox: nudge.sandboxPolicy, approvalPolicy: nudge.approvalPolicy, refused: 2, declined: 1 };
  });

  // S19: review 6, R1. A draft that waits for approval, with an open send step.
  await probe("S19 a draft that waits for approval with an open send step: no continuation, no nudge", async () => {
    const agent = await createAgent("Reviewer");
    const mark = loggedTurns().length;
    const turn: FakeTurn = {
      steps: [
        ["Draft the email to the board", "completed"],
        ["Send the email to the board", "pending"],
      ],
      answer: "Here's the draft email to the board. Please review and approve.",
    };
    const id = await send(
      agent.id,
      `Draft an email to the board about the budget. ${plan(turn, { ...turn, answer: "SENT (must not happen)" })} ${nudges([{ steps: [], answer: "NOT REACHED" }])}`,
    );
    assert.equal(await settled(id), "completed");
    await sleep(500);
    const continuationTurns = turnsSince(mark).filter((entry) => entry.note).length;
    assert.equal(continuationTurns, 0, "no plan continuation");
    assert.equal(continuationLines(agent.id).length, 0);
    assert.deepEqual(checks(agent.id), [], "no check");
    await fireAndSettle(agent.id, mark, 0);
    assert.equal(nudgeTurns(mark).length, 0, "no nudge");
    return { continuationTurns, checks: 0, nudges: 0 };
  });

  // S20: review 6, R3. A promise for tomorrow is checked after tomorrow, not in 15 minutes.
  await probe("S20 a promise for tomorrow: no nudge before tomorrow", async () => {
    const agent = await createAgent("Payer");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `Check the supplier invoice. ${plan({ steps: [], answer: "Invoice checked. Tomorrow I'll pay the supplier." })} ${nudges([{ steps: [], answer: "Waiting for tomorrow." }])}`,
    );
    assert.equal(await settled(id), "completed");
    const [check] = checks(agent.id);
    assert.ok(check?.dueAt, "the promise has a check");
    // Said before 05:00, "tomorrow" is the coming day: today (review 7, T1).
    const tomorrowNine = new Date(Date.parse(check.createdAt));
    if (tomorrowNine.getHours() >= 5) tomorrowNine.setDate(tomorrowNine.getDate() + 1);
    tomorrowNine.setHours(9, 0, 0, 0);
    assert.ok(
      Date.parse(check.dueAt) >= tomorrowNine.getTime() + 15 * 60_000,
      `due after tomorrow 09:15: ${check.dueAt}`,
    );
    await arm();
    await sleep(800);
    assert.equal(nudgeTurns(mark).length, 0, "no nudge before tomorrow");
    assert.equal(checks(agent.id).length, 1, "the check waits");
    return { dueAt: check.dueAt, nudges: 0 };
  });

  // S21: review 7, H1 (probe Q1). A nudge turn cannot make or change a routine: a routine runs later as
  // a normal turn, with no restriction.
  await probe("S21 a nudge turn cannot make or change a routine", async () => {
    const agent = await createAgent("Scheduler");
    const target = await createAgent("Victim");
    const mark = loggedTurns().length;
    const at = new Date(Date.now() + 2 * 60_000);
    const pad = (value: number) => String(value).padStart(2, "0");
    const schedule = {
      kind: "once",
      date: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`,
      time: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`,
    };
    const id = await send(
      agent.id,
      `${REQUEST} ${plan(promiseTurn)} ${nudges([
        {
          steps: [],
          calls: [
            {
              tool: "create_routine",
              arguments: {
                agentId: target.id,
                name: "Pay now",
                instruction: "Send the payment email to the supplier now.",
                schedule,
                timezone: "UTC",
              },
            },
            { tool: "update_routine", arguments: { routineId: "nonexistent", active: true } },
          ],
          answer: "I could not make a routine.",
        },
      ])}`,
    );
    assert.equal(await settled(id), "completed");
    await fireAndSettle(agent.id, mark, 1);
    const [nudge] = nudgeTurns(mark);
    assert.ok(nudge, "the nudge turn ran");
    assert.ok(!nudge.text.includes("openbot.create_routine"), "the nudge does not suggest a routine");
    const results = loggedEntries()
      .filter((entry) => entry.method === "toolResult" && entry.turnId === nudge.turnId)
      .map((entry) => JSON.stringify(entry.result));
    assert.equal(results.length, 2, "the fake got 2 answers");
    for (const result of results) assert.ok(result.includes("This turn is a check-in only"), `refused: ${result}`);
    assert.deepEqual(current.service.listRoutines(target.id), [], "the other agent has no routine");
    assert.deepEqual(current.service.listRoutines(agent.id), [], "the agent has no routine");
    return { refused: results.length };
  });

  // S22: review 7, M2 (probe Q4). A restart during a nudge turn with open plan steps: no continuation.
  await probe("S22 a restart during a nudge turn: no continuation after the restart", async () => {
    const agent = await createAgent("Restarter");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${REQUEST} ${plan(promiseTurn)} ${nudges([
        {
          steps: [
            ["Collect quotes", "completed"],
            ["Compare the quotes", "pending"],
          ],
          planEarly: true,
          delayMs: 60_000,
        },
      ])}`,
    );
    assert.equal(await settled(id), "completed");
    makeDue(agent.id);
    await arm();
    await waitFor("the nudge turn to run", () => nudgeTurns(mark).length >= 1);
    await sleep(500);
    await restart();
    await sleep(4_000);
    const continued = turnsSince(mark).filter((turn) => turn.note);
    assert.deepEqual(
      continued.map((turn) => ({ approvalPolicy: turn.approvalPolicy, sandboxPolicy: turn.sandboxPolicy })),
      [],
      "no continuation turn after the restart",
    );
    assert.equal(nudgeTurns(mark).length, 1, "the nudge did not run again");
    return { continued: continued.length };
  });

  /** Runs a probe with the default nudge providers: OPENBOT_STALL_NUDGE_PROVIDERS unset. */
  const withDefaultProviders = async <T>(run: () => Promise<T>): Promise<T> => {
    delete process.env.OPENBOT_STALL_NUDGE_PROVIDERS;
    try {
      return await run();
    } finally {
      process.env.OPENBOT_STALL_NUDGE_PROVIDERS = NUDGE_PROVIDERS;
    }
  };
  /** A Codex agent with a promise and no backing wait: no nudge, one alert line, and the check ends. */
  const codexGetsAlert = async (name: string) => {
    const agent = await createAgent(name);
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${REQUEST} ${plan(promiseTurn)} ${nudges([{ steps: [], answer: "NOT REACHED" }])}`,
    );
    assert.equal(await settled(id), "completed");
    assert.equal(checks(agent.id).length, 1, "the promise has a check");
    await fireAndSettle(agent.id, mark, 0);
    assert.equal(nudgeTurns(mark).length, 0, "no nudge");
    assert.equal(alerts(agent.id).length, 1, "one alert line");
    assert.deepEqual(checks(agent.id), [], "the check ends");
    return { nudges: 0, alerts: alerts(agent.id).length };
  };

  // S23: a Codex agent whose own Codex config turns on a plugin gets no nudge by default: a plugin
  // tool runs outside the sandbox. The user gets the alert line.
  await probe("S23 a Codex config with a plugin on: no nudge, the alert line", async () => {
    await writeFile(
      fakeConfig,
      JSON.stringify({
        mcp_servers: {},
        features: { apps: false, plugins: false, browser_use: false, computer_use: false },
        plugins: { "gmail@openai-curated": { enabled: true } },
      }),
    );
    try {
      return await withDefaultProviders(() => codexGetsAlert("Plugged"));
    } finally {
      await rm(fakeConfig, { force: true });
    }
  });

  // S24: review 7, M4. A wait that a nudge turn opens keeps the request of the user, not the text of
  // the nudge, so its wake gets no instruction that the user did not give.
  await probe("S24 a wait opened in a nudge turn keeps the request of the user", async () => {
    const agent = await createAgent("Waiter");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${REQUEST} ${plan(promiseTurn)} ${nudges([
        {
          steps: [],
          calls: [{ tool: "await_event", arguments: { note: "Check vendor replies.", wakeAfterMinutes: 120 } }],
          answer: "I opened a wait.",
        },
      ])}`,
    );
    assert.equal(await settled(id), "completed");
    await fireAndSettle(agent.id, mark, 1);
    const [wait] = current.service.listWaits(agent.id).waits;
    assert.ok(wait, "the nudge turn opened a wait");
    assert.ok(
      !wait.requestText.includes(NUDGE_HEADER),
      `no nudge text in the request: ${wait.requestText.slice(0, 200)}`,
    );
    assert.ok(wait.requestText.startsWith(REQUEST), "the request of the user");
    return { requestText: wait.requestText.slice(0, 60) };
  });

  // S25: review 8. With the default nudge providers, a Codex agent gets no nudge also when its Codex
  // config turns all off. The user gets the alert line.
  await probe("S25 a Codex agent with the default providers: no nudge, the alert line", () =>
    withDefaultProviders(() => codexGetsAlert("Plain")),
  );

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
