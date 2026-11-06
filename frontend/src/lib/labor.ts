import { toPersianDigits } from "./dates";
import { normalizeDigits } from "./jalali";

export const MAX_MINUTES = 1440;

/** Hours + minutes text boxes -> minutes. Only whole numbers; empty = 0. null = not a valid number. */
export function toMinutes(hours: string, minutes: string): number | null {
  const parse = (s: string) => {
    const t = normalizeDigits(s).trim();
    if (t === "") return 0;
    return /^\d{1,4}$/.test(t) ? Number(t) : null;
  };
  const h = parse(hours);
  const m = parse(minutes);
  return h === null || m === null ? null : h * 60 + m;
}

export function splitMinutes(total: number): { hours: string; minutes: string } {
  return { hours: String(Math.floor(total / 60)), minutes: String(total % 60) };
}

/** "۲ ساعت و ۳۰ دقیقه" — shown live under the inputs so a typo like 120 in the hours box is obvious. */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  const text = h && m ? `${h} ساعت و ${m} دقیقه` : h ? `${h} ساعت` : `${m} دقیقه`;
  return toPersianDigits(text);
}
