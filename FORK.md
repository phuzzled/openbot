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
| Plan continuation gate | `src/backend/agent/plan-continuation.ts` (one import, an optional `request` input of `consider` and `restore`, and one check in each), `turn-lifecycle.ts` (passes the user's request text; no continuation of a stall nudge), `boot-recovery.ts` (passes the request text) | A continuation, upstream's own after a user turn included, does not run toward an outward next step (send, pay, book, deploy, delete, and so on) that the user's request did not name, or after an answer that asks the user or names an approval. The rule is in `src/backend/stall-sweep/continuation-gate.ts`. `ASKS_TO_CONTINUE` stays private: the gate gets it as a callback. |
| Check-in turns (harmless nudges) | `src/backend/agent/drain-scheduler.ts` (`checkIn` registry, `checkInOnly`, the Codex sandbox and approval policy of a nudge turn), `openbot-tool-router.ts` (one check at the top of `handle`, one before the dynamic tool dispatch), `attention-registry.ts` (`declineForCheckIn`), `claude-client.ts` (`#checkInThreads`, one `canUseTool` line, the `PreToolUse` hook on every non-profile session), `agent-service.ts` (`checkInRestricts` hook) | A stall nudge turn cannot act: each provider refuses every tool that is not a report, a wait, a routine, a question or a read. A provider that OpenBot cannot restrict gets no nudge. The rules are in `src/backend/stall-sweep/check-in-turns.ts`. |
| Stall nudge text and prompt branch | `src/backend/agent/delivery-content.ts` (`STALL_NUDGE_HEADER`, `STALL_NUDGE_REQUEST_MAX`, `cutStallRequest`, `stallNudgeText`, `isStallNudgeDelivery`) | A nudge is a wake-shaped message of the agent to itself; its own text goes to the provider. Its first instruction stops an agent that waits for the user. |
| `status.agent.stallAlert` | `packages/i18n/src/messages/*/status/agent.ts` | The alert line after the last nudge. |

## Settings

- `OPENBOT_STALL_SWEEP=0` turns the stall sweep off. It is on by default. The limits are constants in
  `src/backend/stall-sweep/stall-sweep.ts`: 15 minutes of grace, 60 minutes between nudges, 2 nudges
  for each request, 12 nudges for each agent in 24 hours, and a maximum check age of 24 hours
  (`STALL_MAX_AGE_MS`; an older check ends with no nudge). A promise that names a time is due 15 minutes
  after that time, and its age counts from that time (`stall-sweep/promise-time.ts`). A nudge repeats at most 2,000 characters of
  the request (`STALL_NUDGE_REQUEST_MAX` in `src/backend/agent/delivery-content.ts`).
