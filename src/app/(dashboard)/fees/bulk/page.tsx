import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { FeeStructureService } from "@/services/fee-structure.service";
import { flattenTree, inactiveIds } from "@/lib/academic/tree";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { BulkFeeForm } from "@/components/fees/bulk-fee-form";

export const metadata: Metadata = { title: "Price many classes at once" };
export const dynamic = "force-dynamic";

export default async function BulkFeeStructurePage() {
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

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3 text-muted-foreground">
        <Link href="/fees">
          <ArrowLeft className="size-3.5" />
          Fees
        </Link>
      </Button>

      <PageHeader
        title="Price many classes at once"
        description="Pick classes or courses and an academic year, then apply the same line items to all of them."
      />

      {units.length === 0 ? (
        <EmptyState
          title="No classes or courses yet"
          description="Fees attach to a class or course from your academic structure. Add one first, then come back to price it."
          actionLabel="Go to academic structure"
          actionHref="/academic-structure"
        />
      ) : (
        <BulkFeeForm units={units} feeHeads={feeHeads} />
      )}
    </>
  );
}
