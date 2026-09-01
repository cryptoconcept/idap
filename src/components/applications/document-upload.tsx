"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, type DocumentType } from "@/lib/constants";

// Client-side pre-check (audit flows-L4): reject an over-limit or wrong-type
// file before it leaves the browser, so a parent on mobile isn't made to
// upload a 30 MB file only to be told "5 MB" after the round-trip. The server
// stays the authority — it re-checks size AND sniffs the magic bytes — this is
// only UX. A document may be a scanned image or a PDF, so both are allowed at
// the server's 5 MB document limit.
const ACCEPTED_DOC_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_DOC_BYTES = 5 * 1024 * 1024;

function checkDocumentFile(file: File): string | null {
  if (!ACCEPTED_DOC_TYPES.includes(file.type)) {
    return `${file.name}: attach a JPG, PNG, WEBP or PDF.`;
  }
  if (file.size <= 0) return `${file.name}: the file is empty.`;
  if (file.size > MAX_DOC_BYTES) return `${file.name}: must be 5 MB or smaller.`;
  return null;
}

export function DocumentUpload({ applicationNumber }: { applicationNumber: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [documentType, setDocumentType] = useState<DocumentType>("PHOTO");
  const [uploading, setUploading] = useState(false);
  const [, startTransition] = useTransition();

  async function upload(file: File) {
    const problem = checkDocumentFile(file);
    if (problem) {
      toast.error(problem);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("documentType", documentType);

      const response = await fetch(
        `/api/applications/${encodeURIComponent(applicationNumber)}/documents`,
        { method: "POST", body },
      );
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not upload the file. Please try again.");
        return;
      }

      toast.success(`${DOCUMENT_TYPE_LABELS[documentType]} attached`);
      startTransition(() => router.refresh());
    } catch {
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={documentType}
        onValueChange={(value) => setDocumentType(value as DocumentType)}
      >
        <SelectTrigger size="sm" className="min-w-[170px]" aria-label="Document type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DOCUMENT_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {DOCUMENT_TYPE_LABELS[type]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="size-3.5" />
        {uploading ? "Uploading…" : "Attach file"}
      </Button>

      <p className="text-xs text-muted-foreground">JPG, PNG, WEBP or PDF · up to 5 MB</p>
    </div>
  );
}
