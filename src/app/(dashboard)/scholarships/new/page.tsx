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
import { ScholarshipForm } from "@/components/scholarships/scholarship-form";

export const metadata: Metadata = { title: "Add a scholarship" };
export const dynamic = "force-dynamic";

export default async function NewScholarshipPage() {
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
        <Link href="/scholarships">
          <ArrowLeft className="size-3.5" />
          Scholarships
        </Link>
      </Button>

      <PageHeader
        title="Add a scholarship"
        description="Name it, describe who qualifies, and optionally scope it to one class or course."
      />

      {/*
        Unlike a fee structure, a scholarship has no required academicUnitId —
        it can be institution-wide — so an empty unit list is never a reason
        to block the form; the picker just offers only "All classes and courses".
      */}
      <ScholarshipForm initialScholarship={null} units={units} />
    </>
  );
}
