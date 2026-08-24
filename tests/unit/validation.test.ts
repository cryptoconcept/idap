import { describe, expect, it } from "vitest";
import { createLeadSchema } from "@/lib/validation/lead";
import { createApplicationSchema } from "@/lib/validation/application";
import { createApiClientSchema } from "@/lib/validation/api-client";
import { loginSchema } from "@/lib/validation/user";
import { createStaffSchema } from "@/lib/validation/staff";

const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);

describe("createLeadSchema", () => {
  it("accepts a minimal enquiry", () => {
    const parsed = createLeadSchema.parse({ studentName: "Rahul Kumar", phone: "9876543210" });
    expect(parsed.studentName).toBe("Rahul Kumar");
    expect(parsed.phone).toBe("9876543210");
  });

  it.each([
    ["+91 98765 43210", "9876543210"],
    ["+919876543210", "9876543210"],
    ["98765-43210", "9876543210"],
    ["(98765) 43210", "9876543210"],
  ])("normalises %s to %s", (input, expected) => {
    expect(createLeadSchema.parse({ studentName: "A", phone: input }).phone).toBe(expected);
  });

  it("rejects a missing phone number", () => {
    const result = createLeadSchema.safeParse({ studentName: "Rahul" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["phone"]);
  });

  it("rejects a student name that is only whitespace", () => {
    expect(createLeadSchema.safeParse({ studentName: "   ", phone: "9876543210" }).success).toBe(
      false,
    );
  });

  it("collapses whitespace and strips control characters", () => {
    const parsed = createLeadSchema.parse({
      studentName: "Rahul " + TAB + "  Kumar" + NEWLINE,
      phone: "9876543210",
    });
    expect(parsed.studentName).toBe("Rahul Kumar");
  });

  it("turns an empty optional string into undefined rather than storing it", () => {
    const parsed = createLeadSchema.parse({
      studentName: "Rahul",
      phone: "9876543210",
      email: "",
      classInterested: "",
    });
    expect(parsed.email).toBeUndefined();
    expect(parsed.classInterested).toBeUndefined();
  });

  it("rejects a malformed email", () => {
    expect(
      createLeadSchema.safeParse({ studentName: "A", phone: "9876543210", email: "not-an-email" })
        .success,
    ).toBe(false);
  });

  it("drops unknown keys, which is what stops mass assignment", () => {
    const parsed = createLeadSchema.parse({
      studentName: "Rahul",
      phone: "9876543210",
      institutionId: "INS9999",
      status: "ADMITTED",
      leadNumber: "FORGED-0001",
      _id: "6a8880f3446c577c470cd06c",
    }) as Record<string, unknown>;

    expect(parsed.institutionId).toBeUndefined();
    expect(parsed.status).toBeUndefined();
    expect(parsed.leadNumber).toBeUndefined();
    expect(parsed._id).toBeUndefined();
  });
});

describe("createApplicationSchema", () => {
  const valid = {
    academicYear: "2026-27",
    student: { firstName: "Rahul", lastName: "Kumar" },
    parent: { phone: "9876543210" },
    admission: { applyingFor: "Grade 5" },
  };

  it("accepts the documented minimum", () => {
    const parsed = createApplicationSchema.parse(valid);
    expect(parsed.academicYear).toBe("2026-27");
    expect(parsed.admission.applyingFor).toBe("Grade 5");
    expect(parsed.documents).toEqual([]);
  });

  it.each(["2026-27", "2026-2027", "2026 - 27"])("accepts academic year %s", (year) => {
    expect(createApplicationSchema.safeParse({ ...valid, academicYear: year }).success).toBe(true);
  });

  it.each(["2026", "26-27", "next year", ""])("rejects academic year %s", (year) => {
    expect(createApplicationSchema.safeParse({ ...valid, academicYear: year }).success).toBe(false);
  });

  it("parses a date of birth into a Date", () => {
    const parsed = createApplicationSchema.parse({
      ...valid,
      student: { ...valid.student, dateOfBirth: "2016-05-10" },
    });
    expect(parsed.student.dateOfBirth).toBeInstanceOf(Date);
    expect((parsed.student.dateOfBirth as Date).getUTCFullYear()).toBe(2016);
  });

  it("requires a parent phone number", () => {
    expect(createApplicationSchema.safeParse({ ...valid, parent: {} }).success).toBe(false);
  });

  it("bounds previous percentage to 0-100", () => {
    expect(
      createApplicationSchema.safeParse({ ...valid, academic: { previousPercentage: 101 } }).success,
    ).toBe(false);
    expect(
      createApplicationSchema.safeParse({ ...valid, academic: { previousPercentage: 82 } }).success,
    ).toBe(true);
  });

  it("caps the number of attached documents", () => {
    const documents = Array.from({ length: 21 }, () => ({
      documentType: "OTHER" as const,
      fileName: "f.pdf",
      fileUrl: "https://example.test/f.pdf",
    }));
    expect(createApplicationSchema.safeParse({ ...valid, documents }).success).toBe(false);
  });

  it("ignores a caller-supplied status, number or institution", () => {
    const parsed = createApplicationSchema.parse({
      ...valid,
      status: "APPROVED",
      applicationNumber: "INS9999-APP-000001",
      institutionId: "INS9999",
    }) as Record<string, unknown>;

    expect(parsed.status).toBeUndefined();
    expect(parsed.applicationNumber).toBeUndefined();
    expect(parsed.institutionId).toBeUndefined();
  });
});

describe("createApiClientSchema", () => {
  it("requires at least one permission", () => {
    expect(createApiClientSchema.safeParse({ name: "Site", permissions: [] }).success).toBe(false);
  });

  it("rejects an unknown permission", () => {
    expect(
      createApiClientSchema.safeParse({ name: "Site", permissions: ["DELETE_EVERYTHING"] }).success,
    ).toBe(false);
  });

  it("no longer accepts a caller-chosen institution", () => {
    // The route derives it from the session; leaving it parseable would mislead.
    const parsed = createApiClientSchema.parse({
      name: "Site",
      permissions: ["CREATE_LEAD"],
      institutionId: "INS9999",
    }) as Record<string, unknown>;
    expect(parsed.institutionId).toBeUndefined();
  });
});

describe("createStaffSchema", () => {
  it("rejects a password under 10 characters", () => {
    // 9 characters — long enough to have passed the old 8-character floor,
    // short enough to be rejected by the current 10-character one. A shorter
    // fixture would fail either floor and wouldn't prove which one is enforced.
    const result = createStaffSchema.safeParse({
      name: "Priya Counselor",
      email: "priya@infinityschool.edu.in",
      password: "Shortpw12",
      role: "COUNSELOR",
    });
    expect(result.success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("lowercases and trims the email", () => {
    expect(loginSchema.parse({ email: "  Admin@Example.TEST ", password: "x" }).email).toBe(
      "admin@example.test",
    );
  });

  it("rejects an empty password", () => {
    expect(loginSchema.safeParse({ email: "a@b.test", password: "" }).success).toBe(false);
  });
});
