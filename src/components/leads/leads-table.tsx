import Link from "next/link";
import { Ref } from "@/components/shared/ref";
import { LeadStatusBadge } from "@/components/shared/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatPhone } from "@/lib/utils/format";
import type { LeadDTO } from "@/lib/types";

export function LeadsTable({
  leads,
  variant = "table",
  showAssignee = false,
}: {
  leads: LeadDTO[];
  /** `list` renders the compact card layout at every width — used in narrow panels. */
  variant?: "table" | "list";
  /** Admin-only "Assigned to" column — the caller decides based on the viewer's permissions. */
  showAssignee?: boolean;
}) {
  return (
    <>
      {/* Desktop: dense table. */}
      <div className={variant === "list" ? "hidden" : "hidden overflow-x-auto md:block"}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[168px]">Enquiry No</TableHead>
              <TableHead>Student</TableHead>
              <TableHead>Interested in</TableHead>
              <TableHead>Parent</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
              {showAssignee ? <TableHead>Assigned to</TableHead> : null}
              <TableHead className="text-right">Received</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((lead) => (
              <TableRow key={lead.id} className="group">
                <TableCell>
                  <Link
                    href={`/enquiries/${lead.leadNumber}`}
                    className="underline-offset-4 hover:underline"
                  >
                    <Ref>{lead.leadNumber}</Ref>
                  </Link>
                </TableCell>
                <TableCell className="font-medium">{lead.studentName}</TableCell>
                <TableCell className="text-muted-foreground">
                  {lead.classInterested ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">{lead.parentName ?? "—"}</TableCell>
                <TableCell className="tabular font-mono text-[13px]">
                  {formatPhone(lead.phone)}
                </TableCell>
                <TableCell>
                  <LeadStatusBadge status={lead.status} />
                </TableCell>
                {showAssignee ? (
                  <TableCell className="text-muted-foreground">
                    {lead.assignedToName ?? "—"}
                  </TableCell>
                ) : null}
                <TableCell className="tabular text-right text-muted-foreground">
                  {formatDate(lead.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile: one card per record. */}
      <ul className={variant === "list" ? "divide-y divide-border" : "divide-y divide-border md:hidden"}>
        {leads.map((lead) => (
          <li key={lead.id}>
            <Link href={`/enquiries/${lead.leadNumber}`} className="block space-y-2 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{lead.studentName}</p>
                  <Ref className="text-[11px] text-muted-foreground">{lead.leadNumber}</Ref>
                </div>
                <LeadStatusBadge status={lead.status} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {lead.classInterested ? <span>{lead.classInterested}</span> : null}
                <span className="tabular font-mono">{formatPhone(lead.phone)}</span>
                <span className="tabular ml-auto">{formatDate(lead.createdAt)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
