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
   * Queues the wake in the agent's own chat and returns its delivery id. The same key gives the same
   * delivery, so a pass that stopped before it marked the waits does not queue a second wake.
   */
  enqueueWake(
    agentId: string,
    text: string,
    idempotencyKey: string,
  ): Effect.Effect<string, { readonly cause: unknown }>;
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
 * missed. All the due waits of one agent wake in one delivery to its own chat, whose input repeats
 * each request and note (`wokenWaitsPromptText`).
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
    const dueByAgent = new Map<string, AgentWait[]>();
    for (const wait of this.#store.timed()) {
      if (!wait.wakeAt || wait.wakeAt > nowText || !this.#hooks.mayWake(wait.agentId)) continue;
      dueByAgent.set(wait.agentId, [...(dueByAgent.get(wait.agentId) ?? []), wait]);
    }
    for (const [agentId, due] of dueByAgent) {
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
        .enqueueWake(agentId, waking.map((wait) => wait.note).join("\n\n"), `wait-wake:${first.id}:${first.wakeAt}`)
        .pipe(
          Effect.map((deliveryId) => this.#store.markWokenByTime(agentId, wakingIds, deliveryId)),
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
