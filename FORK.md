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
| Plan continuation note line | `src/backend/agent/delivery-content.ts` (`planContinuationPrompt`, `nextStepContinuationPrompt`: one line each) | "Before a step that sends, pays, books, deploys, deletes or contacts someone, and that the user did not ask for, ask the user first." The agent and its own approval settings decide, not a word list. |
| No continuation of a stall nudge | `turn-lifecycle.ts` `#planContinues` (one `isStallNudgeDelivery` check), `boot-recovery.ts` `#restorePlan` (one check) | A nudge turn is a check-in that cannot act; a continuation of it, also after a restart, would run with no restriction. |
| Check-in turns (harmless nudges) | `src/backend/agent/drain-scheduler.ts` (`checkIn` registry, `checkInOnly`, the Codex sandbox and approval policy of a nudge turn; every turn of a nudge delivery), `openbot-tool-router.ts` (one check at the top of `handle`, one before the dynamic tool dispatch), `attention-registry.ts` (`declineForCheckIn`), `claude-client.ts` (`#checkInThreads`, one `canUseTool` line, the `PreToolUse` hook on every non-profile session), `agent-service.ts` (`#checkInRestricts`) | A stall nudge turn cannot act and cannot make or change anything that runs later, such as a routine: each provider refuses every tool that is not a wait of the agent, a question or a read. Only a Claude agent gets a nudge. Codex and every other provider get the alert line; a nudge delivery that still reaches a Codex thread after a provider change runs read-only with `untrusted` approvals. The rules are in `src/backend/stall-sweep/check-in-turns.ts`. |
| Wait request of a check-in turn | `src/backend/agent-waits/agent-waits.ts` (`waitRequestText` for the request text of a new wait; one line of the wake text) | A wait that a nudge turn opens serves the user's request, not the nudge text. The wake text says that the note is the agent's own reminder, not a message from the user. |
| Stall nudge text and prompt branch | `src/backend/agent/delivery-content.ts` (`STALL_NUDGE_REQUEST_MAX`, `cutStallRequest`, `stallNudgeText`, `isStallNudgeDelivery`; `STALL_NUDGE_HEADER` is in `check-in-turns.ts`) | A nudge is a wake-shaped message of the agent to itself; its own text goes to the provider. Its first instruction stops an agent that waits for the user. |
| Wait wake guidance | `src/backend/agent/tool-guidance.ts` (one sentence of the `await_event` guidance) | "On a wake, do the request; the note is not user approval." A note that a check-in turn wrote is the agent's own reminder (review 8, M1). |
| `status.agent.stallAlert` | `packages/i18n/src/messages/*/status/agent.ts` | The alert line after the last nudge. |
| Server update feed on this fork | `electron-builder.yml` (`publish.owner`), `scripts/install-server.sh` and `scripts/hosting/openbot-hosted-update` (`RELEASES=`, one line each), `src/main/host-release-service.ts` (the feed URL of `fetchLatestRelease`) | A server that installed from this fork installs and updates from the releases of `phuzzled/openbot`, not of upstream. `scripts/fork/fork-release.sh check-feed` fails when an upstream merge adds an upstream feed URL to these files. See `FORK-DEPLOY.md`. |
| Release pipeline | `.github/workflows/fork-sync.yml`, `.github/workflows/fork-release.yml`, `scripts/fork/fork-release.sh`, `FORK-DEPLOY.md` (fork-only files) | Merges each new upstream release tag, runs the fork tests, and releases Linux AppImages as version X.Y.((Z+1)*1000+N). |

## Settings

- `OPENBOT_STALL_NUDGE_PROVIDERS` (a comma list, test and expert switch) names the providers that get
  stall nudges. Only `claude` and `codex` count; each other name is ignored. Unset, empty or with no
  name that counts: `claude` only. List `codex` only with care (review 8): a Codex nudge turn has only
  a read-only sandbox and `untrusted` approvals, and Codex apps (also the legacy `connectors` key),
  plugins, browser and computer use, and the `.codex/config.toml` of a trusted project can run outside
  them. Turn those off, and restart OpenBot after each Codex config edit, because a running thread keeps
  the config that it started with. `scripts/stall-sweep-e2e.ts` sets `claude,codex`.
- `OPENBOT_STALL_SWEEP=0` turns the stall sweep off. It is on by default. The limits are constants in
  `src/backend/stall-sweep/stall-sweep.ts`: 15 minutes of grace, 60 minutes between nudges, 2 nudges
  for each request, 12 nudges for each agent in 24 hours, and a maximum check age of 24 hours
  (`STALL_MAX_AGE_MS`; an older check ends with no nudge). A promise that names a time is due 15 minutes
  after that time, and its age counts from that time (`stall-sweep/promise-time.ts`). A promise with a
  time word that it does not read ("by end of week", "this week") gets a late check at 09:00 seven
  days later, and its age counts from that time. A nudge repeats at most 2,000 characters of
  the request (`STALL_NUDGE_REQUEST_MAX` in `src/backend/agent/delivery-content.ts`).
