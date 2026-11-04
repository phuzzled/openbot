import type { ConversationPlanStep } from "@openbot/contracts/ipc";

/** The parts of a plan step that the gate reads. */
type Step = Pick<ConversationPlanStep, "text" | "status">;

/**
 * The code gate of an automatic plan continuation. A continuation note says "Continue the work now",
 * so it must never reach an action that the user did not ask for. The gate does not read the answer
 * for a promise; it reads the plan and the request:
 *
 * - The next open steps (each step in progress, and the first pending step) must not be an outward
 *   action (`OUTWARD_ACTIONS`: send, pay, book, deploy, delete, sign, contact someone, and so on),
 *   unless the user's own request names that action as a verb ("Write and send the report"). With no
 *   request text of the user (a wake, a task brief, a restart of an agent's message), an outward step
 *   always stops the chain. When unsure, it stops.
 * - The answer must not ask the user anything, and must not name an approval, a confirmation, a
 *   go-ahead, a green light, a sign-off or a review in any form. A last line that only asks whether to
 *   continue ("Shall I continue?") is not a question to the user.
 *
 * It has no state and imports no service. `PlanContinuation` calls it for each continuation and each
 * restore.
 */

/** One outward action: the forms of its verb. A group of verbs that name the same act shares one id. */
interface OutwardAction {
  group: string;
  forms: readonly string[];
}

const action = (group: string, ...forms: string[]): OutwardAction => ({ group, forms });

/**
 * Verbs of actions that leave the agent's own work: they send, pay, book, publish, deploy, delete,
 * sign or contact someone. Each verb lists its forms. The verbs of one group name the same act, so a
 * request that says "email the board" allows a step "Send the email to the board".
 */
const OUTWARD_ACTIONS: readonly OutwardAction[] = [
  action("send", "send", "sends", "sending", "sent"),
  action("send", "email", "emails", "emailing", "emailed", "e-mail", "e-mails", "e-mailed"),
  action("send", "mail", "mails", "mailing", "mailed"),
  action("send", "message", "messages", "messaging", "messaged"),
  action("send", "text", "texts", "texting", "texted"),
  action("send", "sms"),
  action("send", "dm", "dms", "dming", "dmed"),
  action("send", "reply", "replies", "replying", "replied"),
  action("send", "respond", "responds", "responding", "responded"),
  action("send", "forward", "forwards", "forwarding", "forwarded"),
  action("contact", "contact", "contacts", "contacting", "contacted"),
  action("contact", "call", "calls", "calling", "called"),
  action("contact", "phone", "phones", "phoning", "phoned"),
  action("contact", "ring", "rings", "ringing", "rang"),
  action("contact", "notify", "notifies", "notifying", "notified"),
  action("contact", "invite", "invites", "inviting", "invited"),
  action("contact", "announce", "announces", "announcing", "announced"),
  action("publish", "post", "posts", "posting", "posted"),
  action("publish", "publish", "publishes", "publishing", "published"),
  action("publish", "tweet", "tweets", "tweeting", "tweeted"),
  action("publish", "share", "shares", "sharing", "shared"),
  action("publish", "upload", "uploads", "uploading", "uploaded"),
  action("pay", "pay", "pays", "paying", "paid"),
  action("pay", "transfer", "transfers", "transferring", "transferred"),
  action("pay", "wire", "wires", "wiring", "wired"),
  action("pay", "refund", "refunds", "refunding", "refunded"),
  action("pay", "charge", "charges", "charging", "charged"),
  action("buy", "buy", "buys", "buying", "bought"),
  action("buy", "purchase", "purchases", "purchasing", "purchased"),
  action("buy", "order", "orders", "ordering", "ordered"),
  action("book", "book", "books", "booking", "booked"),
  action("book", "reserve", "reserves", "reserving", "reserved"),
  action("deploy", "deploy", "deploys", "deploying", "deployed"),
  action("deploy", "release", "releases", "releasing", "released"),
  action("deploy", "ship", "ships", "shipping", "shipped"),
  action("deploy", "launch", "launches", "launching", "launched"),
  action("deploy", "merge", "merges", "merging", "merged"),
  action("deploy", "push", "pushes", "pushing", "pushed"),
  action("deploy", "roll back", "rolls back", "rolling back", "rolled back"),
  action("deploy", "go live", "goes live", "going live", "went live"),
  action("delete", "delete", "deletes", "deleting", "deleted"),
  action("delete", "remove", "removes", "removing", "removed"),
  action("delete", "drop", "drops", "dropping", "dropped"),
  action("delete", "wipe", "wipes", "wiping", "wiped"),
  action("delete", "purge", "purges", "purging", "purged"),
  action("delete", "erase", "erases", "erasing", "erased"),
  action("delete", "destroy", "destroys", "destroying", "destroyed"),
  action("cancel", "cancel", "cancels", "cancelling", "canceling", "cancelled", "canceled"),
  action("cancel", "unsubscribe", "unsubscribes", "unsubscribing", "unsubscribed"),
  action("cancel", "terminate", "terminates", "terminating", "terminated"),
  action("sign", "sign", "signs", "signing", "signed"),
  action("sign", "submit", "submits", "submitting", "submitted"),
  action("sign", "file", "files", "filing", "filed"),
  action("sign", "accept", "accepts", "accepting", "accepted"),
  action("sign", "approve", "approves", "approving", "approved"),
];

const pattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, String.raw`\s+`);
const FORMS = OUTWARD_ACTIONS.flatMap((item) => item.forms.map((form) => ({ form, group: item.group })))
  // The longest form first, so "roll back" matches before "roll".
  .sort((a, b) => b.form.length - a.form.length);
