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
    // The upstream sequence is unchanged: 53 is the last version of upstream v0.60.0.
    expect(maxVersion(db)).toEqual({ version: 53 });
  });

  it.each([34, 52])(
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
      expect(maxVersion(db)).toEqual({ version: 53 });
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

  describe("stall sweep tables", () => {
    const STALL_OBJECTS = [
      { type: "table", name: "fork_stall_checks" },
      { type: "index", name: "fork_stall_checks_due_at" },
      { type: "index", name: "fork_stall_checks_lane" },
      { type: "table", name: "fork_stall_nudges" },
      { type: "index", name: "fork_stall_nudges_agent" },
    ];
    const stallObjects = (db: DatabaseSync) =>
      db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'fork_stall_%' ORDER BY name").all();
    const insertDelivery = (db: DatabaseSync, deliveryId: string, agentId: string) => {
      db.prepare(
        `INSERT INTO projection_mailbox_messages (message_id, sender_kind, sender_agent_id, text, reply_to_message_id,
           created_at, message_json, last_event_sequence)
         VALUES (?, 'user', NULL, 'Get quotes.', NULL, '2026-01-01', '{}', 0)`,
      ).run(`message-${deliveryId}`);
      db.prepare(
        `INSERT INTO projection_deliveries (delivery_id, message_id, recipient_agent_id, status, turn_id, error,
           created_at, delivery_json, last_event_sequence)
         VALUES (?, ?, ?, 'completed', NULL, NULL, '2026-01-01', '{}', 0)`,
      ).run(deliveryId, `message-${deliveryId}`, agentId);
    };
    const insertCheck = (
      db: DatabaseSync,
      checkId: string,
      agentId: string,
      deliveryId: string,
      taskId: string | null = null,
    ) =>
      db
        .prepare(
          `INSERT INTO fork_stall_checks (check_id, agent_id, task_id, request_delivery_id, request_text, turn_id, reason,
             due_at, nudges, nudge_delivery_id, created_at)
           VALUES (?, ?, ?, ?, 'Get quotes.', 'turn-1', 'promise', '2026-06-01T00:00:00.000Z', 0, NULL, ?)`,
        )
        .run(checkId, agentId, taskId, deliveryId, new Date().toISOString());

    it("gives a new database the stall tables, and no fork migration version", async () => {
      const database = await openDatabase();
      expect(stallObjects(database.connection)).toEqual(STALL_OBJECTS);
      expect(maxVersion(database.connection)).toEqual({ version: 53 });
    });

    it.each([34, 52])("gives a database upgraded from released schema %i the stall tables", (version) => {
      const db = databaseAt(version);
      migrateOpenBotDatabase(db);
      applyForkSchema(db);
      expect(stallObjects(db)).toEqual(STALL_OBJECTS);
      expect(maxVersion(db)).toEqual({ version: 53 });
    });

    it("is idempotent, and keeps one check per lane", async () => {
      const database = await openDatabase();
      const root = database.userDataPath;
      insertDelivery(database.connection, "delivery-1", "chief");
      insertCheck(database.connection, "check-1", "chief", "delivery-1");
      insertCheck(database.connection, "check-2", "chief", "delivery-1", "task-1");
      expect(() => insertCheck(database.connection, "check-3", "chief", "delivery-1")).toThrow();
      applyForkSchema(database.connection);
      database.close();
      opened.splice(opened.indexOf(database), 1);
      const reopened = await openDatabase(root);
      expect(stallObjects(reopened.connection)).toEqual(STALL_OBJECTS);
      expect(reopened.connection.prepare("SELECT check_id FROM fork_stall_checks ORDER BY check_id").all()).toEqual([
        { check_id: "check-1" },
        { check_id: "check-2" },
      ]);
    });

    it("deletes at start a check whose request is gone, and old or orphan nudge log rows", () => {
      const db = new DatabaseSync(":memory:");
      databases.push(db);
      migrateOpenBotDatabase(db);
      applyForkSchema(db);
      insertDelivery(db, "delivery-1", "chief");
      insertCheck(db, "check-kept", "chief", "delivery-1");
      insertCheck(db, "check-gone", "helper", "delivery-gone");
      const recent = new Date().toISOString();
      db.prepare(
        `INSERT INTO fork_stall_nudges (agent_id, sent_at) VALUES ('chief', ?), ('chief', '2020-01-01T00:00:00.000Z'),
           ('ghost', ?)`,
      ).run(recent, recent);
      applyForkSchema(db);
      expect(db.prepare("SELECT check_id FROM fork_stall_checks").all()).toEqual([{ check_id: "check-kept" }]);
      expect(db.prepare("SELECT agent_id, sent_at FROM fork_stall_nudges").all()).toEqual([
        { agent_id: "chief", sent_at: recent },
      ]);
    });

    it("deletes the checks and the nudge log with their agent", async () => {
      const database = await openDatabase();
      const db = database.connection;
      insertDelivery(db, "delivery-1", "chief");
      insertDelivery(db, "delivery-2", "helper");
      insertCheck(db, "check-chief", "chief", "delivery-1");
      insertCheck(db, "check-helper", "helper", "delivery-2");
      db.prepare("INSERT INTO fork_stall_nudges (agent_id, sent_at) VALUES ('chief', ?), ('helper', ?)").run(
        new Date().toISOString(),
        new Date().toISOString(),
      );
      database.hardDeleteAgent("agents:delete", "chief", null, []);
      expect(db.prepare("SELECT check_id FROM fork_stall_checks").all()).toEqual([{ check_id: "check-helper" }]);
      expect(db.prepare("SELECT agent_id FROM fork_stall_nudges").all()).toEqual([{ agent_id: "helper" }]);
    });
  });
});
