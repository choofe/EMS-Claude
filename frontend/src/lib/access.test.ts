import { describe, expect, it } from "vitest";
import { canReport, landingPath } from "./access";
import { makeUser } from "../test/utils";

const as = (role_code: string) => makeUser({ role_code });

describe("landing page by role", () => {
  it("USER and EXPERT start at report entry; MANAGEMENT and AUDITOR keep the dashboard until the reports list exists (Phase 7)", () => {
    expect(landingPath(as("USER"))).toBe("/reports/new");
    expect(landingPath(as("EXPERT"))).toBe("/reports/new");
    expect(landingPath(as("MANAGEMENT"))).toBe("/");
    expect(landingPath(as("AUDITOR"))).toBe("/");
    expect(landingPath(null)).toBe("/equipment");
  });
  it("the auditor can never report", () => {
    expect(canReport(as("AUDITOR"))).toBe(false);
    expect(["USER", "EXPERT", "MANAGEMENT"].every((r) => canReport(as(r)))).toBe(true);
  });
});