const ANY_FORM = FORMS.map(({ form }) => pattern(form)).join("|");
/** The words that can stand before the verb of a step: "Then send…", "2. Finally, pay…". */
const STEP_LEAD = String.raw`(?:(?:then|finally|next|now|also|and|lastly|after\s+that)\s*,?\s+)*`;
/** A verb at the start of a step or of a joined clause: "Send the email", "Draft and send it", "Draft, then send". */
const STEP_VERB = new RegExp(
  String.raw`(?:^|[,;:/&]|\band\b|\bthen\b|\bor\b)\s*${STEP_LEAD}(${ANY_FORM})(?![\p{L}\p{N}-])`,
  "giu",
);
/**
 * A verb in the user's request, in a place where it is a verb and not a noun: at the start of a
 * sentence or clause, or after "and", "then", "please", "to", "you", "me", "just", "also". "Draft an
 * email" does not name a send; "Email the board", "Can you send it", "Draft and send it" do.
 */
const REQUEST_VERB = new RegExp(
  String.raw`(?:^|[.,;:!?/&()\n-]|\b(?:and|then|please|pls|to|you|me|just|also|now|finally|i|we|go\s+ahead\s+and)\b)\s*(${ANY_FORM})(?![\p{L}\p{N}-])`,
  "giu",
);
/** A negation just before a verb of the request: "don't send it", "do not pay", "not to post". */
const NEGATED = /(?:\bnot|\bnever|n['’]t|\bno|\bwithout)\s+(?:yet\s+|to\s+|be\s+|just\s+)?$/i;

function groupOf(form: string): string | undefined {
  const normal = form.toLowerCase().replace(/\s+/g, " ");
  return FORMS.find((item) => item.form === normal)?.group;
}

/** The groups of the outward actions that a plan step starts with or joins: "Send the email" → send. */
export function outwardActions(step: string): string[] {
  const text = step.replace(/^[\s*_`#>]*(?:[-+]|\d+[.)])?\s*/, "").replace(/[*_`]/g, "");
  return [...new Set([...text.matchAll(STEP_VERB)].flatMap((match) => groupOf(match[1] ?? "") ?? []))];
}

/** The groups of the outward actions that the user's request names as a verb, and does not negate. */
export function requestedActions(request: string): Set<string> {
  const groups = new Set<string>();
  for (const match of request.matchAll(REQUEST_VERB)) {
    const verb = match[1] ?? "";
    const before = request.slice(0, (match.index ?? 0) + match[0].length - verb.length);
    if (NEGATED.test(before)) continue;
    const group = groupOf(verb);
    if (group) groups.add(group);
  }
  return groups;
}

/** The steps that a continuation would do next: each step in progress, and the first pending step. */
export function nextOpenSteps<T extends Step>(steps: readonly T[]): T[] {
  const firstPending = steps.find((step) => step.status === "pending");
  return steps.filter((step) => step.status === "inProgress" || step === firstPending);
}

/**
 * Whether the next open steps hold an outward action that the user's request did not name. `request`
 * is the text of the user's message that started the work, or null when no message of the user did.
 */
export function stepsNeedApproval(steps: readonly Step[], request: string | null): boolean {
  const asked = request ? requestedActions(request) : new Set<string>();
  return nextOpenSteps(steps).some((step) => outwardActions(step.text).some((group) => !asked.has(group)));
}

/** Words that name an approval or a check by the user, in any form. Broad on purpose. */
const APPROVAL_WORDS =
  /\b(?:approv\w*|confirm\w*|go-?ahead|green[\s-]?light\w*|sign[\s-]?off|signs?\s+off|signed\s+off|review\w*|authori[sz]\w*|permission|consent|ok(?:ay)?\s+(?:to|with|it)|your\s+(?:call|decision|answer|reply|input|feedback|ok(?:ay)?|word|say-?so)|over\s+to\s+you|standing\s+by|stand\s+by|holding\s+off|hold\s+off|let\s+me\s+know|up\s+to\s+you)\b/i;

/** The answer as the agent wrote it, without fenced and inline code. */
function proseOf(answer: string): string {
  return answer.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, "").replace(/`[^`\n]*`/g, "");
}

/**
 * Whether the answer asks the user anything or names an approval in any form. `onlyAsksToContinue`
 * tells a last line that only asks whether to go on ("Shall I continue?"), which does not count.
 */
export function replyWaitsForUser(answer: string | undefined, onlyAsksToContinue: (line: string) => boolean): boolean {
  if (!answer?.trim()) return false;
  const prose = proseOf(answer).trimEnd();
  if (APPROVAL_WORDS.test(prose)) return true;
  const lines = prose.split("\n");
  const last = (lines.at(-1) ?? "").replace(/[*_`>#]/g, "").trim();
  const rest = onlyAsksToContinue(last) ? lines.slice(0, -1).join("\n") : prose;
  return /[?？](?:\s|$|["'’”)\]*_])/.test(rest);
}

/**
 * Whether an automatic continuation may run: the answer does not wait for the user
 * (`replyWaitsForUser`), and the next open steps hold no outward action that the request did not name
 * (`stepsNeedApproval`).
 */
export function continuationAllowed(input: {
  steps: readonly Step[];
  request: string | null;
  answer: string | undefined;
  onlyAsksToContinue: (line: string) => boolean;
}): boolean {
  return !replyWaitsForUser(input.answer, input.onlyAsksToContinue) && !stepsNeedApproval(input.steps, input.request);
}
