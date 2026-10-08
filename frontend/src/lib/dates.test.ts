import { describe, expect, it } from "vitest";
import { formatJalaliDate, formatJalaliDateTime, parseServerDate, toJalaliParts, toPersianDigits } from "./dates";

describe("jalali dates in Asia/Tehran", () => {
  it("switches year exactly at Tehran midnight (same fixtures as backend tests/test_jalali.py)", () => {
    expect(toJalaliParts("2026-03-20T20:29:59Z")).toEqual({ year: 1404, month: 12, day: 29, hour: 23, minute: 59 });
    expect(toJalaliParts("2026-03-20T20:30:00Z")).toEqual({ year: 1405, month: 1, day: 1, hour: 0, minute: 0 });
  });

  it("never renders midnight as hour 24", () => {
    expect(formatJalaliDateTime("2026-03-20T20:30:00Z")).toBe("۱۴۰۵/۰۱/۰۱ ۰۰:۰۰");
  });

  it("formats with Persian digits", () => {
    expect(formatJalaliDate("2026-03-21T12:00:00Z")).toBe("۱۴۰۵/۰۱/۰۱");
    expect(toPersianDigits("12:30 / 2026")).toBe("۱۲:۳۰ / ۲۰۲۶");
  });

  it("follows the historical DST offset (+04:30 in 2021, +03:30 since 2022)", () => {
    expect(toJalaliParts("2021-07-01T12:00:00Z")).toMatchObject({ hour: 16, minute: 30 });
    expect(toJalaliParts("2026-07-01T12:00:00Z")).toMatchObject({ hour: 15, minute: 30 });
  });

  it("treats a timestamp without a timezone designator as UTC, not browser-local", () => {
    expect(parseServerDate("2026-03-20T20:30:00").toISOString()).toBe("2026-03-20T20:30:00.000Z");
    expect(parseServerDate("2026-03-20T20:30:00+00:00").toISOString()).toBe("2026-03-20T20:30:00.000Z");
    expect(parseServerDate("2026-03-21T00:00:00+03:30").toISOString()).toBe("2026-03-20T20:30:00.000Z");
    expect(formatJalaliDateTime("2026-03-20T20:30:00")).toBe("۱۴۰۵/۰۱/۰۱ ۰۰:۰۰");
  });

  it("shows a dash for missing values and rejects garbage", () => {
    expect(formatJalaliDate(null)).toBe("—");
    expect(formatJalaliDateTime(undefined)).toBe("—");
    expect(() => parseServerDate("not a date")).toThrow(RangeError);
  });
});
