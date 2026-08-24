import { validationError } from "@/lib/api/errors";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** Magic-number check so a renamed executable cannot pose as an allowed image type. */
function sniffImage(bytes: Buffer, contentType: string): boolean {
  if (bytes.byteLength < 4) return false;
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

/**
 * Upload guard for institution media: JPEG/PNG/WebP only (no PDF branch — this
 * is never a document), size bounded, and the sniff must agree with the
 * declared content type.
 */
export function validateImage(input: { contentType: string; bytes: Buffer }): {
  extension: string;
} {
  const extension = IMAGE_EXTENSIONS[input.contentType];
  if (!extension) {
    throw validationError("file: only JPG, PNG and WEBP images can be uploaded");
  }
  if (input.bytes.byteLength <= 0) {
    throw validationError("file: the file is empty");
  }
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw validationError("file: files must be 5 MB or smaller");
  }
  if (!sniffImage(input.bytes, input.contentType)) {
    throw validationError("file: the file contents do not match the declared file type");
  }
  return { extension };
}
