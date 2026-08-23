import { Download } from "lucide-react";
import { CodeBlock } from "@/components/integration/code-block";
import { Section } from "@/components/shared/definition-list";
import { API_RATE_LIMIT } from "@/lib/constants";
import { Ref } from "@/components/shared/ref";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/shared/copy-button";

const ERROR_CODES: [string, string, string][] = [
  ["VALIDATION_ERROR", "400", "A field is missing or malformed. `error.details` lists each field."],
  ["UNAUTHORIZED", "401", "Credentials are missing or incorrect."],
  ["FORBIDDEN", "403", "The key is revoked, or lacks the permission for this endpoint."],
  ["NOT_FOUND", "404", "No record with that identifier belongs to this institution."],
  ["RATE_LIMITED", "429", `More than ${API_RATE_LIMIT.limit} requests in one minute.`],
  ["INTERNAL_ERROR", "500", "Unexpected server error. Retry with backoff."],
];

function Endpoint({
  method,
  path,
  summary,
  permission,
  children,
}: {
  method: string;
  path: string;
  summary: string;
  permission: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded border border-foreground/25 px-1.5 py-0.5 font-mono text-[11px] font-semibold">
            {method}
          </span>
          <Ref size="md">{path}</Ref>
        </div>
        <p className="text-sm text-muted-foreground">{summary}</p>
        <p className="text-xs text-muted-foreground">
          Requires permission <Ref className="text-[11px]">{permission}</Ref>
        </p>
      </div>
      {children}
    </section>
  );
}

