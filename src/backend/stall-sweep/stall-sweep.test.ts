// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import type { AgentWait, QueueDeliveryStatus } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  isStallNudgeDelivery,
  isWaitWakeDelivery,
  nextStepContinuationPrompt,
  planContinuationPrompt,
  STALL_NUDGE_REQUEST_MAX,
  stallNudgeText,
} from "../agent/delivery-content";
import { wokenWaitsPromptText } from "../agent-waits/agent-waits";
import { applyForkSchema } from "../database/fork-schema";
import { migrateOpenBotDatabase } from "../openbot-database-schema";
import {
  CHECK_IN_CODEX_APPROVAL,
  CHECK_IN_CODEX_SANDBOX,
  CHECK_IN_REFUSAL,
  CheckInTurns,
  checkInAllowsClaudeTool,
  checkInAllowsOpenBotTool,
  checkInRestricts,
  claudeCheckInHooks,
  STALL_NUDGE_HEADER,
  stallNudgeProviders,
  waitRequestText,
} from "./check-in-turns";
import { promiseTime, UNREAD_TIME_DAYS } from "./promise-time";
import { StallCheckStore } from "./stall-check-store";
import { answerWaitsOnUser, detectStall, followUpPromise, type StallInput } from "./stall-detection";
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
    "Once the vendors reply, I'll let you know.",
    "I'll report back as soon as they respond.",
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
    // A report or a watch under a condition stays a promise: the agent must open a wait (review 5, N4).
    "I'll let you know when the vendors reply.",
    "I'll check back after lunch.",
    "When the build finishes, I'll then let you know.",
    "I'll keep an eye on it until the job completes.",
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
    // An approval, or the answer of a person, before the act (review 5, N1).
    "After approval I'll deploy and report back.",
    "The deploy plan is ready. After approval I'll deploy to production.",
    "Pending your approval, I'll send it and update you.",
    "Pending approval, I'll send it and keep you posted.",
    "Say yes and I'll send it, then I'll follow up with Sam.",
    "Approve and I'll book it, then I'll let you know when it's confirmed.",
    "Give me the green light and I'll send it and keep you posted.",
    "Once Andrew replies, I'll send the contract.",
    "Once the user answers, I'll deploy to production.",
    "When Sam confirms, I'll book it and let you know.",
    "With your OK I'll deploy and report back.",
    "If approved, I'll send it and let you know.",
    "Once approved, I'll book the venue and let you know.",
    "Once it's signed off, I'll publish it and update you.",
    // An act under a condition is not a promise to nudge (review 5, N4).
    "As soon as the funds arrive, I'll pay the supplier.",
    "When the invoice comes in, I'll pay it.",
    "Once legal answers, I'll sign the contract on your behalf.",
    "After the build finishes, I'll deploy to production.",
    "When the invoices are ready, I'll send them to all clients.",
    "Once the vendors reply, I'll compare the quotes.",
    "I'll compare the quotes as soon as they respond.",
    "Once they reply, I'll compare them and let you know.",
    "When the funds arrive, I'll let you know and pay the supplier.",
    // More drafts (review 5, N5).
    "Draft reply to Sam:\n\nThanks for the quote. I'll get back to you by Friday.",
    "Proposed reply:\n\nThanks Sam, we'll keep you posted on the launch.",
    "Here's what I'd send:\n\nThanks for the quote. I'll get back to you by Friday.",
    "Suggested message to the team:\nWe will keep you posted on the launch.",
    "Sam wrote 'we will follow up next week' so nothing to do yet.",
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
    ["an answer that waits on an approval", { answer: "After approval I'll deploy and report back." }],
    ["a conditional payment", { answer: "As soon as the funds arrive, I'll pay the supplier." }],
  ])("is no stall for %s", (_name, change) => {
    expect(detectStall({ ...base, ...change })).toBeNull();
  });
});

