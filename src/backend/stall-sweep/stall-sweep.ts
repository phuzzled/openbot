import type { AgentWait, QueueDelivery, QueueDeliveryStatus } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { cutStallRequest, stallNudgeText } from "../agent/delivery-content";
import { turnLeavesWaitOpen } from "../agent-waits/agent-waits";
import type { RoutineDueSource } from "../routine-timer";
import type { StallCheck, StallCheckStore } from "./stall-check-store";
import { detectStall, type StallInput } from "./stall-detection";

/** The item type of the line that tells the user that a lane stopped with work open. */
export const STALL_ALERT_ITEM_TYPE = "stall-alert";
/** The time after a stall before the first nudge. The user can answer first. */
export const STALL_GRACE_MS = 15 * 60_000;
/** The time after a nudge turn that stalled again before the next nudge. */
export const STALL_REPEAT_MS = 60 * 60_000;
/** The most nudges of one request. After them, the sweep tells the user once and stops. */
export const STALL_NUDGE_LIMIT = 2;
/** The most nudges of one agent in 24 hours, for all its requests. */
export const STALL_DAILY_LIMIT = 12;
/**
 * The most age of a check before its nudge. An older check (of an agent hidden for a day, or of a
 * host that was down) ends with no nudge, so a nudge never quotes a stale request.
 */
export const STALL_MAX_AGE_MS = 24 * 60 * 60_000;
/** A nudge that could not start (no provider, a failed enqueue) tries again after this time. */
const RETRY_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Whether the stall sweep runs. `OPENBOT_STALL_SWEEP=0` turns it off. */
export function stallSweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENBOT_STALL_SWEEP !== "0";
}

/** A turn that ended, as the owner of the turn end gives it, with the facts of its lane. */
export interface StallTurn extends Omit<StallInput, "excluded"> {
  agentId: string;
  /** The task of the lane. Null: the agent's own chat. */
  taskId: string | null;
  turnId: string;
  /** The turn ran outside a checked lane: a channel or messaging thread, a routine session or a quiet run. */
  excludedLane: boolean;
  deliveries: readonly Pick<QueueDelivery, "id" | "sender" | "recipientAgentId" | "text">[];
}

/** The facts of a check that tell whether a wait backs it. */
export type StallCheckWaitKey = Pick<
  StallCheck,
  "agentId" | "taskId" | "requestDeliveryId" | "nudgeDeliveryId" | "createdAt"
>;

/**
 * Whether an open wait backs a stall check: it runs in the check's lane (`laneOf`), and it serves the
 * check's request or nudge, or it opened at or after the check. An older wait of the lane for other
 * work, as one that a Stop left with no time, does not turn the sweep off for the lane.
 */
export function waitBacksStallCheck(
  waits: readonly AgentWait[],
  check: StallCheckWaitKey,
  laneOf: (wait: AgentWait) => string | null,
): boolean {
  const ids = [check.requestDeliveryId, ...(check.nudgeDeliveryId ? [check.nudgeDeliveryId] : [])];
  return waits.some(
    (wait) => laneOf(wait) === check.taskId && (turnLeavesWaitOpen([wait], ids) || wait.createdAt >= check.createdAt),
  );
}

export interface StallSweepHooks {
  /** Whether the agent can take new work now. A hidden, copied or deleted agent cannot: its check waits. */
  mayWake(agentId: string): boolean;
  /** Whether a provider can run a turn of the agent now. */
  providerReady(agentId: string): boolean;
  /** Whether the lane still exists: the own chat always, a task while its thread is open. */
  laneOpen(agentId: string, taskId: string | null): boolean;
  /** Whether a delivery of the lane is queued, starting or running. */
  laneBusy(agentId: string, taskId: string | null): boolean;
  /**
   * Whether an open wait in the check's lane backs it: the wait serves the check's request or its
   * nudge, or it opened at or after the check. An older, unrelated wait (one that a Stop left with no
   * time) does not.
   */
  waitBacksCheck(check: StallCheckWaitKey): boolean;
  /** Whether the user sent the agent a message after this time. */
  userMessagedSince(agentId: string, since: string): boolean;
  deliveryStatus(deliveryId: string): QueueDeliveryStatus | undefined;
  /** Queues the nudge in the lane, as a message of the agent to itself, and answers its delivery id. */
  enqueueNudge(
    agentId: string,
    taskId: string | null,
    text: string,
    idempotencyKey: string,
  ): Effect.Effect<string, { readonly cause: unknown }>;
  /** Starts the drain of the agent, after the check is marked with its nudge. */
  nudgeQueued(agentId: string): void;
  /** Tells the user, in the lane, that the work stopped and the nudges did not help. */
  alert(agentId: string, taskId: string | null): void;
  /** A check changed: the shared timer derives its next fire again. */
  changed(): void;
  emitError(code: string, error: unknown, agentId: string): void;
}

