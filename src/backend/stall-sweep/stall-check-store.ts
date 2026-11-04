import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import {
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../database/database-rows";
import type { OpenBotDatabase } from "../openbot-database";

/** One stall check: a lane whose last turn left work open, and when the sweep looks at it again. */
export interface StallCheck {
  id: string;
  agentId: string;
  /** The task of the lane. Null: the agent's own chat. */
  taskId: string | null;
  /** The delivery of the request that the lane serves. Nudge turns keep the request of their check. */
  requestDeliveryId: string;
  requestText: string;
  /** The last turn of the lane that the check saw. */
  turnId: string;
  reason: string;
  /** When the sweep looks at the lane. Null while a nudge or a plan continuation of the request runs. */
  dueAt: string | null;
  /** The nudges that the request got. */
  nudges: number;
  /** The delivery of the last nudge, or null before the first one. */
  nudgeDeliveryId: string | null;
  createdAt: string;
}

export interface StallCheckStoreOptions {
  database: Pick<OpenBotDatabase, "connection">;
  createId?: () => string;
}

function toCheck(row: DynamicRecord): StallCheck {
  return {
    id: requiredStringColumn(row, "check_id"),
    agentId: requiredStringColumn(row, "agent_id"),
    taskId: optionalStringColumn(row, "task_id"),
    requestDeliveryId: requiredStringColumn(row, "request_delivery_id"),
    requestText: requiredStringColumn(row, "request_text"),
    turnId: requiredStringColumn(row, "turn_id"),
    reason: requiredStringColumn(row, "reason"),
    dueAt: optionalStringColumn(row, "due_at"),
    nudges: requiredNumberColumn(row, "nudges"),
    nudgeDeliveryId: optionalStringColumn(row, "nudge_delivery_id"),
    createdAt: requiredStringColumn(row, "created_at"),
  };
}

/**
 * Owns the rows of the fork tables `fork_stall_checks` and `fork_stall_nudges` (`database/fork-schema.ts`).
 * One check per lane: a new check of a lane replaces the old one. Rows are written directly, not
 * through `database.dispatch`. It never imports the service facade.
 */
export class StallCheckStore {
  readonly #database: Pick<OpenBotDatabase, "connection">;
  readonly #createId: () => string;

  constructor(options: StallCheckStoreOptions) {
    this.#database = options.database;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  all(): StallCheck[] {
    return databaseRows(
      this.#database.connection.prepare("SELECT * FROM fork_stall_checks ORDER BY created_at, check_id").all(),
    ).map(toCheck);
  }

  forLane(agentId: string, taskId: string | null): StallCheck | null {
    const row = databaseRow(
      this.#database.connection
        .prepare("SELECT * FROM fork_stall_checks WHERE agent_id = ? AND COALESCE(task_id, '') = ?")
        .get(agentId, taskId ?? ""),
    );
    return row ? toCheck(row) : null;
  }

  /** The check whose last nudge is one of these deliveries, or null. */
  forNudge(agentId: string, deliveryIds: readonly string[]): StallCheck | null {
    return (
      databaseRows(
        this.#database.connection
          .prepare("SELECT * FROM fork_stall_checks WHERE agent_id = ? AND nudge_delivery_id IS NOT NULL")
          .all(agentId),
      )
        .map(toCheck)
        .find((check) => check.nudgeDeliveryId !== null && deliveryIds.includes(check.nudgeDeliveryId)) ?? null
    );
  }

  /** The earliest due time of all checks, or null. */
  earliestDue(): string | null {
    return this.all().reduce<string | null>(
      (earliest, check) =>
        check.dueAt !== null && (earliest === null || check.dueAt < earliest) ? check.dueAt : earliest,
      null,
    );
  }

  /** Puts the check of the lane in place of the one that it had. Answers the new check. */
  replace(input: Omit<StallCheck, "id" | "createdAt" | "nudgeDeliveryId">, now: Date): StallCheck {
    const check: StallCheck = { ...input, id: this.#createId(), nudgeDeliveryId: null, createdAt: now.toISOString() };
    const db = this.#database.connection;
    db.exec("SAVEPOINT fork_stall_check_replace");
    try {
      db.prepare("DELETE FROM fork_stall_checks WHERE agent_id = ? AND COALESCE(task_id, '') = ?").run(
        check.agentId,
        check.taskId ?? "",
      );
      db.prepare(
        `INSERT INTO fork_stall_checks (check_id, agent_id, task_id, request_delivery_id, request_text, turn_id,
           reason, due_at, nudges, nudge_delivery_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        check.id,
        check.agentId,
        check.taskId,
        check.requestDeliveryId,
        check.requestText,
        check.turnId,
        check.reason,
        check.dueAt,
        check.nudges,
        check.createdAt,
      );
      db.exec("RELEASE fork_stall_check_replace");
    } catch (error) {
      db.exec("ROLLBACK TO fork_stall_check_replace");
      db.exec("RELEASE fork_stall_check_replace");
      throw error;
    }
    return check;
  }

  setDue(checkId: string, dueAt: string | null): void {
    this.#database.connection.prepare("UPDATE fork_stall_checks SET due_at = ? WHERE check_id = ?").run(dueAt, checkId);
  }

  /** Records a queued nudge: the count goes up, and the check waits for the end of the nudge turn. */
  markNudged(checkId: string, nudgeDeliveryId: string, nudges: number): void {
    this.#database.connection
      .prepare("UPDATE fork_stall_checks SET nudges = ?, nudge_delivery_id = ?, due_at = NULL WHERE check_id = ?")
      .run(nudges, nudgeDeliveryId, checkId);
  }

  delete(checkId: string): void {
    this.#database.connection.prepare("DELETE FROM fork_stall_checks WHERE check_id = ?").run(checkId);
  }

  logNudge(agentId: string, now: Date): void {
    this.#database.connection
      .prepare("INSERT INTO fork_stall_nudges (agent_id, sent_at) VALUES (?, ?)")
      .run(agentId, now.toISOString());
  }

  /** The nudges that the sweep sent this agent since `since`. */
  nudgesSince(agentId: string, since: Date): number {
    const row = databaseRow(
      this.#database.connection
        .prepare("SELECT COUNT(*) AS n FROM fork_stall_nudges WHERE agent_id = ? AND sent_at >= ?")
        .get(agentId, since.toISOString()),
    );
    return row ? requiredNumberColumn(row, "n") : 0;
  }
}
