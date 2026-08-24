import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { AppError } from "@/lib/api/errors";
import { ResultService, type ResultDTO } from "@/services/result.service";
import { describeCycle } from "@/lib/results/label";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { ResultEditor } from "@/components/results/result-editor";

export const metadata: Metadata = { title: "Result" };
export const dynamic = "force-dynamic";

/**
 * The institute admin authors one exam cycle here. The first read happens on
 * the server — the same service the GET route calls — so the editor opens
 * filled in; every write after that goes through `/api/settings/results`.
 */
export default async function ResultEditorPage(props: PageProps<"/results/[resultId]">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const { resultId } = await props.params;

  let result: ResultDTO;
  try {
    result = await ResultService.get(institution.institutionId, resultId);
  } catch (error) {
    // A result belonging to someone else, or an id that is not an id at all,
    // is "no such page" — never a 500.
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3 text-muted-foreground">
        <Link href="/results">
          <ArrowLeft className="size-3.5" />
          Results
        </Link>
      </Button>

      <PageHeader
        title={describeCycle(result)}
        description="Everything a website reading your public results endpoint would see."
      />

      <ResultEditor initialResult={result} institutionId={institution.institutionId} />
    </>
  );
}
