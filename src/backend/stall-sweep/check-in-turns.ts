import type { HookCallbackMatcher, Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProviderId } from "@openbot/contracts/ipc";

/**
 * The code half of a harmless stall nudge. A nudge turn is a check-in only: the agent can report the
 * state of the work, open a wait, make or change a routine, ask the user, and read. It cannot act. The
 * text of the nudge says so, but the safety does not depend on the text: each provider that OpenBot
 * can restrict refuses every other tool call of the turn in code.
 *
 * - OpenBot's own tools (every provider): `OpenBotToolRouter` refuses a tool that is not in
 *   `CHECK_IN_OPENBOT_TOOLS`, and every browser tool.
 * - Claude: a `PreToolUse` hook, which runs also when an allow rule of the user matches, denies every
 *   tool that is not in `CLAUDE_CHECK_IN_TOOLS` and not an OpenBot tool. The MCP tools of the user's
 *   servers, Bash, file writes, web fetches and subagents are denied.
 * - Codex: the turn runs with a read-only sandbox with no network and the `untrusted` approval policy,
 *   and OpenBot declines each approval, permission and MCP consent request of the turn. Codex runs the
 *   MCP tools of the user's servers outside its sandbox, and a tool that the user set to "always
 *   allow" asks nothing, so a Codex agent gets a nudge only when no MCP server is on.
 * - Every other provider (ACP agents, Pi, Grok, Muse, and the rest): OpenBot cannot restrict a turn,
 *   so the sweep sends no nudge and shows the stall alert line to the user.
 */

/** OpenBot tools that a check-in turn may call. Each one reports, waits, schedules, asks or reads. */
export const CHECK_IN_OPENBOT_TOOLS: ReadonlySet<string> = new Set([
  // Waits and routines.
  "await_event",
  "list_waits",
  "close_wait",
  "create_routine",
  "update_routine",
  "list_routines",
  // Questions to the user.
  "ask_user",
  "ask_ui",
  "acknowledge_request",
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
  "list_tables",
  "query_data",
  "list_sites",
  "list_api_keys",
  "list_mcp_servers",
  "list_models",
  "list_local_skills",
  "read_local_skill",
]);

/** Claude's own tools that a check-in turn may use: reads, its to-do list and its question to the user. */
export const CLAUDE_CHECK_IN_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebSearch",
  "TodoWrite",
  "TodoRead",
  "AskUserQuestion",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

/** The prefix of the tools of OpenBot's own MCP server in Claude. `OpenBotToolRouter` checks each one. */
const CLAUDE_OPENBOT_TOOL_PREFIX = "mcp__openbot__";

/** What the agent reads when a check-in turn calls a tool that it may not use. */
export const CHECK_IN_REFUSAL =
  "This turn is a check-in only. You cannot act in it. Report status, open a wait with openbot.await_event, make a routine, or ask the user with openbot.ask_user.";

/** The Codex sandbox of a check-in turn: no write and no network. */
export const CHECK_IN_CODEX_SANDBOX = { type: "readOnly", networkAccess: false } as const;
/** The Codex approval policy of a check-in turn: each command that is not known to be safe asks, and OpenBot declines. */
export const CHECK_IN_CODEX_APPROVAL = "untrusted";

/** Whether a check-in turn may call this OpenBot tool. A browser tool never: it can click and submit. */
export function checkInAllowsOpenBotTool(namespace: string | null, tool: string): boolean {
  return namespace === "openbot" && CHECK_IN_OPENBOT_TOOLS.has(tool);
}

/** Whether a check-in turn of Claude may use this tool. OpenBot's own tools pass to `OpenBotToolRouter`. */
export function checkInAllowsClaudeTool(toolName: string): boolean {
  return CLAUDE_CHECK_IN_TOOLS.has(toolName) || toolName.startsWith(CLAUDE_OPENBOT_TOOL_PREFIX);
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
 * Whether OpenBot can restrict a turn of this agent to a check-in. Claude always; Codex only when no
 * MCP server is on (`mcpServers` is the number of servers that its threads get). Each other provider
 * not: the sweep shows the alert line in place of a nudge.
 */
export function checkInRestricts(provider: AgentProviderId, mcpServers: number): boolean {
  if (provider === "claude") return true;
  if (provider === "codex") return mcpServers === 0;
  return false;
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
