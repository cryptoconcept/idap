import Link from "next/link";
import { Ref } from "@/components/shared/ref";
import { ApplicationStatusBadge } from "@/components/shared/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatPhone } from "@/lib/utils/format";
import type { ApplicationDTO } from "@/lib/types";

export function ApplicationsTable({
  applications,
  variant = "table",
}: {
  applications: ApplicationDTO[];
  /** `list` renders the compact card layout at every width — used in narrow panels. */
  variant?: "table" | "list";
}) {
  return (
    <>
      <div className={variant === "list" ? "hidden" : "hidden overflow-x-auto md:block"}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[186px]">Application No</TableHead>
              <TableHead>Student</TableHead>
              <TableHead>Applying for</TableHead>
              <TableHead>Parent</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {applications.map((application) => {
              const parent =
                application.parent.fatherName ??
                application.parent.guardianName ??
                application.parent.motherName;

              return (
                <TableRow key={application.id}>
                  <TableCell>
                    <Link
                      href={`/applications/${application.applicationNumber}`}
                      className="underline-offset-4 hover:underline"
                    >
                      <Ref>{application.applicationNumber}</Ref>
                    </Link>
                  </TableCell>
                  <TableCell className="font-medium">{application.student.fullName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {application.admission.applyingFor}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{parent ?? "—"}</TableCell>
                  <TableCell className="tabular font-mono text-[13px]">
                    {formatPhone(application.parent.phone)}
                  </TableCell>
                  <TableCell>
                    <ApplicationStatusBadge status={application.status} />
                  </TableCell>
                  <TableCell className="tabular text-right text-muted-foreground">
                    {formatDate(application.createdAt)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ul className={variant === "list" ? "divide-y divide-border" : "divide-y divide-border md:hidden"}>
        {applications.map((application) => (
          <li key={application.id}>
            <Link
              href={`/applications/${application.applicationNumber}`}
              className="block space-y-2 py-3.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{application.student.fullName}</p>
                  <Ref className="text-[11px] text-muted-foreground">
                    {application.applicationNumber}
                  </Ref>
                </div>
                <ApplicationStatusBadge status={application.status} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{application.admission.applyingFor}</span>
                <span className="tabular font-mono">
                  {formatPhone(application.parent.phone)}
                </span>
                <span className="tabular ml-auto">{formatDate(application.createdAt)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
