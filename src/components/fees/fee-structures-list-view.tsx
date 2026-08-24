import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { FeeStructureStatusBadge } from "@/components/fees/fee-structure-status-badge";
import type { FeeStructureDTO } from "@/services/fee-structure.service";
import type { FeeStructureStatus } from "@/lib/constants";

/** Quick-glance total: every ANNUAL line item summed. Not a stored field. */
function annualTotal(feeStructure: FeeStructureDTO): number {
  return (feeStructure.lineItems ?? [])
    .filter((item) => item.frequency === "ANNUAL")
    .reduce((sum, item) => sum + item.amount, 0);
}

export function FeeStructuresListView({ feeStructures }: { feeStructures: FeeStructureDTO[] }) {
  return (
    <>
      <PageHeader
        title="Fees"
        description="Class and course fee structures your website and partner sites read from the public API."
        actions={
          <Button asChild size="sm">
            <Link href="/fees/new">
              <Plus className="size-4" />
              Add a fee structure
            </Link>
          </Button>
        }
      />

      {feeStructures.length === 0 ? (
        <EmptyState
          title="No fee structures yet"
          description="Publish a class or course's fees and any website reading your public API picks it up."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Class / course</th>
                <th className="px-4 py-2 font-medium">Academic year</th>
                <th className="px-4 py-2 font-medium">Annual total</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {feeStructures.map((feeStructure) => (
                <tr key={feeStructure.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/fees/${feeStructure.id}`} className="font-medium hover:underline">
                      {feeStructure.classOrCourse}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{feeStructure.academicYear}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    ₹{annualTotal(feeStructure).toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-2.5">
                    <FeeStructureStatusBadge status={feeStructure.status as FeeStructureStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
