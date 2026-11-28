import { describe, expect, it } from "vitest";
import { RANDOM_ALPHABET, derivedPassword, generateRandomPassword, isTooSimple, mobilePassword, normalizeCode, normalizeMobile } from "./passwordMethods";

describe("password methods (Pk)", () => {
  it("normalises a mobile number like the server does", () => {
    expect(normalizeMobile("09121234567")).toBe("09121234567");
    expect(normalizeMobile("۰۹۱۲۱۲۳۴۵۶۷")).toBe("09121234567");
    expect(normalizeMobile("+98 912 123 4567")).toBe("09121234567");
    expect(normalizeMobile("00989121234567")).toBe("09121234567");
    expect(normalizeMobile("9121234567")).toBe("09121234567");
    expect(normalizeMobile("0912123456")).toBeNull();
    expect(normalizeMobile("0812123456x")).toBeNull();
    expect(normalizeMobile("")).toBeNull();
    expect(normalizeMobile(null)).toBeNull();
  });

  it("accepts a personnel code from 1 to 9999 without a leading zero", () => {
    expect(normalizeCode("۱۳۲")).toBe(132);
    expect(normalizeCode(7)).toBe(7);
    expect(normalizeCode("0123")).toBeNull();
    expect(normalizeCode("10000")).toBeNull();
    expect(normalizeCode("0")).toBeNull();
    expect(normalizeCode("")).toBeNull();
  });

  it("mirrors the server's «too simple» rule", () => {
    expect(isTooSimple("aaaaaaaa")).toBe(true);
    expect(isTooSimple("12345678")).toBe(true);
    expect(isTooSimple("87654321")).toBe(true);
    expect(isTooSimple("abcdefgh")).toBe(true);
    expect(isTooSimple("12345679")).toBe(false);
    expect(isTooSimple("")).toBe(false);
  });

  it("builds the derived password: last four digits of the mobile replaced by the padded code", () => {
    expect(derivedPassword("09121234567", 7)).toBe("09121230007");
    expect(derivedPassword("۰۹۱۲۱۲۳۴۵۶۷", "۱۳۲")).toBe("09121230132");
    expect(derivedPassword("09121234567", 9999)).toBe("09121239999");
    expect(derivedPassword("09121234567", null)).toBeNull();
    expect(derivedPassword(null, 12)).toBeNull();
    expect(derivedPassword("09121234567", "0123")).toBeNull();
  });

  it("offers the mobile number only when it is a valid number", () => {
    expect(mobilePassword("09121234567")).toBe("09121234567");
    expect(mobilePassword("123")).toBeNull();
    expect(mobilePassword(null)).toBeNull();
  });

  it("generates 8–10 characters from the alphabet without look-alikes", () => {
    for (let i = 0; i < 300; i++) {
      const p = generateRandomPassword();
      expect(p.length).toBeGreaterThanOrEqual(8);
      expect(p.length).toBeLessThanOrEqual(10);
      for (const c of p) expect(RANDOM_ALPHABET).toContain(c);
      expect(p).not.toMatch(/[01oli]/);
      expect(isTooSimple(p)).toBe(false);
    }
    expect(RANDOM_ALPHABET).toHaveLength(31);
  });
});
