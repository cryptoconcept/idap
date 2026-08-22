import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { ApplicationService } from "@/services/application.service";
import { createApplicationSchema } from "@/lib/validation/application";
import type { DocumentType } from "@/lib/constants";

// A one-pixel PNG, so the magic-number check sees a genuine image.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const applicationInput = createApplicationSchema.parse({
  academicYear: "2026-27",
  student: { firstName: "Rahul", lastName: "Kumar" },
  parent: { phone: "9876543210" },
  admission: { applyingFor: "Grade 5" },
});

function upload(name: string, type: string, bytes: Buffer) {
  return { name, type, size: bytes.byteLength, bytes };
}

describe("document uploads", () => {
  let uploadDir: string;
  let DocumentService: typeof import("@/services/document.service").DocumentService;

  beforeAll(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), "aem-uploads-"));
    process.env.UPLOAD_DIR = uploadDir;
    await startTestDatabase("documents");
    // Imported after UPLOAD_DIR is set: the local adapter resolves its root once.
    ({ DocumentService } = await import("@/services/document.service"));
  });

  afterAll(async () => {
    await stopTestDatabase();
    await rm(uploadDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await clearDatabase();
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
  });

  async function createApplication(institutionId = "INS0001") {
    return ApplicationService.createApplication({
      institutionId,
      data: applicationInput,
      source: "API",
    });
  }

  it("stores a file and reads exactly the same bytes back", async () => {
    const application = await createApplication();
    const document = await DocumentService.upload({
      institutionId: "INS0001",
      applicationId: application.id,
      documentType: "PHOTO",
      file: upload("photo.png", "image/png", PNG),
    });

    const read = await DocumentService.read("INS0001", document.id);
    expect(read.body.equals(PNG)).toBe(true);
    expect(read.contentType).toBe("image/png");
  });

  it("persists the handle the adapter returned, not the path we asked for", async () => {
    // An adapter may key storage differently — Blob returns a URL — so the
    // read has to go through whatever `put` handed back.
    const application = await createApplication();
    const document = await DocumentService.upload({
      institutionId: "INS0001",
      applicationId: application.id,
      documentType: "MARKSHEET",
      file: upload("marks.pdf", "application/pdf", Buffer.from("%PDF-1.4 marks")),
    });

    await expect(DocumentService.read("INS0001", document.id)).resolves.toMatchObject({
      contentType: "application/pdf",
    });
  });

  it("keeps the visitor's filename for display but never for storage", async () => {
    const application = await createApplication();
    const document = await DocumentService.upload({
      institutionId: "INS0001",
      applicationId: application.id,
      documentType: "PHOTO",
      file: upload("../../etc/passwd.png", "image/png", PNG),
    });

    const read = await DocumentService.read("INS0001", document.id);
    expect(read.fileName).toBe("../../etc/passwd.png");
    // The stored object is keyed by a generated id, so the traversal is inert.
    const listed = await DocumentService.listForApplication("INS0001", application.id);
    expect(listed[0].fileUrl).toMatch(/^\/api\/documents\/[0-9a-f]{24}$/);
  });

  it("refuses a read from another institution", async () => {
    const application = await createApplication();
    const document = await DocumentService.upload({
      institutionId: "INS0001",
      applicationId: application.id,
      documentType: "PHOTO",
      file: upload("photo.png", "image/png", PNG),
    });

    await expect(DocumentService.read("INS0002", document.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses to attach to another institution's application", async () => {
    const application = await createApplication("INS0002");
    await expect(
      DocumentService.upload({
        institutionId: "INS0001",
        applicationId: application.id,
        documentType: "PHOTO",
        file: upload("photo.png", "image/png", PNG),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a file whose contents contradict its declared type", async () => {
    const application = await createApplication();
    await expect(
      DocumentService.upload({
        institutionId: "INS0001",
        applicationId: application.id,
        documentType: "PHOTO",
        file: upload("shell.png", "image/png", Buffer.from("#!/bin/sh\necho pwned\n")),
      }),
    ).rejects.toThrow(/do not match the declared file type/i);
  });

  it("shows the document on the application it was attached to", async () => {
    const application = await createApplication();
    for (const type of ["PHOTO", "BIRTH_CERTIFICATE"] as DocumentType[]) {
      await DocumentService.upload({
        institutionId: "INS0001",
        applicationId: application.id,
        documentType: type,
        file: upload("f.png", "image/png", PNG),
      });
    }

    const reloaded = await ApplicationService.getApplication(
      { institutionId: "INS0001" },
      application.applicationNumber,
    );
    expect(reloaded.documents).toHaveLength(2);
    expect(reloaded.documents.map((d) => d.documentType).sort()).toEqual([
      "BIRTH_CERTIFICATE",
      "PHOTO",
    ]);
  });

  it("rejects a document id that is not an object id", async () => {
    await expect(DocumentService.read("INS0001", "../../../etc/passwd")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
