import { beforeEach, describe, expect, it } from "vitest";
import { clearAllFor, clearLocal, clearUndo, loadLocal, loadUndo, makeSnapshot, purgeOtherUsers, saveLocal, saveUndo } from "./localDraft";
import { emptyState } from "../pages/report/reportForm";

beforeEach(() => localStorage.clear());
const form = (text: string) => ({ ...emptyState(new Date("2026-03-21T11:00:00Z")), description: text, typeId: 5 as const,
  labor: [{ key: "old-key", userId: 3, name: "سعید", hours: "1", minutes: "30" }] });

describe("local working copy", () => {
  it("round-trips the form with its timestamp and the server version it was based on; rows get fresh keys", () => {
    saveLocal(makeSnapshot(2, form("متن"), { draftId: 4, version: 7 }, new Date("2026-03-21T12:00:00Z")));
    const back = loadLocal(2)!;
    expect(back).toMatchObject({ v: 1, userId: 2, baseDraftId: 4, baseVersion: 7, savedAt: "2026-03-21T12:00:00.000Z" });
    expect(back.form.description).toBe("متن");
    expect(back.form.labor[0]).toMatchObject({ userId: 3, name: "سعید", hours: "1", minutes: "30" });
    expect(back.form.labor[0].key).not.toBe("old-key");
  });
  it("is private to the user id and ignores corrupt or foreign data", () => {
    saveLocal(makeSnapshot(2, form("a"), { draftId: null, version: null }));
    expect(loadLocal(3)).toBeNull();
    localStorage.setItem("ems.reportForm.2", "{not json");
    expect(loadLocal(2)).toBeNull();
    localStorage.setItem("ems.reportForm.2", JSON.stringify({ v: 2, userId: 2 }));
    expect(loadLocal(2)).toBeNull();
  });
  it("clear removes the copy; undo is a separate slot", () => {
    saveLocal(makeSnapshot(2, form("now"), { draftId: null, version: null }));
    saveUndo(makeSnapshot(2, form("replaced"), { draftId: null, version: null }));
    expect(loadUndo(2)!.form.description).toBe("replaced");
    clearLocal(2);
    expect(loadLocal(2)).toBeNull();
    expect(loadUndo(2)).not.toBeNull();
    clearUndo(2);
    expect(loadUndo(2)).toBeNull();
    saveLocal(makeSnapshot(2, form("x"), { draftId: null, version: null }));
    saveUndo(makeSnapshot(2, form("y"), { draftId: null, version: null }));
    clearAllFor(2);
    expect(loadLocal(2)).toBeNull();
    expect(loadUndo(2)).toBeNull();
  });
  it("signing in as another user deletes every other user's copies (main and undo), keeps the signed-in user's", () => {
    for (const id of [2, 3, 12]) {
      saveLocal(makeSnapshot(id, form("u" + id), { draftId: null, version: null }));
      saveUndo(makeSnapshot(id, form("undo" + id), { draftId: null, version: null }));
    }
    localStorage.setItem("unrelated", "keep");
    purgeOtherUsers(3);
    expect(loadLocal(3)).not.toBeNull();
    expect(loadUndo(3)).not.toBeNull();
    for (const id of [2, 12]) { expect(loadLocal(id)).toBeNull(); expect(loadUndo(id)).toBeNull(); }
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });
});
