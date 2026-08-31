import Image from "next/image";
import { InstitutionService } from "@/services/institution.service";

/**
 * Social proof, from the same source of truth as everything else on the page:
 * `listPublicDirectory` — so an institution appears here if and only if it is
 * published and active, exactly as on the public directory API. Nothing
 * unpublished can leak onto the marketing page, because the marketing page
 * has no privileged read.
 *
 * Renders nothing at all when the directory is empty: a marketing page that
 * says "trusted by no institutions yet" argues against itself, and absence
 * is the honest zero state.
 */
export async function OnboardedInstitutions() {
  const { institutions, total } = await InstitutionService.listPublicDirectory({ pageSize: 12 });
  if (institutions.length === 0) return null;

  const remainder = total - institutions.length;

  return (
    <section className="border-t border-border py-14" aria-label="Institutions on IDAP">
      <div className="mx-auto max-w-6xl px-5">
        <p className="reveal text-center text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Already publishing with IDAP
        </p>
        <div className="reveal-stagger mt-8 flex flex-wrap items-center justify-center gap-4">
          {institutions.map((institution) => (
            <div
              key={institution.institutionId}
              className="landing-card spotlight-card flex items-center gap-3 px-5 py-3"
            >
              {institution.logoUrl ? (
                <Image
                  src={institution.logoUrl}
                  alt=""
                  width={36}
                  height={36}
                  className="h-9 w-9 rounded-full border border-border object-cover"
                />
              ) : (
                <span
                  aria-hidden
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground"
                >
                  {monogram(institution.institutionName)}
                </span>
              )}
              <span className="text-left">
                <span className="block text-sm font-semibold leading-tight">
                  {institution.institutionName}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {[institution.city, institution.board].filter(Boolean).join(" · ")}
                </span>
              </span>
            </div>
          ))}
          {remainder > 0 && (
            <p className="px-3 text-sm text-muted-foreground">and {remainder} more</p>
          )}
        </div>
      </div>
    </section>
  );
}

/** "Infinity School of Excellence" → "IS" — the logo-less fallback. */
function monogram(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}
