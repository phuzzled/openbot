# Fork deviations

This repository is a fork of OpenBot (`nightly-labs/openbot`). This file lists each place where the
fork differs from upstream in a way that can collide with a later upstream change. Keep it current.

## Rules

- Never add a column to an upstream table. Put fork data in a fork-owned table with the `fork_`
  prefix.
- Never use an upstream migration number. Do not append to `MIGRATIONS` in
  `src/backend/openbot-database-schema.ts`, `LATEST_SCHEMA_SQL` or
  `openbot-database-schema-history.json`. When upstream ships version N, a fork database already
  stamped N would skip it. The schema drift is irreversible, and no backup exists.
- Create fork tables in `src/backend/database/fork-schema.ts` only. That step runs at each start,
  after the upstream migrations, on new and upgraded databases, in one transaction. Each statement
  is idempotent (`IF NOT EXISTS`), and it writes nothing to `schema_migrations`.
- Delete fork rows with the upstream rows that they belong to, explicitly. A fork table has no
  foreign key to an upstream table, and the start step deletes orphan rows.

## Deviations

| Item | Where | Reason |
|---|---|---|
| `fork_agent_wait_timers` (`wait_id`, `agent_id`, `wake_at`, `time_wakes`) | `src/backend/database/fork-schema.ts`, `src/backend/agent-waits/agent-wait-store.ts` | The wake time and the wake count of a timed wait (`openbot.await_event` with `wakeAfterMinutes` or `wakeAt`). It replaces a fork-only migration 56 that added two columns to `agent_waits`. No live database ran that migration. |
| Timer rows deleted with a wait, with an agent, and as orphans at start | `AgentWaitStore.delete`, `database/agent-roster.ts` `hardDeleteAgent`, `applyForkSchema` | The fork table has no foreign key to `agent_waits`. |
| `fork_stall_checks` (`check_id`, `agent_id`, `task_id`, `request_delivery_id`, `request_text`, `turn_id`, `reason`, `due_at`, `nudges`, `nudge_delivery_id`, `created_at`) and `fork_stall_nudges` (`agent_id`, `sent_at`) | `src/backend/database/fork-schema.ts`, `src/backend/stall-sweep/` | The stall sweep: one check per lane for a turn that left work open with nothing to bring the agent back, and a log of nudges for the daily limit. |
| Stall rows deleted with an agent, and as orphans at start | `database/agent-roster.ts` `hardDeleteAgent`, `applyForkSchema` | A check whose request delivery is gone, and a log row older than 2 days or of an agent with no delivery, go at start. |
| `turnSettled` hook | `src/backend/agent/turn-lifecycle.ts` (one optional hook and one call) | The stall sweep checks each turn after its deliveries settle. |
| Plan continuation reads `answerWaitsOnUser` | `src/backend/agent/turn-lifecycle.ts` `#planContinues` (one import and one call, in place of `waitsForUser`) | An answer that waits on the user, on an approval or on a named person ("Let me know what you think", "After approval I'll send it", "Once Andrew replies") does not continue its plan, as the stall sweep does not check its open steps. The rule is in `src/backend/stall-sweep/stall-detection.ts`. |
| Plan continuation note line | `src/backend/agent/delivery-content.ts` (`planContinuationPrompt`, `nextStepContinuationPrompt`: one line each) | "Before a step that sends, pays, books, deploys, deletes or contacts someone, and that the user did not ask for, ask the user first." The agent and its own approval settings decide, not a word list. |
| No continuation of a stall nudge | `turn-lifecycle.ts` `#planContinues` (one `isStallNudgeDelivery` check), `boot-recovery.ts` `#restorePlan` (one check) | A nudge turn is a check-in that cannot act; a continuation of it, also after a restart, would run with no restriction. |
| Check-in turns (harmless nudges) | `src/backend/agent/drain-scheduler.ts` (`checkIn` registry, `checkInOnly`, the Codex sandbox and approval policy of a nudge turn; every turn of a nudge delivery), `openbot-tool-router.ts` (one check at the top of `handle`, one before the dynamic tool dispatch), `attention-registry.ts` (`declineForCheckIn`), `claude-client.ts` (`#checkInThreads`, one `canUseTool` line, the `PreToolUse` hook on every non-profile session), `agent-service.ts` (`#checkInRestricts`: reads the Codex config), `thread-lifecycle.ts` (an optional `codexConfigRead` hook and an `agentId` argument of `codexOwnServersEffect`) | A stall nudge turn cannot act and cannot make or change anything that runs later, such as a routine: each provider refuses every tool that is not a wait of the agent, a question or a read. A provider that OpenBot cannot restrict gets no nudge; a Codex agent only when its Codex config turns off apps, plugins, browser use and computer use. The rules are in `src/backend/stall-sweep/check-in-turns.ts`. |
| Wait request of a check-in turn | `src/backend/agent-waits/agent-waits.ts` (`waitRequestText` for the request text of a new wait; one line of the wake text) | A wait that a nudge turn opens serves the user's request, not the nudge text. The wake text says that the note is the agent's own reminder, not a message from the user. |
| Stall nudge text and prompt branch | `src/backend/agent/delivery-content.ts` (`STALL_NUDGE_REQUEST_MAX`, `cutStallRequest`, `stallNudgeText`, `isStallNudgeDelivery`; `STALL_NUDGE_HEADER` is in `check-in-turns.ts`) | A nudge is a wake-shaped message of the agent to itself; its own text goes to the provider. Its first instruction stops an agent that waits for the user. |
| `status.agent.stallAlert` | `packages/i18n/src/messages/*/status/agent.ts` | The alert line after the last nudge. |

## Settings

- `OPENBOT_STALL_SWEEP=0` turns the stall sweep off. It is on by default. The limits are constants in
  `src/backend/stall-sweep/stall-sweep.ts`: 15 minutes of grace, 60 minutes between nudges, 2 nudges
  for each request, 12 nudges for each agent in 24 hours, and a maximum check age of 24 hours
  (`STALL_MAX_AGE_MS`; an older check ends with no nudge). A promise that names a time is due 15 minutes
  after that time, and its age counts from that time (`stall-sweep/promise-time.ts`). A promise with a
  time word that it does not read gets no check. A nudge repeats at most 2,000 characters of
  the request (`STALL_NUDGE_REQUEST_MAX` in `src/backend/agent/delivery-content.ts`).
