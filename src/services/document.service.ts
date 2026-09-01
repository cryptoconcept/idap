import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Application, DocumentRecord } from "@/models";
import { ActivityService } from "./activity.service";
import { storage } from "@/lib/storage";
import { notFound, validationError } from "@/lib/api/errors";
import { requiredIso } from "@/lib/utils/serialize";
import type { DocumentType } from "@/lib/constants";

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_SIZE_BYTES = MAX_DOCUMENT_BYTES;

/** Only formats an admissions office actually needs, and never anything executable. */
const ALLOWED_MIME: Record<string, string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
};

/**
 * Upload guard: extension and MIME type must agree, size is bounded, and the
 * stored filename is always generated rather than taken from the client.
 */
export function validateUpload(file: { name: string; type: string; size: number }): {
  safeFileName: string;
  extension: string;
} {
  const extensions = ALLOWED_MIME[file.type];
  if (!extensions) {
    throw validationError("file: only JPG, PNG, WEBP and PDF files can be uploaded");
  }

  const lower = file.name.toLowerCase();
  const extension = extensions.find((candidate) => lower.endsWith(candidate));
  if (!extension) {
    throw validationError("file: the file extension does not match its content type");
  }
  if (file.size <= 0) {
    throw validationError("file: the file is empty");
  }
  if (file.size > MAX_SIZE_BYTES) {
    throw validationError("file: files must be 5 MB or smaller");
  }

  return { safeFileName: `${new Types.ObjectId().toHexString()}${extension}`, extension };
}

/** Magic-number check so a renamed executable cannot pose as an allowed type. */
function sniffMatchesDeclaredType(bytes: Buffer, contentType: string): boolean {
  if (bytes.byteLength < 4) return false;
  if (contentType === "application/pdf") return bytes.subarray(0, 4).toString("latin1") === "%PDF";
  if (contentType === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (contentType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/webp") {
    return (
      bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP"
    );
  }
  return false;
}

export const DocumentService = {
  validateUpload,

  /** Stores an uploaded file and records it against the application. */
  async upload(input: {
    institutionId: string;
    applicationId: string;
    documentType: DocumentType;
    file: { name: string; type: string; size: number; bytes: Buffer };
    actor?: { id?: string; name?: string };
  }) {
    const { safeFileName } = validateUpload(input.file);

    if (!sniffMatchesDeclaredType(input.file.bytes, input.file.type)) {
      throw validationError("file: the file contents do not match the declared file type");
    }

    await connectToDatabase();
    const application = await Application.findOne({
      _id: new Types.ObjectId(input.applicationId),
      institutionId: input.institutionId,
    })
      .select("_id applicationNumber")
      .lean();
    if (!application) throw notFound("Application not found");

    // Keyed by tenant so a storage bucket stays browsable per institution.
    const path = `${input.institutionId}/${application.applicationNumber}/${safeFileName}`;
    // The adapter decides the read handle; Blob returns a URL rather than the
    // path it was given, so persist what it hands back.
    const stored = await storage.put({
      key: path,
      body: input.file.bytes,
      contentType: input.file.type,
    });

    const documentId = new Types.ObjectId();
    const fileUrl = `/api/documents/${documentId.toHexString()}`;
    const uploadedAt = new Date();

    await DocumentRecord.create({
      _id: documentId,
      applicationId: application._id,
      institutionId: input.institutionId,
      documentType: input.documentType,
      fileName: safeFileName,
      originalFileName: input.file.name,
      storageKey: stored.key,
      fileUrl,
      mimeType: input.file.type,
      sizeBytes: input.file.size,
      uploadedAt,
    });

    await Application.updateOne(
      { _id: application._id },
      {
        $push: {
          documents: {
            documentType: input.documentType,
            fileName: input.file.name,
            fileUrl,
            uploadedAt,
          },
        },
      },
    );

    await ActivityService.record({
      institutionId: input.institutionId,
      entityType: "APPLICATION",
      entityId: application._id,
      entityRef: application.applicationNumber,
      action: "Document attached",
      description: `${input.documentType} attached`,
      performedBy: input.actor?.id,
      performedByName: input.actor?.name,
    });

    return {
      id: documentId.toHexString(),
      documentType: input.documentType,
      fileName: input.file.name,
      fileUrl,
      uploadedAt: requiredIso(uploadedAt),
    };
  },

  /**
   * Reads a stored file. The institution is always required — there is no
   * cross-tenant read, for any role.
   */
  async read(institutionId: string, documentId: string) {
    if (!Types.ObjectId.isValid(documentId)) throw notFound("Document not found");

    await connectToDatabase();
    const record = await DocumentRecord.findOne({
      _id: new Types.ObjectId(documentId),
      institutionId,
    }).lean();
    if (!record?.storageKey) throw notFound("Document not found");

    const object = await storage.get(record.storageKey);
    if (!object) throw notFound("Document not found");

    return {
      body: object.body,
      contentType: record.mimeType ?? object.contentType,
      fileName: record.originalFileName ?? record.fileName,
    };
  },

  async listForApplication(institutionId: string, applicationId: string) {
    await connectToDatabase();
    const rows = await DocumentRecord.find({
      institutionId,
      applicationId: new Types.ObjectId(applicationId),
    })
      .sort({ uploadedAt: -1 })
      .lean();

    return rows.map((row) => ({
      id: String(row._id),
      documentType: row.documentType as DocumentType,
      fileName: row.originalFileName ?? row.fileName,
      fileUrl: row.fileUrl,
      uploadedAt: requiredIso(row.uploadedAt),
    }));
  },
};
