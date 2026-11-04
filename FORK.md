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
| Stall nudge text and prompt branch | `src/backend/agent/delivery-content.ts` (`STALL_NUDGE_HEADER`, `STALL_NUDGE_REQUEST_MAX`, `cutStallRequest`, `stallNudgeText`, `isStallNudgeDelivery`) | A nudge is a wake-shaped message of the agent to itself; its own text goes to the provider. Its first instruction stops an agent that waits for the user. |
| `status.agent.stallAlert` | `packages/i18n/src/messages/*/status/agent.ts` | The alert line after the last nudge. |

## Settings

- `OPENBOT_STALL_SWEEP=0` turns the stall sweep off. It is on by default. The limits are constants in
  `src/backend/stall-sweep/stall-sweep.ts`: 15 minutes of grace, 60 minutes between nudges, 2 nudges
  for each request, 12 nudges for each agent in 24 hours, and a maximum check age of 24 hours
  (`STALL_MAX_AGE_MS`; an older check ends with no nudge). A nudge repeats at most 2,000 characters of
  the request (`STALL_NUDGE_REQUEST_MAX` in `src/backend/agent/delivery-content.ts`).
