import "server-only";
import PDFDocument from "pdfkit";
import type { ApplicationDTO } from "@/lib/types";
import type { TenantInstitution } from "@/lib/tenant";
import { DOCUMENT_TYPE_LABELS, type DocumentType } from "@/lib/constants";
import { formatDocumentDate, joinAddress } from "@/lib/utils/format";

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const CONTENT_BOTTOM = PAGE_HEIGHT - PAGE_MARGIN;
const COLUMN_WIDTH = CONTENT_WIDTH / 2;

const CHECKLIST: DocumentType[] = [
  "PHOTO",
  "BIRTH_CERTIFICATE",
  "MARKSHEET",
  "TRANSFER_CERTIFICATE",
];

type Doc = InstanceType<typeof PDFDocument>;

/**
 * The layout tracks its own vertical cursor rather than reading `doc.y` back
 * after each draw: two-column rows would otherwise drift down the page as the
 * first column advanced the shared cursor.
 */
type Cursor = { y: number };

/**
 * Institution logos are configured by administrators, but they are still remote
 * URLs fetched from the server, so the scheme is restricted and the request is
 * bounded. A failure only costs the logo, never the document.
 */
async function loadLogo(logoUrl?: string): Promise<Buffer | null> {
  if (!logoUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(logoUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  try {
    const response = await fetch(parsed, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    if (!/image\/(png|jpe?g)/i.test(contentType)) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > 2_000_000 ? null : buffer;
  } catch {
    return null;
  }
}

/** Draws text at an absolute position and returns the y it ended at. */
function write(
  doc: Doc,
  text: string,
  x: number,
  y: number,
  options: {
    font?: string;
    size?: number;
    color?: string;
    width?: number;
    align?: "left" | "center" | "right" | "justify";
    characterSpacing?: number;
  } = {},
): number {
  doc
    .font(options.font ?? "Times-Roman")
    .fontSize(options.size ?? 10)
    .fillColor(options.color ?? "#000000");
  doc.text(text, x, y, {
    width: options.width ?? CONTENT_WIDTH,
    align: options.align ?? "left",
    characterSpacing: options.characterSpacing ?? 0,
  });
  return doc.y;
}

function rule(doc: Doc, y: number, width = 0.75, color = "#000000"): void {
  doc
    .moveTo(PAGE_MARGIN, y)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, y)
    .lineWidth(width)
    .strokeColor(color)
    .stroke();
}

/** Starts a new page when the next block would not fit on the current one. */
function ensureSpace(doc: Doc, cursor: Cursor, needed: number): void {
  if (cursor.y + needed <= CONTENT_BOTTOM) return;
  doc.addPage();
  cursor.y = PAGE_MARGIN;
}

function sectionHeading(doc: Doc, cursor: Cursor, title: string): void {
  ensureSpace(doc, cursor, 46);
  cursor.y += 9;
  const bottom = write(doc, title.toUpperCase(), PAGE_MARGIN, cursor.y, {
    font: "Helvetica-Bold",
    size: 8.5,
    characterSpacing: 1.1,
  });
  rule(doc, bottom + 2.5);
  cursor.y = bottom + 8;
}

function labelledValue(
  doc: Doc,
  label: string,
  value: string | undefined,
  x: number,
  y: number,
  width: number,
): number {
  const labelBottom = write(doc, label.toUpperCase(), x, y, {
    font: "Helvetica",
    size: 7,
    color: "#666666",
    width,
    characterSpacing: 0.5,
  });
  return write(doc, value && value.trim() ? value : "—", x, labelBottom + 0.5, {
    font: "Times-Roman",
    size: 10.5,
    width,
  });
}

function fieldRow(doc: Doc, cursor: Cursor, pairs: [string, string | undefined][]): void {
  ensureSpace(doc, cursor, 34);
  const top = cursor.y;
  let bottom = top;

  pairs.forEach(([label, value], index) => {
    const x = PAGE_MARGIN + index * COLUMN_WIDTH;
    const end = labelledValue(doc, label, value, x, top, COLUMN_WIDTH - 16);
    bottom = Math.max(bottom, end);
  });

  cursor.y = bottom + 6;
}

function fullWidthField(doc: Doc, cursor: Cursor, label: string, value?: string): void {
  ensureSpace(doc, cursor, 34);
  cursor.y = labelledValue(doc, label, value, PAGE_MARGIN, cursor.y, CONTENT_WIDTH) + 6;
}

export async function buildApplicationPdf(
  application: ApplicationDTO,
  institution: TenantInstitution,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
    info: {
      Title: `Admission Application ${application.applicationNumber}`,
      Author: institution.institutionName,
      Subject: `Admission application for ${application.student.fullName}`,
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const logo = await loadLogo(institution.logoUrl);
  const cursor: Cursor = { y: PAGE_MARGIN };

  // ---- Letterhead -------------------------------------------------------
  const textLeft = logo ? PAGE_MARGIN + 58 : PAGE_MARGIN;
  const textWidth = CONTENT_WIDTH - (logo ? 58 : 0);

  if (logo) {
    try {
      doc.image(logo, PAGE_MARGIN, cursor.y, { fit: [46, 46] });
    } catch {
      // A logo pdfkit cannot decode is simply omitted.
    }
  }

  let headerBottom = write(doc, institution.institutionName.toUpperCase(), textLeft, cursor.y, {
    font: "Times-Bold",
    size: 16,
    width: textWidth,
    characterSpacing: 0.4,
  });

  const addressLine = joinAddress({
    addressLine1: institution.address,
    city: institution.city,
    state: institution.state,
    pincode: institution.pincode,
  });
  if (addressLine) {
    headerBottom = write(doc, addressLine, textLeft, headerBottom + 1.5, {
      font: "Helvetica",
      size: 8.5,
      color: "#333333",
      width: textWidth,
    });
  }

  const contactLine = [
    institution.phone ? `Phone: ${institution.phone}` : null,
    institution.email,
    institution.website,
  ]
    .filter(Boolean)
    .join("   |   ");
  if (contactLine) {
    headerBottom = write(doc, contactLine, textLeft, headerBottom + 0.5, {
      font: "Helvetica",
      size: 8.5,
      color: "#333333",
      width: textWidth,
    });
  }

  cursor.y = Math.max(headerBottom, logo ? PAGE_MARGIN + 48 : headerBottom) + 8;
  rule(doc, cursor.y, 1.4);
  cursor.y += 12;

  // ---- Document title ---------------------------------------------------
  cursor.y = write(doc, "ADMISSION APPLICATION", PAGE_MARGIN, cursor.y, {
    font: "Times-Bold",
    size: 13.5,
    align: "center",
    characterSpacing: 1.6,
  });
  cursor.y = write(doc, `Academic Year ${application.academicYear}`, PAGE_MARGIN, cursor.y + 2, {
    font: "Helvetica",
    size: 9,
    color: "#333333",
    align: "center",
  });
  cursor.y += 10;

  // ---- Reference bar ----------------------------------------------------
  const barTop = cursor.y;
  const barHeight = 30;
  doc
    .rect(PAGE_MARGIN, barTop, CONTENT_WIDTH, barHeight)
    .lineWidth(0.75)
    .strokeColor("#000000")
    .stroke();

  write(doc, "APPLICATION NO", PAGE_MARGIN + 10, barTop + 6, {
    font: "Helvetica",
    size: 7,
    color: "#666666",
    width: 200,
    characterSpacing: 0.5,
  });
  write(doc, application.applicationNumber, PAGE_MARGIN + 10, barTop + 15, {
    font: "Courier-Bold",
    size: 11,
    width: 220,
  });

  write(doc, "DATE", PAGE_MARGIN + CONTENT_WIDTH - 130, barTop + 6, {
    font: "Helvetica",
    size: 7,
    color: "#666666",
    width: 120,
    align: "right",
    characterSpacing: 0.5,
  });
  write(doc, formatDocumentDate(application.createdAt), PAGE_MARGIN + CONTENT_WIDTH - 130, barTop + 15, {
    font: "Courier-Bold",
    size: 11,
    width: 120,
    align: "right",
  });

  cursor.y = barTop + barHeight;

  // ---- Student ----------------------------------------------------------
  sectionHeading(doc, cursor, "Student details");
  fieldRow(doc, cursor, [
    ["Student name", application.student.fullName],
    ["Date of birth", formatDocumentDate(application.student.dateOfBirth)],
  ]);
  fieldRow(doc, cursor, [
    ["Gender", application.student.gender],
    ["Blood group", application.student.bloodGroup],
  ]);
  fieldRow(doc, cursor, [
    ["Applying for", application.admission.applyingFor],
    ["Admission type", application.admission.admissionType],
  ]);

  // ---- Parent -----------------------------------------------------------
  sectionHeading(doc, cursor, "Parent / Guardian details");
  fieldRow(doc, cursor, [
    ["Father's name", application.parent.fatherName],
    ["Mother's name", application.parent.motherName],
  ]);
  fieldRow(doc, cursor, [
    ["Guardian's name", application.parent.guardianName],
    ["Mobile", application.parent.phone],
  ]);
  fieldRow(doc, cursor, [
    ["Alternate phone", application.parent.alternatePhone],
    ["Email", application.parent.email],
  ]);

  // ---- Address ----------------------------------------------------------
  sectionHeading(doc, cursor, "Address");
  fullWidthField(doc, cursor, "Residential address", joinAddress(application.address));

  // ---- Academic ---------------------------------------------------------
  sectionHeading(doc, cursor, "Previous academic details");
  fieldRow(doc, cursor, [
    ["Previous institution", application.academic.previousInstitution],
    ["Previous class", application.academic.previousClass],
  ]);
  fieldRow(doc, cursor, [
    [
      "Previous percentage",
      application.academic.previousPercentage !== undefined
        ? `${application.academic.previousPercentage}%`
        : undefined,
    ],
    ["Academic year", application.academicYear],
  ]);

  // ---- Documents --------------------------------------------------------
  sectionHeading(doc, cursor, "Documents submitted");
  const submitted = new Set(application.documents.map((document) => document.documentType));
  const boxSize = 8.5;
  const checklistTop = cursor.y;

  CHECKLIST.forEach((type, index) => {
    const x = PAGE_MARGIN + (index % 2) * COLUMN_WIDTH;
    const y = checklistTop + Math.floor(index / 2) * 16;

    doc.rect(x, y, boxSize, boxSize).lineWidth(0.75).strokeColor("#000000").stroke();
    if (submitted.has(type)) {
      doc.rect(x + 2, y + 2, boxSize - 4, boxSize - 4).fillColor("#000000").fill();
    }
    write(doc, DOCUMENT_TYPE_LABELS[type], x + boxSize + 7, y - 1, {
      font: "Times-Roman",
      size: 10,
      width: COLUMN_WIDTH - 30,
    });
  });
  cursor.y = checklistTop + Math.ceil(CHECKLIST.length / 2) * 16 + 2;

  const extraDocuments = application.documents.filter(
    (document) => !CHECKLIST.includes(document.documentType),
  );
  if (extraDocuments.length > 0) {
    fullWidthField(
      doc,
      cursor,
      "Other documents",
      extraDocuments.map((document) => document.fileName).join(", "),
    );
  }

  if (application.message) {
    sectionHeading(doc, cursor, "Additional information");
    cursor.y = write(doc, application.message, PAGE_MARGIN, cursor.y, {
      font: "Times-Roman",
      size: 10,
      align: "justify",
    });
  }

  // ---- Declaration ------------------------------------------------------
  // Declaration, signatures and the office box are one unit: never split them.
  ensureSpace(doc, cursor, 190);
  sectionHeading(doc, cursor, "Declaration");
  cursor.y = write(
    doc,
    "I declare that the information provided in this application is true and correct to the best of my knowledge. I understand that any false information may result in the cancellation of admission.",
    PAGE_MARGIN,
    cursor.y,
    { font: "Times-Roman", size: 10, align: "justify" },
  );

  const signatureWidth = (CONTENT_WIDTH - 44) / 2;
  const signatureY = cursor.y + 34;
  ["Parent / Guardian signature", "Applicant signature"].forEach((label, index) => {
    const x = PAGE_MARGIN + index * (signatureWidth + 44);
    doc.moveTo(x, signatureY).lineTo(x + signatureWidth, signatureY).lineWidth(0.75).strokeColor("#000000").stroke();
    write(doc, label.toUpperCase(), x, signatureY + 3.5, {
      font: "Helvetica",
      size: 7,
      color: "#333333",
      width: signatureWidth,
      characterSpacing: 0.5,
    });
  });
  cursor.y = signatureY + 22;

  // ---- Office use -------------------------------------------------------
  const officeTop = cursor.y;
  const officeHeight = 78;
  doc
    .rect(PAGE_MARGIN, officeTop, CONTENT_WIDTH, officeHeight)
    .lineWidth(0.75)
    .strokeColor("#000000")
    .stroke();

  write(doc, "FOR OFFICE USE", PAGE_MARGIN + 10, officeTop + 8, {
    font: "Helvetica-Bold",
    size: 8,
    width: 200,
    characterSpacing: 1.1,
  });

  (["Application status", "Verified by", "Date"] as const).forEach((label, index) => {
    const lineY = officeTop + 34 + index * 20;
    write(doc, label.toUpperCase(), PAGE_MARGIN + 10, lineY - 7, {
      font: "Helvetica",
      size: 7,
      color: "#666666",
      width: 120,
      characterSpacing: 0.5,
    });
    doc
      .moveTo(PAGE_MARGIN + 130, lineY)
      .lineTo(PAGE_MARGIN + CONTENT_WIDTH - 12, lineY)
      .lineWidth(0.5)
      .strokeColor("#999999")
      .stroke();
  });

  cursor.y = officeTop + officeHeight + 8;
  write(
    doc,
    `${application.applicationNumber}  ·  ${institution.institutionName}  ·  Generated ${formatDocumentDate(new Date())}`,
    PAGE_MARGIN,
    cursor.y,
    { font: "Helvetica", size: 7, color: "#999999", align: "center" },
  );

  doc.end();
  return finished;
}
