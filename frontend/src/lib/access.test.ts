import { describe, expect, it } from "vitest";
import { canReport, landingPath } from "./access";
import { makeUser } from "../test/utils";

const as = (role_code: string) => makeUser({ role_code });

describe("landing page by role", () => {
  it("every signed-in role lands on the reports list (the backend scope decides what it shows); nobody: equipment", () => {
    for (const r of ["USER", "EXPERT", "MANAGEMENT", "AUDITOR"]) expect(landingPath(as(r))).toBe("/reports");
    expect(landingPath(null)).toBe("/equipment");
  });
  it("the auditor can never report", () => {
    expect(canReport(as("AUDITOR"))).toBe(false);
    expect(["USER", "EXPERT", "MANAGEMENT"].every((r) => canReport(as(r)))).toBe(true);
  });
});
