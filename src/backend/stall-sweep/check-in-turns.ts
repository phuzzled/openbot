import type { HookCallbackMatcher, Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProviderId } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

/**
 * The code half of a harmless stall nudge. A nudge turn is a check-in only: the agent can report the
 * state of the work, open or close its own wait, ask the user, and read. It cannot act, and it cannot
 * make or change anything that runs later or elsewhere, such as a routine. The text of the nudge says
 * so, but the safety does not depend on the text: each provider that OpenBot can restrict refuses every
 * other tool call of the turn in code.
 *
 * - OpenBot's own tools (every provider): `OpenBotToolRouter` refuses a tool that is not in
 *   `CHECK_IN_OPENBOT_TOOLS`, and every browser tool.
 * - Claude: a `PreToolUse` hook, which runs also when an allow rule of the user matches, denies every
 *   tool that is not in `CLAUDE_CHECK_IN_TOOLS` and not one of the OpenBot tools of
 *   `CHECK_IN_OPENBOT_TOOLS` on OpenBot's own server. The MCP tools and resources of the user's servers,
 *   Bash, file writes, web fetches, web searches and subagents are denied.
 * - Every provider but Claude (Codex, ACP agents, Pi, Grok, Muse, and the rest): OpenBot cannot
 *   restrict a turn fully, so the sweep sends no nudge and shows the stall alert line to the user.
 *   Codex runs the MCP tools of the user's servers, its apps, its plugins and its browser and computer
 *   use outside its sandbox, and its effective config can change under a running thread. A nudge
 *   delivery that still reaches a Codex thread (the provider changed after the sweep queued it) runs
 *   with a read-only sandbox and the `untrusted` approval policy, and OpenBot declines its approvals.
 */

/** The first line of a stall nudge (`stallNudgeText`). It tells a nudge from the wake of timed waits. */
export const STALL_NUDGE_HEADER = "OpenBot check: your last turn ended with work still open.";
/** The line of a stall nudge after which the request of the user follows, to the end of the text. */
export const STALL_NUDGE_REQUEST_LINE = "--- the request ---";

/**
 * The request that a wait serves when a turn of this delivery opens it. For a stall nudge (a message
 * of the agent to itself that starts with `STALL_NUDGE_HEADER`) it is the request of the user that the
 * nudge repeats, not the text of the nudge. So a wait that a check-in turn opens carries no instruction
 * that the user did not give, and its wake reads the same as the wake of any other wait.
 */
export function waitRequestText(delivery: {
  sender: { kind: string; agentId?: string };
  recipientAgentId: string;
  text: string;
}): string {
  if (
    delivery.sender.kind !== "agent" ||
    delivery.sender.agentId !== delivery.recipientAgentId ||
    !delivery.text.startsWith(STALL_NUDGE_HEADER)
  )
    return delivery.text;
  const at = delivery.text.indexOf(`\n${STALL_NUDGE_REQUEST_LINE}\n`);
  return at < 0 ? "" : delivery.text.slice(at + STALL_NUDGE_REQUEST_LINE.length + 2);
}

/**
 * OpenBot tools that a check-in turn may call. Each one waits, asks or reads. None makes or changes
 * anything that runs later or elsewhere: `create_routine` and `update_routine` are not here, because a
 * routine runs later as a normal turn with no restriction. `acknowledge_request` is not here either:
 * when nobody answers in 10 s, OpenBot presses its start button, which is not the user's answer.
 * `close_wait` closes only the agent's own wait (`checkInAllowsOpenBotTool`). Of the tools of upstream
 * v0.61.0, only the workflow reads are here: `save_api_key`, `create_channel`, `update_channel`,
 * `channel_cancel`, `edit_workflow`, `delete_workflow` and `run_workflow` write, delete or start work.
 */
export const CHECK_IN_OPENBOT_TOOLS: ReadonlySet<string> = new Set([
  // The agent's own waits.
  "await_event",
  "list_waits",
  "close_wait",
  "list_routines",
  // Questions to the user.
  "ask_user",
  "ask_ui",
  // Reads.
  "tool_search",
  "tool_describe",
  "history_search",
  "history_read",
  "list_agents",
  "read_agent",
  "list_memories",
  "search_memories",
  "list_sections",
  "list_channels",
  "channel_history",
  "channel_list_routines",
  "list_workflows",
  "read_workflow",
  "read_workflow_runs",
  "list_tables",
  "query_data",
  "list_sites",
  "list_api_keys",
  "list_mcp_servers",
  "list_models",
  "list_local_skills",
  "read_local_skill",
]);

/**
 * Claude's own tools that a check-in turn may use: local reads, its to-do list and its question to the
 * user. `WebSearch` sends a query out, and the MCP resource tools call the user's servers, which can do
 * anything on a read: they are not here.
 */
export const CLAUDE_CHECK_IN_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "TodoWrite",
  "TodoRead",
  "AskUserQuestion",
]);

/**
 * The prefix of the tools of OpenBot's own MCP server in Claude. Claude changes `.` and spaces in a
 * server name to `_`, so a user server named `openbot_` or `openbot.` makes tool names that also start
 * with it: only an exact OpenBot tool name after the prefix passes.
 */
