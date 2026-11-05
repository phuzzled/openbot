// Checks that a timed wait follows the user's request to its end, across restarts. Runs the real agent
// service on a temporary profile with a fake Codex app-server, as `timed-waits-e2e.ts` does. The
// current message names its turns in `<<PLAN[...]PLAN>>`; a wait note names the turns of the wake.
// The fake puts the woken wait's id in place of "$WAIT".
// Checks:
//   P1   Own chat: a 2-day wait survives a restart and wakes once. The wake turn closes the wait with
//        the same open step text as before the wake, and the plan continues to the report.
//   P1v  As P1, with a new open step text in the wake turn.
//   P1b  A restart cuts off the wake turn: the wait gets a wake time again, so it is not lost.
//   P2   As P1, in a task side thread. P2v: with a new open step text.
//   P3   A routine run whose continuation waits at a restart ends once, and its digest has an answer.
//   P4   A teammate's turn that a restart cuts off continues, and the asker gets one result.
//   P8   A restart during a turn that opened a wait does not continue that turn.
//   P9   A wake turn that closes its wait and opens a new one keeps the user's request and the count of
//        time wakes.
// No provider, account or network is used. `bun run test:timed-waits-followup`. `ONLY=P1,P4` runs some.
// Writes .openbot-build/timed-waits-followup-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent, PLAN_CONTINUATION_ITEM_TYPE } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/timed-waits-followup-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-timed-waits-followup-"));
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
    if (process.env.ONLY && !process.env.ONLY.split(",").some((k) => name.startsWith(k + " "))) return;
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
  const wakeTurns = (mark: number) => turnsSince(mark).filter((turn) => turn.text.includes("Wait ID:"));
  const QUOTE_REQUEST =
    "Find 3 printer quotes from local vendors and come back to me with a comparison when they reply.";

  // P1: own chat. 2-day timed wait, restart, wake once, wake turn closes the wait with an open step,
  // the plan continues, finishes and reports.
  await probe("P1 printer quotes in own chat: wait 2 days, restart, wake once, continue plan, report", async () => {
    const agent = await createAgent("Buyer1");
    const mark = loggedTurns().length;
    const wakeTurn: FakeTurn = {
      steps: [
        ["Email vendors", "completed"],
        ["Collect 3 replies", "completed"],
        ["Compare quotes", "pending"],
      ],
      calls: [{ tool: "close_wait", arguments: { waitId: "$WAIT" } }],
      answer: "All 3 vendors replied. Next I compare them.",
    };
    const contTurn: FakeTurn = {
      steps: [
        ["Email vendors", "completed"],
        ["Collect 3 replies", "completed"],
        ["Compare quotes", "completed"],
      ],
      answer: "REPORT: Vendor B is cheapest at $410.",
    };
    const id = await send(
      agent.id,
      `${QUOTE_REQUEST} ${plan({
        steps: [
          ["Email vendors", "completed"],
          ["Collect 3 replies", "pending"],
          ["Compare quotes", "pending"],
        ],
        calls: [
          {
            tool: "await_event",
            arguments: { note: `Check vendor replies ${plan(wakeTurn, contTurn)}`, wakeAfterMinutes: 2880 },
          },
        ],
        answer: "I emailed 3 vendors. I check back in 2 days.",
      })}`,
    );
    assert.equal(await settled(id), "completed");
    const [opened] = current.service.listWaits(agent.id).waits;
    assert.ok(opened?.wakeAt, "wait has a wake time");
    assert.equal(turnsSince(mark).length, 1, "no continuation after the wait-opening turn");
    makeDue(agent.id);
    await restart();
    const wake = await waitFor("the wake", () => selfWakes(agent.id)[0]);
    assert.equal(await settled(wake.id, 30_000), "completed");
    await new Promise((done) => setTimeout(done, 2_000));
    const after = turnsSince(mark).slice(1);
    assert.equal(wakeTurns(mark).length, 1, "exactly one wake turn");
    assert.deepEqual(
      after.map((t) => t.note),
      [false, true],
      "wake turn then one plan continuation",
    );
    assert.ok(after[0]?.text.includes("printer quotes"), "wake input repeats the request");
    assert.deepEqual(current.service.listWaits(agent.id).waits, [], "wait closed");
    const report = chatMessages(agent.id).some((m) => m.text === "REPORT: Vendor B is cheapest at $410.");
    assert.ok(report, "final report is in the chat");
    await restart();
    await new Promise((done) => setTimeout(done, 1_500));
    assert.equal(selfWakes(agent.id).length, 1, "no second wake after another restart");
    return { turns: after.map((t) => t.note), wakes: selfWakes(agent.id).length };
  });

  // P1b: the restart interrupts the wake turn itself (no plan). Does the wait wake again later?
  await probe("P1b a restart cuts off the wake turn: the wait gets a wake time again", async () => {
    const agent = await createAgent("Buyer1b");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${QUOTE_REQUEST} ${plan({
        steps: [],
        calls: [
          {
            tool: "await_event",
            arguments: {
              note: `Check vendor replies ${plan({ steps: [], delayMs: 60_000, answer: "NOT REACHED" })}`,
              wakeAfterMinutes: 2880,
            },
          },
        ],
        answer: "I check back in 2 days.",
      })}`,
    );
    assert.equal(await settled(id), "completed");
    makeDue(agent.id);
    await restart();
    const wake = await waitFor("the wake", () => selfWakes(agent.id)[0]);
    await waitFor("the wake turn to start", () => wakeTurns(mark).length === 1);
    await restart();
    const status = await settled(wake.id, 30_000);
    await new Promise((done) => setTimeout(done, 2_000));
    const waits = current.service.listWaits(agent.id).waits;
    const detail = {
      wakeStatus: status,
      waits: waits.map((w) => ({ wakeAt: w.wakeAt, timeWakes: w.timeWakes, wokenAt: w.wokenAt })),
      wakeTurns: wakeTurns(mark).length,
    };
    assert.ok(
      waits.length === 0 || waits.some((w) => w.wakeAt),
      `the wait is left open with no wake time and nothing will ever wake it: ${JSON.stringify(detail)}`,
    );
    return detail;
  });

  // P2: same request in a task side thread.
  await probe("P2 printer quotes in a task thread: wait, restart, wake in task once, continue, report", async () => {
    const agent = await createAgent("Buyer2");
    const mark = loggedTurns().length;
    const wakeTurn: FakeTurn = {
      steps: [
        ["Email vendors", "completed"],
        ["Collect 3 replies", "completed"],
        ["Compare quotes", "pending"],
      ],
      calls: [{ tool: "close_wait", arguments: { waitId: "$WAIT" } }],
      answer: "All replied. Next I compare.",
    };
    const contTurn: FakeTurn = {
      steps: [
        ["Email vendors", "completed"],
        ["Collect 3 replies", "completed"],
        ["Compare quotes", "completed"],
      ],
      answer: "TASK REPORT: Vendor C wins.",
    };
    const task = await runCauseEffect(
      current.service.startTask({
        agentId: agent.id,
        text: `${QUOTE_REQUEST} ${plan({
          steps: [
            ["Email vendors", "completed"],
            ["Collect 3 replies", "pending"],
            ["Compare quotes", "pending"],
          ],
          calls: [
            {
              tool: "await_event",
              arguments: { note: `Check vendor replies ${plan(wakeTurn, contTurn)}`, wakeAfterMinutes: 2880 },
            },
          ],
          answer: "I emailed vendors. Back in 2 days.",
        })}`,
      }),
    );
    await waitFor("task first answer", () =>
      current.service.readTask(agent.id, task.id).messages.some((m) => m.text === "I emailed vendors. Back in 2 days."),
    );
    await new Promise((done) => setTimeout(done, 800));
    const waits = current.service.listWaits(agent.id).waits;
    assert.equal(
      waits.length,
      1,
      `a wait opened in the task: ${JSON.stringify(
        loggedEntries()
          .filter((e) => e.method === "toolResult")
          .slice(-1),
      )}`,
    );
    assert.equal(turnsSince(mark).length, 1, "no continuation after wait-opening turn");
    makeDue(agent.id);
    await restart();
    await waitFor(
      "task report",
      () => current.service.readTask(agent.id, task.id).messages.some((m) => m.text === "TASK REPORT: Vendor C wins."),
      30_000,
    );
    await new Promise((done) => setTimeout(done, 1_500));
    const after = turnsSince(mark).slice(1);
    assert.equal(wakeTurns(mark).length, 1, "one wake turn");
    assert.ok(
      after.every((t) => t.threadId === turnsSince(mark)[0]?.threadId),
      "wake and continuation ran in the task session",
    );
    assert.deepEqual(
      after.map((t) => t.note),
      [false, true],
    );
    assert.ok(!chatMessages(agent.id).some((m) => m.text?.includes("TASK REPORT")), "report not in own chat");
    assert.deepEqual(current.service.listWaits(agent.id).waits, []);
    return { turns: after.map((t) => t.note) };
  });

  // P2: same request in a task side thread.
  await probe(
    "P2v printer quotes in a task thread (new step text): wait, restart, wake in task once, continue, report",
    async () => {
      const agent = await createAgent("Buyer2v");
      const mark = loggedTurns().length;
      const wakeTurn: FakeTurn = {
        steps: [
          ["Email vendors", "completed"],
          ["Collect 3 replies", "completed"],
          ["Compare the 3 quotes and recommend one", "pending"],
        ],
        calls: [{ tool: "close_wait", arguments: { waitId: "$WAIT" } }],
        answer: "All replied. Next I compare.",
      };
      const contTurn: FakeTurn = {
        steps: [
          ["Email vendors", "completed"],
          ["Collect 3 replies", "completed"],
          ["Compare the 3 quotes and recommend one", "completed"],
        ],
        answer: "TASK REPORT: Vendor C wins.",
      };
      const task = await runCauseEffect(
        current.service.startTask({
          agentId: agent.id,
          text: `${QUOTE_REQUEST} ${plan({
            steps: [
              ["Email vendors", "completed"],
              ["Collect 3 replies", "pending"],
              ["Compare quotes", "pending"],
            ],
            calls: [
              {
                tool: "await_event",
                arguments: { note: `Check vendor replies ${plan(wakeTurn, contTurn)}`, wakeAfterMinutes: 2880 },
              },
            ],
            answer: "I emailed vendors. Back in 2 days.",
          })}`,
        }),
      );
      await waitFor("task first answer", () =>
        current.service
          .readTask(agent.id, task.id)
          .messages.some((m) => m.text === "I emailed vendors. Back in 2 days."),
      );
      await new Promise((done) => setTimeout(done, 800));
      const waits = current.service.listWaits(agent.id).waits;
      assert.equal(
        waits.length,
        1,
        `a wait opened in the task: ${JSON.stringify(
          loggedEntries()
            .filter((e) => e.method === "toolResult")
            .slice(-1),
        )}`,
      );
      assert.equal(turnsSince(mark).length, 1, "no continuation after wait-opening turn");
      makeDue(agent.id);
      await restart();
      await waitFor(
        "task report",
        () =>
          current.service.readTask(agent.id, task.id).messages.some((m) => m.text === "TASK REPORT: Vendor C wins."),
        30_000,
      );
      await new Promise((done) => setTimeout(done, 1_500));
      const after = turnsSince(mark).slice(1);
      assert.equal(wakeTurns(mark).length, 1, "one wake turn");
      assert.ok(
        after.every((t) => t.threadId === turnsSince(mark)[0]?.threadId),
        "wake and continuation ran in the task session",
      );
      assert.deepEqual(
        after.map((t) => t.note),
        [false, true],
      );
      assert.ok(!chatMessages(agent.id).some((m) => m.text?.includes("TASK REPORT")), "report not in own chat");
      assert.deepEqual(current.service.listWaits(agent.id).waits, []);
      return { turns: after.map((t) => t.note) };
    },
  );

  // P3: routine run with open plan whose continuation waits when OpenBot restarts: one digest?
  await probe("P3 routine run continuation cut by restart: run ends once and digest carries an answer", async () => {
    const agent = await createAgent("Router3");
    const routine = current.service.createRoutine(
      {
        agentId: agent.id,
        name: "Daily",
        instruction: `Write the report. ${plan(
          {
            steps: [
              ["Collect", "completed"],
              ["Write", "pending"],
            ],
            answer: "ROUTINE-PART-1 collected.",
            delayMs: 1_500,
          },
          {
            steps: [
              ["Collect", "completed"],
              ["Write", "completed"],
            ],
            answer: "ROUTINE-PART-2 written.",
          },
        )}`,
        active: false,
        timezone: "UTC",
        schedule: { kind: "custom", expression: "0 9 * * *" },
      },
      { recordConversationEvent: false },
    );
    const mark = loggedTurns().length;
    await runCauseEffect(current.service.testRoutine({ agentId: agent.id, routineId: routine.id }));
    await waitFor("first routine turn", () => turnsSince(mark).length === 1);
    await runCauseEffect(current.service.setAgentHidden({ agentId: agent.id, hidden: true }));
    const routineThread = current.service.listTasks(agent.id).tasks[0]?.threadId;
    await waitFor("continuation waits", () => continuationLines(agent.id, routineThread).length === 1);
    await restart();
    await runCauseEffect(current.service.setAgentHidden({ agentId: agent.id, hidden: false }));
    const run = await waitFor(
      "the run to end",
      () => {
        const [r] = current.service.listRoutineRuns({ agentId: agent.id, routineId: routine.id });
        return r && r.status !== "running" && r.status !== "queued" ? r : null;
      },
      30_000,
    );
    await new Promise((done) => setTimeout(done, 1_000));
    const runs = current.service.listRoutineRuns({ agentId: agent.id, routineId: routine.id });
    const next = await send(agent.id, "What did the routine find?");
    assert.equal(await settled(next), "completed");
    const chatTurn = turnsSince(mark).at(-1)?.text ?? "";
    const detail = {
      runStatus: run.status,
      runs: runs.length,
      turnsNotes: turnsSince(mark).map((t) => t.note),
      digestHasPart1: chatTurn.includes("ROUTINE-PART-1"),
    };
    assert.equal(runs.length, 1, "one run");
    assert.ok(
      detail.digestHasPart1,
      `the digest given to the own chat carries the last answer: ${JSON.stringify(detail)}`,
    );
    return detail;
  });

  // P4: A asks B; restart interrupts B's turn with open steps; B continues; A gets exactly one result.
  await probe("P4 teammate request: restart cuts B mid-turn, B continues, A gets one result", async () => {
    const lead = await createAgent("LeadP4");
    const helper = await createAgent("HelperP4");
    const request = `Check the vendor list. ${plan(
      {
        steps: [
          ["Read list", "completed"],
          ["Summarise", "inProgress"],
        ],
        planEarly: true,
        delayMs: 60_000,
      },
      {
        steps: [
          ["Read list", "completed"],
          ["Summarise", "completed"],
        ],
        answer: "P4-RESULT summary written.",
      },
    )}`;
    const id = await send(
      lead.id,
      `Ask the helper. ${plan({
        steps: [],
        calls: [{ tool: "send_message", arguments: { recipientAgentIds: [helper.id], text: request } }],
        answer: "I asked the helper.",
      })}`,
    );
    assert.equal(await settled(id), "completed");
    await waitFor("helper plan", () =>
      chatMessages(helper.id).some((m) => m.plan?.steps.some((s) => s.text === "Summarise")),
    );
    await restart();
    const result = await waitFor(
      "result for lead",
      () =>
        current.service
          .listQueue(lead.id)
          .deliveries.find((d) => d.sender.kind === "agent" && d.sender.agentId === helper.id),
      30_000,
    );
    await settled(result.id, 30_000);
    await new Promise((done) => setTimeout(done, 1_500));
    const results = current.service
      .listQueue(lead.id)
      .deliveries.filter((d) => d.sender.kind === "agent" && d.sender.agentId === helper.id);
    assert.equal(results.length, 1, "exactly one result");
    // The fake forgets its per-session script on restart, so the continuation answers "Done.".
    assert.ok(results[0]?.text === "Done.", "result is the answer of the post-restart continuation turn");
    return { results: results.length };
  });

  // P1v: as P1, but the wake turn's open step has a text that was not in the plan before the wake.
  await probe("P1v wake turn with a new open step text: the plan continues", async () => {
    const agent = await createAgent("Buyer1v");
    const mark = loggedTurns().length;
    const wakeTurn: FakeTurn = {
      steps: [
        ["Email vendors", "completed"],
        ["Collect 3 replies", "completed"],
        ["Compare the 3 quotes and recommend one", "pending"],
      ],
      calls: [{ tool: "close_wait", arguments: { waitId: "$WAIT" } }],
      answer: "All 3 vendors replied.",
    };
    const contTurn: FakeTurn = {
      steps: [
        ["Email vendors", "completed"],
        ["Collect 3 replies", "completed"],
        ["Compare the 3 quotes and recommend one", "completed"],
      ],
      answer: "REPORT-V: Vendor B.",
    };
    const id = await send(
      agent.id,
      `${QUOTE_REQUEST} ${plan({
        steps: [
          ["Email vendors", "completed"],
          ["Collect 3 replies", "pending"],
          ["Compare quotes", "pending"],
        ],
        calls: [
          {
            tool: "await_event",
            arguments: { note: `Check vendor replies ${plan(wakeTurn, contTurn)}`, wakeAfterMinutes: 2880 },
          },
        ],
        answer: "Back in 2 days.",
      })}`,
    );
    assert.equal(await settled(id), "completed");
    makeDue(agent.id);
    await restart();
    const wake = await waitFor("the wake", () => selfWakes(agent.id)[0]);
    assert.equal(await settled(wake.id, 30_000), "completed");
    await new Promise((done) => setTimeout(done, 2_000));
    const notes = turnsSince(mark)
      .slice(1)
      .map((t) => t.note);
    assert.deepEqual(notes, [false, true], `notes=${JSON.stringify(notes)}`);
    return { notes };
  });

  // P8: a turn that opened a timed wait and is cut off by a restart while its plan is open.
  await probe("P8 a restart during a turn that opened a wait does not continue that turn", async () => {
    const agent = await createAgent("WaitCut");
    const mark = loggedTurns().length;
    const id = await send(
      agent.id,
      `${QUOTE_REQUEST} ${plan(
        {
          steps: [
            ["Email vendors", "completed"],
            ["Collect replies", "inProgress"],
          ],
          planEarly: true,
          delayMs: 60_000,
          calls: [
            {
              tool: "await_event",
              arguments: { note: `Check replies ${plan({ steps: [], answer: "wake" })}`, wakeAfterMinutes: 2880 },
            },
          ],
        },
        {
          steps: [
            ["Email vendors", "completed"],
            ["Collect replies", "completed"],
          ],
          answer: "P8-CONTINUED right after restart.",
        },
      )}`,
    );
    await waitFor(
      "wait open + plan",
      () =>
        current.service.listWaits(agent.id).waits.length === 1 &&
        chatMessages(agent.id).some((m) => m.plan?.steps.some((s) => s.text === "Collect replies")),
    );
    await restart();
    const status = await settled(id, 30_000);
    await new Promise((done) => setTimeout(done, 1_500));
    const detail = {
      status,
      notes: turnsSince(mark).map((t) => t.note),
      waits: current.service.listWaits(agent.id).waits.length,
    };
    assert.ok(
      !detail.notes.includes(true),
      `a turn that opened a wait was auto-continued after restart: ${JSON.stringify(detail)}`,
    );
    return detail;
  });

  // P9: close a woken timed wait and open a new one in the wake turn: what request does the new wait keep?
  await probe("P9 a reopen after close in a wake turn keeps the request and the wake count", async () => {
    const agent = await createAgent("Reopen");
    const id = await send(
      agent.id,
      `${QUOTE_REQUEST} ${plan({
        steps: [],
        calls: [
          {
            tool: "await_event",
            arguments: {
              note: `Check replies ${plan({
                steps: [],
                calls: [
                  { tool: "close_wait", arguments: { waitId: "$WAIT" } },
                  { tool: "await_event", arguments: { note: "check again", wakeAfterMinutes: 60 } },
                ],
                answer: "Again later.",
              })}`,
              wakeAfterMinutes: 2880,
            },
          },
        ],
        answer: "Back in 2 days.",
      })}`,
    );
    assert.equal(await settled(id), "completed");
    makeDue(agent.id);
    await restart();
    const wake = await waitFor("the wake", () => selfWakes(agent.id)[0]);
    await settled(wake.id, 30_000);
    await new Promise((done) => setTimeout(done, 800));
    const rows = current.service.listWaits(agent.id).waits;
    const detail = rows.map((r) => ({
      requestHasUser: r.requestText.includes("printer quotes"),
      note: r.note,
      timeWakes: r.timeWakes,
    }));
    assert.ok(
      rows.length === 1 && rows[0]?.requestText.includes("printer quotes"),
      `new wait lost the user's request: ${JSON.stringify(detail)}`,
    );
    assert.equal(rows[0]?.timeWakes, 1, `the new wait keeps the count of time wakes: ${JSON.stringify(detail)}`);
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