export interface StallSweepOptions {
  store: StallCheckStore;
  hooks: StallSweepHooks;
  enabled?: boolean;
  now?: () => Date;
}

const isTerminal = (status: QueueDeliveryStatus | undefined) =>
  status === undefined ||
  status === "completed" ||
  status === "failed" ||
  status === "interrupted" ||
  status === "cancelled";

/**
 * Owns the stall sweep: a turn of the agent's own chat or of a task that ends with an unbacked promise
 * ("I'll let you know when they reply") or with open plan steps, and with no plan continuation, no
 * open wait and no question to the user, gets a check (`StallCheckStore`). It is one more source of
 * the shared `RoutineTimer`, so a system sleep or a held restart holds it as it holds the routines.
 *
 * At its time, a check that is still valid queues one nudge in the lane: a message of the agent to
 * itself that gives the reason, the request, and the four ways to end the stall. A newer turn in the
 * lane, a busy lane, a wait that backs the check, or a message of the user since the check cancels
 * it. A teammate's message does not. A hidden agent keeps its check until it shows again, up to
 * `STALL_MAX_AGE_MS`. With no ready provider the check waits.
 *
 * A nudge turn is checked as any turn, and counts against the nudges of its request. After
 * `STALL_NUDGE_LIMIT` nudges, or at the daily limit of the agent, a lane that stalls again gets one
 * alert line for the user and no more nudges. A turn that the user stopped, that opened a wait, or
 * that ended the work ends the check. It never imports the agent service facade.
 */
export class StallSweep implements RoutineDueSource {
  readonly #store: StallCheckStore;
  readonly #hooks: StallSweepHooks;
  readonly #enabled: boolean;
  readonly #now: () => Date;

  constructor(options: StallSweepOptions) {
    this.#store = options.store;
    this.#hooks = options.hooks;
    this.#enabled = options.enabled ?? stallSweepEnabled();
    this.#now = options.now ?? (() => new Date());
  }

  /** Checks a turn that just ended, after its deliveries settled. */
  turnEnded(turn: StallTurn): void {
    if (!this.#enabled) return;
    const deliveryIds = turn.deliveries.map((delivery) => delivery.id);
    const lane = this.#store.forLane(turn.agentId, turn.taskId);
    // A turn of the same request: a nudge turn of the check, or a turn of its request's plan chain.
    const same =
      lane !== null &&
      ((lane.nudgeDeliveryId !== null && deliveryIds.includes(lane.nudgeDeliveryId)) ||
        deliveryIds.includes(lane.requestDeliveryId))
        ? lane
        : null;
    // Only the user's requests and the agent's own messages (a task brief, a wake, a nudge) count. A
    // teammate's message has its own reply protocol.
    const excluded =
      turn.excludedLane ||
      turn.deliveries.length === 0 ||
      turn.deliveries.some(
        (delivery) =>
          delivery.sender.kind !== "user" &&
          !(delivery.sender.kind === "agent" && delivery.sender.agentId === delivery.recipientAgentId),
      );
    // An excluded turn of another request (a teammate's message, a turn with no delivery) does not
    // resolve the promise: the lane keeps its check.
    if (excluded && !same) return;
    if (turn.continued) {
      // The request goes on in a plan continuation: its check waits for the end of the chain.
      if (same) this.#store.setDue(same.id, null);
      else if (lane) this.#store.delete(lane.id);
      this.#hooks.changed();
      return;
    }
    const stall = detectStall({ ...turn, excluded });
    if (!stall) {
      if (lane) {
        this.#store.delete(lane.id);
        this.#hooks.changed();
      }
      return;
    }
    const nudges = same ? same.nudges : 0;
    if (same && nudges >= STALL_NUDGE_LIMIT) {
      this.#store.delete(same.id);
      this.#hooks.alert(turn.agentId, turn.taskId);
      this.#hooks.changed();
      return;
    }
    const first = turn.deliveries.findLast((item) => item.sender.kind === "user") ?? turn.deliveries[0];
    const request = same
      ? { id: same.requestDeliveryId, text: same.requestText }
      : first && { id: first.id, text: cutStallRequest(first.text) };
    if (!request) return;
    const now = this.#now();
    this.#store.replace(
      {
        agentId: turn.agentId,
        taskId: turn.taskId,
        requestDeliveryId: request.id,
        requestText: request.text,
        turnId: turn.turnId,
        reason: stall.reason,
        dueAt: new Date(now.getTime() + (nudges === 0 ? STALL_GRACE_MS : STALL_REPEAT_MS)).toISOString(),
        nudges,
      },
      now,
    );
    this.#hooks.changed();
  }

