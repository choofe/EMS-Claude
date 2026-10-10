import { describe, expect, it } from "vitest";
import { ApiError } from "../api/http";
import { errorMessage } from "./messages";

describe("errorMessage", () => {
  it("maps known codes to Persian", () => {
    expect(errorMessage(new ApiError(401, "invalid_credentials"))).toContain("نام کاربری یا رمز عبور");
    expect(errorMessage(new ApiError(409, "last_management"))).toContain("مدیر فعال");
  });
  it("joins password-policy errors", () => {
    const msg = errorMessage(new ApiError(422, "password_policy", { code: "password_policy", errors: ["too_short", "too_common"] }));
    expect(msg).toContain("کوتاه‌تر");
    expect(msg).toContain("رایج");
  });
  it("includes structured details with Persian digits", () => {
    expect(errorMessage(new ApiError(409, "group_has_active_equipment", { count: 3 }))).toContain("۳ تجهیز فعال");
    const range = errorMessage(new ApiError(422, "setting_out_of_range", { minimum: 0, maximum: 720, special: [-1] }));
    expect(range).toContain("۰");
    expect(range).toContain("۷۲۰");
    expect(range).toContain("-۱");
  });
  it("rate-limit message uses Retry-After in minutes", () => {
    expect(errorMessage(new ApiError(429, "too_many_attempts", {}, 600))).toContain("۱۰ دقیقه");
    expect(errorMessage(new ApiError(429, "too_many_attempts"))).toContain("کمی بعد");
  });
  it("falls back safely for unknown codes and non-API errors", () => {
    expect(errorMessage(new ApiError(500, "weird_code"))).toContain("weird_code");
    expect(errorMessage(new Error("x"))).toContain("پیش‌بینی‌نشده");
    expect(errorMessage(null)).toContain("پیش‌بینی‌نشده");
  });
});
