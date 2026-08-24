"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { CreateStaffDialog } from "@/components/staff/create-staff-dialog";
import { USER_ROLE_LABELS } from "@/lib/constants";
import type { StaffDTO } from "@/services/staff.service";

export function StaffListView({ staff }: { staff: StaffDTO[] }) {
  const router = useRouter();

  async function toggleActive(id: string, active: boolean) {
    try {
      const response = await fetch(`/api/staff/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not update the account. Please try again.");
        return;
      }

      toast.success(active ? "Account reactivated" : "Account deactivated");
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    }
  }

  return (
    <>
      <PageHeader
        title="Staff"
        description="Counselors and front desk accounts for your institution."
        actions={<CreateStaffDialog />}
      />

      {staff.length === 0 ? (
        <EmptyState
          title="No staff accounts yet"
          description="Add a counselor or front desk account to start assigning enquiries."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {staff.map((person) => (
                <tr key={person.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 font-medium">{person.name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{person.email}</td>
                  <td className="px-4 py-2.5">{USER_ROLE_LABELS[person.role]}</td>
                  <td className="px-4 py-2.5">{person.active ? "Active" : "Inactive"}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => toggleActive(person.id, !person.active)}
                    >
                      {person.active ? "Deactivate" : "Reactivate"}
                    </Button>
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
