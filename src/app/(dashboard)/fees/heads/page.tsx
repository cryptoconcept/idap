import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { FeeStructureService } from "@/services/fee-structure.service";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { FeeHeadsEditor } from "@/components/fees/fee-heads-editor";

export const metadata: Metadata = { title: "Fee heads" };
export const dynamic = "force-dynamic";

export default async function FeeHeadsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

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
        title="Fee heads"
        description="Fee heads are shortcuts the line-item editor fills from when creating or editing a fee structure. A line item can still carry any label."
      />

      <FeeHeadsEditor initialFeeHeads={feeHeads} />
    </>
  );
}
