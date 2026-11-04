import { waitsForUser } from "../agent/plan-continuation";

/**
 * The detection half of the stall sweep: whether a turn that just ended left work open with nothing
 * that brings the agent back. It has no state and imports no service. `StallSweep` owns the checks.
 */

/** Why a lane stalls: the answer promised a follow-up, or the plan of the turn has open steps. */
export type StallKind = "promise" | "openSteps";

/** The last part of an answer that is searched for a promise. A promise is near the end of an answer. */
const FINAL_PART_MAX = 400;

const WILL = String.raw`(?:i['’]ll|i\s+will|i['’]m\s+going\s+to|i\s+am\s+going\s+to|i\s+shall|we['’]ll|we\s+will)`;
/** At most three words between "I'll" and the verb, as in "I'll then quickly follow up". Not a negation. */
const FILLER = String.raw`(?:(?!not\b|never\b|no\s+longer\b)[a-z]+\s+){0,3}`;
/** Verbs that promise a later return to the user or to the work. */
const FOLLOW_UP_VERB = String.raw`(?:follow\s+up|check\s+back|check\s+in|circle\s+back|get\s+back\s+to\s+you|come\s+back\s+to\s+you|report\s+back|keep\s+(?:an|my|a\s+close)\s+eye|keep\s+watching|keep\s+monitoring|keep\s+tracking|monitor|watch\s+for|keep\s+you\s+(?:posted|updated|informed)|update\s+you|let\s+you\s+know(?!\s+if\b)|ping\s+you|notify\s+you|be\s+in\s+touch|chase)`;
/** Words that say that an outside party, or a running job, will answer or end later. */
const LATER_EVENT = String.raw`(?:repl(?:y|ies|ied)|respond(?:s|ed)?|answers?|answered|gets?\s+back|comes?\s+back|comes?\s+in|arrives?|lands?|finish(?:es)?|completes?|is\s+(?:ready|done|back)|are\s+(?:ready|done|back)|hear\s+back)`;

const PROMISES = [
  // "I'll let you know", "I will follow up tomorrow", "We'll keep you posted".
  new RegExp(String.raw`\b${WILL}\s+${FILLER}${FOLLOW_UP_VERB}\b`, "i"),
  // "Will update you", "will report back" at the start of a sentence, with no subject.
  new RegExp(String.raw`^(?:and\s+)?will\s+${FOLLOW_UP_VERB}\b`, "i"),
  // "Once they reply, I'll compare the quotes."
  new RegExp(
    String.raw`\b(?:once|when|as\s+soon\s+as|after)\b[^.!?\n]{0,60}\b${LATER_EVENT}\b[^.!?\n]{0,80}\b${WILL}\b`,
    "i",
  ),
  // "I'll compare the quotes once they reply."
  new RegExp(
    String.raw`\b${WILL}\b[^.!?\n]{0,80}\b(?:once|when|as\s+soon\s+as|after)\b[^.!?\n]{0,60}\b${LATER_EVENT}\b`,
    "i",
  ),
];

/** A sentence that offers the user a choice is a question to the user, not a promise. */
const OFFER = /\bif\s+you(?:['’]d)?\s+(?:want|like|prefer|need|wish)\b|\bwould\s+you\s+like\b|\bdo\s+you\s+want\b/i;

/** The sentences of the final part of an answer, without Markdown emphasis, code, quote or heading marks. */
function finalSentences(answer: string): string[] {
  const text = answer.trim().replace(/[*_`>#]/g, "");
  const paragraphs = text.split(/\n\s*\n/);
  const last = paragraphs.at(-1) ?? "";
  // A short last paragraph, such as a sign-off, joins the paragraph before it.
  const finalPart = (last.length < 120 && paragraphs.length > 1 ? `${paragraphs.at(-2)}\n${last}` : last).slice(
    -FINAL_PART_MAX,
  );
  return finalPart
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/^\s*(?:[-+]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

/**
 * The sentence of the answer's final part that says that the agent will follow up later, or null. "I'll
 * let you know when they reply", "I'll keep an eye on it", "Once the vendors reply, I'll compare them".
 * A question, an offer ("If you want, I'll follow up"), a negation and the past tense do not count. It
 * is conservative: a promise that it does not see is a missed nudge, and a false one costs a turn.
 */
export function followUpPromise(answer: string | undefined): string | null {
  if (!answer?.trim()) return null;
  for (const sentence of finalSentences(answer).reverse()) {
    if (/[?？]\s*$/.test(sentence) || OFFER.test(sentence)) continue;
    if (PROMISES.some((pattern) => pattern.test(sentence))) return sentence;
  }
  return null;
}

export interface StallInput {
  /** The end status of the turn. */
  outcome: "completed" | "failed" | "interrupted" | string;
  /** The user stopped the turn. */
  stopped: boolean;
  /** An automatic plan continuation is queued for the turn. */
  continued: boolean;
  /**
   * The turn is not in a lane that the sweep checks: a channel or messaging thread, a routine run or
   * its session, a quiet run, or a turn that served a teammate's message.
   */
  excluded: boolean;
  /** An open wait serves the turn's request or lane, or the turn opened or rescheduled one. */
  waitOpen: boolean;
  /** A question, an approval or a takeover of the agent waits for the user. */
  waitsForAttention: boolean;
  /** The answer of the turn. */
  answer: string | undefined;
  /** The texts of the open steps of the turn's plan. Empty: no plan, or no open step. */
  openSteps: readonly string[];
}

export interface Stall {
  kind: StallKind;
  /** The text of the reason, for the nudge and the store: the promise, or the open steps. */
  reason: string;
}

/**
 * Whether the turn is a stall: it completed with no continuation, in a checked lane, with no open wait
 * and nothing that waits for the user, and it promised a follow-up or left plan steps open.
 */
export function detectStall(input: StallInput): Stall | null {
  if (input.outcome !== "completed" || input.stopped || input.continued || input.excluded) return null;
  if (input.waitOpen || input.waitsForAttention || waitsForUser(input.answer)) return null;
  const promise = followUpPromise(input.answer);
  if (promise) return { kind: "promise", reason: `You wrote: "${promise}"` };
  if (input.openSteps.length > 0)
    return {
      kind: "openSteps",
      reason: `Your plan has open steps: ${input.openSteps.map((step) => `"${step}"`).join(", ")}`,
    };
  return null;
}
