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
  ),
  // "Tomorrow I'll compare the quotes", "later today I'll send the summary", "On Monday I'll send it",
  // "In 2 hours I'll check". Not "tomorrow I'll be off". The sweep checks it after that time.
  new RegExp(
    String.raw`\b(?:tomorrow|tonight|later\s+(?:today|tonight|on)|this\s+(?:afternoon|evening)|first\s+thing\s+tomorrow|in\s+the\s+morning|(?:on|next|this)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next\s+week|in\s+(?:\d+|an?|one|two|three|a\s+few|a\s+couple\s+of)\s+(?:minutes?|hours?|days?))\s*,?\s+${WILL}\s+(?!not\b|never\b|be\s+(?:off|away|out|offline|unavailable)\b)[a-z]`,
    "i",
  ),
];

/** A sentence that offers the user a choice is a question to the user, not a promise. */
const OFFER = /\bif\s+you(?:['’]d)?\s+(?:want|like|prefer|need|wish)\b|\bwould\s+you\s+like\b|\bdo\s+you\s+want\b/i;
/**
 * A sentence whose later event is an act of the user waits for the user, so it is not a stall: "When
 * you are ready, I'll start the migration", "Once you reply with the dates, I'll book it", "Let me know
 * and I'll send it", "I'll deploy with your approval", "Ready when you are".
 */
const WAITS_ON_USER =
  /\b(?:when(?:ever)?|once|as\s+soon\s+as|after|if|until|unless)\s+(?:you|you['’](?:re|ve|ll|d)|your)\b|\blet\s+me\s+know\b|\bsay\s+the\s+word\b|\bready\s+when\s+you\s+are\b|\b(?:on|with|after|once\s+i\s+(?:have|get))\s+your\s+(?:go-?ahead|approval|ok(?:ay)?|confirmation|sign-?off|answer|reply|word)\b|\bplease\s+(?:review|approve|confirm|check|advise|decide|sign\s+off)\b|\bstanding\s+by\b|\bover\s+to\s+you\b|\b(?:your|the\s+user['’]s)\s+(?:call|decision)\b|\bup\s+to\s+you\b|\bholding\s+off\b|\bnot\s+(?:yet\s+)?sent\b|\bhaven['’]t\s+sent\b|\b(?:need|needs|want|wants|require|requires)\s+(?:you\s+to\s+(?:check|review|approve|confirm|sign)|your\s+(?:go-?ahead|approval|ok(?:ay)?|confirmation|sign-?off|review|input|decision|answer))\b/i;
/**
 * A sentence that waits on an approval before the agent acts, so it is not a stall: "After approval
 * I'll deploy", "Pending your approval, I'll send it", "If approved, I'll book it", "Say yes and I'll
 * send it", "Give me the green light and I'll send it".
 */
const WAITS_ON_APPROVAL = new RegExp(
  [
    // "after approval", "pending your approval", "upon sign-off", "awaiting the board's OK".
    String.raw`\b(?:after|upon|on|with|pending|once|when|if|until|awaiting|waiting\s+(?:for|on)|subject\s+to)\s+(?:(?:your|the|an?|his|her|their|our|[a-z]+['’]s)\s+)?(?:explicit\s+|final\s+|written\s+)?(?:approval|ok(?:ay)?|go-?ahead|green\s+light|sign-?off|confirmation|permission|consent|authori[sz]ation|decision|review|answer|reply|response|feedback|input|thumbs\s+up)\b`,
    // "for your approval", "before your sign-off", "need your go-ahead", "without your OK". Only an approval noun.
    String.raw`\b(?:for|before|needs?|without)\s+(?:(?:your|the|an?|his|her|their|our|[a-z]+['’]s)\s+)?(?:explicit\s+|final\s+|written\s+)?(?:approval|ok(?:ay)?|go-?ahead|green\s+light|sign-?off|confirmation|permission|consent|authori[sz]ation|thumbs\s+up)\b`,
    // "if approved", "once it's signed off", "when this is confirmed".
    String.raw`\b(?:after|once|when|if|until|unless)\s+(?:(?:it|this|that|they|these)\s+(?:is|are|['’]s|['’]re|gets?|has\s+been|have\s+been)\s+|(?:it|this|that)['’]s\s+)?(?:approved|signed\s+off|confirmed|authori[sz]ed|ok(?:ay)?['’]?e?d|green-?lit|cleared)\b`,
    // "approve and I'll book it", "say yes and I'll send it", "give me the green light and I'll send it".
    String.raw`\b(?:approve|confirm|ok(?:ay)?|say\s+(?:yes|so|go)|give\s+me\s+(?:the|a|your)\s+(?:green\s+light|go-?ahead|ok(?:ay)?|nod|thumbs\s+up))\b[^.!?\n]{0,30}\b(?:and|then)\s+(?:then\s+)?(?:i['’]ll|i\s+will|we['’]ll|we\s+will)\b`,
  ].join("|"),
  "i",
);
/**
 * A sentence that waits on the answer of a named person or of the user: "Once Andrew replies, I'll
 * send the contract", "When Sam confirms, I'll book it", "Once the user answers". Only a capitalised
 * name counts, so "when the vendors reply" does not.
 */
const WAITS_ON_NAMED_PERSON =
  /\b(?:[Ww]hen(?:ever)?|[Oo]nce|[Aa]s\s+soon\s+as|[Aa]fter|[Ii]f|[Uu]ntil|[Uu]nless)\s+(?:[A-Z][a-z]+|the\s+user)\s+(?:repl(?:y|ies|ied)|answers?|answered|confirms?|confirmed|approves?|approved|decides?|decided|agrees?|agreed|responds?|responded|signs?|signed|signs?\s+off|says?\s+(?:yes|so|ok(?:ay)?|go))\b/;
/** Words that put a condition on the promise of a sentence: "once the funds arrive, I'll pay the supplier". */
const CONDITION =
  /\b(?:when(?:ever)?|once|as\s+soon\s+as|after|if|until|unless|pending|upon|provided|assuming|in\s+case)\b/i;
/** Adverbs that can stand between "I'll" and a report to the user: "I'll then let you know". */
const REPORT_FILLER = String.raw`(?:(?:then|also|just|quickly|immediately|promptly|definitely|certainly|gladly|happily|be\s+sure\s+to|make\s+sure\s+to)\s+){0,2}`;
/** Verbs by which the agent only reports to the user or watches. They act on nothing outside. */
const REPORT_VERB = String.raw`(?:let\s+you\s+know|update\s+you|keep\s+you\s+(?:posted|updated|informed)|report\s+back|get\s+back\s+to\s+you|ping\s+you|notify\s+you|tell\s+you|be\s+in\s+touch|follow\s+up(?!\s+with)|check\s+back|check\s+in(?!\s+with)|circle\s+back(?!\s+with)|come\s+back|be\s+back|revisit|keep\s+(?:an|my|a\s+close)\s+eye|keep\s+watching|keep\s+monitoring|keep\s+tracking|monitor|watch\s+for)`;
const WILL_AT = new RegExp(String.raw`(?:\b${WILL}|^(?:and\s+)?will)\s+`, "gi");
const REPORT_AT = new RegExp(String.raw`^${REPORT_FILLER}${REPORT_VERB}\b`, "i");
/** A second action joined to a report: "I'll let you know and send it", "then pay the supplier". */
const JOINED_ACTION = new RegExp(
  String.raw`\b(?:and|then|,)\s+(?:then\s+)?(?:${WILL}\s+)?(?!let\s+you|update\s+you|keep\s+you|report\s+back|get\s+back\s+to\s+you|ping\s+you|notify\s+you|tell\s+you)(?:pay|send|sign|deploy|delete|book|publish|transfer|submit|merge|release|buy|order|post|purchase|cancel|remove|email|forward|share|commit|push|wire|charge|refund|execute|run|launch|install|upgrade|apply|approve|accept|reject|file|reply|respond|contact|message|call)\b`,
  "i",
);

/**
 * Whether each "I'll" of the sentence only reports to the user or watches: "I'll let you know when
 * the vendors reply". A sentence that does any other act ("I'll pay the supplier", "I'll compare
 * them and let you know") does not.
 */
function onlyReports(sentence: string): boolean {
  const starts = [...sentence.matchAll(WILL_AT)];
  return (
    starts.length > 0 &&
    starts.every((match) => REPORT_AT.test(sentence.slice((match.index ?? 0) + match[0].length))) &&
    !JOINED_ACTION.test(sentence)
  );
}

/**
 * Whether a sentence waits for the user: it waits on an act of the user or on an approval, or it
 * offers the user a choice.
 */
function sentenceWaitsOnPerson(sentence: string): boolean {
  return OFFER.test(sentence) || WAITS_ON_USER.test(sentence) || WAITS_ON_APPROVAL.test(sentence);
}

/** A line that starts a text that the agent writes for someone else: "Here is a draft:", "Subject:", "Hi Sam,". */
const DRAFT_START =
  /^(?:(?:here(?:['’]s|\s+is)|below\s+is)\b[^\n]{0,40}\b(?:draft|reply|response|message|email|e-mail|text|note|post|letter)\b|here(?:['’]s|\s+is)\s+what\s+i['’]d\s+(?:send|say|write|reply)\b|(?:draft|proposed|suggested)\s+(?:draft|reply|response|message|email|e-mail|text|note|post|letter|answer)\b[^:\n]{0,40}:|(?:draft|subject|re|to|cc)\s*:|draft\s*$|(?:draft\s+)?(?:email|e-mail|message|text|sms|note|letter|reply|dm|whatsapp)\s+(?:to|for)\s+[^.!?\n]{1,40}(?::|$)|text\s+to\s+send\s*:|(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))\b[^,\n]{0,40},)/i;
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
  return (
    kept
      .join("\n")
      .replace(/`[^`\n]*`/g, "")
      .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, "")
      // A span in single quotes of 3 words or more, as "Sam wrote 'we will follow up next week'". Not an
      // apostrophe: the quote opens after a space and closes before a non-letter.
      .replace(/(?<![\p{L}\p{N}])'(?=\S)(?:[^'\n]*?\s){2,}[^'\n]*?(?<=\S)'(?![\p{L}\p{N}])/gu, "")
  );
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
 * let you know when they reply", "I'll keep an eye on it", "Once the vendors reply, I'll let you know".
 * A question, an offer ("If you want, I'll follow up"), a sentence that waits on an act of the user
 * ("When you are ready, I'll start") or on an approval ("After approval I'll deploy"), a negation and
 * the past tense do not count. A promise under a condition ("As soon as the funds arrive, I'll pay
 * the supplier", "Once Andrew replies, I'll send the contract") counts only when the agent only
 * reports or watches ("I'll let you know when they reply"): an act after a condition can need the
 * user's approval, so a nudge must not push it. Only the agent's own prose counts: quoted, fenced and
 * drafted text goes (`ownProse`). It is conservative: a promise that it does not see is a missed
 * nudge, and a false one costs a turn.
 */
export function followUpPromise(answer: string | undefined): string | null {
  if (!answer?.trim()) return null;
  for (const sentence of finalSentences(answer).reverse()) {
    if (/[?？]\s*$/.test(sentence) || sentenceWaitsOnPerson(sentence)) continue;
    if (!PROMISES.some((pattern) => pattern.test(sentence))) continue;
    if (CONDITION.test(sentence) && !onlyReports(sentence)) continue;
    return sentence;
  }
  return null;
}

/** A last question that is only social: "Anything else?", "Is there anything else I can help with?". */
const SOCIAL_QUESTION =
  /(^|[.!?]\s+|\n\s*)(?:(?:is\s+there\s+)?anything\s+else(?:\s+(?:i\s+can\s+(?:help\s+(?:you\s+)?with|do(?:\s+for\s+you)?)|you\s+need))?|need\s+anything\s+else|can\s+i\s+help\s+with\s+anything\s+else)\s*[?？]+\s*$/i;

/** The sentences of the last part of the answer as it is, drafts and quotes included. */
function lastRawSentences(answer: string): string[] {
  return answer
    .trim()
    .slice(-FINAL_PART_MAX)
    .replace(/[*_`>#]/g, "")
    .split(/(?<=[.!?？])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Whether the answer waits for the user, or for a person, before the agent goes on: its last line asks
 * a question or says that the agent waits (`waitsForUser`), or a sentence of its last part waits on
 * an act of the user ("Let me know what you think.", "Ready when you are.", "When you are ready,
 * I'll send it."), on an approval ("After approval I'll deploy"), or on the answer of a named person
 * ("Once Andrew replies, I'll send the contract"), or offers a choice, or a sentence asks the user a
 * question that is not only whether to continue. When unsure, it waits. The plan
 * continuation and the open-steps check do not run for such a turn.
 */
export function answerWaitsOnUser(answer: string | undefined): boolean {
  if (waitsForUser(answer)) return true;
  if (!answer?.trim()) return false;
  // A question asks the user, unless it only asks whether to continue ("Do you want me to continue?").
  return lastRawSentences(answer).some((sentence) =>
    /[?？]\s*$/.test(sentence)
      ? waitsForUser(sentence)
      : sentenceWaitsOnPerson(sentence) || WAITS_ON_NAMED_PERSON.test(sentence),
  );
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
 * and nothing that waits for the user, and it promised a follow-up or left plan steps open. A last
 * social question ("Anything else?") does not hide a promise before it, but it still holds the open
 * steps. Open steps do not count when the answer waits on the user or a person (`answerWaitsOnUser`).
 */
export function detectStall(input: StallInput): Stall | null {
  if (input.outcome !== "completed" || input.stopped || input.continued || input.excluded) return null;
  if (input.waitOpen || input.waitsForAttention) return null;
  let answer = input.answer;
  let social = false;
  if (waitsForUser(answer)) {
    const without = answer?.trimEnd().replace(SOCIAL_QUESTION, "$1");
    if (without === undefined || without === answer?.trimEnd() || !without.trim() || waitsForUser(without)) return null;
    answer = without;
    social = true;
  }
  // An answer that waits on the user in any sentence is no stall, also when another sentence promises
  // to watch: a nudge would land on an agent whose draft waits for approval.
  if (answerWaitsOnUser(answer)) return null;
  const promise = followUpPromise(answer);
  if (promise) return { kind: "promise", reason: `You wrote: "${promise}"` };
  if (social || input.openSteps.length === 0) return null;
  return {
    kind: "openSteps",
    reason: `Your plan has open steps: ${input.openSteps.map((step) => `"${step}"`).join(", ")}`,
  };
}