const CLAUDE_OPENBOT_TOOL_PREFIX = "mcp__openbot__";

/** What the agent reads when a check-in turn calls a tool that it may not use. */
export const CHECK_IN_REFUSAL =
  "This turn is a check-in only. You cannot act in it. Report status, open a wait with openbot.await_event, or ask the user with openbot.ask_user.";

/** The Codex sandbox of a check-in turn: no write and no network. */
export const CHECK_IN_CODEX_SANDBOX = { type: "readOnly", networkAccess: false } as const;
/** The Codex approval policy of a check-in turn: each command that is not known to be safe asks, and OpenBot declines. */
export const CHECK_IN_CODEX_APPROVAL = "untrusted";

/**
 * Whether a check-in turn may call this OpenBot tool. A browser tool never: it can click and submit.
 * `close_wait` only for a wait of the calling agent (`agentId` absent or the caller's own id).
 */
export function checkInAllowsOpenBotTool(
  namespace: string | null,
  tool: string,
  args?: unknown,
  callerAgentId?: string | null,
): boolean {
  if (namespace !== "openbot" || !CHECK_IN_OPENBOT_TOOLS.has(tool)) return false;
  if (tool !== "close_wait") return true;
  const agentId = isDynamicRecord(args) ? args.agentId : undefined;
  return agentId === undefined || (typeof callerAgentId === "string" && agentId === callerAgentId);
}

/**
 * Whether a check-in turn of Claude may use this tool: one of `CLAUDE_CHECK_IN_TOOLS`, or exactly
 * `mcp__openbot__<tool>` for a tool of `CHECK_IN_OPENBOT_TOOLS`. `OpenBotToolRouter` checks those again.
 */
export function checkInAllowsClaudeTool(toolName: string): boolean {
  if (CLAUDE_CHECK_IN_TOOLS.has(toolName)) return true;
  return (
    toolName.startsWith(CLAUDE_OPENBOT_TOOL_PREFIX) &&
    CHECK_IN_OPENBOT_TOOLS.has(toolName.slice(CLAUDE_OPENBOT_TOOL_PREFIX.length))
  );
}

/**
 * The `PreToolUse` hook of a Claude session that denies, while `checkIn()` is true, each tool that
 * `checkInAllowsClaudeTool` does not allow. A hook runs for every tool, also when an allow rule of the
 * user's Claude settings matches it or the session skips permission prompts. Joined with the other
 * `PreToolUse` hooks of the session: the first deny wins.
 */
export function claudeCheckInHooks(
  checkIn: () => boolean,
  hooks: NonNullable<Options["hooks"]> = {},
): NonNullable<Options["hooks"]> {
  const matcher: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse" || !checkIn() || checkInAllowsClaudeTool(input.tool_name)) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: CHECK_IN_REFUSAL,
          },
        };
      },
    ],
  };
  return { ...hooks, PreToolUse: [matcher, ...(hooks.PreToolUse ?? [])] };
}

/**
 * Whether OpenBot can restrict a turn of this agent to a check-in. By default Claude only. Each other
 * provider, Codex included, not: the sweep shows the alert line in place of a nudge. A test can list
 * Codex too (`stallNudgeProviders`).
 */
export function checkInRestricts(
  provider: AgentProviderId,
  nudgeProviders: string | undefined = process.env.OPENBOT_STALL_NUDGE_PROVIDERS,
): boolean {
  return stallNudgeProviders(nudgeProviders).has(provider);
}

/** The providers that have a code lock on a check-in turn, and that `OPENBOT_STALL_NUDGE_PROVIDERS` can list. */
const LOCKED_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex"]);

/**
 * The providers that get stall nudges: `OPENBOT_STALL_NUDGE_PROVIDERS`, a comma list, for tests and
 * expert use. Only "claude" and "codex" count: each other name is ignored. Empty, unset or with no
 * name that counts: Claude only. Codex has only its read-only sandbox and `untrusted` approvals, and
 * its apps (also the legacy `connectors`), plugins and project `.codex/config.toml` can run outside
 * them (review 8), so list it only with that config off and a restart after each config edit.
 */
export function stallNudgeProviders(value: string | undefined): ReadonlySet<string> {
  const listed = (value ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => LOCKED_PROVIDERS.has(name));
  return new Set(listed.length > 0 ? listed : ["claude"]);
}

/**
 * Owns the provider threads that run a check-in turn now. `DrainScheduler` marks a thread when it
 * starts a turn: on for a stall nudge, off for each other turn. A thread stays marked after its
 * check-in turn ends, until its next turn starts; that only restricts more. It holds no other state.
 */
export class CheckInTurns {
  readonly #threads = new Set<string>();

  /** Marks the turn that starts now on the provider thread. */
  mark(threadId: string, checkIn: boolean): void {
    if (checkIn) this.#threads.add(threadId);
    else this.#threads.delete(threadId);
  }

  /** Whether the provider thread runs a check-in turn. */
  has(threadId: string | null | undefined): boolean {
    return typeof threadId === "string" && this.#threads.has(threadId);
  }

  forget(threadId: string): void {
    this.#threads.delete(threadId);
  }
}
