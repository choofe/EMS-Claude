import type { PersonnelCorrection, PersonnelPreview } from "../../api/types";

/** What the manager decided for one invalid group code. */
export type TokenFix = { op: "replace"; to: string } | { op: "remove" };
/** Decisions per row of `group_issues`. A dropped row ignores its token decisions. */
export type Fixes = Record<number, { drop?: boolean; tokens: Record<string, TokenFix> }>;

export const SHOWN_STEP = 50;
/** The server refuses a longer corrections list (`invalid_corrections`); the page blocks the commit first. */
export const MAX_CORRECTIONS = 2000;

/** Token keys are prefixed so a code such as `constructor` or `__proto__` can never hit the object prototype. */
const tk = (token: string) => `t:${token}`;
export const tokenFix = (f: Fixes, row: number, token: string): TokenFix | undefined => f[row]?.tokens[tk(token)];

export function setTokenFix(f: Fixes, row: number, token: string, fix: TokenFix | null): Fixes {
  const cur = f[row] ?? { tokens: {} };
  const tokens = { ...cur.tokens };
  if (fix) tokens[tk(token)] = fix; else delete tokens[tk(token)];
  return { ...f, [row]: { ...cur, tokens } };
}

export function setDrop(f: Fixes, row: number, drop: boolean): Fixes {
  const cur = f[row] ?? { tokens: {} };
  return { ...f, [row]: { ...cur, drop } };
}

/**
 * The corrections list for the server. Only rows and tokens the preview actually reported are sent; a dropped row
 * sends the single `drop` (the server re-validates every item, nothing here is trusted).
 */
export function buildCorrections(p: PersonnelPreview, f: Fixes): PersonnelCorrection[] {
  const out: PersonnelCorrection[] = [];
  for (const issue of p.group_issues) {
    const fix = f[issue.row];
    if (!fix) continue;
    if (fix.drop) { out.push({ row: issue.row, op: "drop" }); continue; }
    for (const bad of issue.invalid_groups) {
      const t = tokenFix(f, issue.row, bad.token);
      if (t?.op === "replace") out.push({ row: issue.row, op: "replace", token: bad.token, to: t.to });
      else if (t?.op === "remove") out.push({ row: issue.row, op: "remove", token: bad.token });
    }
  }
  return out;
}

export interface Summary {
  importable: number;        // people that would be created now
  dropped: number;           // rows the manager left out
  unresolvedRows: number;    // rows that still hold an undecided invalid group code
  unresolvedTokens: number;
}

/** Counts shown on the page. The preview is not repeated after a fix; the server re-validates at commit. */
export function summarize(p: PersonnelPreview, f: Fixes): Summary {
  let dropped = 0, unresolvedRows = 0, unresolvedTokens = 0;
  for (const issue of p.group_issues) {
    const fix = f[issue.row];
    if (fix?.drop) { dropped += 1; continue; }
    const left = issue.invalid_groups.filter((b) => !tokenFix(f, issue.row, b.token)).length;
    if (left > 0) { unresolvedRows += 1; unresolvedTokens += left; }
  }
  return { importable: p.valid_count - dropped, dropped, unresolvedRows, unresolvedTokens };
}

export const canCommit = (s: Summary, correctionCount = 0) =>
  s.importable > 0 && s.unresolvedRows === 0 && correctionCount <= MAX_CORRECTIONS;

/** Header row of the empty template (UTF-8 with BOM so Excel reads Persian text; no data rows). */
export const TEMPLATE_HEADER = ["first_name", "last_name", "personnel_code", "groups", "mobile"];
export function templateCsv(): Blob {
  return new Blob(["\ufeff" + TEMPLATE_HEADER.join(",") + "\r\n"], { type: "text/csv;charset=utf-8" });
}
