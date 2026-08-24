import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { NewResultForm } from "@/components/results/result-editor";

export const metadata: Metadata = { title: "Add a result" };
export const dynamic = "force-dynamic";

/**
 * Creating a cycle asks for the cycle and nothing else. The outcome numbers,
 * the score bands and the toppers open on the editor that follows, because a
 * topper's photograph has no result to attach itself to until one exists.
 */
export default async function NewResultPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3 text-muted-foreground">
        <Link href="/results">
          <ArrowLeft className="size-3.5" />
          Results
        </Link>
      </Button>

      <PageHeader
        title="Add a result"
        description="Name the exam cycle. Saving it opens the outcome numbers, the score bands and the toppers."
      />

      <NewResultForm />
    </>
  );
}
