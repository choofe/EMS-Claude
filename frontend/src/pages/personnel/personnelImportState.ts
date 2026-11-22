import type { PersonnelCorrection, PersonnelFileConflict, PersonnelGroupIssue, PersonnelPreview, PersonnelSameNameInFile, PersonnelSameNameRow } from "../../api/types";
import { toPersianDigits } from "../../lib/dates";

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

/** The backend lists a repeated bad code (`XX;XX`) once per occurrence but corrects it by token, so the page works per DISTINCT token. */
export const distinctBad = (issue: PersonnelGroupIssue) =>
  issue.invalid_groups.filter((b, i, all) => all.findIndex((x) => x.token === b.token) === i);

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

/** Rows the manager dropped through a group decision, other than rows already dropped by a conflict choice. A drop
 *  stays a drop even when a repeated preview no longer lists the row as a group issue (the row is still in the file). */
export const droppedByFix = (f: Fixes, conflictRows: number[] = []): number[] =>
  Object.keys(f).map(Number).filter((row) => f[row].drop && !conflictRows.includes(row));

/**
 * The corrections list for the server: the rows dropped by conflict choices, the dropped group-decision rows, and the
 * token decisions of rows that still hold an invalid group code (the server re-validates every item).
 */
export function buildCorrections(p: PersonnelPreview, f: Fixes, conflictRows: number[] = []): PersonnelCorrection[] {
  const out: PersonnelCorrection[] = [...conflictRows, ...droppedByFix(f, conflictRows)].map((row) => ({ row, op: "drop" as const }));
  for (const issue of p.group_issues) {
    const fix = f[issue.row];
    if (!fix || fix.drop) continue;
    for (const bad of distinctBad(issue)) {
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
export function summarize(p: PersonnelPreview, f: Fixes, conflictRows: number[] = []): Summary {
  const dropped = droppedByFix(f, conflictRows).length;
  let unresolvedRows = 0, unresolvedTokens = 0;
  for (const issue of p.group_issues) {
    const fix = f[issue.row];
    if (fix?.drop) continue;
    const left = distinctBad(issue).filter((b) => !tokenFix(f, issue.row, b.token)).length;
    if (left > 0) { unresolvedRows += 1; unresolvedTokens += left; }
  }
  return { importable: p.valid_count - dropped, dropped, unresolvedRows, unresolvedTokens };
}

/** The commit waits for every group decision AND for every conflict cluster (the server refuses it otherwise). */
export const canCommit = (s: Summary, correctionCount = 0, openConflicts = 0) =>
  s.importable > 0 && s.unresolvedRows === 0 && openConflicts === 0 && correctionCount <= MAX_CORRECTIONS;

/**
 * The sample as the manager's decisions leave it: a dropped row disappears, and a replaced group code joins the
 * person's groups. (The preview is not repeated after a fix, so this is computed in the page.)
 */
export function sampleAfterFixes(p: PersonnelPreview, f: Fixes): PersonnelPreview["sample"] {
  const issues = new Map(p.group_issues.map((i) => [i.row, i]));
  return p.sample.filter((s) => !f[s.row]?.drop).map((s) => {
    const issue = issues.get(s.row);
    if (!issue) return s;
    const added = issue.invalid_groups.flatMap((b) => { const t = tokenFix(f, s.row, b.token); return t?.op === "replace" ? [t.to] : []; });
    return { ...s, group_codes: [...new Set([...s.group_codes, ...added])] };
  });
}

/** «نام‌خانوادگی (کد پرسنلی)»; the code alone when the last name is unknown (an absent key, never `null`). */
export function personLabel(lastName: string | null | undefined, code: string | number | null | undefined): string {
  const c = code === null || code === undefined || code === "" ? "" : toPersianDigits(String(code));
  if (lastName && c) return `${lastName} (${c})`;
  return lastName || c || "—";
}

/** The same-name notice as the manager's decisions leave it: a row he dropped (here or in the group decisions) leaves the
 *  COUNT but stays in the dialog, so the drop can be undone (the preview is not repeated after those decisions). */
export function sameNamesAfterFixes(p: PersonnelPreview, f: Fixes): { count: number; rows: PersonnelSameNameRow[]; incomplete: boolean } {
  const rows = p.same_names ?? [];
  const droppedRows = rows.filter((r) => f[r.row]?.drop).length;
  const total = p.same_name_count ?? 0;
  return { count: Math.max(0, total - droppedRows), rows, incomplete: total > rows.length };
}

/** The rows to drop when the manager keeps ONE row of a conflict cluster (`keep`) or none (`null`): every other row.
 *  The preview is then re-run with these rows (the server drops them BEFORE the analysis, so the kept row is valid). */
export function conflictDrops(current: number[], cluster: PersonnelFileConflict, keep: number | null): number[] {
  return [...new Set([...current, ...cluster.rows.map((r) => r.row).filter((row) => row !== keep)])];
}

/** The same-name-in-file warnings as the group decisions leave them: dropped rows leave, a group needs two rows. */
export function sameNamesInFileAfterFixes(p: PersonnelPreview, f: Fixes): PersonnelSameNameInFile[] {
  return (p.same_name_in_file ?? []).map((g) => ({ rows: g.rows.filter((r) => !f[r.row]?.drop) })).filter((g) => g.rows.length > 1);
}

/** Digits of `value` that differ from `other` at the same position (a mistyped mobile prefix is the usual error). */
export function differingPositions(value: string, other: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!other) return out;
  for (let i = 0; i < value.length; i++) if (value[i] !== other[i]) out.add(i);
  return out;
}
