import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { AppError } from "@/lib/api/errors";
import { FeeStructureService, type FeeStructureDTO } from "@/services/fee-structure.service";
import type { FeeStructureStatus } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { FeeStructureForm } from "@/components/fees/fee-structure-form";
import { FeeStructureActions } from "@/components/fees/fee-structure-actions";
import { FeeStructureStatusBadge } from "@/components/fees/fee-structure-status-badge";

export const metadata: Metadata = { title: "Fee structure" };
export const dynamic = "force-dynamic";

export default async function FeeStructureEditorPage(props: PageProps<"/fees/[feeId]">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const { feeId } = await props.params;

  let feeStructure: FeeStructureDTO;
  try {
    feeStructure = await FeeStructureService.get(institution.institutionId, feeId);
  } catch (error) {
    // A fee structure belonging to someone else, or an id that is not an id
    // at all, is "no such page" — never a 500.
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const feeHeads = await FeeStructureService.getFeeHeads(institution.institutionId);

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3 text-muted-foreground">
        <Link href="/fees">
          <ArrowLeft className="size-3.5" />
          Fees
        </Link>
      </Button>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={`${feeStructure.classOrCourse} · ${feeStructure.academicYear}`}
          description="Everything a website reading your public fees endpoint would see."
        />
        <div className="flex items-center gap-3">
          <FeeStructureStatusBadge status={feeStructure.status as FeeStructureStatus} />
          <FeeStructureActions feeStructure={feeStructure} />
        </div>
      </div>

      <FeeStructureForm initialFeeStructure={feeStructure} units={[]} feeHeads={feeHeads} />
    </>
  );
}
