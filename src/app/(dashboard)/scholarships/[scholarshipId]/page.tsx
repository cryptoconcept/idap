import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { AppError } from "@/lib/api/errors";
import { ScholarshipService, type ScholarshipDTO } from "@/services/scholarship.service";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { flattenTree, inactiveIds } from "@/lib/academic/tree";
import type { ScholarshipStatus } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { ScholarshipForm } from "@/components/scholarships/scholarship-form";
import { ScholarshipActions } from "@/components/scholarships/scholarship-actions";
import { ScholarshipStatusBadge } from "@/components/scholarships/scholarship-status-badge";

export const metadata: Metadata = { title: "Scholarship" };
export const dynamic = "force-dynamic";

export default async function ScholarshipEditorPage(
  props: PageProps<"/scholarships/[scholarshipId]">,
) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const { scholarshipId } = await props.params;

  let scholarship: ScholarshipDTO;
  try {
    scholarship = await ScholarshipService.get(institution.institutionId, scholarshipId);
  } catch (error) {
    // A scholarship belonging to someone else, or an id that is not an id at
    // all, is "no such page" — never a 500.
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  // Unlike a fee structure's class/course, the unit stays editable here, so
  // this page needs the same effectively-active unit list the create page
  // does — the exact filtering from `/scholarships/new/page.tsx`.
  const allUnits = await AcademicStructureService.list(institution.institutionId);
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

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={scholarship.name}
          description="Everything a website reading your public scholarships endpoint would see."
        />
        <div className="flex items-center gap-3">
          <ScholarshipStatusBadge status={scholarship.status as ScholarshipStatus} />
          <ScholarshipActions scholarship={scholarship} />
        </div>
      </div>

      <ScholarshipForm initialScholarship={scholarship} units={units} />
    </>
  );
}