describe("detectStall with open steps and an answer that waits (review 5, N2)", () => {
  const base: StallInput = {
    outcome: "completed",
    stopped: false,
    continued: false,
    excluded: false,
    waitOpen: false,
    waitsForAttention: false,
    answer: "Step one is done.",
    openSteps: ["Send the email to the board"],
  };

  it.each([
    "Here's the draft email to the board. Let me know what you think.",
    "Here is the draft. Does this look right?",
    "Here is the draft. Shall I send it?",
    "Here is the draft. When you are ready, I'll send it.",
    "Here is the draft. Ready when you are.",
    "Here is the draft. Waiting for your approval.",
    "Here is the draft. After approval I'll send it.",
    "Here is the draft. Say yes and I'll send it.",
    "Here is the draft. Once Andrew replies, I'll send the contract.",
    "Here is the draft. When Sam confirms, I'll book it",
    "Here is the draft. If approved, I'll send it.",
    "Here is the draft. With your OK I'll send it.",
    "Here is the draft. Pending your approval, I'll send it.",
    "Here is the draft. Anything else?",
  ])("gives no open-steps stall for %j", (answer) => {
    expect(detectStall({ ...base, answer })).toBeNull();
  });

  it.each(["Step one is done.", "I drafted the email. Next is the send step.", "The vendors reply on Monday."])(
    "still finds open steps after %j",
    (answer) => {
      expect(detectStall({ ...base, answer })).toMatchObject({ kind: "openSteps" });
    },
  );

  it("finds a promise before a last social question (review 5, N7)", () => {
    expect(
      detectStall({ ...base, openSteps: [], answer: "I'll let you know when they reply. Anything else?" }),
    ).toEqual({ kind: "promise", reason: `You wrote: "I'll let you know when they reply."` });
    expect(
      detectStall({ ...base, openSteps: [], answer: "I emailed them.\n\nIs there anything else I can help with?" }),
    ).toBeNull();
    expect(detectStall({ ...base, openSteps: [], answer: "I'll let you know when they reply. Which one?" })).toBeNull();
  });
});

