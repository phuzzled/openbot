/**
 * The open waits of every agent. Rows are written directly, not through `database.dispatch`: a wait
 * holds a copy of the user's request, and the event log is never deleted from. A closed or cancelled
 * wait is deleted. It owns no events: the runtime says when something changed.
 *
 * The wake time and the count of time wakes are in the fork's own table `fork_agent_wait_timers`
 * (`database/fork-schema.ts`), not in `agent_waits`: the fork adds no column to an upstream table. The
 * store reads them with a join, and deletes a timer row with its wait.
 *
 * A timed wait is a wait that has a wake time, or that a wake time woke (`time_wakes` > 0). Only its
 * time, a script event that names it, or a run of the routine that its `routine_id` names wakes it. A
 * run of any other routine does not, also after the wake cleared its time: the agent set a time, so it
 * did not ask for each routine run. A timed wait that the agent leaves open with no new time stays
 * open, and only a script event, a new time or the user's cancel ends that. A wait with no time and no
 * routine is woken by every routine run of its agent, as before wake times. A wait with no time that
 * gets one becomes a timed wait.
 */

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentWait } from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import {
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../database/database-rows";
import type { OpenBotDatabase } from "../openbot-database";

/** A refusal the agent reads: the text is already a sentence for it. */
export class AgentWaitError extends Error {}

/** The agent already has the most open waits it may have. */
export class AgentWaitLimitError extends AgentWaitError {}

export interface AgentWaitStoreOptions {
  database: Pick<OpenBotDatabase, "connection">;
  createId?: () => string;
  now?: () => Date;
}

export interface OpenAgentWaitInput {
  agentId: string;
  requestMessageId: string;
  requestText: string;
  note: string;
  routineId: string | null;
  /** When the wait wakes by itself, as an ISO time. Null: a routine run or a script event wakes it. */
  wakeAt: string | null;
  /**
   * The time wakes that the wait starts with. A wait that a wake turn opens again for the same
   * request keeps the count of the wait that it replaces, so the limit stays. Absent: 0.
   */
  timeWakes?: number;
}

/** Each wait with its timer row, if it has one. */
const WAIT_SELECT = `SELECT w.*, t.wake_at AS wake_at, COALESCE(t.time_wakes, 0) AS time_wakes
  FROM agent_waits w LEFT JOIN fork_agent_wait_timers t ON t.wait_id = w.wait_id`;

export class AgentWaitStore {
  readonly #database: Pick<OpenBotDatabase, "connection">;
  readonly #createId: () => string;
  readonly #now: () => Date;

  constructor(options: AgentWaitStoreOptions) {
    this.#database = options.database;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  list(agentId: string): AgentWait[] {
    return databaseRows(
      this.#database.connection
        .prepare(`${WAIT_SELECT} WHERE w.agent_id = ? ORDER BY w.created_at, w.wait_id`)
        .all(agentId),
    ).map(toWait);
  }

  get(agentId: string, waitId: string): AgentWait | null {
    const row = databaseRow(
      this.#database.connection.prepare(`${WAIT_SELECT} WHERE w.agent_id = ? AND w.wait_id = ?`).get(agentId, waitId),
    );
    return row ? toWait(row) : null;
  }

  /** One statement, so two tool calls at once cannot both pass the limit. The timer row in the same transaction. */
  open(input: OpenAgentWaitInput): AgentWait {
    const waitId = this.#createId();
    const timeWakes = input.timeWakes ?? 0;
    const inserted = this.#transaction(() => {
      const changes = this.#database.connection
        .prepare(
          `INSERT INTO agent_waits (wait_id, agent_id, request_delivery_id, request_text, note, routine_id, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM agent_waits WHERE agent_id = ?) < ?`,
        )
        .run(
          waitId,
          input.agentId,
          input.requestMessageId,
          input.requestText,
          input.note,
          input.routineId,
          this.#now().toISOString(),
          input.agentId,
          INPUT_LIMITS.agentWaits,
        ).changes;
      if (changes > 0 && (input.wakeAt !== null || timeWakes > 0))
        this.#database.connection
          .prepare("INSERT INTO fork_agent_wait_timers (wait_id, agent_id, wake_at, time_wakes) VALUES (?, ?, ?, ?)")
          .run(waitId, input.agentId, input.wakeAt, timeWakes);
      return changes;
    });
    if (inserted === 0)
      throw new AgentWaitLimitError(sourceText("error.backend.agentWaitLimit", { count: INPUT_LIMITS.agentWaits }));
    const wait = this.get(input.agentId, waitId);
    if (!wait) throw new Error("The new wait is missing.");
    return wait;
  }

  count(agentId: string): number {
    const row = databaseRow(
      this.#database.connection.prepare("SELECT COUNT(*) AS waits FROM agent_waits WHERE agent_id = ?").get(agentId),
    );
    return row ? requiredNumberColumn(row, "waits") : 0;
  }

  /** The number of open waits of each agent that has one. */
  countByAgent(): Map<string, number> {
    const rows = databaseRows(
      this.#database.connection.prepare("SELECT agent_id, COUNT(*) AS waits FROM agent_waits GROUP BY agent_id").all(),
    );
    return new Map(rows.map((row) => [requiredStringColumn(row, "agent_id"), requiredNumberColumn(row, "waits")]));
  }

  /** Closes or cancels a wait. False when it was not open. */
  delete(agentId: string, waitId: string): boolean {
    return this.#transaction(() => {
      this.#database.connection
        .prepare("DELETE FROM fork_agent_wait_timers WHERE agent_id = ? AND wait_id = ?")
        .run(agentId, waitId);
      return (
        this.#database.connection
          .prepare("DELETE FROM agent_waits WHERE agent_id = ? AND wait_id = ?")
          .run(agentId, waitId).changes > 0
      );
    });
  }

  /**
   * The waits a run of this routine wakes, when no event names one wait: the waits of this routine,
   * and the waits of no routine that are not timed.
   */
  forRoutineRun(agentId: string, routineId: string): AgentWait[] {
    return databaseRows(
      this.#database.connection
        .prepare(
          `${WAIT_SELECT} WHERE w.agent_id = ?
           AND (w.routine_id = ? OR (w.routine_id IS NULL AND t.wake_at IS NULL AND COALESCE(t.time_wakes, 0) = 0))
           ORDER BY w.created_at, w.wait_id`,
        )
        .all(agentId, routineId),
    ).map(toWait);
  }

  markWoken(agentId: string, waitIds: readonly string[], deliveryId: string): void {
    if (waitIds.length === 0) return;
    this.#database.connection
      .prepare(
        `UPDATE agent_waits SET woken_at = ?, wake_delivery_id = ?
         WHERE agent_id = ? AND wait_id IN (${waitIds.map(() => "?").join(", ")})`,
      )
      .run(this.#now().toISOString(), deliveryId, agentId, ...waitIds);
  }

  /** Sets or clears the time at which these waits wake by themselves. */
  setWakeAt(agentId: string, waitIds: readonly string[], wakeAt: string | null): void {
    if (waitIds.length === 0) return;
    this.#database.connection
      .prepare(
        `INSERT INTO fork_agent_wait_timers (wait_id, agent_id, wake_at)
         SELECT wait_id, agent_id, ? FROM agent_waits
         WHERE agent_id = ? AND wait_id IN (${waitIds.map(() => "?").join(", ")})
         ON CONFLICT(wait_id) DO UPDATE SET wake_at = excluded.wake_at`,
      )
      .run(wakeAt, agentId, ...waitIds);
  }

  /** Every wait that has a wake time, the earliest first. */
  timed(): AgentWait[] {
    return databaseRows(
      this.#database.connection
        .prepare(`${WAIT_SELECT} WHERE t.wake_at IS NOT NULL ORDER BY t.wake_at, w.created_at, w.wait_id`)
        .all(),
    ).map(toWait);
  }

  /**
   * Marks the waits that their wake time woke, clears that time and counts the wake in the same
   * statement, so a wait wakes once for each time it is given.
   */
  markWokenByTime(agentId: string, waitIds: readonly string[], deliveryId: string): void {
    if (waitIds.length === 0) return;
    const ids = waitIds.map(() => "?").join(", ");
    this.#transaction(() => {
      this.#database.connection
        .prepare(`UPDATE agent_waits SET woken_at = ?, wake_delivery_id = ? WHERE agent_id = ? AND wait_id IN (${ids})`)
        .run(this.#now().toISOString(), deliveryId, agentId, ...waitIds);
      this.#database.connection
        .prepare(
          `UPDATE fork_agent_wait_timers SET wake_at = NULL, time_wakes = time_wakes + 1
           WHERE agent_id = ? AND wait_id IN (${ids})`,
        )
        .run(agentId, ...waitIds);
    });
  }

  /** The open waits that this delivery woke. A wait cancelled since then is not in the list. */
  wokenBy(deliveryId: string): AgentWait[] {
    return databaseRows(
      this.#database.connection
        .prepare(`${WAIT_SELECT} WHERE w.wake_delivery_id = ? ORDER BY w.created_at, w.wait_id`)
        .all(deliveryId),
    ).map(toWait);
  }

  /**
   * Runs `write` in one transaction. A savepoint, so it also works inside a transaction that a caller
   * holds already.
   */
  #transaction<T>(write: () => T): T {
    const db = this.#database.connection;
    db.exec("SAVEPOINT agent_wait_store");
    try {
      const result = write();
      db.exec("RELEASE agent_wait_store");
      return result;
    } catch (error) {
      db.exec("ROLLBACK TO agent_wait_store");
      db.exec("RELEASE agent_wait_store");
      throw error;
    }
  }
}

function toWait(row: DynamicRecord): AgentWait {
  return {
    id: requiredStringColumn(row, "wait_id"),
    agentId: requiredStringColumn(row, "agent_id"),
    note: requiredStringColumn(row, "note"),
    requestMessageId: requiredStringColumn(row, "request_delivery_id"),
    requestText: requiredStringColumn(row, "request_text"),
    routineId: optionalStringColumn(row, "routine_id"),
    createdAt: requiredStringColumn(row, "created_at"),
    wokenAt: optionalStringColumn(row, "woken_at"),
    wakeDeliveryId: optionalStringColumn(row, "wake_delivery_id"),
    wakeAt: optionalStringColumn(row, "wake_at"),
    timeWakes: requiredNumberColumn(row, "time_wakes"),
  };
}
