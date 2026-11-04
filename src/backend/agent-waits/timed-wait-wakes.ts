import type { AgentWait } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { MailboxStore } from "../mailbox-store";
import type { RoutineDueSource } from "../routine-timer";
import type { AgentWaitStore } from "./agent-wait-store";

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

export interface TimedWaitWakesOptions {
  store: AgentWaitStore;
  mailbox: Pick<MailboxStore, "getDelivery">;
  hooks: TimedWaitWakesHooks;
}

/**
 * Owns the wake of a wait at the time the agent gave with `openbot.await_event`, with no routine. It
 * is one more source of the shared `RoutineTimer`, so a system sleep or a held restart holds it as
 * it holds the routines, and the next fire is one time across every owner.
 *
 * A due wait wakes once: the wake clears its time. A time that passed while the app was closed or
 * the computer slept is due at the next pass, so the wait wakes once then, not once for each time it
 * missed. All the due waits of one agent and lane wake in one delivery, whose input repeats each
 * request and note (`wokenWaitsPromptText`). The lane is the agent's own chat, or the open task whose
 * thread opened the wait.
 *
 * It never imports the agent service facade.
 */
export class TimedWaitWakes implements RoutineDueSource {
  readonly #store: AgentWaitStore;
  readonly #mailbox: Pick<MailboxStore, "getDelivery">;
  readonly #hooks: TimedWaitWakesHooks;

  constructor(options: TimedWaitWakesOptions) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#hooks = options.hooks;
  }

  nextDueAt(): string | null {
    return this.#store.timed().find((wait) => this.#hooks.mayWake(wait.agentId))?.wakeAt ?? null;
  }

  readonly processDue = Effect.fn("TimedWaitWakes.processDue")(function* (
    this: TimedWaitWakes,
    now: Date,
    active: () => boolean,
  ) {
    const nowText = now.toISOString();
    const dueByLane = new Map<string, { agentId: string; taskId: string | null; due: AgentWait[] }>();
    for (const wait of this.#store.timed()) {
      if (!wait.wakeAt || wait.wakeAt > nowText || !this.#hooks.mayWake(wait.agentId)) continue;
      const taskId = this.#hooks.taskFor(wait);
      const key = `${wait.agentId}\u0000${taskId ?? ""}`;
      const lane = dueByLane.get(key) ?? { agentId: wait.agentId, taskId, due: [] };
      lane.due.push(wait);
      dueByLane.set(key, lane);
    }
    for (const { agentId, taskId, due } of dueByLane.values()) {
      if (!active()) break;
      // A run that woke the wait and has not ended continues it already. The time is spent.
      const pending = due.filter((wait) => wait.wakeDeliveryId !== null && this.#isPending(wait.wakeDeliveryId));
      const waking = due.filter((wait) => !pending.includes(wait));
      if (pending.length > 0)
        this.#store.setWakeAt(
          agentId,
          pending.map((wait) => wait.id),
          null,
        );
      const first = waking[0];
      if (!first) {
        this.#hooks.changed(agentId);
        continue;
      }
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
