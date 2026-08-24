import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { ResultService } from "@/services/result.service";
import { ResultsListView } from "@/components/results/results-list-view";

export const metadata: Metadata = { title: "Results" };
export const dynamic = "force-dynamic";

/**
 * The institute admin owns this screen. The platform admin has no route here:
 * they provision institutions, they do not read institution results.
 */
export default async function ResultsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const results = await ResultService.list(institution.institutionId);

  return <ResultsListView results={results} />;
}
