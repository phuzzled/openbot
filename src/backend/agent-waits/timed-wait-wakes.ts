import type { AgentWait } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { MailboxStore } from "../mailbox-store";
import type { RoutineDueSource } from "../routine-timer";
import type { AgentWaitStore } from "./agent-wait-store";
import { TIME_WAKES_MAX } from "./agent-waits";

export interface TimedWaitWakesHooks {
  /**
   * Whether the agent can take a wake now. A hidden agent, or one that is copied or deleted, cannot:
   * its waits stay due and wake once when it can again.
   */
  mayWake(agentId: string): boolean;
  /**
   * The task in which the wake of this wait runs: the open task whose thread opened it. Null: the
   * agent's own chat.
   */
  taskFor(wait: AgentWait): string | null;
  /**
   * Queues the wake in the agent's own chat, or in the task `taskId`, and returns its delivery id. It
   * does not start the drain: the waits are marked first (`wakeQueued`). The same key gives the same
   * delivery, so a pass that stopped before it marked the waits does not queue a second wake.
   */
  enqueueWake(
    agentId: string,
    taskId: string | null,
    text: string,
    idempotencyKey: string,
  ): Effect.Effect<string, { readonly cause: unknown }>;
  /** Starts the drain of the agent, after the waits are marked with their wake. */
  wakeQueued(agentId: string): void;
  /** The open waits of this agent changed. */
  changed(agentId: string): void;
  emitError(code: string, error: unknown, agentId: string): void;
}

/** A wake that could not be queued tries again after this time, not at once: the timer would spin. */
const RETRY_MS = 5 * 60_000;
/** The longest delay before a wake that did not complete wakes again. */
const REWAKE_MAX_MS = 80 * 60_000;

export interface TimedWaitWakesOptions {
  store: AgentWaitStore;
  mailbox: Pick<MailboxStore, "getDelivery">;
  hooks: TimedWaitWakesHooks;
  now?: () => Date;
}

/**
 * Owns the wake of a wait at the time the agent gave with `openbot.await_event`, with no routine. It
 * is one more source of the shared `RoutineTimer`, so a system sleep or a held restart holds it as
 * it holds the routines, and the next fire is one time across every owner.
 *
 * A due wait wakes once: the wake clears its time. A wait that its wake turn gave a new time keeps
 * that time while the turn runs, also when the time comes before the turn ends: it wakes once after
 * that turn. A time that passed while the app was closed or
 * the computer slept is due at the next pass, so the wait wakes once then, not once for each time it
 * missed. All the due waits of one agent and lane wake in one delivery, whose input repeats each
 * request and note (`wokenWaitsPromptText`). The lane is the agent's own chat, or the open task whose
 * thread opened the wait.
 *
 * A wake whose delivery ended failed, interrupted or cancelled (a restart, a provider error, a Stop)
 * did not continue the request, and the wait has no time left. The next pass gives it a time again,
 * 5 minutes ahead and doubled for each time wake up to 80 minutes, so the follow-up is not lost. Each
 * wake counts against `TIME_WAKES_MAX`, and a wait at the limit gets no new time. A wake that completed
 * is final: the agent closed the wait, set a new time, or chose to leave it open. The owner of the turn
 * end arms the shared timer when a wake ends (`wakeEnded`), so the pass runs at once.
 *
 * It never imports the agent service facade.
 */
export class TimedWaitWakes implements RoutineDueSource {
  readonly #store: AgentWaitStore;
  readonly #mailbox: Pick<MailboxStore, "getDelivery">;
  readonly #hooks: TimedWaitWakesHooks;
  readonly #now: () => Date;

