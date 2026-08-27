import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { PlatformCredentialService } from "@/services/platform-credential.service";
import { PageHeader } from "@/components/shared/page-header";
import { PlatformCredentialsPanel } from "@/components/admin/platform-credentials-panel";

export const metadata: Metadata = { title: "Platforms" };
export const dynamic = "force-dynamic";

export default async function AdminPlatformsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");

  const { vaultReady, credentials } = await PlatformCredentialService.list();

  return (
    <>
      <PageHeader
        title="Platforms"
        description="API keys IDAP uses to push institution data to PassPercent and FeesBasket."
      />
      <PlatformCredentialsPanel vaultReady={vaultReady} credentials={credentials} />
    </>
  );
}
