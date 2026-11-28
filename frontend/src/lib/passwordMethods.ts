/**
 * Temporary-password methods of the users panel (Pk). Everything runs in the browser: the values are computed here, the
 * method chosen is never sent or audited. The server stays the authority on the password policy; the small check below
 * only mirrors its «too simple» rule so a candidate that is certain to be refused is never offered.
 */
export type PasswordMethod = "none" | "random" | "mobile" | "derived" | "manual";

/** Lowercase letters and digits without the look-alikes `0 o 1 l i`. */
export const RANDOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Persian and Arabic-Indic digits to ASCII; everything else is left as it is. */
export function asciiDigits(text: string): string {
  return text.replace(/[۰-۹٠-٩]/g, (c) => {
    const i = PERSIAN_DIGITS.indexOf(c);
    return String(i >= 0 ? i : ARABIC_DIGITS.indexOf(c));
  });
}

/** The stored form `09xxxxxxxxx`, or null when the text is not a mobile number (`+98`, `0098`, `98` and a missing 0 are accepted, like the server). */
export function normalizeMobile(text: string | null | undefined): string | null {
  if (!text) return null;
  let d = asciiDigits(text).replace(/[\s\-()]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (!/^\d+$/.test(d)) return null;
  if (d.startsWith("0098")) d = d.slice(4);
  else if (d.startsWith("98") && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith("9")) d = "0" + d;
  return /^09\d{9}$/.test(d) ? d : null;
}

/** An integer 1–9999 without a leading zero, or null. */
export function normalizeCode(text: string | number | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const d = asciiDigits(String(text)).trim();
  if (!/^[1-9]\d{0,3}$/.test(d)) return null;
  return Number(d);
}

/** Mirror of the server's «too simple» rule: one repeated character, or a straight ascending/descending run. */
export function isTooSimple(password: string): boolean {
  if (!password) return false;
  if (new Set(password).size === 1) return true;
  const diffs = new Set<number>();
  for (let i = 1; i < password.length; i++) diffs.add(password.charCodeAt(i) - password.charCodeAt(i - 1));
  return diffs.size === 1 && (diffs.has(1) || diffs.has(-1));
}

/** A random index below `n` without modulo bias. */
function randomBelow(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % n;
}

/** 8–10 characters from the alphabet above; drawn again if the result is a certain refusal. */
export function generateRandomPassword(): string {
  for (;;) {
    const length = 8 + randomBelow(3);
    let out = "";
    for (let i = 0; i < length; i++) out += RANDOM_ALPHABET[randomBelow(RANDOM_ALPHABET.length)];
    if (!isTooSimple(out)) return out;
  }
}

/** The mobile number itself as the password; null when there is no valid mobile or the number is a certain refusal. */
export function mobilePassword(mobile: string | null | undefined): string | null {
  const m = normalizeMobile(mobile);
  return m && !isTooSimple(m) ? m : null;
}

/** The mobile number with its last four digits replaced by the personnel code padded to four digits. */
export function derivedPassword(mobile: string | null | undefined, code: string | number | null | undefined): string | null {
  const m = normalizeMobile(mobile);
  const c = normalizeCode(code);
  if (!m || c === null) return null;
  const out = m.slice(0, 7) + String(c).padStart(4, "0");
  return isTooSimple(out) ? null : out;
}

/** Roles whose accounts need the stricter handling: a guessable temporary password must be changed at the first sign-in. */
export const PRIVILEGED_ROLES: readonly string[] = ["MANAGEMENT", "AUDITOR"];
