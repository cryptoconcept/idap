import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireTenantUserPage, getCurrentInstitution, tenantFilter } from "@/lib/tenant";
import { ApiClientService } from "@/services/api-client.service";
import { getAppOrigin } from "@/lib/utils/origin";
import { PageHeader } from "@/components/shared/page-header";
import { TabLinks } from "@/components/shared/tab-links";
import { Section } from "@/components/shared/definition-list";
import { Ref } from "@/components/shared/ref";
import { CopyButton } from "@/components/shared/copy-button";
import { CodeBlock } from "@/components/integration/code-block";
import { ApiKeysPanel } from "@/components/integration/api-keys-panel";
import { ApiDocs } from "@/components/integration/api-docs";
import { ConnectionsPanel } from "@/components/integration/connections-panel";
import { ConnectionService } from "@/services/connection.service";

export const metadata: Metadata = { title: "Integration" };
export const dynamic = "force-dynamic";

const TABS = [
  { value: "credentials", label: "API credentials" },
  { value: "website", label: "Website integration" },
  { value: "api", label: "API documentation" },
  { value: "connections", label: "Connected platforms" },
];

export default async function IntegrationPage(props: PageProps<"/integration">) {
  const user = await requireTenantUserPage();
  if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const searchParams = await props.searchParams;
  const tabParam = typeof searchParams.tab === "string" ? searchParams.tab : "credentials";
  const tab = TABS.some((entry) => entry.value === tabParam) ? tabParam : "credentials";

  const [clients, origin, connections] = await Promise.all([
    ApiClientService.list(tenantFilter(user)),
    getAppOrigin(),
    ConnectionService.list(institution.institutionId),
  ]);

  const activeKeys = clients.filter((client) => client.active).length;
  const applyUrl = `${origin}/apply/${institution.institutionId}`;
  const enquiryUrl = `${applyUrl}/enquiry`;

  const widgetSnippet = `<script
  src="${origin}/widget.js"
  data-institution="${institution.institutionId}">
</script>`;

  return (
    <>
      <PageHeader
        title="Integration"
        description="Connect your website to this institution's admission pipeline."
      />

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 rounded-lg border border-border bg-card p-4">
          <p className="eyebrow">Institution ID</p>
          <div className="flex items-center gap-2">
            <Ref size="lg">{institution.institutionId}</Ref>
            <CopyButton value={institution.institutionId} size="xs" variant="ghost" label="" />
          </div>
        </div>
        <div className="space-y-1.5 rounded-lg border border-border bg-card p-4">
          <p className="eyebrow">API status</p>
          <p className="text-lg font-semibold">
            {activeKeys > 0 ? "Active" : "Not connected"}
          </p>
          <p className="text-xs text-muted-foreground">
            {activeKeys} active credential{activeKeys === 1 ? "" : "s"}
          </p>
        </div>
        <div className="space-y-1.5 rounded-lg border border-border bg-card p-4">
          <p className="eyebrow">Hosted application page</p>
          <a
            href={applyUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="block truncate text-sm underline underline-offset-4"
          >
            {applyUrl}
          </a>
        </div>
      </section>

      <div className="mt-7">
        <TabLinks tabs={TABS} active={tab} basePath="/integration" />
      </div>

      <div className="mt-5">
        {tab === "credentials" ? (
          <Section title="API credentials">
            <ApiKeysPanel clients={clients} />
          </Section>
        ) : null}

        {tab === "website" ? (
          <div className="space-y-5">
            <Section title="Hosted pages — no code">
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Link to these from anywhere on your website. The forms are already built,
                  validated and branded with your institution&apos;s details, and nothing secret
                  reaches the browser.
                </p>
                <CodeBlock
                  label="Links"
                  code={`Apply for admission   ${applyUrl}
Admission enquiry     ${enquiryUrl}`}
                />
              </div>
            </Section>

            <Section title="Widget — one line">
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Drop this where you want the two admission buttons to appear. It renders links to
                  the hosted pages.
                </p>
                <CodeBlock label="HTML" code={widgetSnippet} />
              </div>
            </Section>

            <Section title="Your own form on a static website">
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  If your site is static — plain HTML, Astro, Hugo, Jekyll, a Next.js export — post
                  straight to the public endpoints. They take no API key, so there is nothing to
                  leak, and they accept cross-origin requests from your domain. Submissions are
                  rate limited per visitor.
                </p>
                <CodeBlock
                  label="Enquiry form"
                  copyLabel="Copy snippet"
                  code={`<form id="admission-enquiry">
  <input name="studentName" placeholder="Student name" required />
  <input name="phone" placeholder="Mobile number" required />
  <input name="classInterested" placeholder="Class interested in" />
  <button type="submit">Send enquiry</button>
</form>

<script>
  document
    .getElementById("admission-enquiry")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(event.target));

      const response = await fetch(
        "${origin}/api/public/${institution.institutionId}/leads",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      const result = await response.json();
      if (result.success) {
        event.target.innerHTML =
          "<p>Thank you. Your enquiry number is " + result.leadNumber + "</p>";
      } else {
        alert(result.error.message);
      }
    });
</script>`}
                />
                <p className="text-sm text-muted-foreground">
                  The same endpoint pattern accepts full applications at{" "}
                  <Ref className="text-[11px]">
                    /api/public/{institution.institutionId}/applications
                  </Ref>
                  , and your institution&apos;s name, address and logo can be read from{" "}
                  <Ref className="text-[11px]">/api/public/{institution.institutionId}</Ref> to fill
                  in the site&apos;s header and footer.
                </p>
              </div>
            </Section>

            <Section title="Your own backend">
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  If you do have a server, call the credentialed API from it instead. That gets you
                  an audited caller identity and the ability to read applications back. Never put
                  the secret in browser JavaScript — anyone could read it and submit as your
                  institution.
                </p>
                <CodeBlock
                  label="cURL"
                  copyLabel="Copy cURL"
                  code={`curl -X POST ${origin}/api/v1/leads \\
  -H "Authorization: Bearer <KEY_ID>.<SECRET>" \\
  -H "Content-Type: application/json" \\
  -d '{"studentName":"Rahul Kumar","phone":"9876543210","classInterested":"Grade 5"}'`}
                />
              </div>
            </Section>
          </div>
        ) : null}

        {tab === "api" ? (
          <ApiDocs origin={origin} institutionId={institution.institutionId} />
        ) : null}

        {tab === "connections" ? (
          <Section title="Connected platforms">
            <ConnectionsPanel connections={connections} />
          </Section>
        ) : null}
      </div>
    </>
  );
}
