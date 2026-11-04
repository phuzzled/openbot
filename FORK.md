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