  constructor(options: TimedWaitWakesOptions) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#hooks = options.hooks;
    this.#now = options.now ?? (() => new Date());
  }

  nextDueAt(): string | null {
    // A wake that did not complete gets its new time at the next pass, which is now.
    const now = this.#now().toISOString();
    if (this.#unfinishedWakes().length > 0) return now;
    // A due wait whose wake still runs waits for the end of that wake (`waitWakeEnded` arms the timer):
    // its time would fire the timer again at once.
    return (
      this.#store
        .timed()
        .find(
          (wait) =>
            this.#hooks.mayWake(wait.agentId) && !(wait.wakeAt != null && wait.wakeAt <= now && this.#wakeRuns(wait)),
        )?.wakeAt ?? null
    );
  }

  /** Whether the last wake of this wait has not ended yet. */
  #wakeRuns(wait: AgentWait): boolean {
    return wait.wakeDeliveryId !== null && this.#isPending(wait.wakeDeliveryId);
  }

  /** The spent waits whose last wake did not complete, of agents that can take a wake, under the limit. */
  #unfinishedWakes(): AgentWait[] {
    return this.#store.spentTimeWakes().filter((wait) => {
      if ((wait.timeWakes ?? 0) >= TIME_WAKES_MAX || !this.#hooks.mayWake(wait.agentId)) return false;
      const status = wait.wakeDeliveryId ? this.#mailbox.getDelivery(wait.wakeDeliveryId)?.delivery.status : undefined;
      return status === "failed" || status === "interrupted" || status === "cancelled";
    });
  }

  readonly processDue = Effect.fn("TimedWaitWakes.processDue")(function* (
    this: TimedWaitWakes,
    now: Date,
    active: () => boolean,
  ) {
    const nowText = now.toISOString();
    for (const wait of this.#unfinishedWakes()) {
      const delay = Math.min(RETRY_MS * 2 ** Math.max(0, (wait.timeWakes ?? 1) - 1), REWAKE_MAX_MS);
      this.#store.setWakeAt(wait.agentId, [wait.id], new Date(now.getTime() + delay).toISOString());
      this.#hooks.changed(wait.agentId);
    }
    const dueByLane = new Map<string, { agentId: string; taskId: string | null; due: AgentWait[] }>();
    for (const wait of this.#store.timed()) {
      if (!wait.wakeAt || wait.wakeAt > nowText || !this.#hooks.mayWake(wait.agentId)) continue;
      // The wake turn that set this time still runs. The wait keeps its time and wakes after that turn
      // ends: the time is not spent.
      if (this.#wakeRuns(wait)) continue;
      const taskId = this.#hooks.taskFor(wait);
      const key = `${wait.agentId}\u0000${taskId ?? ""}`;
      const lane = dueByLane.get(key) ?? { agentId: wait.agentId, taskId, due: [] };
      lane.due.push(wait);
      dueByLane.set(key, lane);
    }
    for (const { agentId, taskId, due: waking } of dueByLane.values()) {
      if (!active()) break;
      const first = waking[0];
      if (!first) continue;
      const wakingIds = waking.map((wait) => wait.id);
      yield* this.#hooks
        .enqueueWake(
          agentId,
          taskId,
          waking.map((wait) => wait.note).join("\n\n"),
          // The count of time wakes, not the time: a retry moves the time, and must find the same wake.
          `wait-wake:${first.id}:${first.timeWakes ?? 0}`,
        )
        .pipe(
          // The waits are marked before the drain can start the wake, so its input names them.
          Effect.tap((deliveryId) =>
            Effect.sync(() => {
              this.#store.markWokenByTime(agentId, wakingIds, deliveryId);
              this.#hooks.wakeQueued(agentId);
            }),
          ),
          Effect.catch((failure) =>
            Effect.sync(() => {
              this.#hooks.emitError("timed_wait_wake_failed", failure.cause, agentId);
              this.#store.setWakeAt(agentId, wakingIds, new Date(now.getTime() + RETRY_MS).toISOString());
            }),
          ),
        );
      this.#hooks.changed(agentId);
    }
  });

  #isPending(deliveryId: string): boolean {
    const status = this.#mailbox.getDelivery(deliveryId)?.delivery.status;
    return status === "queued" || status === "starting" || status === "running";
  }
}
