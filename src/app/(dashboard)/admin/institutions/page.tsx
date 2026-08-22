import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2 } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { InstitutionService } from "@/services/institution.service";
import { INSTITUTION_TYPE_LABELS, type InstitutionType } from "@/lib/constants";
import { PageHeader } from "@/components/shared/page-header";
import { FilterBar } from "@/components/shared/filter-bar";
import { Pagination } from "@/components/shared/pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { CreateInstitutionDialog } from "@/components/institutions/create-institution-dialog";
import { Ref } from "@/components/shared/ref";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils/format";

export const metadata: Metadata = { title: "Institutions" };
export const dynamic = "force-dynamic";

export default async function AdminInstitutionsPage(props: PageProps<"/admin/institutions">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");

  const searchParams = await props.searchParams;
  const readParam = (key: string) => {
    const value = searchParams[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const activeParam = readParam("active");
  const result = await InstitutionService.list({
    q: readParam("q"),
    active: activeParam === undefined ? undefined : activeParam === "true",
    page: Number(readParam("page") ?? 1),
    pageSize: 20,
  });

  return (
    <>
      <PageHeader
        title="Institutions"
        description="Every institution on the platform, and the state of its account."
        actions={<CreateInstitutionDialog />}
      />

      <Suspense fallback={<Skeleton className="h-9 w-full max-w-xl rounded-md" />}>
        <FilterBar
          searchPlaceholder="Search institution ID, name or city..."
          showDateRange={false}
          filters={[
            {
              key: "active",
              label: "State",
              options: [
                { value: "true", label: "Active" },
                { value: "false", label: "Deactivated" },
              ],
            },
          ]}
        />
      </Suspense>

      <div className="mt-5">
        {result.items.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No institutions found"
            description="Create an institution to start receiving admission enquiries and applications."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[110px]">ID</TableHead>
                    <TableHead>Institution</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>City</TableHead>
                    <TableHead>State of account</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.items.map((institution) => (
                    <TableRow key={institution.id}>
                      <TableCell>
                        <Ref>{institution.institutionId}</Ref>
                      </TableCell>
                      <TableCell className="font-medium">
                        <Link
                          href={`/admin/institutions/${institution.institutionId}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {institution.institutionName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {INSTITUTION_TYPE_LABELS[institution.institutionType as InstitutionType]}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {institution.city ?? "—"}
                      </TableCell>
                      <TableCell>
                        {institution.active ? (
                          <span className="rounded-full border border-foreground/25 px-2 py-0.5 text-[11px]">
                            Active
                          </span>
                        ) : (
                          <span className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                            Deactivated
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="tabular text-right text-muted-foreground">
                        {formatDate(institution.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Suspense fallback={null}>
              <Pagination
                page={result.page}
                totalPages={result.totalPages}
                total={result.total}
                pageSize={result.pageSize}
              />
            </Suspense>
          </>
        )}
      </div>
    </>
  );
}
