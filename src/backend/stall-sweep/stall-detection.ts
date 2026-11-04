import { waitsForUser } from "../agent/plan-continuation";

/**
 * The detection half of the stall sweep: whether a turn that just ended left work open with nothing
 * that brings the agent back. It has no state and imports no service. `StallSweep` owns the checks.
 */

/** Why a lane stalls: the answer promised a follow-up, or the plan of the turn has open steps. */
export type StallKind = "promise" | "openSteps";

/** The last part of an answer that is searched for a promise. A promise is near the end of an answer. */
const FINAL_PART_MAX = 400;

const WILL = String.raw`(?:i['’]ll|i\s+will|i['’]m\s+going\s+to|i\s+am\s+going\s+to|(?:i['’]m\s+)?gonna|i\s+shall|we['’]ll|we\s+will)`;
/** At most three words between "I'll" and the verb, as in "I'll then quickly follow up". Not a negation. */
const FILLER = String.raw`(?:(?!not\b|never\b|no\s+longer\b)[a-z]+\s+){0,3}`;
/** Verbs that promise a later return to the user or to the work. */
const FOLLOW_UP_VERB = String.raw`(?:follow\s+up|check\s+back|check\s+in|check\s+on|circle\s+back|get\s+back|come\s+back|be\s+back|revisit|report\s+back|keep\s+(?:an|my|a\s+close)\s+eye|keep\s+watching|keep\s+monitoring|keep\s+tracking|monitor|watch\s+for|keep\s+you\s+(?:posted|updated|informed)|update\s+you|let\s+you\s+know(?!\s+if\b)|ping\s+you|notify\s+you|be\s+in\s+touch|chase)`;
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
  ), // "Tomorrow I'll compare the quotes", "later today I'll send the summary". Not "tomorrow I'll be off".
  new RegExp(
    String.raw`\b(?:tomorrow|tonight|later\s+(?:today|tonight|on)|this\s+(?:afternoon|evening)|first\s+thing\s+tomorrow|in\s+the\s+morning)\s*,?\s+${WILL}\s+(?!not\b|never\b|be\s+(?:off|away|out|offline|unavailable)\b)[a-z]`,
    "i",
  ),
];

/** A sentence that offers the user a choice is a question to the user, not a promise. */
const OFFER = /\bif\s+you(?:['’]d)?\s+(?:want|like|prefer|need|wish)\b|\bwould\s+you\s+like\b|\bdo\s+you\s+want\b/i;
/**
 * A sentence whose later event is an act of the user waits for the user, so it is not a stall: "When
 * you are ready, I'll start the migration", "Once you reply with the dates, I'll book it", "Let me know
 * and I'll send it", "I'll deploy with your approval".
 */
const WAITS_ON_USER =
  /\b(?:when(?:ever)?|once|as\s+soon\s+as|after|if|until|unless)\s+(?:you|you['’](?:re|ve|ll|d)|your)\b|\blet\s+me\s+know\b|\bsay\s+the\s+word\b|\b(?:on|with|after|once\s+i\s+(?:have|get))\s+your\s+(?:go-?ahead|approval|ok(?:ay)?|confirmation|sign-?off|answer|reply|word)\b/i;

/** A line that starts a text that the agent writes for someone else: "Here is a draft:", "Subject:", "Hi Sam,". */
const DRAFT_START =
  /^(?:(?:here(?:['’]s|\s+is)|below\s+is)\b[^\n]{0,40}\b(?:draft|reply|response|message|email|e-mail|text|note|post|letter)\b|(?:draft|subject|re|to|cc)\s*:|(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))\b[^,\n]{0,40},)/i;
/** The sign-off line of a drafted message: "Cheers,", "Kind regards", "Thanks!". */
const SIGN_OFF =
  /^(?:cheers|regards|(?:kind|best|warm|warmest)\s+regards|best(?:\s+wishes)?|all\s+the\s+best|thanks|thank\s+you|many\s+thanks|sincerely|yours(?:\s+\w+)?|talk\s+soon|speak\s+soon)\s*[,.!]?$/i;
/** The name line after a sign-off: short, and not a sentence. */
const NAME_LINE = /^[^.!?:\n]{1,40}$/;

/**
 * The agent's own prose of an answer. Fenced code, quoted lines, inline code and text in double
 * quotes go. A drafted message goes from its start ("Here is a draft", "Subject:", a greeting) to its
 * sign-off and name, or to the end of the answer when it has no sign-off. A sign-off with no start
 * before it takes all text before it.
 */
function ownProse(answer: string): string {
  const lines: { text: string; quoteFollows: boolean }[] = [];
  let lastText: { quoteFollows: boolean } | undefined;
  let fence: string | null = null;
  for (const line of answer.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null || marker || /^\s*>/.test(line)) {
      if (fence !== null && marker?.startsWith(fence)) fence = null;
      else if (fence === null && marker) fence = marker;
      if (lastText) lastText.quoteFollows = true;
      continue;
    }
    const kept = { text: line, quoteFollows: false };
    lines.push(kept);
    if (line.trim()) lastText = kept;
  }
  const plain = (line: string) => line.replace(/[*_#]/g, "").trim();
  const kept: string[] = [];
  let draftFrom: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const text = plain(line.text);
    if (SIGN_OFF.test(text)) {
      kept.length = draftFrom ?? 0;
      draftFrom = null;
      const next = plain(lines[index + 1]?.text ?? "");
      if (next && NAME_LINE.test(next)) index += 1;
      continue;
    }
    // "Here is a draft:" followed by quoted or fenced text: the draft is that text, and it is gone.
    if (draftFrom === null && DRAFT_START.test(text) && !(line.quoteFollows && text.endsWith(":")))
      draftFrom = kept.length;
    kept.push(line.text);
  }
  if (draftFrom !== null) kept.length = draftFrom;
  return kept
    .join("\n")
    .replace(/`[^`\n]*`/g, "")
    .replace(/"[^"\n]*"|“[^”\n]*”/g, "");
}

/** The sentences of the final part of the agent's own prose, without Markdown emphasis or heading marks. */
function finalSentences(answer: string): string[] {
  const text = ownProse(answer)
    .trim()
    .replace(/[*_`>#]/g, "");
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
 * A question, an offer ("If you want, I'll follow up"), a sentence that waits on an act of the user
 * ("When you are ready, I'll start"), a negation and the past tense do not count. Only the agent's own
 * prose counts: quoted, fenced and drafted text goes (`ownProse`). It is conservative: a promise that
 * it does not see is a missed nudge, and a false one costs a turn.
 */
export function followUpPromise(answer: string | undefined): string | null {
  if (!answer?.trim()) return null;
  for (const sentence of finalSentences(answer).reverse()) {
    if (/[?？]\s*$/.test(sentence) || OFFER.test(sentence) || WAITS_ON_USER.test(sentence)) continue;
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
