import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { ResultStatusBadge } from "@/components/results/result-status-badge";
import { describeCycle } from "@/lib/results/label";
import type { ResultDTO } from "@/services/result.service";
import type { ResultStatus } from "@/lib/constants";

export function ResultsListView({ results }: { results: ResultDTO[] }) {
  return (
    <>
      <PageHeader
        title="Results"
        description="Exam-cycle results your website and partner sites read from the public API."
        actions={
          <Button asChild size="sm">
            <Link href="/results/new">
              <Plus className="size-4" />
              Add a result
            </Link>
          </Button>
        }
      />

      {results.length === 0 ? (
        <EmptyState
          title="No results yet"
          description="Publish an exam cycle and any website reading your public API picks it up."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Cycle</th>
                <th className="px-4 py-2 font-medium">Appeared</th>
                <th className="px-4 py-2 font-medium">Pass rate</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result) => (
                <tr key={result.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/results/${result.id}`} className="font-medium hover:underline">
                      {describeCycle(result)}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{result.appeared}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {result.passPercentage === null ? "—" : `${result.passPercentage}%`}
                  </td>
                  <td className="px-4 py-2.5">
                    <ResultStatusBadge status={result.status as ResultStatus} />
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