  /**
   * A check that waits for a turn (`dueAt` null) whose delivery ended with no turn end that the
   * sweep saw: a Stop of a turn that no provider ran, or a restart that cut it off. It ends.
   */
  #stale(check: StallCheck): boolean {
    return (
      check.dueAt === null && isTerminal(this.#hooks.deliveryStatus(check.nudgeDeliveryId ?? check.requestDeliveryId))
    );
  }

  nextDueAt(): string | null {
    if (!this.#enabled) return null;
    const checks = this.#store.all();
    if (checks.some((check) => this.#stale(check))) return this.#now().toISOString();
    return checks.reduce<string | null>(
      (earliest, check) =>
        check.dueAt !== null && this.#hooks.mayWake(check.agentId) && (earliest === null || check.dueAt < earliest)
          ? check.dueAt
          : earliest,
      null,
    );
  }

  readonly processDue = Effect.fn("StallSweep.processDue")(function* (
    this: StallSweep,
    now: Date,
    active: () => boolean,
  ) {
    if (!this.#enabled) return;
    const nowText = now.toISOString();
    for (const check of this.#store.all()) {
      if (!active()) break;
      if (this.#stale(check)) {
        this.#store.delete(check.id);
        continue;
      }
      if (check.dueAt === null || check.dueAt > nowText) continue;
      // A check older than the age limit ends with no nudge, also while the agent is hidden.
      if (now.getTime() - Date.parse(check.createdAt) > STALL_MAX_AGE_MS) {
        this.#store.delete(check.id);
        continue;
      }
      if (!this.#hooks.mayWake(check.agentId)) continue;
      const { agentId, taskId } = check;
      if (
        !this.#hooks.laneOpen(agentId, taskId) ||
        this.#hooks.laneBusy(agentId, taskId) ||
        this.#hooks.waitBacksCheck(check) ||
        this.#hooks.userMessagedSince(agentId, check.createdAt)
      ) {
        this.#store.delete(check.id);
        continue;
      }
      // No retry is spent while no provider can run the nudge.
      if (!this.#hooks.providerReady(agentId)) {
        this.#store.setDue(check.id, new Date(now.getTime() + RETRY_MS).toISOString());
        continue;
      }
      if (this.#store.nudgesSince(agentId, new Date(now.getTime() - DAY_MS)) >= STALL_DAILY_LIMIT) {
        this.#store.delete(check.id);
        this.#hooks.alert(agentId, taskId);
        continue;
      }
      const nudge = check.nudges + 1;
      yield* this.#hooks
        .enqueueNudge(
          agentId,
          taskId,
          stallNudgeText({ reason: check.reason, requestText: check.requestText, nudge, limit: STALL_NUDGE_LIMIT }),
          `stall-nudge:${check.id}:${nudge}`,
        )
        .pipe(
          // The check is marked before the drain can start the nudge, so its turn end finds it.
          Effect.tap((deliveryId) =>
            Effect.sync(() => {
              this.#store.markNudged(check.id, deliveryId, nudge);
              this.#store.logNudge(agentId, now);
              this.#hooks.nudgeQueued(agentId);
            }),
          ),
          Effect.catch((failure) =>
            Effect.sync(() => {
              this.#hooks.emitError("stall_nudge_failed", failure.cause, agentId);
              this.#store.setDue(check.id, new Date(now.getTime() + RETRY_MS).toISOString());
            }),
          ),
        );
    }
  });
}
