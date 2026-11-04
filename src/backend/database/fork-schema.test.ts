// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWaitStore } from "../agent-waits/agent-wait-store";
import { runCauseEffect } from "../effect-boundary";
import { OpenBotDatabase } from "../openbot-database";
import { migrateOpenBotDatabase } from "../openbot-database-schema";
import { applyForkSchema } from "./fork-schema";

const databases: DatabaseSync[] = [];
const opened: OpenBotDatabase[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const database of opened.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A database at a released upstream schema version, as the upstream migration tests build it. */
function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
  return db;
}

async function openDatabase(root?: string): Promise<OpenBotDatabase> {
  const path = root ?? (await mkdtemp(join(tmpdir(), "openbot-fork-schema-")));
  if (!root) roots.push(path);
  const database = new OpenBotDatabase(path);
  await runCauseEffect(database.initialize());
  opened.push(database);
  return database;
}

function timerTable(db: DatabaseSync) {
  return db
    .prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'fork_agent_wait_timers%' ORDER BY name")
    .all();
}

function maxVersion(db: DatabaseSync) {
  return db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
}

const TIMER_OBJECTS = [
  { type: "table", name: "fork_agent_wait_timers" },
  { type: "index", name: "fork_agent_wait_timers_agent" },
  { type: "index", name: "fork_agent_wait_timers_wake_at" },
];

describe("fork schema", () => {
  it("gives a new database the timer table at start, and no fork migration version", async () => {
    const database = await openDatabase();
    const db = database.connection;
    expect(timerTable(db)).toEqual(TIMER_OBJECTS);
    // The upstream sequence is unchanged: 55 is the last upstream version.
    expect(maxVersion(db)).toEqual({ version: 55 });
  });

  it.each([34, 54])(
    "gives a database upgraded from released schema %i the timer table, and keeps its waits",
    (version) => {
      const db = databaseAt(version);
      db.prepare(
        `INSERT INTO agent_waits (wait_id, agent_id, request_delivery_id, request_text, note, created_at)
       VALUES ('wait-1', 'chief', 'delivery-1', 'Deploy.', 'Check the deploy.', '2026-01-01')`,
      ).run();
      const before = db.prepare("SELECT * FROM agent_waits").all();
      migrateOpenBotDatabase(db);
      applyForkSchema(db);
      expect(timerTable(db)).toEqual(TIMER_OBJECTS);
      expect(db.prepare("SELECT * FROM agent_waits").all()).toEqual(before);
      expect(maxVersion(db)).toEqual({ version: 55 });
      // A wait from before the fork has no timer row: no wake time and no time wake.
      const store = new AgentWaitStore({ database: { connection: db } });
      expect(store.get("chief", "wait-1")).toMatchObject({ wakeAt: null, timeWakes: 0 });
    },
  );

  it("is idempotent: a second start keeps the table and its rows", async () => {
    const database = await openDatabase();
    const root = database.userDataPath;
    const store = new AgentWaitStore({ database });
    const wait = store.open({
      agentId: "chief",
      requestMessageId: "delivery-1",
      requestText: "Deploy.",
      note: "Check the deploy.",
      routineId: null,
      wakeAt: "2026-06-01T00:00:00.000Z",
    });
    applyForkSchema(database.connection);
    database.close();
    opened.splice(opened.indexOf(database), 1);
    const reopened = await openDatabase(root);
    expect(timerTable(reopened.connection)).toEqual(TIMER_OBJECTS);
    expect(new AgentWaitStore({ database: reopened }).get("chief", wait.id)).toMatchObject({
      wakeAt: "2026-06-01T00:00:00.000Z",
      timeWakes: 0,
    });
  });

  it("deletes at start a timer row whose wait is gone, and keeps the others", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateOpenBotDatabase(db);
    applyForkSchema(db);
    db.prepare(
      `INSERT INTO agent_waits (wait_id, agent_id, request_delivery_id, request_text, note, created_at)
       VALUES ('wait-1', 'chief', 'delivery-1', 'Deploy.', 'Check the deploy.', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO fork_agent_wait_timers (wait_id, agent_id, wake_at, time_wakes) VALUES
         ('wait-1', 'chief', '2026-06-01T00:00:00.000Z', 1),
         ('wait-gone', 'chief', '2026-06-01T00:00:00.000Z', 2)`,
    ).run();
    applyForkSchema(db);
    expect(db.prepare("SELECT wait_id FROM fork_agent_wait_timers ORDER BY wait_id").all()).toEqual([
      { wait_id: "wait-1" },
    ]);
  });

  it("deletes the timer with its wait, and with its agent", async () => {
    const database = await openDatabase();
    const store = new AgentWaitStore({ database });
    const open = (agentId: string) =>
      store.open({
        agentId,
        requestMessageId: "delivery-1",
        requestText: "Deploy.",
        note: "Check the deploy.",
        routineId: null,
        wakeAt: "2026-06-01T00:00:00.000Z",
      });
    const closed = open("chief");
    const kept = open("chief");
    const other = open("helper");
    const timers = () =>
      database.connection.prepare("SELECT wait_id FROM fork_agent_wait_timers ORDER BY wait_id").all();
    expect(store.delete("chief", closed.id)).toBe(true);
    expect(timers()).toEqual(
      [{ wait_id: kept.id }, { wait_id: other.id }].sort((a, b) => a.wait_id.localeCompare(b.wait_id)),
    );
    database.hardDeleteAgent("agents:delete", "chief", null, []);
    expect(store.list("chief")).toEqual([]);
    expect(timers()).toEqual([{ wait_id: other.id }]);
  });
});
