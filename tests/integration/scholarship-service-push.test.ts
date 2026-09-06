import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestDatabase, stopTestDatabase, clearDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { ScholarshipService } from "@/services/scholarship.service";
import { ScholarshipPublishService } from "@/services/scholarship-publish.service";

beforeAll(() => startTestDatabase("scholarship-service-push"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});

describe("ScholarshipService push hooks", () => {
  it("setStatus(publish) calls the publish service; setStatus(unpublish) calls pushClose", async () => {
    const publish = vi.spyOn(ScholarshipPublishService, "publish").mockResolvedValue(undefined as never);
    const pushClose = vi.spyOn(ScholarshipPublishService, "pushClose").mockResolvedValue(undefined as never);
    // create a complete, publishable scholarship for INS0001 (seed institution/unit as the crud test does)
    const created = await ScholarshipService.create("INS0001", { name: "Infinity Merit", /* + structured fields to pass the gate */ } as never, { id: "u1", name: "Admin" });
    await ScholarshipService.setStatus("INS0001", created.id, "publish", { id: "u1", name: "Admin" });
    expect(publish).toHaveBeenCalledWith("INS0001", created.id, expect.anything());
    await ScholarshipService.setStatus("INS0001", created.id, "unpublish", { id: "u1", name: "Admin" });
    expect(pushClose).toHaveBeenCalled();
  });
});
