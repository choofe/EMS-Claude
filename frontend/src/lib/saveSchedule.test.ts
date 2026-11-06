import { describe, expect, it } from "vitest";
import { changedChars, dueForSave, SAVE_STEPS, stepAt } from "./saveSchedule";

describe("changedChars", () => {
  it("counts insertions, deletions and replacements, not the unchanged ends", () => {
    expect(changedChars("", "سلام")).toBe(4);
    expect(changedChars("سلام", "")).toBe(4);
    expect(changedChars("abcdef", "abcdef")).toBe(0);
    expect(changedChars("abcdef", "abXXdef")).toBe(2); // 'c' -> 'XX'
    expect(changedChars("start end", "start middle end")).toBe(7);
    expect(changedChars("abc", "xyz")).toBe(3);
  });
});

describe("save schedule: thresholds shrink with every save down to a floor", () => {
  it("steps are 100/25 s, 70/20 s, 45/15 s, then 20/10 s forever", () => {
    expect(SAVE_STEPS.map((s) => [s.chars, s.ms / 1000])).toEqual([[100, 25], [70, 20], [45, 15], [20, 10]]);
    expect(stepAt(0).chars).toBe(100);
    expect(stepAt(3).chars).toBe(20);
    expect(stepAt(50).chars).toBe(20);
  });
  const base = { savedText: "", text: "", dirtySince: 0 as number | null, now: 0, savesDone: 0 };
  it("nothing is due when nothing changed since the last save", () => {
    expect(dueForSave({ ...base, dirtySince: null, now: 999_999 })).toBe(false);
  });
  it("first save: 100 changed characters, or 25 s after typing started — whichever comes first", () => {
    expect(dueForSave({ ...base, text: "x".repeat(99), now: 10_000 })).toBe(false);
    expect(dueForSave({ ...base, text: "x".repeat(100), now: 1_000 })).toBe(true);
    expect(dueForSave({ ...base, text: "short", now: 24_999 })).toBe(false);
    expect(dueForSave({ ...base, text: "short", now: 25_000 })).toBe(true); // a short note still gets saved after the time limit
  });
  it("later saves ask for less", () => {
    expect(dueForSave({ ...base, savesDone: 1, text: "x".repeat(70), now: 1 })).toBe(true);
    expect(dueForSave({ ...base, savesDone: 1, text: "x".repeat(69), now: 19_999 })).toBe(false);
    expect(dueForSave({ ...base, savesDone: 9, text: "x".repeat(20), now: 1 })).toBe(true);
    expect(dueForSave({ ...base, savesDone: 9, text: "x".repeat(19), now: 10_000 })).toBe(true); // floor: 10 s
    expect(dueForSave({ ...base, savesDone: 9, text: "x".repeat(19), now: 9_999 })).toBe(false);
  });
  it("is measured against the text that was last saved, not against empty", () => {
    expect(dueForSave({ ...base, savesDone: 3, savedText: "x".repeat(300), text: "x".repeat(310), now: 1 })).toBe(false);
    expect(dueForSave({ ...base, savesDone: 3, savedText: "x".repeat(300), text: "x".repeat(300) + "y".repeat(20), now: 1 })).toBe(true);
  });
});