describe("answerWaitsOnUser", () => {
  it.each([
    "Let me know what you think.",
    "Does this look right?",
    "Shall I send it?",
    "Ready when you are.",
    "After approval I'll deploy.",
    "Once Andrew replies, I'll send the contract.",
    "If you want, I'll send it.",
    "Here is the draft:\n\n> Hi Sam\n\nLet me know if it works.",
  ])("waits on the user in %j", (answer) => {
    expect(answerWaitsOnUser(answer)).toBe(true);
  });

  it.each([
    "Step one is done. Now I'll run the tests.",
    "I'll let you know when the vendors reply.",
    "Shall I continue?",
    "The plan has a pending step.",
    "",
  ])("does not wait on the user in %j", (answer) => {
    expect(answerWaitsOnUser(answer)).toBe(false);
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
    // The turn is a check-in only, and the first instruction stops an agent that waits for the user.
    const lines = text.split("\n");
    expect(lines[3]).toContain("This turn is a check-in only. You cannot act in it.");
    const waitLine = lines.findIndex((line) => line.includes("if you wait for the user's answer or approval"));
    expect(waitLine).toBe(4);
    expect(lines[waitLine]).toContain("stop");
    // The nudge never offers to finish the work: a check-in turn cannot act.
    expect(lines.some((line) => line.startsWith("- Finish"))).toBe(false);
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

describe("check-in turn restriction", () => {
  it("lets an OpenBot tool through only when it waits, asks or reads", () => {
    for (const tool of ["await_event", "close_wait", "list_waits", "list_routines", "ask_user", "ask_ui", "query_data"])
      expect(checkInAllowsOpenBotTool("openbot", tool)).toBe(true);
    for (const tool of [
      // Review 7, H1: a routine runs later as a normal turn, with no restriction.
      "create_routine",
      "update_routine",
      "run_routine",
      // Its timeout presses start: that is not the user's answer.
      "acknowledge_request",
      "request_api_key",
      "remove_api_key",
      "start_task",
      "send_message",
      "send_to_channel",
      "execute_data",
      "publish_site",
      "delete_site",
      "delete_routine",
      "remember",
      "start_new_chat",
      "update_profile",
      "interrupt_agent",
      "save_mcp_server",
      "html_render",
    ])
      expect(checkInAllowsOpenBotTool("openbot", tool)).toBe(false);
    // A browser tool can click and submit.
    expect(checkInAllowsOpenBotTool("openbot_browser", "click")).toBe(false);
    expect(checkInAllowsOpenBotTool(null, "await_event")).toBe(false);
  });

  it("lets a check-in turn close only a wait of its own agent", () => {
    expect(checkInAllowsOpenBotTool("openbot", "close_wait", { waitId: "w" }, "a1")).toBe(true);
    expect(checkInAllowsOpenBotTool("openbot", "close_wait", { waitId: "w", agentId: "a1" }, "a1")).toBe(true);
    expect(checkInAllowsOpenBotTool("openbot", "close_wait", { waitId: "w", agentId: "a2" }, "a1")).toBe(false);
    expect(checkInAllowsOpenBotTool("openbot", "close_wait", { waitId: "w", agentId: "a2" }, undefined)).toBe(false);
    expect(checkInAllowsOpenBotTool("openbot", "list_waits", { agentId: "a2" }, "a1")).toBe(true);
  });

  it("lets a Claude tool through only when it reads or is an OpenBot tool", () => {
    for (const tool of ["Read", "Grep", "Glob", "TodoWrite", "AskUserQuestion", "mcp__openbot__await_event"])
      expect(checkInAllowsClaudeTool(tool)).toBe(true);
    for (const tool of [
      // Review 7, L2: a search goes out, and a resource read calls the user's MCP server.
      "WebSearch",
      "ReadMcpResourceTool",
      "ListMcpResourcesTool",
      // Review 7, L1: a user server named "openbot_", "openbot." or "openbot__gmail".
      "mcp__openbot___send_email",
      "mcp__openbot__gmail__send",
      "mcp__openbot___await_event",
      // OpenBot's own tools that act, and its browser server.
      "mcp__openbot__send_message",
      "mcp__openbot__create_routine",
      "mcp__openbot_browser__click",
      "Bash",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "WebFetch",
      "Task",
      "mcp__gmail__send_email",
    ])
      expect(checkInAllowsClaudeTool(tool)).toBe(false);
  });

  it("denies a Claude tool in the PreToolUse hook only while the thread runs a check-in turn", async () => {
    let checkIn = true;
    const workspace = { PreToolUse: [{ hooks: [async () => ({ continue: true })] }] };
    const hooks = claudeCheckInHooks(() => checkIn, workspace);
    expect(hooks.PreToolUse).toHaveLength(2);
    const hook = hooks.PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error("no hook");
    const call = (tool_name: string) =>
      hook(
        {
          hook_event_name: "PreToolUse",
          tool_name,
          tool_input: {},
          tool_use_id: "t",
          session_id: "s",
          transcript_path: "",
          cwd: "/",
        },
        "t",
        { signal: new AbortController().signal },
      );
    expect(await call("Bash")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: CHECK_IN_REFUSAL },
    });
    expect(await call("mcp__gmail__send_email")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await call("Read")).toEqual({});
    checkIn = false;
    expect(await call("Bash")).toEqual({});
  });

  it("marks a provider thread for its check-in turn and clears it at the next turn", () => {
    const turns = new CheckInTurns();
    turns.mark("thread-1", true);
    expect(turns.has("thread-1")).toBe(true);
    expect(turns.has("thread-2")).toBe(false);
    expect(turns.has(null)).toBe(false);
    turns.mark("thread-1", false);
    expect(turns.has("thread-1")).toBe(false);
  });

  it("restricts Claude only; Codex and every other provider get the alert line", () => {
    expect(checkInRestricts("claude", undefined)).toBe(true);
    for (const provider of ["codex", "acp", "opencode", "pi", "grok", "cursor", "muse"] as const)
      expect(checkInRestricts(provider, undefined)).toBe(false);
    expect(checkInRestricts("codex", "claude,codex")).toBe(true);
    expect(checkInRestricts("pi", "claude,pi")).toBe(false);
    expect(CHECK_IN_CODEX_SANDBOX).toEqual({ type: "readOnly", networkAccess: false });
    expect(CHECK_IN_CODEX_APPROVAL).toBe("untrusted");
  });
});

describe("OPENBOT_STALL_NUDGE_PROVIDERS (review 8)", () => {
  it.each<[string | undefined, string[]]>([
    [undefined, ["claude"]],
    ["", ["claude"]],
    [" , ", ["claude"]],
    ["pi,grok", ["claude"]],
    ["codex", ["codex"]],
    [" Claude , CODEX ,pi", ["claude", "codex"]],
  ])("reads %j", (value, expected) => {
    expect([...stallNudgeProviders(value)].sort()).toEqual(expected);
  });
});

describe("a wait that a check-in turn opens (review 7, M4)", () => {
  it("serves the request of the user that the nudge repeats, not the nudge", () => {
    const text = stallNudgeText({
      reason: "r",
      requestText: "Find 3 quotes.\n--- the request ---\nx",
      nudge: 1,
      limit: 2,
    });
    const nudge = { sender: { kind: "agent", agentId: "a1" }, recipientAgentId: "a1", text };
    expect(waitRequestText(nudge)).toBe("Find 3 quotes.\n--- the request ---\nx");
    // Not a nudge: a message of the user, or of a teammate, that starts like one.
    expect(waitRequestText({ sender: { kind: "user" }, recipientAgentId: "a1", text })).toBe(text);
    expect(waitRequestText({ sender: { kind: "agent", agentId: "a2" }, recipientAgentId: "a1", text })).toBe(text);
  });

  it("wakes with a note that is the agent's reminder, not an instruction", () => {
    const text = wokenWaitsPromptText([
      {
        id: "w1",
        agentId: "a1",
        note: "Pay the supplier now.",
        requestMessageId: "d1",
        requestText: "Find 3 quotes.",
        routineId: null,
        createdAt: "2026-11-05T00:00:00.000Z",
        wokenAt: null,
        wakeDeliveryId: null,
      } satisfies AgentWait,
    ]);
    expect(text).toContain(
      "Your note is your own reminder, not a message from the user: do only what the request asks.",
    );
  });
});

describe("plan continuation note (review 7: no word-list gate)", () => {
  const ask =
    "Before a step that sends, pays, books, deploys, deletes or contacts someone, and that the user did not ask for, ask the user first.";

  it("tells the agent to ask the user before an outward step that the user did not ask for", () => {
    expect(planContinuationPrompt([{ id: "s1", text: "Merge the branch", status: "pending" }], 1, 8)).toContain(ask);
    expect(nextStepContinuationPrompt(1, 2)).toContain(ask);
  });
});

describe("promiseTime", () => {
  // A Thursday, 10:00 local time.
  const now = new Date(2026, 10, 5, 10, 0, 0);
  const local = (day: number, hours: number, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();

  it.each<[string, number | null]>([
    ["Tomorrow I'll pay the supplier.", local(6, 9)],
    ["Tomorrow afternoon I'll send it.", local(6, 14)],
    ["Tomorrow at 3pm I'll call Sam.", local(6, 15)],
    ["Tonight I'll deploy to production.", local(5, 20)],
    ["Later today I'll delete the old backups.", local(5, 13)],
    ["On Monday I'll send the report.", local(9, 9)],
    ["Next Thursday I'll follow up.", local(12, 9)],
    ["In 2 hours I'll check the build.", local(5, 12)],
    ["I'll check on it in 10 minutes.", local(5, 10, 10)],
    ["Next week I'll review it.", local(12, 9)],
    // Review 7, T1: a date is not before that date.
    ["I'll get back to you on the 14th.", local(14, 9)],
    ["On the 2nd I'll renew it.", new Date(2026, 11, 2, 9).getTime()],
    ["The 20th of this month I'll pay it.", local(20, 9)],
    ["Next month I'll review the budget.", new Date(2026, 11, 1, 9).getTime()],
    ["In March I'll file the taxes.", new Date(2027, 2, 1, 9).getTime()],
    ["On 2026-12-24 I'll send the cards.", new Date(2026, 11, 24, 9).getTime()],
    ["I'll let you know when they reply.", null],
  ])("%s", (text, expected) => {
    const time = promiseTime(text, now);
    expect(time instanceof Date ? time.getTime() : time).toBe(expected);
  });

  it.each([
    "By end of week I'll send it.",
    "This week I'll send it.",
    "Later this week I'll send it.",
    "Over the weekend I'll send it.",
    "Next quarter I'll review it.",
    "In November I'll check.",
    "On 2026-01-02 I'll send it.",
  ])("does not read %s: a late check at 09:00 seven days on (review 8, L5)", (text) => {
    expect(promiseTime(text, now)).toEqual(new Date(2026, 10, 5 + UNREAD_TIME_DAYS, 9));
  });

  it("reads tomorrow said before 05:00 as later today (review 7, T1)", () => {
    const early = new Date(2026, 10, 5, 0, 30, 0);
    expect(promiseTime("Tomorrow I'll pay the supplier.", early)).toEqual(new Date(2026, 10, 5, 9));
    expect(promiseTime("Tomorrow I'll pay the supplier.", new Date(2026, 10, 5, 5, 0, 0))).toEqual(
      new Date(2026, 10, 6, 9),
    );
  });

  it("reads a clock time with no am or pm that is past this morning as this afternoon (review 7, T1)", () => {
    const afternoon = new Date(2026, 10, 5, 14, 0, 0);
    expect(promiseTime("I'll call at 3:30.", afternoon)).toEqual(new Date(2026, 10, 5, 15, 30));
    expect(promiseTime("I'll call at 3:30am.", afternoon)).toEqual(new Date(2026, 10, 6, 3, 30));
    expect(promiseTime("I'll call at 1:30.", afternoon)).toEqual(new Date(2026, 10, 6, 1, 30));
  });

  it("never names a time before now", () => {
    const late = new Date(2026, 10, 5, 22, 0, 0);
    expect(promiseTime("Tonight I'll deploy.", late)).toEqual(late);
  });
});

describe("detectStall with an answer that waits on the user in another sentence (review 6, R2)", () => {
  const input = (answer: string): StallInput => ({
    outcome: "completed",
    stopped: false,
    continued: false,
    excluded: false,
    waitOpen: false,
    waitsForAttention: false,
    answer,
    openSteps: ["Send the email to the board"],
  });

  it.each([
    "Draft is in the doc. Let me know if this looks right.\nI'll keep an eye on replies.",
    "Approve the draft and I'll send it. Meanwhile I'll keep an eye on the inbox.",
    "Here's the draft email to the board. Please review and approve.",
    "Standing by for your go-ahead.",
    "I need your approval before I send it.",
    "Over to you.",
    "Once Sam signs I'll send the invoice.",
  ])("no stall: %s", (answer) => {
    expect(detectStall(input(answer))).toBeNull();
  });

  it("still finds a promise with no wait on the user", () => {
    expect(detectStall(input("I emailed the vendors. I'll let you know when they reply."))?.kind).toBe("promise");
  });
});

describe("followUpPromise in a draft with a header (review 6, R6)", () => {
  it.each([
    "Email to Sam:\n\nSam - thanks for the quote. I'll get back to you by Friday with the signed contract.",
    "### Draft\n\nThanks for the quote. I'll get back to you by Friday.",
    "**Message for Sam**\n\nThanks. I'll follow up next week.",
    "Text to send:\nHi, I'll let you know when the part arrives.",
    "SMS to the plumber:\nI'll let you know when I'm home.",
  ])("%j is not the agent's promise", (answer) => {
    expect(followUpPromise(answer)).toBeNull();
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
      checkIn: true,
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
      checkInRestricts: () => Effect.succeed(state.checkIn),
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

  it("checks a promise with a named time after that time, and counts its age from it (review 6, R3)", async () => {
    const { store, state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn({ answer: "Invoice checked. Tomorrow I'll pay the supplier." }));
    const check = store.forLane("chief", null);
    const named = promiseTime("Tomorrow I'll pay the supplier.", new Date("2026-11-01T10:00:00.000Z"));
    if (!check?.dueAt || !(named instanceof Date)) throw new Error("no check");
    expect(Date.parse(check.dueAt)).toBe(named.getTime() + STALL_GRACE_MS);
    advance(STALL_GRACE_MS);
    await fire();
    expect(state.nudges).toEqual([]);
    // Past the 24 hours from creation, but inside 24 hours from the named time: a nudge.
    advance(Date.parse(check.dueAt) - Date.parse("2026-11-01T10:00:00.000Z") - STALL_GRACE_MS);
    await fire();
    expect(state.nudges).toHaveLength(1);
  });

  it("checks a promise whose time it cannot read late, and counts its age from that time (review 8, L5)", async () => {
    const { store, state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn({ answer: "Invoice checked. I'll get back to you by end of week." }));
    const check = store.forLane("chief", null);
    const late = promiseTime("I'll get back to you by end of week.", new Date("2026-11-01T10:00:00.000Z"));
    if (!check?.dueAt || !late) throw new Error("no check");
    expect(Date.parse(check.dueAt)).toBe(late.getTime() + STALL_GRACE_MS);
    advance(2 * STALL_MAX_AGE_MS);
    await fire();
    expect(state.nudges).toEqual([]);
    // Days past the age limit from creation, but inside it from the late check: a nudge.
    advance(Date.parse(check.dueAt) - Date.parse("2026-11-01T10:00:00.000Z") - 2 * STALL_MAX_AGE_MS);
    await fire();
    expect(state.nudges).toHaveLength(1);
    expect(state.alerts).toEqual([]);
  });

  it("sends no nudge to a provider that it cannot restrict, and alerts the user", async () => {
    const { store, state, sweep, advance, fire } = setup();
    state.checkIn = false;
    sweep.turnEnded(userTurn());
    advance(STALL_GRACE_MS);
    await fire();
    expect(state.nudges).toEqual([]);
    expect(state.alerts).toEqual([{ agentId: "chief", taskId: null }]);
    expect(store.forLane("chief", null)).toBeNull();
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

  it("puts off a due check while the lane is busy, then nudges (review 5, N6)", async () => {
    const { store, state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn());
    state.laneBusy = true;
    advance(STALL_GRACE_MS);
    await fire();
    expect(state.nudges).toEqual([]);
    const check = store.forLane("chief", null);
    expect(check).toMatchObject({ nudges: 0 });
    expect(Date.parse(check?.dueAt ?? "")).toBeGreaterThan(Date.parse("2026-11-01T10:00:00.000Z") + STALL_GRACE_MS);
    advance(15 * 60_000);
    await fire();
    expect(state.nudges).toEqual([]);
    state.laneBusy = false;
    advance(15 * 60_000);
    await fire();
    expect(state.nudges).toHaveLength(1);
  });

  it("ends a check that a busy lane put off past the age limit", async () => {
    const { store, state, sweep, advance, fire } = setup();
    sweep.turnEnded(userTurn());
    state.laneBusy = true;
    for (let pass = 0; pass < 100; pass += 1) {
      advance(15 * 60_000);
      await fire();
    }
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
    dueAt: "2026-11-01T10:15:00.000Z",
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
    // A status question while the timed wait of the first request is open (review 5, N3).
    ["an older timed wait of the lane", { wakeAt: "2026-11-01T12:00:00.000Z" }, true],
    // Review 6, R8: a timed wait that wakes more than 24 hours after the check's time does not back it.
    ["an older timed wait of the lane that wakes in 3 days", { wakeAt: "2026-11-04T12:00:00.000Z" }, false],
    [
      "an older timed wait of the lane that wakes 23 hours after the check",
      { wakeAt: "2026-11-02T09:15:00.000Z" },
      true,
    ],
  ])("%s: %s", (_name, change, backs) => {
    expect(waitBacksStallCheck([wait(change)], check, inChat, new Date(check.dueAt))).toBe(backs);
  });

  it("ignores a wait of another lane", () => {
    expect(waitBacksStallCheck([wait({ requestMessageId: "request-1" })], check, () => "task-1")).toBe(false);
  });
});
