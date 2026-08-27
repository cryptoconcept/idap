import {
  API_RATE_LIMIT,
  APPLICATION_STATUSES,
  DOCUMENT_TYPES,
  PUBLIC_FORM_RATE_LIMIT,
  RESULT_BOARDS,
  RESULT_LEVELS,
} from "@/lib/constants";

/**
 * The OpenAPI description of the external API, generated from the same
 * constants the runtime uses so the document cannot drift from the code.
 *
 * When an institution is supplied, every example is pre-filled with that
 * institution's real identifiers — the spec an integrator downloads from their
 * own dashboard is the one for their tenant.
 */
export type OpenApiOptions = {
  origin: string;
  institutionId?: string;
  institutionName?: string;
  slug?: string;
};

const PLACEHOLDER_ID = "INS0001";

/** Documented error codes, and what each one means to a caller. */
const ERROR_CATALOGUE: {
  status: number;
  code: string;
  summary: string;
  message: string;
}[] = [
  {
    status: 400,
    code: "VALIDATION_ERROR",
    summary: "A field is missing or malformed",
    message: "phone: Phone number is required",
  },
  {
    status: 401,
    code: "UNAUTHORIZED",
    summary: "Credentials are missing or incorrect",
    message: "Invalid API credentials",
  },
  {
    status: 403,
    code: "FORBIDDEN",
    summary: "The credential is revoked, or lacks the permission this endpoint requires",
    message: "This API key is not permitted to perform CREATE_APPLICATION",
  },
  {
    status: 404,
    code: "NOT_FOUND",
    summary: "No record with that identifier belongs to this institution",
    message: "Application not found",
  },
  {
    status: 429,
    code: "RATE_LIMITED",
    summary: "The per-key rate limit was exceeded",
    message: `Rate limit exceeded. Maximum ${API_RATE_LIMIT.limit} requests per minute.`,
  },
  {
    status: 500,
    code: "INTERNAL_ERROR",
    summary: "Unexpected server error. Retry with backoff",
    message: "Something went wrong. Please try again.",
  },
];

const RATE_LIMIT_HEADERS = {
  "X-RateLimit-Limit": {
    description: "Requests allowed in the current window.",
    schema: { type: "integer", example: API_RATE_LIMIT.limit },
  },
  "X-RateLimit-Remaining": {
    description: "Requests left in the current window.",
    schema: { type: "integer", example: 97 },
  },
  "X-RateLimit-Reset": {
    description: "Unix seconds at which the window resets.",
    schema: { type: "integer", example: 1787330520 },
  },
} as const;

function errorResponses(codes: string[]) {
  return Object.fromEntries(
    ERROR_CATALOGUE.filter((entry) => codes.includes(entry.code)).map((entry) => [
      String(entry.status),
      {
        description: entry.summary,
        headers: entry.code === "RATE_LIMITED" ? {
          "Retry-After": {
            description: "Seconds to wait before retrying.",
            schema: { type: "integer", example: 42 },
          },
          ...RATE_LIMIT_HEADERS,
        } : undefined,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" },
            example: {
              success: false,
              error: { code: entry.code, message: entry.message },
            },
          },
        },
      },
    ]),
  );
}

