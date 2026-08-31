import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { LandingPage } from "@/components/landing/landing-page";

/**
 * `/` is two pages wearing one URL. A signed-in user never sees marketing —
 * they go straight to their console, exactly as before this page existed. A
 * visitor gets the landing page.
 */
export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) redirect(user.role === "SUPER_ADMIN" ? "/admin" : "/dashboard");
  return <LandingPage />;
}
