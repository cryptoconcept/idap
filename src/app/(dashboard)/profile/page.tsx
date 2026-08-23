import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { InstitutionService } from "@/services/institution.service";
import { PageHeader } from "@/components/shared/page-header";
import { Ref } from "@/components/shared/ref";
import { ProfileEditor } from "@/components/profile/profile-editor";

export const metadata: Metadata = { title: "Institution Profile" };
export const dynamic = "force-dynamic";

/**
 * The institute admin authors their own profile here. The platform admin has no
 * route to this screen: they provision institutions, they do not write profiles.
 *
 * The first read happens on the server — same service the GET route calls — so
 * the editor opens filled in. Every write, and every re-read after one, goes
 * through `/api/settings/institution` from the client.
 */
export default async function ProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const { profile, completion } = await InstitutionService.getProfile(institution.institutionId);

  return (
    <>
      <PageHeader
        title="Institution profile"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Ref className="text-muted-foreground">{institution.institutionId}</Ref>
            <span aria-hidden>·</span>
            <span>Everything a parent or a partner website sees about you.</span>
          </span>
        }
      />

      <ProfileEditor initialProfile={profile} initialCompletion={completion} />
    </>
  );
}
