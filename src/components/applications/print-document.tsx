import Image from "next/image";
import { DOCUMENT_TYPE_LABELS, type DocumentType } from "@/lib/constants";
import { formatDocumentDate, joinAddress } from "@/lib/utils/format";
import type { ApplicationDTO } from "@/lib/types";
import type { TenantInstitution } from "@/lib/tenant";

const CHECKLIST: DocumentType[] = [
  "PHOTO",
  "BIRTH_CERTIFICATE",
  "MARKSHEET",
  "TRANSFER_CERTIFICATE",
];

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-sans text-[7.5pt] tracking-[0.08em] text-neutral-600 uppercase">{label}</dt>
      <dd className="mt-0.5 text-[11pt] leading-snug break-words text-black">
        {value && value.trim() ? value : "—"}
      </dd>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-5 mb-2.5 border-b border-black pb-1 font-sans text-[8.5pt] font-semibold tracking-[0.12em] text-black uppercase">
      {children}
    </h2>
  );
}

/**
 * The formal admission application. This is the artifact families sign and the
 * office files, so it is set in a serif face on an A4 sheet and mirrors the
 * generated PDF field for field.
 */
export function ApplicationPrintDocument({
  application,
  institution,
}: {
  application: ApplicationDTO;
  institution: TenantInstitution;
}) {
  const submitted = new Set(application.documents.map((document) => document.documentType));
  const extraDocuments = application.documents.filter(
    (document) => !CHECKLIST.includes(document.documentType),
  );

  const institutionAddress = joinAddress({
    addressLine1: institution.address,
    city: institution.city,
    state: institution.state,
    pincode: institution.pincode,
  });

  const contactLine = [
    institution.phone ? `Phone: ${institution.phone}` : null,
    institution.email,
    institution.website,
  ]
    .filter(Boolean)
    .join("   |   ");

  return (
    <article
      className="print-page mx-auto w-full max-w-[210mm] bg-white px-[14mm] py-[14mm] text-black shadow-sm print:shadow-none"
      style={{ fontFamily: "var(--font-document)" }}
    >
      {/* Letterhead */}
      <header className="flex items-start gap-4">
        {institution.logoUrl ? (
          // Institution logos may be any colour; the rest of the document stays monochrome.
          <Image
            src={institution.logoUrl}
            alt=""
            width={56}
            height={56}
            unoptimized
            className="size-14 shrink-0 object-contain"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="text-[17pt] leading-tight font-bold tracking-[0.02em] text-black uppercase">
            {institution.institutionName}
          </h1>
          {institutionAddress ? (
            <p className="mt-1 font-sans text-[8.5pt] text-neutral-700">{institutionAddress}</p>
          ) : null}
          {contactLine ? (
            <p className="font-sans text-[8.5pt] text-neutral-700">{contactLine}</p>
          ) : null}
        </div>
      </header>

      <div className="mt-3 border-t-2 border-black" />

      <div className="mt-4 text-center">
        <h2 className="text-[14pt] font-bold tracking-[0.18em] text-black uppercase">
          Admission Application
        </h2>
        <p className="mt-1 font-sans text-[9pt] text-neutral-700">
          Academic Year {application.academicYear}
        </p>
      </div>

      {/* Reference bar */}
      <div className="mt-4 flex items-start justify-between gap-4 border border-black px-3 py-2">
        <div>
          <p className="font-sans text-[7.5pt] tracking-[0.08em] text-neutral-600 uppercase">Application No</p>
          <p className="font-mono text-[11.5pt] font-semibold tabular text-black">
            {application.applicationNumber}
          </p>
        </div>
        <div className="text-right">
          <p className="font-sans text-[7.5pt] tracking-[0.08em] text-neutral-600 uppercase">Date</p>
          <p className="font-mono text-[11.5pt] font-semibold tabular text-black">
            {formatDocumentDate(application.createdAt)}
          </p>
        </div>
      </div>

      <section className="print-avoid-break">
        <Heading>Student details</Heading>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3">
          <Row label="Student name" value={application.student.fullName} />
          <Row label="Date of birth" value={formatDocumentDate(application.student.dateOfBirth)} />
          <Row label="Gender" value={application.student.gender} />
          <Row label="Blood group" value={application.student.bloodGroup} />
          <Row label="Applying for" value={application.admission.applyingFor} />
          <Row label="Admission type" value={application.admission.admissionType} />
        </dl>
      </section>

      <section className="print-avoid-break">
        <Heading>Parent / Guardian details</Heading>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3">
          <Row label="Father's name" value={application.parent.fatherName} />
          <Row label="Mother's name" value={application.parent.motherName} />
          <Row label="Guardian's name" value={application.parent.guardianName} />
          <Row label="Mobile" value={application.parent.phone} />
          <Row label="Alternate phone" value={application.parent.alternatePhone} />
          <Row label="Email" value={application.parent.email} />
        </dl>
      </section>

      <section className="print-avoid-break">
        <Heading>Address</Heading>
        <dl>
          <Row label="Residential address" value={joinAddress(application.address)} />
        </dl>
      </section>

      <section className="print-avoid-break">
        <Heading>Previous academic details</Heading>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3">
          <Row label="Previous institution" value={application.academic.previousInstitution} />
          <Row label="Previous class" value={application.academic.previousClass} />
          <Row
            label="Previous percentage"
            value={
              application.academic.previousPercentage !== undefined
                ? `${application.academic.previousPercentage}%`
                : undefined
            }
          />
          <Row label="Academic year" value={application.academicYear} />
        </dl>
      </section>

      <section className="print-avoid-break">
        <Heading>Documents submitted</Heading>
        <ul className="grid grid-cols-2 gap-x-8 gap-y-2">
          {CHECKLIST.map((type) => (
            <li key={type} className="flex items-center gap-2 text-[11pt]">
              <span className="flex size-[11px] shrink-0 items-center justify-center border border-black">
                {submitted.has(type) ? (
                  <span className="size-[5px] bg-black" aria-hidden />
                ) : null}
              </span>
              {DOCUMENT_TYPE_LABELS[type]}
            </li>
          ))}
        </ul>
        {extraDocuments.length > 0 ? (
          <p className="mt-2 text-[10pt] text-neutral-700">
            Other: {extraDocuments.map((document) => document.fileName).join(", ")}
          </p>
        ) : null}
      </section>

      {application.message ? (
        <section className="print-avoid-break">
          <Heading>Additional information</Heading>
          <p className="text-[10.5pt] whitespace-pre-wrap">{application.message}</p>
        </section>
      ) : null}

      <section className="print-avoid-break">
        <Heading>Declaration</Heading>
        <p className="text-justify text-[10.5pt] leading-relaxed">
          I declare that the information provided in this application is true and correct to the
          best of my knowledge. I understand that any false information may result in the
          cancellation of admission.
        </p>

        <div className="mt-12 grid grid-cols-2 gap-10">
          {["Parent / Guardian signature", "Applicant signature"].map((label) => (
            <div key={label}>
              <div className="border-t border-black" />
              <p className="mt-1 font-sans text-[7.5pt] tracking-[0.08em] text-neutral-700 uppercase">
                {label}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="print-avoid-break mt-6 border border-black px-3 py-3">
        <p className="font-sans text-[8.5pt] font-semibold tracking-[0.12em] text-black uppercase">
          For office use
        </p>
        <dl className="mt-3 space-y-4">
          {["Application status", "Verified by", "Date"].map((label) => (
            <div key={label} className="flex items-end gap-3">
              <dt className="w-[150px] shrink-0 font-sans text-[7.5pt] tracking-[0.08em] text-neutral-600 uppercase">
                {label}
              </dt>
              <dd className="flex-1 border-b border-neutral-400" />
            </div>
          ))}
        </dl>
      </section>

      <footer className="mt-4 text-center font-sans text-[7pt] text-neutral-500">
        {application.applicationNumber} · {institution.institutionName} · Generated{" "}
        {formatDocumentDate(new Date())}
      </footer>
    </article>
  );
}
