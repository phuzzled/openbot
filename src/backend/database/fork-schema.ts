import type { DatabaseSync } from "node:sqlite";

/**
 * The schema that only this fork of OpenBot adds. It is NOT part of the upstream migration sequence
 * (`openbot-database-schema.ts`), on purpose: a fork migration would take the next upstream version
 * number, and when upstream ships its own migration with that number, a fork database that is already
 * stamped with it would skip the upstream change. That drift is irreversible, and no backup exists.
 *
 * So the fork keeps its data in its own tables, with the `fork_` prefix, and never adds a column to an
 * upstream table. `applyForkSchema` runs at each start, after the upstream migrations, on a new and on
 * an upgraded database. Each statement is idempotent (`IF NOT EXISTS`), so it is safe to run again,
 * and it writes nothing to `schema_migrations`. A stock upstream build ignores these tables.
 *
 * `fork_agent_wait_timers` holds the wake time of an open wait (`agent_waits`), and the number of times
 * that a wake time woke it. A wait with no row has no wake time and was never woken by one. The row has
 * the wait's id and agent id. `AgentWaitStore` deletes it with its wait, and `hardDeleteAgent` with the
 * agent; each start also deletes a row whose wait is gone.
 *
 * `fork_stall_checks` holds the stall checks of the stall sweep (`stall-sweep/stall-sweep.ts`): at most
 * one per lane (the agent's own chat, or one task), for a turn that ended with work open and nothing
 * that brings the agent back. `fork_stall_nudges` logs each nudge that the sweep sent, for the daily
 * limit of each agent. `hardDeleteAgent` deletes both with the agent. Each start deletes a check whose
 * request delivery is gone, and a log row that is older than two days or whose agent has no delivery.
 * See `FORK.md` at the repository root.
 */
export const FORK_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS fork_agent_wait_timers (
    wait_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    wake_at TEXT,
    time_wakes INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS fork_agent_wait_timers_agent ON fork_agent_wait_timers(agent_id);
  CREATE INDEX IF NOT EXISTS fork_agent_wait_timers_wake_at ON fork_agent_wait_timers(wake_at)
    WHERE wake_at IS NOT NULL;
  CREATE TABLE IF NOT EXISTS fork_stall_checks (
    check_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    task_id TEXT,
    request_delivery_id TEXT NOT NULL,
    request_text TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    due_at TEXT,
    nudges INTEGER NOT NULL DEFAULT 0,
    nudge_delivery_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS fork_stall_checks_lane ON fork_stall_checks(agent_id, COALESCE(task_id, ''));
  CREATE INDEX IF NOT EXISTS fork_stall_checks_due_at ON fork_stall_checks(due_at) WHERE due_at IS NOT NULL;
  CREATE TABLE IF NOT EXISTS fork_stall_nudges (
    agent_id TEXT NOT NULL,
    sent_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS fork_stall_nudges_agent ON fork_stall_nudges(agent_id, sent_at);
`;

/**
 * Creates the fork tables when they are missing, and deletes the orphan rows: a timer row whose wait
 * is gone, a stall check whose request delivery is gone, and an old nudge log row. One transaction: a
 * failure leaves the database as it was, and the next start tries again.
 */
export function applyForkSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(FORK_SCHEMA_SQL);
    db.exec(
      "DELETE FROM fork_agent_wait_timers WHERE NOT EXISTS (SELECT 1 FROM agent_waits WHERE agent_waits.wait_id = fork_agent_wait_timers.wait_id)",
    );
    db.exec(
      "DELETE FROM fork_stall_checks WHERE NOT EXISTS (SELECT 1 FROM projection_deliveries d WHERE d.delivery_id = fork_stall_checks.request_delivery_id)",
    );
    db.prepare(
      "DELETE FROM fork_stall_nudges WHERE sent_at < ? OR NOT EXISTS (SELECT 1 FROM projection_deliveries d WHERE d.recipient_agent_id = fork_stall_nudges.agent_id)",
    ).run(new Date(Date.now() - 2 * 86_400_000).toISOString());
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
