import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { flattenTree, inactiveIds } from "@/lib/academic/tree";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { OfferForm } from "@/components/offers/offer-form";

export const metadata: Metadata = { title: "Add an offer" };
export const dynamic = "force-dynamic";

export default async function NewOfferPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const allUnits = await AcademicStructureService.list(institution.institutionId);
  // Effectively-inactive units are excluded — Phase 5's read-time rule, where a unit
  // counts as inactive when it or any ancestor is. Offering something you have
  // hidden, or something under a branch you have hidden, is not a thing to offer.
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

      <PageHeader
        title="Add an offer"
        description="Name it, set a discount, and optionally scope it to one class or course."
      />

      {/*
        Unlike a fee structure, an offer has no required academicUnitId —
        it can be institution-wide — so an empty unit list is never a reason
        to block the form; the picker just offers only "All classes and courses".
      */}
      <OfferForm initialOffer={null} units={units} />
    </>
  );
}
