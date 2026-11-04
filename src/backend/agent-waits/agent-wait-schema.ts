// Migration 34 creates the table with this text. Do not change it: it may have shipped. The latest
// table, for new databases, is `AGENT_WAIT_SCHEMA_SQL` below. IF NOT EXISTS throughout.
//
// An open wait is work an agent stopped before it was done, because it waits for something outside
// the turn: a build, a deploy, the next routine run. The agent opens it with `openbot.await_event`,
// lists it with `openbot.list_waits` and closes it with `openbot.close_wait`; another local agent
// can list and close it with `agentId`; the user can cancel it. A closed or cancelled wait is
// deleted, so every row is an open wait.
//
// Agent ids carry no foreign key, as in every other table keyed by an agent: `hardDeleteAgent`
// removes the rows of a deleted agent by hand.
//
// `request_delivery_id` and `request_text` are the message the wait serves, copied when the wait
// opens, so a wake can repeat the request after the transcript is compacted or cleared.
// `routine_id` limits the runs that wake the wait to one routine; absent, any routine run of the
// agent wakes it. A deleted routine leaves the wait to any run. `woken_at` and `wake_delivery_id`
// are the last run that woke the wait: the agent sees the wait in that delivery's input.
export const V34_AGENT_WAIT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_waits (
    wait_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    request_delivery_id TEXT NOT NULL,
    request_text TEXT NOT NULL,
    note TEXT NOT NULL,
    routine_id TEXT REFERENCES projection_agent_routines(routine_id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    woken_at TEXT,
    wake_delivery_id TEXT
  );
  CREATE INDEX IF NOT EXISTS agent_waits_agent ON agent_waits(agent_id);
  CREATE INDEX IF NOT EXISTS agent_waits_routine ON agent_waits(routine_id) WHERE routine_id IS NOT NULL;
`;

// Migration 56. The time at which the wait wakes by itself, added with no default: no rebuild, no data
// change, and every existing wait gets null, which is a wait that only a routine run or a script event
// wakes, as before. A wait with a time needs no routine. The wake clears it, so it fires once.
export const V56_AGENT_WAIT_WAKE_AT_COLUMN_SQL = "wake_at TEXT";
// Migration 56 also adds the number of times the wake time woke the wait, 0 for every existing wait. A
// wait that has a time, or that a time woke, is a timed wait: a routine run that names no wait does not
// wake it after its time is spent, and the count limits how often the agent can set a new time.
export const V56_AGENT_WAIT_TIME_WAKES_COLUMN_SQL = "time_wakes INTEGER NOT NULL DEFAULT 0";

// The latest table, for new databases.
export const AGENT_WAIT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_waits (
    wait_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    request_delivery_id TEXT NOT NULL,
    request_text TEXT NOT NULL,
    note TEXT NOT NULL,
    routine_id TEXT REFERENCES projection_agent_routines(routine_id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    woken_at TEXT,
    wake_delivery_id TEXT,
    wake_at TEXT,
    time_wakes INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS agent_waits_agent ON agent_waits(agent_id);
  CREATE INDEX IF NOT EXISTS agent_waits_routine ON agent_waits(routine_id) WHERE routine_id IS NOT NULL;
`;
