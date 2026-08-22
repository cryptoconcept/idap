import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { InstitutionService } from "@/services/institution.service";
import { joinAddress } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

export default async function ApplyLayout({
  children,
  params,
}: LayoutProps<"/apply/[institutionId]">) {
  const { institutionId } = await params;
  const institution = await InstitutionService.getPublicBranding(institutionId);
  if (!institution) notFound();

  const address = joinAddress({
    addressLine1: institution.address,
    city: institution.city,
    state: institution.state,
    pincode: institution.pincode,
  });

  return (
    <div className="flex min-h-dvh flex-col bg-mist">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-[880px] items-center gap-4 px-5 py-5 sm:px-8">
          {institution.logoUrl ? (
            // Institution logos keep their own colours; the interface stays monochrome.
            <Image
              src={institution.logoUrl}
              alt=""
              width={44}
              height={44}
              unoptimized
              className="size-11 shrink-0 object-contain"
            />
          ) : null}
          <div className="min-w-0">
            <Link
              href={`/apply/${institution.institutionId}`}
              className="block truncate text-base font-semibold tracking-tight sm:text-lg"
            >
              {institution.institutionName}
            </Link>
            {address ? (
              <p className="truncate text-xs text-muted-foreground">{address}</p>
            ) : null}
          </div>
        </div>
      </header>

      <main className="flex-1">
        <div className="mx-auto w-full max-w-[880px] px-5 py-8 sm:px-8 sm:py-12">{children}</div>
      </main>

      <footer className="border-t border-border bg-background">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-1 px-5 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>
            {[institution.phone, institution.email].filter(Boolean).join("  ·  ") ||
              institution.institutionName}
          </p>
          {institution.website ? (
            <a
              href={institution.website}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-4"
            >
              {institution.website.replace(/^https?:\/\//, "")}
            </a>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
