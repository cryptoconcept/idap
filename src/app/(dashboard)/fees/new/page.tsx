import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { FeeStructureService } from "@/services/fee-structure.service";
import { flattenTree, inactiveIds } from "@/lib/academic/tree";
import { suggestNextAcademicYear } from "@/lib/fee-structure/academic-year";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { FeeStructureForm } from "@/components/fees/fee-structure-form";

export const metadata: Metadata = { title: "Add a fee structure" };
export const dynamic = "force-dynamic";

export default async function NewFeeStructurePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const allUnits = await AcademicStructureService.list(institution.institutionId);
  // Effectively-inactive units are excluded — Phase 5's read-time rule, where a unit
  // counts as inactive when it or any ancestor is. Pricing something you have hidden,
  // or something under a branch you have hidden, is not a thing to offer.
  const hidden = inactiveIds(allUnits);
  const units = flattenTree(allUnits).filter((unit) => !hidden.has(unit.id));
  const feeHeads = await FeeStructureService.getFeeHeads(institution.institutionId);
  const { years, taken } = await FeeStructureService.getYearPlanning(institution.institutionId);
  const suggestedYear = suggestNextAcademicYear(years);
  const academicYears = years.includes(suggestedYear) ? years : [suggestedYear, ...years];

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3 text-muted-foreground">
        <Link href="/fees">
          <ArrowLeft className="size-3.5" />
          Fees
        </Link>
      </Button>

      <PageHeader
        title="Add a fee structure"
        description="Pick the academic year, then the class or course, then add line items."
      />

      {units.length === 0 ? (
        <EmptyState
          title="No classes or courses yet"
          description="Fees attach to a class or course from your academic structure. Add one first, then come back to price it."
          actionLabel="Go to academic structure"
          actionHref="/academic-structure"
        />
      ) : (
        <FeeStructureForm
          initialFeeStructure={null}
          units={units}
          feeHeads={feeHeads}
          academicYears={academicYears}
          takenUnitYearPairs={taken}
        />
      )}
    </>
  );
}
