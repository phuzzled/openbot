/**
 * The time that a promise names: "Tomorrow I'll pay the supplier", "Tonight I'll deploy", "On Monday
 * I'll send it", "in 2 hours I'll check", "I'll check on it in 10 minutes". The stall sweep puts the
 * check of such a promise after that time, so a nudge never comes before the time that the agent named.
 * Times are local times of this computer. It has no state and imports no service.
 *
 * Rules, safe side first:
 * - "in N minutes/hours/days/weeks": now plus that time.
 * - "tomorrow", "first thing tomorrow", "in the morning": 09:00 of that day; "afternoon" 14:00,
 *   "evening" 18:00, "tonight" 20:00. A clock time ("at 3pm", "at 15:30") wins over the default hour.
 *   "Tomorrow" said before 05:00 is the coming day: later today.
 * - "this morning/afternoon/evening", "tonight", "end of day": that hour of today, or now when it is past.
 * - "later today", "later on": now plus 3 hours.
 * - A weekday ("on Monday", "next Friday"): 09:00 of the next such day after today.
 * - "next week": 09:00 seven days from today; "this weekend": 09:00 of the next Saturday.
 * - A clock time alone: today at that time, or tomorrow when it is past. With no am/pm, an hour from 1
 *   to 11 that is past this morning is the same hour in the afternoon when that is still ahead
 *   ("at 3:30" said at 14:00 is 15:30).
 * - A date: "on the 20th" or "the 20th of": 09:00 of the next 20th; "next month": 09:00 on the 1st of
 *   next month; "in March": 09:00 on the 1st of the next March (not the month of now); "2026-12-01":
 *   09:00 that day, when it is ahead.
 * - Another time word that this does not read ("end of week", "this week", "next quarter", "over the
 *   weekend", a date that is not ahead): a late check, 09:00 seven days from today
 *   (`UNREAD_TIME_DAYS`). It never comes early for a time inside the week, and the promise is not lost.
 * - A promise with no time word: null, and the normal grace applies.
 *
 * Not handled (review 7, T1): a time zone ("at 9am PT" is 09:00 here); a weekday said on that day ("on
 * Friday" said on a Friday is next Friday); "by Friday" (the nudge comes on Friday, before the
 * deadline ends); "tonight" said after 20:00 (now).
 */

/** The days after which a promise with a time word that `promiseTime` does not read is checked. */
export const UNREAD_TIME_DAYS = 7;

const DAY_MS = 24 * 60 * 60_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  "a couple of": 2,
  "a few": 3,
  "half an": 0.5,
};
const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  min: 60_000,
  hour: 3_600_000,
  hr: 3_600_000,
  day: DAY_MS,
  week: 7 * DAY_MS,
};

const RELATIVE =
  /\bin\s+(\d+(?:\.\d+)?|a\s+couple\s+of|a\s+few|half\s+an|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty)\s+(minute|min|hour|hr|day|week)s?\b/i;
const CLOCK =
  /\b(?:at|by|around|after|before)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?![\d%])|\b(noon|midday|midnight)\b/i;
const WEEKDAY = new RegExp(String.raw`\b(?:on\s+|next\s+|this\s+(?:coming\s+)?|by\s+)?(${WEEKDAYS.join("|")})\b`, "i");
/** Words that name a time that the rules above do not read. They get the safe default. */
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const DAY_OF_MONTH = /\b(?:on\s+the\s+(\d{1,2})(?:st|nd|rd|th)|(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\s+of)\b/i;
const IN_MONTH = new RegExp(String.raw`\bin\s+(${MONTHS.join("|")})\b`, "i");
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const OTHER_TIME =
  /\b(?:on\s+the\s+\d{1,2}(?:st|nd|rd|th)|\d{1,2}(?:st|nd|rd|th)\s+of|in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)|next\s+(?:month|year|quarter)|end\s+of\s+(?:the\s+)?(?:week|month)|eow|eom|this\s+week|over\s+the\s+weekend|\d{4}-\d{2}-\d{2})\b/i;

function at(day: Date, hours: number, minutes = 0): Date {
  const result = new Date(day.getTime());
  result.setHours(hours, minutes, 0, 0);
  return result;
}

