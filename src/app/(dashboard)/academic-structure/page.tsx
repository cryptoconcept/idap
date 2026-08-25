import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { AcademicStructureService } from "@/services/academic-structure.service";
import { AcademicStructureView } from "@/components/academic/academic-structure-view";

export const metadata: Metadata = { title: "Academic Structure" };
export const dynamic = "force-dynamic";

/**
 * Institute-admin only, matching Fees, Results and Staff exactly: the platform
 * admin has no route here, and neither does Counselor or Front Desk.
 */
export default async function AcademicStructurePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const [segments, units] = await Promise.all([
    AcademicStructureService.getSegments(institution.institutionId),
    AcademicStructureService.list(institution.institutionId),
  ]);

  // Offered only while there is nothing to overwrite and something to import.
  const canSeed =
    units.length === 0 &&
    (await AcademicStructureService.hasProfileOfferings(institution.institutionId));

  return <AcademicStructureView segments={segments} units={units} canSeed={canSeed} />;
}
