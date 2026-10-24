/**
 * Jalali date INPUT (report entry). Display uses lib/dates.ts (Intl). To avoid a second, possibly disagreeing
 * calendar implementation, conversion here is done by SEARCHING with the very same Intl formatter that renders
 * dates: the returned instant is the one whose Tehran wall clock shows exactly the typed Jalali date and time.
 * Invalid dates (31 Shahrivar, 30 Esfand in a non-leap year, ...) are rejected because no instant matches.
 */
import { toJalaliParts, type JalaliParts } from "./dates";

const DAY = 86_400_000;
const TEHRAN = "Asia/Tehran";

const wallFormat = new Intl.DateTimeFormat("en-CA-u-nu-latn", {
  timeZone: TEHRAN, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** Tehran wall-clock of an instant, expressed as a UTC timestamp of the same digits. */
function wallAsUtc(date: Date): number {
  const parts = wallFormat.formatToParts(date);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
}

const ordinal = (p: Pick<JalaliParts, "year" | "month" | "day">) => p.year * 400 + p.month * 32 + p.day;

export function jalaliToDate(p: JalaliParts): Date | null {
  const { year, month, day, hour, minute } = p;
  if (![year, month, day, hour, minute].every(Number.isInteger)) return null;
  if (year < 1300 || year > 1500 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const monthStart = month <= 6 ? (month - 1) * 31 : 186 + (month - 7) * 30;
  let guess = new Date(Date.UTC(year + 621, 2, 21, 9, 0) + (monthStart + day - 1) * DAY); // ~09:00 UTC = noon in Tehran
  const target = ordinal(p);
  let prev = 0;
  for (let i = 0; i < 20; i++) {
    const cur = ordinal(toJalaliParts(guess));
    if (cur === target) break;
    const step = cur < target ? 1 : -1;
    if (prev && step !== prev) return null; // stepped over the target: that day does not exist
    prev = step;
    guess = new Date(guess.getTime() + step * DAY);
    if (i === 19) return null;
  }
  const dayWall = new Date(wallAsUtc(guess));
  const targetWall = Date.UTC(dayWall.getUTCFullYear(), dayWall.getUTCMonth(), dayWall.getUTCDate(), hour, minute);
  let instant = new Date(targetWall - 3.5 * 3_600_000);
  for (let i = 0; i < 3; i++) instant = new Date(targetWall - (wallAsUtc(instant) - instant.getTime()));
  const back = toJalaliParts(instant);
  return back.year === year && back.month === month && back.day === day && back.hour === hour && back.minute === minute ? instant : null;
}

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/** Persian / Arabic-Indic digits -> ASCII, so people can type in whatever keyboard they have. */
export function normalizeDigits(text: string): string {
  return text.replace(/[۰-۹٠-٩]/g, (c) => String(PERSIAN.includes(c) ? PERSIAN.indexOf(c) : ARABIC_INDIC.indexOf(c)));
}

export function parseJalaliDateText(text: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(normalizeDigits(text).trim());
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}

export function parseTimeText(text: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2})[:٫.](\d{2})$/.exec(normalizeDigits(text).trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/** Instant for the two text boxes, or null if either is malformed / not a real date. */
export function dateTimeFromTexts(dateText: string, timeText: string): Date | null {
  const d = parseJalaliDateText(dateText);
  const t = parseTimeText(timeText);
  return d && t ? jalaliToDate({ ...d, ...t }) : null;
}

const two = (n: number) => String(n).padStart(2, "0");

/** Text-box values (ASCII digits; the field shows them LTR) for an instant. */
export function textsFromDate(value: Date | string): { dateText: string; timeText: string } {
  const p = toJalaliParts(value);
  return { dateText: `${p.year}/${two(p.month)}/${two(p.day)}`, timeText: `${two(p.hour)}:${two(p.minute)}` };
}
