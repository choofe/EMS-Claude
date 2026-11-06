import { describe, expect, it } from "vitest";
import { dateTimeFromTexts, jalaliToDate, normalizeDigits, parseJalaliDateText, parseTimeText, textsFromDate } from "./jalali";
import { formatMinutes, splitMinutes, toMinutes } from "./labor";

describe("jalali input conversion (browser TZ is America/Los_Angeles in tests)", () => {
  it("converts known dates: 1 Farvardin 1405 = 2026-03-21, 14:30 Tehran = 11:00 UTC", () => {
    expect(jalaliToDate({ year: 1405, month: 1, day: 1, hour: 14, minute: 30 })?.toISOString()).toBe("2026-03-21T11:00:00.000Z");
    expect(jalaliToDate({ year: 1404, month: 12, day: 29, hour: 0, minute: 0 })?.toISOString()).toBe("2026-03-19T20:30:00.000Z");
    expect(jalaliToDate({ year: 1405, month: 7, day: 25, hour: 9, minute: 5 })?.toISOString()).toBe("2026-10-17T05:35:00.000Z");
  });

  it("round-trips through the display formatter for every day of a year, including both ends of the leap-year rule", () => {
    for (const year of [1403, 1404, 1405]) {
      for (let month = 1; month <= 12; month++) {
        const last = month <= 6 ? 31 : month <= 11 ? 30 : null;
        for (let day = 1; day <= (last ?? 29); day++) {
          const d = jalaliToDate({ year, month, day, hour: 23, minute: 59 });
          expect(d, `${year}/${month}/${day}`).not.toBeNull();
          expect(textsFromDate(d!)).toEqual({ dateText: `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`, timeText: "23:59" });
        }
      }
    }
  });

  it("knows which Esfand 30 exists (1403 is a leap year, 1404 is not)", () => {
    expect(jalaliToDate({ year: 1403, month: 12, day: 30, hour: 12, minute: 0 })).not.toBeNull();
    expect(jalaliToDate({ year: 1404, month: 12, day: 30, hour: 12, minute: 0 })).toBeNull();
  });

  it("rejects impossible dates and times", () => {
    const base = { year: 1405, month: 1, day: 1, hour: 10, minute: 0 };
    expect(jalaliToDate({ ...base, month: 7, day: 31 })).toBeNull(); // Mehr has 30 days
    expect(jalaliToDate({ ...base, month: 13 })).toBeNull();
    expect(jalaliToDate({ ...base, day: 0 })).toBeNull();
    expect(jalaliToDate({ ...base, hour: 24 })).toBeNull();
    expect(jalaliToDate({ ...base, minute: 60 })).toBeNull();
    expect(jalaliToDate({ ...base, year: 1405.5 })).toBeNull();
  });

  it("uses the Tehran offset valid on that date (DST was abolished in 2022; 1401 summer was +04:30)", () => {
    expect(jalaliToDate({ year: 1401, month: 4, day: 1, hour: 12, minute: 0 })?.toISOString()).toBe("2022-06-22T07:30:00.000Z");
    expect(jalaliToDate({ year: 1402, month: 4, day: 1, hour: 12, minute: 0 })?.toISOString()).toBe("2023-06-22T08:30:00.000Z");
  });

  it("parses Persian, Arabic-Indic and ASCII digits with / - . separators", () => {
    expect(normalizeDigits("۱۴۰۵/٠٧/25")).toBe("1405/07/25");
    expect(parseJalaliDateText("۱۴۰۵/۰۷/۲۵")).toEqual({ year: 1405, month: 7, day: 25 });
    expect(parseJalaliDateText("1405-7-5")).toEqual({ year: 1405, month: 7, day: 5 });
    expect(parseJalaliDateText("05/07/25")).toBeNull();
    expect(parseTimeText("۱۴:۳۰")).toEqual({ hour: 14, minute: 30 });
    expect(parseTimeText("9:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeText("9:5")).toBeNull();
    expect(dateTimeFromTexts("۱۴۰۵/۰۱/۰۱", "۱۴:۳۰")?.toISOString()).toBe("2026-03-21T11:00:00.000Z");
    expect(dateTimeFromTexts("1405/01/01", "")).toBeNull();
  });
});

describe("labor helpers", () => {
  it("converts hours+minutes boxes to minutes", () => {
    expect(toMinutes("2", "30")).toBe(150);
    expect(toMinutes("", "45")).toBe(45);
    expect(toMinutes("۱", "")).toBe(60);
    expect(toMinutes("", "")).toBe(0);
    expect(toMinutes("1.5", "0")).toBeNull(); // no decimals: the unit is explicit
    expect(toMinutes("abc", "0")).toBeNull();
    expect(toMinutes("-1", "0")).toBeNull();
  });
  it("formats and splits", () => {
    expect(formatMinutes(150)).toBe("۲ ساعت و ۳۰ دقیقه");
    expect(formatMinutes(60)).toBe("۱ ساعت");
    expect(formatMinutes(30)).toBe("۳۰ دقیقه");
    expect(splitMinutes(90)).toEqual({ hours: "1", minutes: "30" });
  });
});
