// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade changes or loses a row of any table, or an open wait; a failed upgrade
// leaves the column or its marker; a newer or incomplete history is accepted; a development profile
// that has the column already fails the upgrade. These fixtures cover each.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  migrateUpTo(db, version);
  return db;
}

function migrateUpTo(db: DatabaseSync, version: number): void {
  db.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
}

/** A routine and two open waits, one woken by a run: the rows that migration 56 must keep. */
function seed(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_agent_routines
    (routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at, last_event_sequence)
    VALUES ('routine-1', 'chief', 'Nightly build', 'Check the build.', 1, 'UTC', '2026-01-01', '2026-01-01', 1)`).run();
  const insert = db.prepare(`INSERT INTO agent_waits
    (wait_id, agent_id, request_delivery_id, request_text, note, routine_id, created_at, woken_at, wake_delivery_id)
    VALUES (?, 'chief', 'delivery-1', 'Ship it 界"\\', ?, ?, '2026-01-02', ?, ?)`);
  insert.run("wait-1", "Build", "routine-1", null, null);
  insert.run("wait-2", "Deploy", null, "2026-01-03", "delivery-2");
}

/**
 * Every row of every table, by table name. Migration 47 replaces the empty task table with the thread
 * table; `agent-thread-migration.test.ts` checks that move.
 */
function contents(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name <> 'schema_migrations' AND name NOT LIKE 'agent_memory_search%'
       AND name NOT IN ('projection_agent_tasks', 'projection_agent_threads') ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
}

/** The rows before, with no wake time and no time wake on every wait. */
function withEmptyWakeAt(before: Record<string, unknown[]>): Record<string, unknown[]> {
  return {
    ...before,
    agent_waits: (before.agent_waits ?? []).map((row) =>
      isDynamicRecord(row) ? { ...row, wake_at: null, time_wakes: 0 } : row,
    ),
  };
}

function hasColumn(db: DatabaseSync, name: string): boolean {
  return db
    .prepare("PRAGMA table_info(agent_waits)")
    .all()
    .some((column) => column.name === name);
}

function hasWakeAt(db: DatabaseSync): boolean {
  return hasColumn(db, "wake_at") || hasColumn(db, "time_wakes");
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 56 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

describe("agent wait wake time migration", () => {
  it.each(Array.from({ length: 48 }, (_, index) => index + 8))(
    "preserves every row from released schema %i",
    (version) => {
      const db = databaseAt(version);
      // The wait table comes with migration 34: seed after it.
      if (version < 34) migrateUpTo(db, 34);
      seed(db);
      // The earlier migrations run first; the rows after them are what v56 must keep.
      if (version < 55) migrateUpTo(db, 55);
      const before = contents(db);
      expect(before.agent_waits).toHaveLength(2);
      migrateOpenBotDatabase(db);
      expect(contents(db)).toEqual(withEmptyWakeAt(before));
      expectHealthy(db);
    },
  );

  it("rolls back the column and the marker after a late failure, then retries", () => {
    const db = databaseAt(55);
    seed(db);
    const before = contents(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=56
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 56 failed");
    expect(contents(db)).toEqual(before);
    expect(hasWakeAt(db)).toBe(false);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=56").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual(withEmptyWakeAt(before));
    expectHealthy(db);
  });

  it("rejects newer and incomplete migration histories before it adds the column", () => {
    const db = databaseAt(55);
    seed(db);
    const before = contents(db);
    db.exec("INSERT INTO schema_migrations VALUES(57,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version=57; DELETE FROM schema_migrations WHERE version=20");
    expect(() => migrateOpenBotDatabase(db)).toThrow("missing version 20");
    expect(contents(db)).toEqual(before);
    expect(hasWakeAt(db)).toBe(false);
  });

  it("keeps a column that a development profile added before the version shipped", () => {
    const db = databaseAt(55);
    seed(db);
    db.exec("ALTER TABLE agent_waits ADD COLUMN wake_at TEXT");
    db.prepare("UPDATE agent_waits SET wake_at = '2026-02-01T00:00:00.000Z' WHERE wait_id = 'wait-1'").run();
    migrateOpenBotDatabase(db);
    expect(db.prepare("SELECT wait_id, wake_at, time_wakes FROM agent_waits ORDER BY wait_id").all()).toEqual([
      { wait_id: "wait-1", wake_at: "2026-02-01T00:00:00.000Z", time_wakes: 0 },
      { wait_id: "wait-2", wake_at: null, time_wakes: 0 },
    ]);
    expectHealthy(db);
  });

  it("keeps both columns that a development profile added before the version shipped", () => {
    const db = databaseAt(55);
    seed(db);
    db.exec("ALTER TABLE agent_waits ADD COLUMN wake_at TEXT");
    db.exec("ALTER TABLE agent_waits ADD COLUMN time_wakes INTEGER NOT NULL DEFAULT 0");
    db.prepare("UPDATE agent_waits SET time_wakes = 3 WHERE wait_id = 'wait-2'").run();
    migrateOpenBotDatabase(db);
    expect(db.prepare("SELECT wait_id, time_wakes FROM agent_waits ORDER BY wait_id").all()).toEqual([
      { wait_id: "wait-1", time_wakes: 0 },
      { wait_id: "wait-2", time_wakes: 3 },
    ]);
    expectHealthy(db);
  });
});