export function ApiDocs({
  origin,
  institutionId,
}: {
  origin: string;
  /** Scopes the OpenAPI examples to one institution's identifiers. */
  institutionId?: string;
}) {
  const specQuery = institutionId ? `?institution=${institutionId}` : "";
  const specJsonUrl = `${origin}/api/v1/openapi.json${specQuery}`;
  const specYamlUrl = `${origin}/api/v1/openapi.yaml${specQuery}`;

  const authHeaderExample = `Authorization: Bearer <KEY_ID>.<SECRET>

# or, as separate headers
X-API-KEY: <KEY_ID>
X-API-SECRET: <SECRET>`;

  const leadBody = `{
  "studentName": "Rahul Kumar",
  "parentName": "Rajesh Kumar",
  "phone": "9876543210",
  "email": "parent@gmail.com",
  "classInterested": "Grade 5",
  "message": "Interested in admission"
}`;

  const leadCurl = `curl -X POST ${origin}/api/v1/leads \\
  -H "Authorization: Bearer <KEY_ID>.<SECRET>" \\
  -H "Content-Type: application/json" \\
  -d '${leadBody.replace(/\n\s*/g, " ")}'`;

  const applicationBody = `{
  "academicYear": "2026-27",
  "student": {
    "firstName": "Rahul",
    "lastName": "Kumar",
    "dateOfBirth": "2016-05-10",
    "gender": "Male"
  },
  "parent": {
    "fatherName": "Rajesh Kumar",
    "motherName": "Anitha Kumar",
    "phone": "9876543210",
    "email": "parent@gmail.com"
  },
  "address": {
    "addressLine1": "Mysore",
    "city": "Mysore",
    "state": "Karnataka",
    "pincode": "570001"
  },
  "academic": {
    "previousInstitution": "ABC School",
    "previousClass": "Grade 4"
  },
  "admission": {
    "applyingFor": "Grade 5"
  }
}`;

  const applicationCurl = `curl -X POST ${origin}/api/v1/applications \\
  -H "Authorization: Bearer <KEY_ID>.<SECRET>" \\
  -H "Content-Type: application/json" \\
  -d '${applicationBody.replace(/\n\s*/g, " ")}'`;

  const readCurl = `curl ${origin}/api/v1/applications/INS0001-APP-000124 \\
  -H "Authorization: Bearer <KEY_ID>.<SECRET>"`;

  return (
    <div className="space-y-5">
      <Section
        title="OpenAPI specification"
        action={
          <div className="flex items-center gap-1.5">
            <Button asChild variant="outline" size="xs">
              <a href={`/api/v1/openapi.json${specQuery}`} download="idap-api.openapi.json">
                <Download className="size-3" />
                JSON
              </a>
            </Button>
            <Button asChild variant="outline" size="xs">
              <a href={`/api/v1/openapi.yaml${specQuery}`} download="idap-api.openapi.yaml">
                <Download className="size-3" />
                YAML
              </a>
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            An OpenAPI 3.1 document describing every endpoint, request body, response and error
            code below. Hand it to whoever — or whatever — builds your website: it explains which
            endpoints are safe to call from a static site and includes a working form example.{" "}
            {institutionId ? (
              <>
                It is generated for <Ref className="text-[11px]">{institutionId}</Ref>, so the
                examples use your own identifier format.
              </>
            ) : (
              "Download it from an institution's Integration page to get that tenant's examples."
            )}{" "}
            Point Swagger UI, Postman, Insomnia or a client generator straight at the URL — it needs
            no credentials to read.
          </p>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-mist px-3 py-2">
            <Ref className="min-w-0 flex-1 truncate">{specJsonUrl}</Ref>
            <CopyButton value={specJsonUrl} size="xs" variant="ghost" label="Copy URL" />
          </div>

          <CodeBlock
            label="Generate a typed client"
            copyLabel="Copy command"
            code={`npx openapi-typescript ${specJsonUrl} -o idap-api.d.ts`}
          />
          <CodeBlock
            label="Import into Postman or Insomnia"
            code={`# Postman  → Import → Link → paste the URL
# Insomnia → Import → From URL → paste the URL

${specYamlUrl}`}
          />
        </div>
      </Section>

      <Section title="Authentication">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Every request carries an API key and secret. The institution is derived from the
            credential itself, so an institution ID in the request body is ignored. Keep the secret
            on your server — never in browser JavaScript.
          </p>
          <CodeBlock label="Request headers" code={authHeaderExample} />
        </div>
      </Section>

      <Section title="Endpoints">
        <div className="space-y-6">
          <Endpoint
            method="POST"
            path="/api/v1/leads"
            summary="Create an admission enquiry."
            permission="CREATE_LEAD"
          >
            <div className="grid gap-3 lg:grid-cols-2">
              <CodeBlock label="Request body" code={leadBody} />
              <CodeBlock
                label="Response · 201"
                code={`{
  "success": true,
  "leadNumber": "INS0001-LD000128",
  "message": "Enquiry submitted successfully"
}`}
              />
            </div>
            <CodeBlock label="cURL" copyLabel="Copy cURL" code={leadCurl} />
          </Endpoint>

          <Endpoint
            method="POST"
            path="/api/v1/applications"
            summary="Create an admission application."
            permission="CREATE_APPLICATION"
          >
            <div className="grid gap-3 lg:grid-cols-2">
              <CodeBlock label="Request body" code={applicationBody} />
              <CodeBlock
                label="Response · 201"
                code={`{
  "success": true,
  "applicationNumber": "INS0001-APP-000124",
  "status": "SUBMITTED"
}`}
              />
            </div>
            <CodeBlock label="cURL" copyLabel="Copy cURL" code={applicationCurl} />
          </Endpoint>

          <Endpoint
            method="GET"
            path="/api/v1/applications/{applicationNumber}"
            summary="Read one application. Notes, activity and internal fields are never returned."
            permission="READ_APPLICATION"
          >
            <CodeBlock label="cURL" copyLabel="Copy cURL" code={readCurl} />
          </Endpoint>
        </div>
      </Section>

      <Section title="Rate limits">
        <p className="text-sm text-muted-foreground">
          {API_RATE_LIMIT.limit} requests per minute per API key. Responses carry{" "}
          <Ref className="text-[11px]">X-RateLimit-Remaining</Ref> and{" "}
          <Ref className="text-[11px]">X-RateLimit-Reset</Ref>. Exceeding the limit returns{" "}
          <Ref className="text-[11px]">429</Ref> with a{" "}
          <Ref className="text-[11px]">Retry-After</Ref> header.
        </p>
      </Section>

      <Section title="Error codes">
        <div className="space-y-3">
          <CodeBlock
            label="Error shape"
            code={`{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "phone: Phone number is required"
  }
}`}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-2 pr-4 font-medium">Code</th>
                  <th className="py-2 pr-4 font-medium">HTTP</th>
                  <th className="py-2 font-medium">When it happens</th>
                </tr>
              </thead>
              <tbody>
                {ERROR_CODES.map(([code, status, description]) => (
                  <tr key={code} className="border-b border-border last:border-0">
                    <td className="py-2 pr-4">
                      <Ref>{code}</Ref>
                    </td>
                    <td className="tabular py-2 pr-4 text-muted-foreground">{status}</td>
                    <td className="py-2 text-muted-foreground">{description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>
    </div>
  );
}
