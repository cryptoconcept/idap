import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { AppError } from "@/lib/api/errors";
import { OfferService, type OfferDTO } from "@/services/offer.service";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { flattenTree, inactiveIds } from "@/lib/academic/tree";
import type { OfferStatus } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { OfferForm } from "@/components/offers/offer-form";
import { OfferActions } from "@/components/offers/offer-actions";
import { OfferStatusBadge } from "@/components/offers/offer-status-badge";

export const metadata: Metadata = { title: "Offer" };
export const dynamic = "force-dynamic";

export default async function OfferEditorPage(props: PageProps<"/offers/[offerId]">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const { offerId } = await props.params;

  let offer: OfferDTO;
  try {
    offer = await OfferService.get(institution.institutionId, offerId);
  } catch (error) {
    // An offer belonging to someone else, or an id that is not an id at all,
    // is "no such page" — never a 500.
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  // Unlike a fee structure's class/course, the unit stays editable here, so
  // this page needs the same effectively-active unit list the create page
  // does — the exact filtering from `/offers/new/page.tsx`.
  const allUnits = await AcademicStructureService.list(institution.institutionId);
  const hidden = inactiveIds(allUnits);
  const units = flattenTree(allUnits).filter((unit) => !hidden.has(unit.id));

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3 text-muted-foreground">
        <Link href="/offers">
          <ArrowLeft className="size-3.5" />
          Offers
        </Link>
      </Button>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={offer.title}
          description="Everything a website reading your public offers endpoint would see."
        />
        <div className="flex items-center gap-3">
          <OfferStatusBadge status={offer.status as OfferStatus} />
          <OfferActions offer={offer} />
        </div>
      </div>

      <OfferForm initialOffer={offer} units={units} />
    </>
  );
}