function addDays(day: Date, days: number): Date {
  const result = new Date(day.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * The clock time of the text as [hours, minutes, whether it says am or pm], or null. A bare number needs
 * am/pm or minutes.
 */
function clockOf(text: string): [number, number, boolean] | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  if (match[4]) return match[4].toLowerCase() === "midnight" ? [23, 59, true] : [12, 0, true];
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase().replace(/\./g, "");
  if (!meridiem && !match[2]) return null;
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return [hours, minutes, meridiem !== undefined];
}

/** 09:00 of the date, or null when the month has no such day ("the 31st" of a 30-day month). */
function dayAt(year: number, month: number, day: number): Date | null {
  const result = new Date(year, month, day, 9, 0, 0, 0);
  return result.getMonth() === ((month % 12) + 12) % 12 && result.getDate() === day ? result : null;
}

/** The date that the text names ("on the 20th", "next month", "in March", "2026-12-01"), or null. */
function dateOf(text: string, now: Date): Date | null {
  const ahead = (time: Date | null) => (time && time.getTime() > now.getTime() ? time : null);
  const day = DAY_OF_MONTH.exec(text);
  if (day) {
    const date = Number(day[1] ?? day[2]);
    return (
      ahead(dayAt(now.getFullYear(), now.getMonth(), date)) ?? ahead(dayAt(now.getFullYear(), now.getMonth() + 1, date))
    );
  }
  if (/\bnext\s+month\b/i.test(text)) return dayAt(now.getFullYear(), now.getMonth() + 1, 1);
  const month = IN_MONTH.exec(text);
  if (month) {
    const target = MONTHS.indexOf((month[1] ?? "").toLowerCase());
    if (target === now.getMonth()) return null;
    return dayAt(now.getFullYear() + (target < now.getMonth() ? 1 : 0), target, 1);
  }
  const iso = ISO_DATE.exec(text);
  if (iso) return ahead(dayAt(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  return null;
}

/** The default hour of a part of the day that the text names, or the fallback. */
function partHour(text: string, fallback: number): number {
  if (/\bmorning\b/i.test(text)) return 9;
  if (/\b(?:afternoon|midday|lunch(?:time)?)\b/i.test(text)) return 14;
  if (/\bevening\b/i.test(text)) return 18;
  if (/\bnight\b|\btonight\b/i.test(text)) return 20;
  return fallback;
}

/**
 * The time that the promise names, as a date not before `now`, or null when it names no time. A time
 * that this does not read gives the late check of `UNREAD_TIME_DAYS`. See the file comment for the rules.
 */
export function promiseTime(text: string, now: Date): Date | null {
  const later = (time: Date) => (time.getTime() < now.getTime() ? now : time);
  const relative = RELATIVE.exec(text);
  if (relative) {
    const amount = relative[1] ?? "";
    const count = /^\d/.test(amount) ? Number(amount) : (NUMBER_WORDS[amount.toLowerCase().replace(/\s+/g, " ")] ?? 1);
    return new Date(now.getTime() + count * (UNIT_MS[(relative[2] ?? "").toLowerCase()] ?? 0));
  }
  const clock = clockOf(text);
  const timed = (day: Date, fallbackHour: number) =>
    clock ? at(day, clock[0], clock[1]) : at(day, partHour(text, fallbackHour));
  // Before 05:00, "tomorrow" is the coming day: today.
  if (/\btomorrow\b/i.test(text)) return later(timed(addDays(now, now.getHours() < 5 ? 0 : 1), 9));
  if (/\btonight\b|\blater\s+tonight\b/i.test(text)) return later(timed(now, 20));
  if (/\bthis\s+(?:morning|afternoon|evening)\b/i.test(text)) return later(timed(now, 9));
  if (/\bend\s+of\s+(?:the\s+)?(?:day|business)\b|\beod\b|\bcob\b/i.test(text)) return later(timed(now, 17));
  if (/\blater\s+(?:today|on)\b/i.test(text)) return new Date(now.getTime() + 3 * 3_600_000);
  if (/\bin\s+the\s+morning\b/i.test(text)) {
    const today = at(now, 9);
    return today.getTime() > now.getTime() ? today : at(addDays(now, 1), 9);
  }
  const weekday = WEEKDAY.exec(text);
  if (weekday) {
    const target = WEEKDAYS.indexOf((weekday[1] ?? "").toLowerCase());
    const ahead = (target - now.getDay() + 7) % 7 || 7;
    return timed(addDays(now, ahead), 9);
  }
  if (/\bnext\s+week\b/i.test(text)) return timed(addDays(now, 7), 9);
  if (/\bthis\s+weekend\b|\bat\s+the\s+weekend\b|\bon\s+the\s+weekend\b/i.test(text)) {
    const ahead = (6 - now.getDay() + 7) % 7 || 7;
    return timed(addDays(now, ahead), 9);
  }
  if (clock) {
    const today = at(now, clock[0], clock[1]);
    if (today.getTime() > now.getTime()) return today;
    // "at 3:30" said at 14:00: 15:30, not 03:30 tomorrow.
    const afternoon = at(now, clock[0] + 12, clock[1]);
    if (!clock[2] && clock[0] >= 1 && clock[0] <= 11 && afternoon.getTime() > now.getTime()) return afternoon;
    return addDays(today, 1);
  }
  const date = dateOf(text, now);
  if (date) return date;
  if (OTHER_TIME.test(text) || DAY_OF_MONTH.test(text) || IN_MONTH.test(text) || ISO_DATE.test(text))
    return timed(addDays(now, UNREAD_TIME_DAYS), 9);
  return null;
}