export function buildOpenApiDocument(options: OpenApiOptions): Record<string, unknown> {
  const institutionId = options.institutionId ?? PLACEHOLDER_ID;
  const scoped = Boolean(options.institutionId);

  const leadNumber = `${institutionId}-LD000128`;
  const applicationNumber = `${institutionId}-APP-000124`;

  const publicBase = scoped
    ? `/api/public/${institutionId}`
    : "/api/public/{institutionId}";

  const slugPath = options.slug
    ? `/api/public/institutions/${options.slug}`
    : "/api/public/institutions/{slug}";

  const description = [
    "Two ways to send admission enquiries and applications to this platform. Pick by where your",
    "code runs.",
    "",
    "## Building a static website? Use the Website endpoints",
    "",
    "A static site — plain HTML/JS, Astro, Hugo, Jekyll, a Next.js export, anything with no server",
    "of its own — should call the **Website** endpoints under `/api/public`. They:",
    "",
    "- take **no API key and no secret**, so there is nothing to leak,",
    "- are CORS-enabled, so a browser on the institution's own domain can call them directly,",
    "- are rate limited per visitor IP.",
    "",
    "```html",
    '<form id="enquiry">',
    '  <input name="studentName" required>',
    '  <input name="phone" required>',
    '  <input name="classInterested">',
    "</form>",
    "<script>",
    'document.getElementById("enquiry").addEventListener("submit", async (event) => {',
    "  event.preventDefault();",
    "  const body = Object.fromEntries(new FormData(event.target));",
    `  const response = await fetch("${options.origin}${publicBase}/leads", {`,
    '    method: "POST",',
    '    headers: { "Content-Type": "application/json" },',
    "    body: JSON.stringify(body),",
    "  });",
    "  const result = await response.json();",
    "  // result.leadNumber is the reference to show the visitor",
    "});",
    "</script>",
    "```",
    "",
    "**Never put an API key or secret in browser JavaScript.** Anyone viewing source could read it",
    "and submit as this institution. If you find yourself needing a key on a static site, you have",
    "picked the wrong set of endpoints.",
    "",
    "### No-code option",
    "",
    "If you would rather not build the forms at all, link to the hosted pages, which are already",
    "styled and validated:",
    "",
    "```",
    `${options.origin}/apply/${institutionId}            Apply for admission`,
    `${options.origin}/apply/${institutionId}/enquiry    Admission enquiry`,
    "```",
    "",
    "Or drop in the widget, which renders both buttons:",
    "",
    "```html",
    `<script src="${options.origin}/widget.js" data-institution="${institutionId}"></script>`,
    "```",
    "",
    "## Have a server? Use the Server-to-server endpoints",
    "",
    "Endpoints under `/api/v1` take an API key and secret, issued from **Integration → API",
    "credentials** in the dashboard. Call them only from your own backend:",
    "",
    "```",
    "Authorization: Bearer <KEY_ID>.<SECRET>",
    "```",
    "",
    "or as a header pair:",
    "",
    "```",
    "X-API-KEY: <KEY_ID>",
    "X-API-SECRET: <SECRET>",
    "```",
    "",
    "They add what a static site cannot have: reading applications back, and an audited caller",
    "identity per integration.",
    "",
    "## Common to both",
    "",
    "The institution is never taken from the request body. Server-to-server calls derive it from the",
    "credential; website calls take it from the URL path.",
    "",
    `Rate limits: ${API_RATE_LIMIT.limit} requests per minute per API key, and ${PUBLIC_FORM_RATE_LIMIT.limit} submissions per minute per visitor IP`,
    "on the website endpoints. Exceeding either returns `429` with `Retry-After`.",
    "",
    "Failures always use the same envelope, with an appropriate HTTP status:",
    "",
    "```json",
    '{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "phone: Phone number is required" } }',
    "```",
    "",
    scoped
      ? `This document is generated for **${options.institutionName ?? institutionId}** (\`${institutionId}\`). Every path and example below is concrete — there is nothing to substitute.`
      : "Examples use the placeholder institution `INS0001`. Download this document from an institution's Integration page to get one with its real paths filled in.",
  ].join("\n");

  return {
    openapi: "3.1.0",
    info: {
      title: scoped
        ? `I-DAP API · ${options.institutionName ?? institutionId}`
        : "I-DAP API",
      version: "1.0.0",
      summary: "Admission enquiries and applications for educational institutions.",
      description,
    },
    servers: [{ url: options.origin, description: "This deployment" }],
    security: [{ bearerAuth: [] }, { apiKeyHeader: [], apiSecretHeader: [] }],
    tags: [
      {
        name: "Website",
        description:
          "Called directly from a visitor's browser on the institution's own site. No credentials, CORS-enabled, rate limited per IP. This is what a static website should use.",
      },
      {
        name: "Server to server",
        description:
          "Called from your own backend with an API key and secret. Never from browser JavaScript.",
      },
      {
        name: "Staff app",
        description:
          "Used by the institution staff mobile app. Bearer tokens, obtained with a staff email and password. Not for external integrations.",
      },
    ],
    paths: {
      [`${publicBase}/leads`]: {
      ...(scoped
        ? {}
        : {
            parameters: [
              {
                name: "institutionId",
                in: "path",
                required: true,
                description: "The institution receiving the submission, e.g. `INS0001`.",
                schema: { type: "string", example: PLACEHOLDER_ID },
              },
            ],
          }),
        post: {
          tags: ["Website"],
          summary: "Submit an admission enquiry from a website",
          description:
            "Records an enquiry for this institution. Takes no credentials and is safe to call from browser JavaScript on a static site. Rate limited per visitor IP.",
          operationId: "submitWebsiteEnquiry",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateLeadRequest" },
                example: {
                  studentName: "Rahul Kumar",
                  parentName: "Rajesh Kumar",
                  phone: "9876543210",
                  email: "parent@gmail.com",
                  classInterested: "Grade 5",
                  message: "Interested in admission",
                },
              },
            },
          },
          responses: {
            "201": {
              description:
                "Enquiry recorded. Show `leadNumber` to the visitor as their reference.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateLeadResponse" },
                  example: {
                    success: true,
                    leadNumber,
                    message: "Enquiry submitted successfully",
                  },
                },
              },
            },
            ...errorResponses([
              "VALIDATION_ERROR",
              "NOT_FOUND",
              "RATE_LIMITED",
              "INTERNAL_ERROR",
            ]),
          },
        },
      },

      [`${publicBase}/applications`]: {
      ...(scoped
        ? {}
        : {
            parameters: [
              {
                name: "institutionId",
                in: "path",
                required: true,
                description: "The institution receiving the submission, e.g. `INS0001`.",
                schema: { type: "string", example: PLACEHOLDER_ID },
              },
            ],
          }),
        post: {
          tags: ["Website"],
          summary: "Submit an admission application from a website",
          description:
            "Records a full admission application for this institution. Takes no credentials and is safe to call from browser JavaScript on a static site. Rate limited per visitor IP.",
          operationId: "submitWebsiteApplication",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateApplicationRequest" },
                example: {
                  academicYear: "2026-27",
                  student: {
                    firstName: "Rahul",
                    lastName: "Kumar",
                    dateOfBirth: "2016-05-10",
                    gender: "Male",
                  },
                  parent: {
                    fatherName: "Rajesh Kumar",
                    motherName: "Anitha Kumar",
                    phone: "9876543210",
                    email: "parent@gmail.com",
                  },
                  address: {
                    addressLine1: "Mysore",
                    city: "Mysore",
                    state: "Karnataka",
                    pincode: "570001",
                  },
                  academic: {
                    previousInstitution: "ABC School",
                    previousClass: "Grade 4",
                  },
                  admission: { applyingFor: "Grade 5" },
                },
              },
            },
          },
          responses: {
            "201": {
              description:
                "Application recorded. Show `applicationNumber` to the visitor and tell them to keep it.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateApplicationResponse" },
                  example: { success: true, applicationNumber, status: "SUBMITTED" },
                },
              },
            },
            ...errorResponses([
              "VALIDATION_ERROR",
              "NOT_FOUND",
              "RATE_LIMITED",
              "INTERNAL_ERROR",
            ]),
          },
        },
      },

      [publicBase]: {
      ...(scoped
        ? {}
        : {
            parameters: [
              {
                name: "institutionId",
                in: "path",
                required: true,
                description: "The institution receiving the submission, e.g. `INS0001`.",
                schema: { type: "string", example: PLACEHOLDER_ID },
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "Read the institution's public profile",
          description:
            "Name, address, phone, email, website and logo — enough to build the site's header, footer and contact section from live data instead of hard-coding it. No credentials required.",
          operationId: "getInstitutionProfile",
          security: [],
          responses: {
            "200": {
              description: "The institution's public details.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/InstitutionProfileResponse" },
                },
              },
            },
            ...errorResponses(["NOT_FOUND", "INTERNAL_ERROR"]),
          },
        },
      },

      [`${publicBase}/profile`]: {
      ...(scoped
        ? {}
        : {
            parameters: [
              {
                name: "institutionId",
                in: "path",
                required: true,
                description: "The institution whose public profile to read, e.g. `INS0001`.",
                schema: { type: "string", example: PLACEHOLDER_ID },
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "Read the institution's full public profile",
          description:
            "Everything a hosted profile page or a website integration needs to render the institution — contact details, academics, facilities, and social links — sourced from the same profile the institution publishes once. Only a `PUBLISHED` and active institution's profile is returned; a draft, suspended or nonexistent one 404s, so a caller cannot tell them apart. No credentials required.",
          operationId: "getPublicProfileById",
          security: [],
          responses: {
            "200": {
              description: "The institution's public profile.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicProfileResponse" },
                },
              },
            },
            ...errorResponses(["NOT_FOUND", "INTERNAL_ERROR"]),
          },
        },
      },

      [`${publicBase}/results`]: {
      ...(scoped
        ? {}
        : {
            parameters: [
              {
                name: "institutionId",
                in: "path",
                required: true,
                schema: { type: "string" },
                description: "Institution id, e.g. INS0001",
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "List the institution's published exam results",
          description:
            "Published exam-cycle results, newest academic year first. Toppers appear only where the institution has confirmed consent to publish. Cached for five minutes.",
          operationId: "listPublicResultsById",
          security: [],
          parameters: [
            { name: "academicYear", in: "query", required: false, schema: { type: "string" }, example: "2025-26" },
            { name: "level", in: "query", required: false, schema: { type: "string", enum: [...RESULT_LEVELS] } },
            { name: "board", in: "query", required: false, schema: { type: "string", enum: [...RESULT_BOARDS] } },
          ],
          responses: {
            "200": {
              description: "Published results for this institution",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicResultsResponse" },
                },
              },
            },
            ...errorResponses(["VALIDATION_ERROR", "NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"]),
          },
        },
      },

      [`${publicBase}/fees`]: {
      ...(scoped
        ? {}
        : {
            parameters: [
              {
                name: "institutionId",
                in: "path",
                required: true,
                schema: { type: "string" },
                description: "Institution id, e.g. INS0001",
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "List the institution's published fee structures",
          description:
            "Published fee structures — itemized line items per class or course, per academic year — newest academic year first. Cached for five minutes.",
          operationId: "listPublicFeeStructuresById",
          security: [],
          parameters: [
            { name: "academicYear", in: "query", required: false, schema: { type: "string" }, example: "2026-27" },
          ],
          responses: {
            "200": {
              description: "Published fee structures for this institution",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicFeeStructuresResponse" },
                },
              },
            },
            ...errorResponses(["VALIDATION_ERROR", "NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"]),
          },
        },
      },

      [`${publicBase}/scholarships`]: {
      ...(scoped
        ? {}
        : {
            parameters: [
              {
                name: "institutionId",
                in: "path",
                required: true,
                schema: { type: "string" },
                description: "Institution id, e.g. INS0001",
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "List the institution's published scholarships",
          description: "Published scholarships, newest first. No credentials required.",
          operationId: "listPublicScholarshipsById",
          security: [],
          responses: {
            "200": {
              description: "Published scholarships for this institution",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicScholarshipsResponse" },
                },
              },
            },
            ...errorResponses(["NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"]),
          },
        },
      },

      [`${publicBase}/offers`]: {
      ...(scoped
        ? {}
        : {
            parameters: [
              {
                name: "institutionId",
                in: "path",
                required: true,
                schema: { type: "string" },
                description: "Institution id, e.g. INS0001",
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "List the institution's published, unexpired offers",
          description: "Published offers that have not expired, newest first. No credentials required.",
          operationId: "listPublicOffersById",
          security: [],
          responses: {
            "200": {
              description: "Published offers for this institution",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicOffersResponse" },
                },
              },
            },
            ...errorResponses(["NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"]),
          },
        },
      },

      [slugPath]: {
      ...(options.slug
        ? {}
        : {
            parameters: [
              {
                name: "slug",
                in: "path",
                required: true,
                description: "The institution's public slug, from its profile URL.",
                schema: { type: "string", example: "infinity-school-mysore" },
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "Read the institution's full public profile, by slug",
          description:
            "Identical payload to the id-keyed route above, looked up by the institution's public slug instead — what a hosted profile page's pretty URL calls. Only a `PUBLISHED` and active institution's profile is returned; a draft, suspended or nonexistent one 404s. No credentials required.",
          operationId: "getPublicProfileBySlug",
          security: [],
          responses: {
            "200": {
              description: "The institution's public profile.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicProfileResponse" },
                },
              },
            },
            ...errorResponses(["NOT_FOUND", "INTERNAL_ERROR"]),
          },
        },
      },

      [`${slugPath}/results`]: {
      ...(options.slug
        ? {}
        : {
            parameters: [
              {
                name: "slug",
                in: "path",
                required: true,
                description: "The institution's public slug, from its profile URL.",
                schema: { type: "string", example: "infinity-school-mysore" },
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "List the institution's published exam results, by slug",
          description:
            "Published exam-cycle results, newest academic year first. Toppers appear only where the institution has confirmed consent to publish. Cached for five minutes.",
          operationId: "listPublicResultsBySlug",
          security: [],
          parameters: [
            { name: "academicYear", in: "query", required: false, schema: { type: "string" }, example: "2025-26" },
            { name: "level", in: "query", required: false, schema: { type: "string", enum: [...RESULT_LEVELS] } },
            { name: "board", in: "query", required: false, schema: { type: "string", enum: [...RESULT_BOARDS] } },
          ],
          responses: {
            "200": {
              description: "Published results for this institution",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicResultsResponse" },
                },
              },
            },
            ...errorResponses(["VALIDATION_ERROR", "NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"]),
          },
        },
      },

      [`${slugPath}/fees`]: {
      ...(options.slug
        ? {}
        : {
            parameters: [
              {
                name: "slug",
                in: "path",
                required: true,
                description: "The institution's public slug, from its profile URL.",
                schema: { type: "string", example: "infinity-school-mysore" },
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "List the institution's published fee structures, by slug",
          description:
            "Published fee structures — itemized line items per class or course, per academic year — newest academic year first. Cached for five minutes.",
          operationId: "listPublicFeeStructuresBySlug",
          security: [],
          parameters: [
            { name: "academicYear", in: "query", required: false, schema: { type: "string" }, example: "2026-27" },
          ],
          responses: {
            "200": {
              description: "Published fee structures for this institution",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicFeeStructuresResponse" },
                },
              },
            },
            ...errorResponses(["VALIDATION_ERROR", "NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"]),
          },
        },
      },

      [`${slugPath}/scholarships`]: {
      ...(options.slug
        ? {}
        : {
            parameters: [
              {
                name: "slug",
                in: "path",
                required: true,
                description: "The institution's public slug, from its profile URL.",
                schema: { type: "string", example: "infinity-school-mysore" },
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "List the institution's published scholarships, by slug",
          description: "Published scholarships, newest first. No credentials required.",
          operationId: "listPublicScholarshipsBySlug",
          security: [],
          responses: {
            "200": {
              description: "Published scholarships for this institution",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicScholarshipsResponse" },
                },
              },
            },
            ...errorResponses(["NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"]),
          },
        },
      },

      [`${slugPath}/offers`]: {
      ...(options.slug
        ? {}
        : {
            parameters: [
              {
                name: "slug",
                in: "path",
                required: true,
                description: "The institution's public slug, from its profile URL.",
                schema: { type: "string", example: "infinity-school-mysore" },
              },
            ],
          }),
        get: {
          tags: ["Website"],
          summary: "List the institution's published, unexpired offers, by slug",
          description: "Published offers that have not expired, newest first. No credentials required.",
          operationId: "listPublicOffersBySlug",
          security: [],
          responses: {
            "200": {
              description: "Published offers for this institution",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicOffersResponse" },
                },
              },
            },
            ...errorResponses(["NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR"]),
          },
        },
      },

      "/api/v1/leads": {
        post: {
          tags: ["Server to server"],
          summary: "Create an admission enquiry",
          description:
            "Records an enquiry against the institution that owns the credential. Requires the `CREATE_LEAD` permission.",
          operationId: "createLead",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateLeadRequest" },
                example: {
                  studentName: "Rahul Kumar",
                  parentName: "Rajesh Kumar",
                  phone: "9876543210",
                  email: "parent@gmail.com",
                  classInterested: "Grade 5",
                  message: "Interested in admission",
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Enquiry recorded.",
              headers: RATE_LIMIT_HEADERS,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateLeadResponse" },
                  example: {
                    success: true,
                    leadNumber,
                    message: "Enquiry submitted successfully",
                  },
                },
              },
            },
            ...errorResponses([
              "VALIDATION_ERROR",
              "UNAUTHORIZED",
              "FORBIDDEN",
              "RATE_LIMITED",
              "INTERNAL_ERROR",
            ]),
          },
        },
      },

      "/api/v1/applications": {
        post: {
          tags: ["Server to server"],
          summary: "Create an admission application",
          description:
            "Records a full admission application. Requires the `CREATE_APPLICATION` permission.",
          operationId: "createApplication",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateApplicationRequest" },
                example: {
                  academicYear: "2026-27",
                  student: {
                    firstName: "Rahul",
                    lastName: "Kumar",
                    dateOfBirth: "2016-05-10",
                    gender: "Male",
                  },
                  parent: {
                    fatherName: "Rajesh Kumar",
                    motherName: "Anitha Kumar",
                    phone: "9876543210",
                    email: "parent@gmail.com",
                  },
                  address: {
                    addressLine1: "Mysore",
                    city: "Mysore",
                    state: "Karnataka",
                    pincode: "570001",
                  },
                  academic: {
                    previousInstitution: "ABC School",
                    previousClass: "Grade 4",
                  },
                  admission: { applyingFor: "Grade 5" },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Application recorded.",
              headers: RATE_LIMIT_HEADERS,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateApplicationResponse" },
                  example: { success: true, applicationNumber, status: "SUBMITTED" },
                },
              },
            },
            ...errorResponses([
              "VALIDATION_ERROR",
              "UNAUTHORIZED",
              "FORBIDDEN",
              "RATE_LIMITED",
              "INTERNAL_ERROR",
            ]),
          },
        },
      },

      "/api/v1/applications/{applicationNumber}": {
        get: {
          tags: ["Server to server"],
          summary: "Read an admission application",
          description:
            "Returns one application belonging to the credential's institution. Requires the `READ_APPLICATION` permission. Notes, activity and internal metadata are never returned.",
          operationId: "getApplication",
          parameters: [
            {
              name: "applicationNumber",
              in: "path",
              required: true,
              description: "The application number issued at submission.",
              schema: { type: "string", example: applicationNumber },
            },
          ],
          responses: {
            "200": {
              description: "The application.",
              headers: RATE_LIMIT_HEADERS,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GetApplicationResponse" },
                },
              },
            },
            ...errorResponses([
              "UNAUTHORIZED",
              "FORBIDDEN",
              "NOT_FOUND",
              "RATE_LIMITED",
              "INTERNAL_ERROR",
            ]),
          },
        },
      },

      "/api/auth/token": {
        post: {
          tags: ["Staff app"],
          summary: "Exchange staff credentials for tokens",
          description:
            "Returns a 15-minute access token and a 30-day refresh token. Refresh tokens are single-use and rotate on every refresh. Platform administrators are refused.",
          operationId: "issueStaffToken",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password", "deviceId"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string" },
                    deviceId: {
                      type: "string",
                      description: "Stable per-installation id, so one device can be signed out alone.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Tokens issued.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", const: true },
                      accessToken: { type: "string" },
                      refreshToken: { type: "string" },
                      expiresIn: { type: "integer", example: 900 },
                      user: {
                        type: "object",
                        description:
                          "The signed-in member of staff. Returned so the app can show an account without decoding the access token.",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          email: { type: "string", format: "email" },
                          institutionId: { type: "string", example: "INS0001" },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses([
              "VALIDATION_ERROR",
              "UNAUTHORIZED",
              "FORBIDDEN",
              "RATE_LIMITED",
              "INTERNAL_ERROR",
            ]),
          },
        },
      },

      "/api/auth/token/refresh": {
        post: {
          tags: ["Staff app"],
          summary: "Rotate a refresh token",
          description:
            "Consumes the refresh token and returns a new pair. Presenting an already-used token revokes every token for that device.",
          operationId: "refreshStaffToken",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["refreshToken"],
                  properties: { refreshToken: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "New token pair.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", const: true },
                      accessToken: { type: "string" },
                      refreshToken: { type: "string" },
                      expiresIn: { type: "integer", example: 900 },
                    },
                  },
                },
              },
            },
            ...errorResponses(["VALIDATION_ERROR", "UNAUTHORIZED", "INTERNAL_ERROR"]),
          },
        },
      },

      "/api/auth/token/revoke": {
        post: {
          tags: ["Staff app"],
          summary: "Sign out",
          description:
            "Revokes the refresh token and unregisters that installation's push devices. Always reports success, whether or not the token was live, so it cannot be used to probe a token's state.",
          operationId: "revokeStaffToken",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["refreshToken"],
                  properties: { refreshToken: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Signed out.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", const: true },
                      message: { type: "string", example: "Signed out" },
                    },
                  },
                },
              },
            },
            ...errorResponses(["VALIDATION_ERROR", "INTERNAL_ERROR"]),
          },
        },
      },

      "/api/devices": {
        post: {
          tags: ["Staff app"],
          summary: "Register this device for push notifications",
          description:
            "The institution is taken from the access token, never from the body. Re-registering the same push token updates the existing record. Send the same `deviceId` used at token issue: signing out drops that installation's registrations by it.",
          operationId: "registerDevice",
          security: [{ staffAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["deviceId", "pushToken"],
                  properties: {
                    deviceId: {
                      type: "string",
                      description: "The same stable per-installation id sent to `POST /api/auth/token`.",
                    },
                    pushToken: { type: "string" },
                    platform: { type: "string", enum: ["android", "ios"], default: "android" },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Device registered.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", const: true },
                      device: {
                        type: "object",
                        properties: { id: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses([
              "VALIDATION_ERROR",
              "UNAUTHORIZED",
              "FORBIDDEN",
              "INTERNAL_ERROR",
            ]),
          },
        },
      },
    },

    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "`Authorization: Bearer <KEY_ID>.<SECRET>`",
        },
        apiKeyHeader: {
          type: "apiKey",
          in: "header",
          name: "X-API-KEY",
          description: "The key id. Send alongside `X-API-SECRET`.",
        },
        apiSecretHeader: {
          type: "apiKey",
          in: "header",
          name: "X-API-SECRET",
          description: "The secret. Send alongside `X-API-KEY`.",
        },
        staffAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Access token from `POST /api/auth/token`. Expires after 15 minutes; refresh with `POST /api/auth/token/refresh`.",
        },
      },

      schemas: {
        ErrorResponse: {
          type: "object",
          required: ["success", "error"],
          properties: {
            success: { type: "boolean", const: false },
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: {
                  type: "string",
                  enum: ERROR_CATALOGUE.map((entry) => entry.code),
                  description: ERROR_CATALOGUE.map(
                    (entry) => `- \`${entry.code}\` (${entry.status}) — ${entry.summary}`,
                  ).join("\n"),
                },
                message: { type: "string", description: "Human-readable explanation." },
                details: {
                  type: "array",
                  description: "Present on validation errors: one entry per rejected field.",
                  items: {
                    type: "object",
                    properties: {
                      field: { type: "string", example: "phone" },
                      message: { type: "string", example: "Phone number is required" },
                    },
                  },
                },
              },
            },
          },
        },

        InstitutionProfileResponse: {
          type: "object",
          required: ["success", "institution"],
          properties: {
            success: { type: "boolean", const: true },
            institution: {
              type: "object",
              properties: {
                institutionId: { type: "string", example: institutionId },
                institutionName: {
                  type: "string",
                  example: options.institutionName ?? "Infinity School of Excellence",
                },
                institutionType: { type: "string", example: "SCHOOL" },
                address: { type: "string" },
                city: { type: "string" },
                state: { type: "string" },
                pincode: { type: "string" },
                phone: { type: "string" },
                email: { type: "string", format: "email" },
                website: { type: "string", format: "uri" },
                logoUrl: { type: "string", format: "uri" },
              },
            },
          },
        },

        PublicProfileResponse: {
          type: "object",
          required: ["success", "profile"],
          properties: {
            success: { type: "boolean", const: true },
            profile: {
              type: "object",
              description:
                "An allow-list projection: only fields named here ever leave the server, whatever else the institution's record holds.",
              properties: {
                institutionId: { type: "string", example: institutionId },
                slug: {
                  type: "string",
                  description: "Present once the institution has claimed a public slug.",
                  example: options.slug ?? "infinity-school-mysore",
                },
                institutionName: {
                  type: "string",
                  example: options.institutionName ?? "Infinity School of Excellence",
                },
                legalName: { type: "string" },
                shortName: { type: "string" },
                institutionType: { type: "string", example: "SCHOOL" },
                regionCode: { type: "string" },
                tagline: { type: "string" },
                description: { type: "string" },
                establishedYear: { type: "integer", example: 1998 },
                logoUrl: { type: "string", format: "uri" },
                coverImageUrl: { type: "string", format: "uri" },
                address: {
                  type: "object",
                  properties: {
                    addressLine1: { type: "string" },
                    addressLine2: { type: "string" },
                    locality: { type: "string" },
                    area: { type: "string" },
                    city: { type: "string" },
                    taluk: { type: "string" },
                    district: { type: "string" },
                    state: { type: "string" },
                    country: { type: "string" },
                    pincode: { type: "string" },
                  },
                },
                geo: {
                  type: "object",
                  properties: {
                    latitude: { type: "number" },
                    longitude: { type: "number" },
                    mapUrl: { type: "string", format: "uri" },
                  },
                },
                contact: {
                  type: "object",
                  properties: {
                    phone: { type: "string" },
                    secondaryPhone: { type: "string" },
                    whatsapp: { type: "string" },
                    email: { type: "string", format: "email" },
                    alternateEmail: { type: "string", format: "email" },
                    website: { type: "string", format: "uri" },
                    contactPerson: { type: "string" },
                  },
                },
                academic: {
                  type: "object",
                  properties: {
                    board: { type: "string" },
                    affiliation: { type: "string" },
                    recognition: { type: "string" },
                    affiliationNumber: { type: "string" },
                    udiseCode: { type: "string" },
                    medium: { type: "array", items: { type: "string" } },
                    genderType: { type: "string" },
                    currentAcademicYear: { type: "string" },
                    classesOffered: { type: "array", items: { type: "string" } },
                    coursesOffered: { type: "array", items: { type: "string" } },
                  },
                },
                management: {
                  type: "object",
                  description: "Names and designations only. The head's direct line is not public.",
                  properties: {
                    managementType: { type: "string" },
                    trustName: { type: "string" },
                    societyName: { type: "string" },
                    managementName: { type: "string" },
                    principalName: { type: "string" },
                    headDesignation: { type: "string" },
                  },
                },
                facilities: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      code: { type: "string" },
                      label: { type: "string" },
                      available: { type: "boolean" },
                      note: { type: "string" },
                    },
                  },
                },
                social: {
                  type: "object",
                  properties: {
                    facebook: { type: "string", format: "uri" },
                    instagram: { type: "string", format: "uri" },
                    youtube: { type: "string", format: "uri" },
                    linkedin: { type: "string", format: "uri" },
                    x: { type: "string", format: "uri" },
                    other: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          label: { type: "string" },
                          url: { type: "string", format: "uri" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },

        PublicResultsResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            results: {
              type: "array",
              items: { $ref: "#/components/schemas/PublicResult" },
            },
          },
        },

        PublicResult: {
          type: "object",
          properties: {
            board: { type: "string", example: "CBSE" },
            boardLabel: { type: "string", example: "CBSE" },
            level: { type: "string", example: "CLASS_10" },
            stream: { type: "string", nullable: true, example: null },
            academicYear: { type: "string", example: "2025-26" },
            examLabel: { type: "string", example: "CBSE Class 10 Board Exam" },
            appeared: { type: "integer", example: 142 },
            passed: { type: "integer", example: 140 },
            passPercentage: { type: "number", nullable: true, example: 98.6 },
            averageScore: { type: "number", example: 82.4 },
            highestScore: { type: "number", example: 98.6 },
            bands: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", example: "90% and above" },
                  minPercentage: { type: "number", example: 90 },
                  maxPercentage: { type: "number", example: 100 },
                  count: { type: "integer", example: 38 },
                },
              },
            },
            toppers: {
              type: "array",
              description: "Only toppers whose consent to publish the institution has confirmed.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", example: "Priya S" },
                  percentage: { type: "number", example: 98.6 },
                  rank: { type: "integer", example: 1 },
                  note: { type: "string", example: "School topper" },
                  photoUrl: { type: "string", example: "https://cdn.example/media/INS0001/results/…" },
                },
              },
            },
            publishedAt: { type: "string", format: "date-time" },
          },
        },

        PublicFeeStructuresResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            feeStructures: {
              type: "array",
              items: { $ref: "#/components/schemas/PublicFeeStructure" },
            },
          },
        },

        PublicFeeStructure: {
          type: "object",
          properties: {
            classOrCourse: { type: "string", example: "Grade 10" },
            academicYear: { type: "string", example: "2026-27" },
            lineItems: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", example: "Tuition" },
                  amount: { type: "number", example: 60000 },
                  frequency: { type: "string", enum: ["ONE_TIME", "ANNUAL"], example: "ANNUAL" },
                  optional: { type: "boolean", example: false },
                },
              },
            },
            publishedAt: { type: "string", format: "date-time" },
          },
        },

        PublicScholarshipsResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            scholarships: {
              type: "array",
              items: { $ref: "#/components/schemas/PublicScholarship" },
            },
          },
        },

        PublicScholarship: {
          type: "object",
          properties: {
            name: { type: "string", example: "Merit Scholarship" },
            criteria: { type: "string", example: "Above 90% in the previous board exam" },
            amount: { type: "string", example: "₹10,000" },
            classOrCourse: { type: "string", example: "Grade 10" },
            publishedAt: { type: "string", format: "date-time" },
          },
        },

        PublicOffersResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            offers: {
              type: "array",
              items: { $ref: "#/components/schemas/PublicOffer" },
            },
          },
        },

        PublicOffer: {
          type: "object",
          properties: {
            title: { type: "string", example: "Early Bird Discount" },
            description: { type: "string", example: "10% off tuition for applications submitted before March 31" },
            kind: { type: "string", enum: ["PERCENTAGE", "FLAT"], example: "PERCENTAGE" },
            value: { type: "number", example: 10 },
            code: { type: "string", example: "EARLYBIRD10" },
            classOrCourse: { type: "string", example: "Grade 10" },
            validFrom: { type: "string", format: "date-time" },
            validUntil: { type: "string", format: "date-time" },
            publishedAt: { type: "string", format: "date-time" },
          },
        },

        CreateLeadRequest: {
          type: "object",
          required: ["studentName", "phone"],
          description:
            "Unknown properties are ignored. `institutionId` is never read from the body.",
          properties: {
            studentName: { type: "string", maxLength: 120, example: "Rahul Kumar" },
            parentName: { type: "string", maxLength: 120, example: "Rajesh Kumar" },
            phone: {
              type: "string",
              description: "10-digit national number; a `+91` prefix and spacing are accepted.",
              example: "9876543210",
            },
            email: { type: "string", format: "email", example: "parent@gmail.com" },
            classInterested: { type: "string", maxLength: 80, example: "Grade 5" },
            message: { type: "string", maxLength: 2000 },
            sourceApplication: {
              type: "string",
              maxLength: 80,
              description: "Which of your properties sent this, for your own reporting.",
              example: "schoolsin.in",
            },
            sourceUrl: {
              type: "string",
              format: "uri",
              description: "The page the enquiry was submitted from.",
            },
          },
        },

        CreateLeadResponse: {
          type: "object",
          required: ["success", "leadNumber"],
          properties: {
            success: { type: "boolean", const: true },
            leadNumber: {
              type: "string",
              description: "Tenant-scoped enquiry number.",
              example: leadNumber,
            },
            message: { type: "string", example: "Enquiry submitted successfully" },
          },
        },

        Student: {
          type: "object",
          required: ["firstName"],
          properties: {
            firstName: { type: "string", maxLength: 80, example: "Rahul" },
            middleName: { type: "string", maxLength: 80 },
            lastName: { type: "string", maxLength: 80, example: "Kumar" },
            dateOfBirth: { type: "string", format: "date", example: "2016-05-10" },
            gender: { type: "string", example: "Male" },
            bloodGroup: { type: "string", maxLength: 10, example: "O+" },
          },
        },

        Parent: {
          type: "object",
          required: ["phone"],
          properties: {
            fatherName: { type: "string", maxLength: 120, example: "Rajesh Kumar" },
            motherName: { type: "string", maxLength: 120, example: "Anitha Kumar" },
            guardianName: { type: "string", maxLength: 120 },
            phone: { type: "string", example: "9876543210" },
            alternatePhone: { type: "string" },
            email: { type: "string", format: "email", example: "parent@gmail.com" },
          },
        },

        Address: {
          type: "object",
          properties: {
            addressLine1: { type: "string", maxLength: 200, example: "Mysore" },
            addressLine2: { type: "string", maxLength: 200 },
            city: { type: "string", maxLength: 80, example: "Mysore" },
            state: { type: "string", maxLength: 80, example: "Karnataka" },
            pincode: { type: "string", example: "570001" },
          },
        },

        Academic: {
          type: "object",
          properties: {
            previousInstitution: { type: "string", maxLength: 160, example: "ABC School" },
            previousClass: { type: "string", maxLength: 80, example: "Grade 4" },
            previousPercentage: { type: "number", minimum: 0, maximum: 100, example: 82 },
          },
        },

        Admission: {
          type: "object",
          required: ["applyingFor"],
          properties: {
            applyingFor: { type: "string", maxLength: 80, example: "Grade 5" },
            admissionType: { type: "string", maxLength: 40, example: "REGULAR" },
          },
        },

        DocumentReference: {
          type: "object",
          required: ["documentType", "fileName", "fileUrl"],
          properties: {
            documentType: { type: "string", enum: DOCUMENT_TYPES },
            fileName: { type: "string", example: "birth-certificate.pdf" },
            fileUrl: {
              type: "string",
              description: "A URL your system already hosts the file at.",
            },
          },
        },

        CreateApplicationRequest: {
          type: "object",
          required: ["academicYear", "student", "parent", "admission"],
          description:
            "Unknown properties are ignored. `institutionId` is never read from the body.",
          properties: {
            academicYear: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}(\\d{2})?$",
              example: "2026-27",
            },
            student: { $ref: "#/components/schemas/Student" },
            parent: { $ref: "#/components/schemas/Parent" },
            address: { $ref: "#/components/schemas/Address" },
            academic: { $ref: "#/components/schemas/Academic" },
            admission: { $ref: "#/components/schemas/Admission" },
            message: { type: "string", maxLength: 2000 },
            documents: {
              type: "array",
              maxItems: 20,
              items: { $ref: "#/components/schemas/DocumentReference" },
            },
            sourceUrl: { type: "string", format: "uri" },
          },
        },

        CreateApplicationResponse: {
          type: "object",
          required: ["success", "applicationNumber", "status"],
          properties: {
            success: { type: "boolean", const: true },
            applicationNumber: {
              type: "string",
              description: "Tenant-scoped application number.",
              example: applicationNumber,
            },
            status: { type: "string", enum: APPLICATION_STATUSES, example: "SUBMITTED" },
          },
        },

        GetApplicationResponse: {
          type: "object",
          required: ["success", "application"],
          properties: {
            success: { type: "boolean", const: true },
            application: {
              type: "object",
              properties: {
                applicationNumber: { type: "string", example: applicationNumber },
                status: { type: "string", enum: APPLICATION_STATUSES, example: "UNDER_REVIEW" },
                academicYear: { type: "string", example: "2026-27" },
                student: { $ref: "#/components/schemas/Student" },
                parent: { $ref: "#/components/schemas/Parent" },
                address: { $ref: "#/components/schemas/Address" },
                academic: { $ref: "#/components/schemas/Academic" },
                admission: { $ref: "#/components/schemas/Admission" },
                documents: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      documentType: { type: "string", enum: DOCUMENT_TYPES },
                      fileName: { type: "string" },
                      uploadedAt: { type: "string", format: "date-time" },
                    },
                  },
                },
                submittedAt: { type: "string", format: "date-time" },
                updatedAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
    },
  };
}
