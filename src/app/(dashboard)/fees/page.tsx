import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { FeeStructureService } from "@/services/fee-structure.service";
import { FeeStructuresListView } from "@/components/fees/fee-structures-list-view";

export const metadata: Metadata = { title: "Fees" };
export const dynamic = "force-dynamic";

/**
 * The institute admin owns this screen, matching Results and Staff exactly:
 * the platform admin has no route here, and neither does Counselor or Front
 * Desk — they read published fees the same way any public caller does.
 */
export default async function FeesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const feeStructures = await FeeStructureService.list(institution.institutionId);

  return <FeeStructuresListView feeStructures={feeStructures} />;
}
