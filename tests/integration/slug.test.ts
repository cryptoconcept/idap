import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Institution } from "@/models";
import { claimSlug, slugify, RESERVED_SLUGS } from "@/services/slug.service";

describe("slug allocation", () => {
  beforeAll(async () => {
    await startTestDatabase("slugs");
    await Institution.syncIndexes();
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("builds a readable slug from name and locality", () => {
    expect(slugify("Sri Vivekananda School, Hanur")).toBe("sri-vivekananda-school-hanur");
    expect(slugify("  St. Joseph's   PU College  ")).toBe("st-josephs-pu-college");
    expect(slugify("A&B Public School (Main)")).toBe("a-b-public-school-main");
  });

  it("claims the plain slug when it is free", async () => {
    await makeInstitution("INS0001");
    expect(await claimSlug("INS0001", "green-valley-school")).toBe("green-valley-school");
  });

  it("suffixes rather than collides when the name is taken", async () => {
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
    await claimSlug("INS0001", "green-valley-school");

    expect(await claimSlug("INS0002", "green-valley-school")).toBe("green-valley-school-2");
  });

  it("survives two institutions claiming the same base at once", async () => {
    // The unique index is the lock. A read-then-write would hand both the
    // same slug and one of the writes would fail.
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
    await makeInstitution("INS0003");

    const claimed = await Promise.all([
      claimSlug("INS0001", "shared-name"),
      claimSlug("INS0002", "shared-name"),
      claimSlug("INS0003", "shared-name"),
    ]);

    expect(new Set(claimed).size).toBe(3);
    expect(claimed).toContain("shared-name");
  });

  it("refuses a reserved word", async () => {
    await makeInstitution("INS0001");
    const claimed = await claimSlug("INS0001", "admin");
    expect(RESERVED_SLUGS).toContain("admin");
    expect(claimed).not.toBe("admin");
  });

  it("does not move an existing slug when the institution is renamed", async () => {
    // Consumers hold URLs pointing at the slug. Renaming a school must not
    // silently break every one of them.
    await makeInstitution("INS0001");
    const first = await claimSlug("INS0001", "old-name-school");
    const second = await claimSlug("INS0001", "new-name-school");

    expect(second).toBe(first);
  });
});
