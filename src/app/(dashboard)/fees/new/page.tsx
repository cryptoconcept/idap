import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
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
        description="Name the class or course and its academic year, then add line items."
      />

      <FeeStructureForm initialFeeStructure={null} />
    </>
  );
}
