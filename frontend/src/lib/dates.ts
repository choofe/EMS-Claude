/**
 * Dates: the server stores and returns UTC; the UI shows the Persian (Jalali) calendar in the business timezone
 * Asia/Tehran. Uses the browser's built-in Intl (zero dependencies, timezone- and DST-history-correct); the
 * `jalaali-js` library is only needed when users TYPE dates (report entry, Phase 6).
 */
const TZ = "Asia/Tehran";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export function toPersianDigits(text: string): string {
  return text.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]);
}

const HAS_TZ = /(Z|[+-]\d{2}:?\d{2})$/i;

/** The API serialises UTC; some serialisers drop the "Z". A bare timestamp is UTC — never browser-local time. */
export function parseServerDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  const date = new Date(HAS_TZ.test(value) ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${value}`);
  return date;
}

const partsFormat = new Intl.DateTimeFormat("en-u-ca-persian-nu-latn", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface JalaliParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function toJalaliParts(value: string | Date): JalaliParts {
  const parts = partsFormat.formatToParts(parseServerDate(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

const two = (n: number) => String(n).padStart(2, "0");

export function formatJalaliDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const p = toJalaliParts(value);
  return toPersianDigits(`${p.year}/${two(p.month)}/${two(p.day)}`);
}

export function formatJalaliDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const p = toJalaliParts(value);
  return toPersianDigits(`${p.year}/${two(p.month)}/${two(p.day)} ${two(p.hour)}:${two(p.minute)}`);
}
