// Checks the timed waits of the agent service: a wait that the agent opens with a wake time and no
// routine. Runs the real agent service on a temporary profile with a fake Codex app-server, as
// `plan-continuation-e2e.ts` does. The current message names its turns in `<<PLAN[...]PLAN>>`; a
// wait note names the turn of the run that its wake starts, because the wake input repeats the note
// before the request.
// Checks:
//   1. A timed wait survives a restart and wakes once, at the first pass after the start. The wake
//      input names the wait and repeats the request. The wake turn sets a new time on the same wait,
//      and no automatic plan continuation runs after it: the wait keeps it waiting.
//   2. A wait of a hidden agent does not wake. It wakes once when the agent shows again.
//   3. A wait that the user cancels before its time never wakes.
//   4. A routine run of the agent does not wake a timed wait.
// No provider, account or network is used. `bun run test:timed-waits`.
// Writes .openbot-build/timed-waits-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent, PLAN_CONTINUATION_ITEM_TYPE } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/timed-waits-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-timed-waits-"));
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
      const turn = { threadId: params.threadId, turnId, script, calls: [...(script.calls || [])] };
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

async function check(name: string, run: () => Promise<unknown>) {
  const detail = await run();
  report.checks.push({ name, passed: true, detail });
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

function errorsFor(agentId: string, since: number) {
  return current.events.slice(since).filter((event) => event.type === "error" && event.agentId === agentId);
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
  /** Opens one timed wait in a new request and answers its delivery id. `wakeTurn` is the wake's turn. */
  async function openTimedWait(agentId: string, request: string, wakeTurn: FakeTurn) {
    const steps: [string, StepStatus][] = [
      ["Email vendors", "completed"],
      ["Wait for replies", "pending"],
    ];
    const id = await send(
      agentId,
      `${request} ${plan({
        steps,
        calls: [
          { tool: "await_event", arguments: { note: `Check replies ${plan(wakeTurn)}`, wakeAfterMinutes: 2880 } },
        ],
        answer: "I emailed the vendors. I check back in 2 days.",
      })}`,
    );
    assert.equal(await settled(id), "completed");
    return id;
  }

  await check("a timed wait survives a restart, wakes once, and its wake turn waits again", async () => {
    const agent = await createAgent("Buyer");
    const mark = loggedTurns().length;
    await openTimedWait(agent.id, "Find 3 printer quotes and come back when vendors reply.", {
      steps: [
        ["Email vendors", "completed"],
        ["Get 3 replies (1/3)", "pending"],
        ["Compare quotes", "pending"],
      ],
      calls: [{ tool: "await_event", arguments: { note: "again", wakeAfterMinutes: 60 } }],
      answer: "One vendor replied. I check again in 1 hour.",
    });
    const [opened] = current.service.listWaits(agent.id).waits;
    assert.ok(opened?.wakeAt, "The wait has a wake time.");
    assert.equal(opened?.routineId, null, "The wait needs no routine.");
    const turnsBefore = turnsSince(mark).length;
    assert.deepEqual(
      turnsSince(mark).map((turn) => turn.note),
      [false],
      "The turn that opens the wait does not continue.",
    );
    makeDue(agent.id);
    await restart();
    const since = current.events.length;
    const wake = await waitFor("the wake", () => selfWakes(agent.id)[0]);
    assert.equal(await settled(wake.id, 30_000), "completed");
    // A continuation would start at once; give it the time to show.
    await new Promise((done) => setTimeout(done, 1_500));
    const turns = turnsSince(mark).slice(turnsBefore);
    assert.equal(turns.length, 1, "One wake turn runs.");
    assert.ok(turns[0]?.text.includes(`Wait ID: ${opened?.id}`), "The wake input names the wait.");
    assert.ok(turns[0]?.text.includes("printer quotes"), "The wake input repeats the request.");
    assert.ok(!turns.some((turn) => turn.note), "No plan continuation runs after the wake turn.");
    assert.equal(selfWakes(agent.id).length, 1, "One wake.");
    const [after] = current.service.listWaits(agent.id).waits;
    assert.equal(after?.id, opened?.id, "The same wait stays open.");
    assert.ok(after?.wakeAt && after.wakeAt > new Date().toISOString(), "The wake turn set the next wake time.");
    assert.equal(after?.timeWakes, 1, "The wait counts one wake of its time.");
    assert.equal(continuationLines(agent.id).length, 0, "The chat shows no continuation line.");
    assert.equal(chatMessages(agent.id).filter((message) => message.id.startsWith("outbox-")).length, 0);
    assert.equal(errorsFor(agent.id, since).length, 0, "No error shows.");
    return { wakeAt: after?.wakeAt };
  });

  await check("a hidden agent's wait does not wake, and wakes once when the agent shows again", async () => {
    const agent = await createAgent("Hidden");
    await openTimedWait(agent.id, "Check the deploy later.", { steps: [], answer: "The deploy is live." });
    await runCauseEffect(current.service.setAgentHidden({ agentId: agent.id, hidden: true }));
    makeDue(agent.id);
    await restart();
    await new Promise((done) => setTimeout(done, 1_500));
    assert.equal(selfWakes(agent.id).length, 0, "A hidden agent gets no wake.");
    await runCauseEffect(current.service.setAgentHidden({ agentId: agent.id, hidden: false }));
    const wake = await waitFor("the wake", () => selfWakes(agent.id)[0]);
    assert.equal(await settled(wake.id, 30_000), "completed");
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(selfWakes(agent.id).length, 1, "One wake.");
    return { wakes: 1 };
  });

  await check("a wait that the user cancels before its time never wakes", async () => {
    const agent = await createAgent("Cancelled");
    await openTimedWait(agent.id, "Check the build later.", { steps: [], answer: "NOT REACHED" });
    const [wait] = current.service.listWaits(agent.id).waits;
    assert.ok(wait, "The wait is open.");
    makeDue(agent.id);
    current.service.cancelWait(agent.id, wait.id);
    await restart();
    await new Promise((done) => setTimeout(done, 1_500));
    assert.equal(selfWakes(agent.id).length, 0, "No wake.");
    assert.deepEqual(current.service.listWaits(agent.id).waits, []);
    return { wakes: 0 };
  });

  await check("a routine run does not wake a timed wait", async () => {
    const agent = await createAgent("Routines");
    await openTimedWait(agent.id, "Check the invoices later.", { steps: [], answer: "NOT REACHED" });
    const routine = current.service.createRoutine(
      {
        agentId: agent.id,
        name: "Inbox",
        instruction: `Check the inbox. ${plan({ steps: [], answer: "The inbox is empty." })}`,
        active: false,
        timezone: "UTC",
        schedule: { kind: "custom", expression: "0 9 * * *" },
      },
      { recordConversationEvent: false },
    );
    const mark = loggedTurns().length;
    await runCauseEffect(current.service.testRoutine({ agentId: agent.id, routineId: routine.id }));
    await waitFor("the routine run to end", () => {
      const [run] = current.service.listRoutineRuns({ agentId: agent.id, routineId: routine.id });
      return run && (run.status === "succeeded" || ended(run.status)) ? run : null;
    });
    const [wait] = current.service.listWaits(agent.id).waits;
    assert.equal(wait?.wokenAt, null, "The routine run does not wake the wait.");
    assert.ok(wait?.wakeAt, "The wait keeps its time.");
    assert.ok(!turnsSince(mark).some((turn) => turn.text.includes("Wait ID:")), "The run input names no wait.");
    return { wokenAt: wait?.wokenAt };
  });
  report.passed = true;
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
  for (const entry of report.checks) process.stdout.write(`PASS ${entry.name}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
