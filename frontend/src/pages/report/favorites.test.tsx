import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FavoritesToast, TOAST_MS, TOAST_UNDO_MS, type FavoritesController, type Toast } from "./favorites";

const person = { id: 3, full_name: "سعید احمدی" };
function setup(toasts: Toast[]) {
  const ctrl = { toasts, dismissToast: vi.fn(), undo: vi.fn() } as unknown as FavoritesController;
  render(<FavoritesToast ctrl={ctrl} />);
  return ctrl;
}

describe("favorites messages", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders nothing when there is no message", () => {
    setup([]);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("shows the messages in the given order (newest first), each with its own close button", () => {
    setup([{ id: 2, text: "دوم", severity: "info" }, { id: 1, text: "اول", severity: "error" }]);
    const alerts = within(screen.getByRole("region", { name: "پیام‌های ستاره‌دارها" })).getAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual([expect.stringContaining("دوم"), expect.stringContaining("اول")]);
    expect(screen.getAllByRole("button", { name: "بستن پیام" })).toHaveLength(2); // also on the one that has no action of its own
  });

  it("the close button closes exactly its own message", async () => {
    vi.useRealTimers();
    const ctrl = setup([{ id: 2, text: "دوم", severity: "info" }, { id: 1, text: "اول", severity: "info" }]);
    await userEvent.click(within(screen.getAllByRole("alert")[1]).getByRole("button", { name: "بستن پیام" }));
    expect(ctrl.dismissToast).toHaveBeenCalledTimes(1);
    expect(ctrl.dismissToast).toHaveBeenCalledWith(1);
  });

  it("«بازگردانی» undoes the person of ITS message", async () => {
    vi.useRealTimers();
    const older = { id: 1, text: "اول", severity: "info" as const, undo: person };
    const ctrl = setup([{ id: 2, text: "دوم", severity: "info", undo: { id: 4, full_name: "رضا کریمی" } }, older]);
    await userEvent.click(within(screen.getAllByRole("alert")[1]).getByRole("button", { name: "بازگردانی" }));
    expect(ctrl.undo).toHaveBeenCalledWith(1, person);
  });

  it("a plain message leaves after its time, a message with undo a little later", () => {
    const ctrl = setup([{ id: 2, text: "با بازگردانی", severity: "info", undo: person }, { id: 1, text: "ساده", severity: "error" }]);
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1); });
    expect(ctrl.dismissToast).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(ctrl.dismissToast).toHaveBeenCalledTimes(1);
    expect(ctrl.dismissToast).toHaveBeenCalledWith(1);
    act(() => { vi.advanceTimersByTime(TOAST_UNDO_MS - TOAST_MS); });
    expect(ctrl.dismissToast).toHaveBeenCalledTimes(2);
    expect(ctrl.dismissToast).toHaveBeenLastCalledWith(2);
    expect(TOAST_UNDO_MS).toBeLessThanOrEqual(6000); // Amin 2026-11-02: at most one second shorter than the first version (7 s / 6 s)
    expect(TOAST_MS).toBeLessThanOrEqual(5000);
  });
});
