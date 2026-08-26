# EduFleet Exchange — Integration Recon (read-only)

Repos examined:
- **R1** = `/Users/automicai/edufleet-exchange` (Next.js, app under `web/`)
- **R2** = `/Users/automicai/Documents/GitHub/eduFleet/edufleetexchange` (Express 5 + Mongoose 9, server under `server/`, separate `edufleetexchange_ui`)

---

## 1. Which repo is canonical/active

**R1 (`/Users/automicai/edufleet-exchange`) is canonical and active. R2 is the abandoned predecessor that R1 replaced.**

Evidence:

- **R2's own last commit is a decision to restart from scratch.** R2's HEAD commit is `cf2270a docs: greenfield PRD v2 — fresh project spec, assumes nothing built` (2026-07-05 18:06:52 +0530), adding `docs/prd-v2-fresh.md`. That doc opens: *"Greenfield specification — assumes nothing is built. This document alone defines the new project"* and ends with open questions to the founder including **"Q4: Tech stack preference for the new project, or my recommendation?"** — i.e. R2 itself declares R2 obsolete and calls for a fresh build.
- **R1's very first commit lands the next day** and independently authors that fresh build: `7f3e81f docs: PRD v1.0 + aurora design mockups (landing, 17-screen showcase, wireframes)` at 2026-07-06 00:29:21 +0530 (< 6 hours after R2's last commit). `diff`ing R2's `docs/prd-edufleet-2026-07-05.md` against R1's `docs/PRD.md` shows they are different documents (R1's is the "PRD + Technical Design (TDD)" doc, distinctly written, not a copy) — consistent with R1 being the actual greenfield rewrite R2's final commit called for, done as a fresh Next.js/Mongoose app rather than continuing R2's Express/Mongoose codebase.
- **R1 has been developed continuously for ~7 weeks since**, reaching `ec0b654` on 2026-08-18 07:55:48 +0530 — 89 sequential commits (`d3f3c98` core models → `9344780` job lifecycle+applications → `f93c50c` demand alerts → ... → `1af117f` teacher job-alerts tab → `694f1a1` instant job→teacher alert fan-out → `ec0b654` supplier alert fixes), with a full TDD paper trail under `docs/superpowers/plans/*.md` and `docs/superpowers/specs/*.md` (50+ plan/spec docs) and long-lived feature branches (`build/account-suspension`, `build/admin-audit-log`, `build/teacher-reviews`, etc.).
- **R2 has no activity after 2026-07-05.** Its git log stops at the greenfield-restart commit; nothing merges after it.
- The teacher-jobs vertical in R1 is materially deeper: dedicated `Job`, `JobAlert`, `JobAlertDelivery`, `JobApplication`, `JobClaim`, `JobTemplate`, `JobView` models, a job-templates feature, a full instant teacher-match alert/notification pipeline with unsubscribe tokens, view analytics, and an "aggregated/claimable" cold-start listing mechanism (jobs sourced from print classifieds a school can later claim). R2's teacher-jobs vertical is a single `Job` model + CRUD controller + a job-consultant persona experiment that was still being designed (`docs/superpowers/plans/2026-06-04-job-consultant-persona.md`) when the project was abandoned.

**Conclusion:** treat R1 as the real EduFleet Exchange. R2 is legacy/dead — useful only as a secondary data point on the data model, not as an integration target.

---

## 2. Teacher-jobs data model

### R1 (canonical) — `web/src/models/Job.ts`

```
web/src/models/Job.ts:8    export const JOB_ORIGINS = ["school_posted", "aggregated"] as const;
web/src/models/Job.ts:13   export const CLAIM_STATUSES = ["unclaimed", "claim_pending", "claimed", "withdrawn"] as const;
web/src/models/Job.ts:17-24  sourceAttributionSchema { publication, publishDate, sourceUrl } (_id:false)
web/src/models/Job.ts:26-69 jobSchema:
  schoolId          ObjectId ref "School", index          (nullable — null until an aggregated job is claimed)
  title             String, required
  categoryGroup     String enum ["academic","administration","support"], required
  subject           String, required   (validated against a fixed taxonomy, not a free-form enum — see below)
  slug              String, required, index
  description       String, required
  location          String, required
  branchId          ObjectId (optional — points at a sub-doc in School.branches)
  branchName        String
  branchAddress     String
  salaryMin         Number, min 0
  salaryMax         Number, min 0
  experienceRequired Number, min 0, default 0
  facilities        [String] default [] (perks/benefits, from JOB_FACILITIES allow-list)
  status            String enum ["active","closed"], default "active", index
  featured          Boolean default false   (true when the posting school is on the "pro" plan)
  origin            String enum JOB_ORIGINS, default "school_posted", index
  sourceAttribution sourceAttributionSchema (only for aggregated/cold-start listings)
  schoolNameCached  String   (denormalised so aggregated listings render without a School doc)
  district/taluk/state  String  (denormalised location breakdown)
  claimToken        String, unique+sparse index
  claimStatus       String enum CLAIM_STATUSES, default "unclaimed", index
  hiddenPendingReview Boolean default false, index
  takedownReason    String
  timestamps: true
web/src/models/Job.ts:71   compound index { status, categoryGroup, location }
```

Notes:
- **No `employmentType` field** (full-time/part-time/contract) exists on R1's Job — every posting is implicitly a direct-hire vacancy; there's no grade-level field either.
- **Subject/category is a closed taxonomy**, not a free enum on the schema: `web/src/lib/taxonomy.ts:21-29` defines `JOB_CATEGORIES` from three name lists — `academic` (Mathematics, Physics, Chemistry, Biology, English, Kannada, Hindi, Social Science), `administration` (Principal, Vice Principal, Coordinator, Administrator), `support` (Accountant, Clerk, Driver, Librarian) — each mapped to a `group` and a `slug`. `isValidJobSubject()` (`web/src/lib/taxonomy.ts:91-93`) is what the create-job service enforces (see §3).
- **Qualifications aren't on the Job at all** in R1 — qualification/experience/subjects live on the `Teacher` profile (`web/src/models/Teacher.ts`), matched against jobs by `web/src/lib/job-match-logic.ts`.
- **Application flow model** — `web/src/models/JobApplication.ts`:
  ```
  web/src/models/JobApplication.ts:3   APPLICATION_STATUSES = ["applied","viewed","shortlisted","rejected"]
  web/src/models/JobApplication.ts:10  RELEASE_STATES = ["held","released"]   (held = application to an unclaimed aggregated job, invisible until claimed+approved)
  web/src/models/JobApplication.ts:12-20  jobId (ref Job, required), teacherId (ref Teacher, required), status, releaseState
  web/src/models/JobApplication.ts:23  unique compound index { jobId, teacherId } — one application per teacher per job
  ```
- Related job-vertical models, all one-per-concern: `web/src/models/JobAlert.ts` / `JobAlertDelivery.ts` (saved-search alerts + delivery ledger), `web/src/models/JobClaim.ts` (claim workflow for aggregated jobs), `web/src/models/JobTemplate.ts` (reusable job drafts), `web/src/models/JobView.ts` (view analytics).

### R2 (legacy) — `server/models/Job.ts`

```
server/models/Job.ts:3-36  IJob:
  title              string, required
  instituteName      string, required        (denormalised display name)
  department         string, required
  location           { city, state, country="India" }, city+state required
  subjects           string[], required, at least one   (free-form strings, NOT taxonomy-checked in the schema)
  experience         { min: number required, max: number required }
  salary             { min, max, currency="INR" }, min/max required
  qualification      string[], required
  employmentType     enum ["full-time","part-time","contract","temporary"], required
  description        string, required
  responsibilities   string[], default []
  requirements       string[], default []
  benefits           string[], default []
  contactEmail       string, required, regex-validated
  contactPhone       string, optional
  instituteId        ObjectId ref "Account", required
  applicationDeadline Date, optional
  status             enum ["active","closed","expired"], default "active"
  applicationsCount  number, default 0
  timestamps: true
server/models/Job.ts:159-163  indexes: {instituteId,status}, {status,createdAt desc}, {department}, {location.city,location.state}, {subjects}
```

R2's schema is richer in *employment-contract* fields (employmentType, applicationDeadline, structured experience/salary/qualification) but shallower in *marketplace mechanics* (no origin/claim/cold-start concept, no separate JobApplication model with dedupe — R2 tracks only a denormalised `applicationsCount`, and application records/status live in `jobController.ts`'s `applyToJob`/`getApplications` handlers, not shown as a separate schema file found in this pass).

---

## 3. How a job gets created today (R1, canonical)

- **Persona/role:** only `role: "school"` users, and only once the school's `verificationStatus` is `"approved"` by an admin. Enforced by the gate function itself:
  ```
  web/src/lib/authz.ts:50-64  requireApprovedSchool(userId):
    - loads User by id; throws AuthzError if missing
    - throws AuthzError if user.role !== "school"
    - loads School by userId; throws AuthzError if none
    - throws AuthzError if school.verificationStatus !== "approved"
  ```
  Roles are `USER_ROLES = ["school","teacher","supplier","admin","platform_admin"]` (`web/src/models/User.ts:3`).

- **Auth mechanism:** NextAuth.js v5 (`next-auth`), **JWT-strategy session cookie**, not a bare Express JWT header:
  ```
  web/src/auth.ts:20-23   NextAuth({ secret: authSecret(), trustHost: true, session: { strategy: "jwt" }, ... })
  web/src/auth.ts:26-37   Credentials provider #1: email+password (bcrypt via verifyCredentials)
  web/src/auth.ts:38-50   Credentials provider #2: email+OTP ("email-otp")
  web/src/auth.ts:52-65   jwt/session callbacks copy {uid, role} onto the session
  web/src/lib/auth-secret.ts:8-15  AUTH_SECRET env var; hard-fails in production if unset, dev fallback otherwise
  ```
  There is **no REST/JSON API endpoint for creating a job.** Job posting is a Next.js **Server Action** invoked directly from a form:
  ```
  web/src/lib/actions.ts:93   async function uid(): session = await auth(); redirect("/login") if no session
  web/src/lib/actions.ts:211-227  postJobAction(_p, form):
    await createJob(await uid(), { title, subject, description, branchId, salaryMin, salaryMax, experienceRequired, facilities })
    then revalidatePath("/school"), revalidatePath("/jobs"), revalidatePublicJobs()
  ```
  The full six API routes in R1 are `web/src/app/api/{auth/[...nextauth], alerts/unsubscribe, jobs/[id]/view, products/[id]/viewer-state, teachers/[id]/viewer-state, upload}/route.ts` — none of these accept job-creation payloads; job mutation only happens through server actions gated by the NextAuth session cookie.

- **Create logic / validation** (`web/src/lib/services/jobs.ts:31-99` `createJob`):
  1. `requireApprovedSchool(userId)` (role+approval gate, above).
  2. `isValidJobSubject(input.subject)` against the fixed taxonomy — else `ValidationError`.
  3. `assertSalaryRange` — `salaryMin` cannot exceed `salaryMax`.
  4. If `branchId` given, resolves it against `school.branches` sub-docs and denormalises `location/branchName/branchAddress`; else requires a non-empty `location`.
  5. **Quota/subscription gating** — `web/src/lib/services/jobs.ts:61-69`:
     ```
     if (school.plan !== "pro") {
       const activeCount = await Job.countDocuments({ schoolId: school._id, status: "active" });
       if (activeCount >= FREE_ACTIVE_JOB_LIMIT) throw new UpgradeError(...);
     }
     ```
     `FREE_ACTIVE_JOB_LIMIT = 3` (`web/src/lib/services/subscriptions.ts:7`). Plan is a **per-school flag**, `School.plan: enum ["free","pro"]` (`web/src/models/School.ts:33`), set self-serve/manually by `setSchoolPlan()` (`web/src/lib/services/subscriptions.ts:19-26`) — **there is no on-platform payment integration; "pro" is flipped directly, no billing provider**. Pro also sets every one of that school's jobs `featured: true`.
  6. `Job.create({...})`, then a best-effort, failure-isolated fan-out to matching teachers (`notifyMatchingTeachers`, `web/src/lib/services/jobs.ts:92-96`) that never blocks the posting flow.

So: **yes — posting a job is quota-gated by the school's subscription tier** (free schools capped at 3 simultaneous active jobs; "pro" is unlimited and gets ranked first), confirming the README's per-persona subscription claim for the teacher-jobs vertical.

### R2 (legacy) job creation, for contrast
- Genuine REST API: `POST /` on `server/routes/jobs.ts:31`, gated by `authenticate, requireRole(['institute','sales','admin'])` (`server/middleware/auth.ts:13-38,65-78`).
- Auth: JWT accepted via **either** `Authorization: Bearer <token>` header **or** an httpOnly `cookies.token` (`server/middleware/auth.ts:15-16`) — i.e. R2's auth middleware already tolerates header-based bearer tokens, which R1's NextAuth-cookie-only setup does not.
- R2 has a full subscription-plan CRUD/controller (`server/controllers/subscriptionController.ts`, `server/models/{Subscription,SubscriptionPlan,SubscriptionRequest}.ts`) with a standard `{success, data}`/`{success:false, error, code}` envelope, but this predates the abandonment and isn't wired into R1 at all.

---

## 4. Does ANY inbound partner/integration API exist?

**No. In neither repo does anything resembling a two-layer partner API (platform key + per-institution grant, à la PassPercent/FeesBasket) exist. There is no inbound integration surface at all in either codebase.**

What was found instead, in both repos, is exclusively **outbound** third-party API usage (the app calling out to vendors, not vendors calling in):
- R1: `web/src/lib/config.ts:20,25,42` (Resend email API key, SMS gateway API key, Cloudinary API key — all outbound), `web/src/lib/services/sms.ts:14` and `mailer.ts:21` send `Authorization: Bearer <our-own-vendor-key>` to Resend/SMS providers.
- R2: `server/utils/email.ts:5-16` (`RESEND_API_KEY`, outbound to Resend); a couple of seed-data strings mentioning "Google for Education Partner" / "Microsoft Partner" as supplier certifications (not code).

Confirmed by exhaustive search: `grep -rniE "api[_-]?key|partner|webhook|bearer token|x-api-key|integration|externalRef|external_ref|inbound"` across `web/src` (R1) and `server` (R2) turned up nothing that authenticates an inbound third-party caller — no API-key model, no webhook receiver route, no partner-scoped token, no per-institution grant record. A second, broader pass for `externalId|external_id|externalRef|external_ref|partnerKey|integrationKey|sourceSystem|providerRef` across every `.ts/.tsx/.js` file in both repos (excluding `node_modules`/`dist`/`.next`) returned **zero hits**.

R1's complete API route inventory (6 files total) is entirely internal-app plumbing: NextAuth's own catch-all, an alert-unsubscribe link handler, job/product/teacher view-tracking beacons, and a signed file-upload endpoint — none accept externally-authored payloads from a third party.

**This is the headline finding for the design conversation: there is no receiving surface today. Anything IDAP wants to push has to be built from zero — models, auth, and routes — not adapted from an existing (even partial) partner API.**

---

## 5. Sizing: what the receiving side would need (NOT built — sizing only)

Given R1's existing patterns (Mongoose models, a `requireApprovedSchool`-style authz gate, Next.js route handlers under `web/src/app/api/`), a same-shape inbound partner API would plausibly need:

- **New model: `PartnerApiKey` (or `IntegrationPartner`)** — platform-level credential: `partnerName` ("IDAP"), a hashed key/secret (bcrypt, same pattern as `User.passwordHash` in `web/src/models/User.ts:12`), `scopes`/`status` (active/revoked), rate-limit or usage counters. This is the "platform key" layer PassPercent/FeesBasket have that is wholly absent here.
- **New model: `SchoolIntegrationGrant`** (the missing "per-institution grant" layer) — links a `PartnerApiKey` to a specific `School._id` (`web/src/models/School.ts:14` is the ref target), analogous to how `School.userId` already links one school to one login. Needs an explicit opt-in/consent step per school (nothing like this exists — `School` today has zero notion of being linked to any external system; see §6) plus an `externalRef`/`sourceJobId` field to dedupe re-pushes.
- **New middleware**, parallel to `requireApprovedSchool` (`web/src/lib/authz.ts:50-64`) but keyed off a request header (e.g. `Authorization: Bearer <partner-key>` + an `X-Institution-Grant` or school-external-id header) rather than a NextAuth session cookie — R1's entire auth stack (`web/src/auth.ts`) is cookie/session-based and has no header-token verification path today (R2's `authenticate()` at `server/middleware/auth.ts:13-38` is the closer analogue since it already reads `Authorization: Bearer`, but it verifies a *user* JWT, not a platform/partner key, and R2 is dead code anyway).
- **New route(s)** under `web/src/app/api/partners/jobs` (a genuine REST/JSON `route.ts`, since job creation today is a server action with no JSON contract at all — `web/src/lib/actions.ts:211-227`) implementing create/update/close for externally-sourced jobs, translating the partner payload into `web/src/lib/services/jobs.ts`'s `JobInput` shape, respecting the same taxonomy validation (`isValidJobSubject`, `web/src/lib/taxonomy.ts:91-93`) and quota gating (`FREE_ACTIVE_JOB_LIMIT`, `web/src/lib/services/subscriptions.ts:7`) that school-posted jobs already go through — or a deliberate decision on whether partner-pushed jobs bypass the free-tier cap.
- Likely also a **new `origin` value** on `Job` (today `JOB_ORIGINS = ["school_posted","aggregated"]`, `web/src/models/Job.ts:8`) — e.g. `"partner_pushed"` — to keep the existing `sourceAttribution` display and takedown/moderation logic (`hiddenPendingReview`, `takedownReason`) working the same way it does for the existing "aggregated" cold-start listings, which are architecturally the closest existing precedent for "a job that didn't originate from a school's own form."

None of this exists today; this is new build, not adaptation.

---

## 6. How schools are identified (Account/InstituteProfile shape; external-ref concept)

### R1 (canonical)
- `web/src/models/User.ts:3` — `USER_ROLES = ["school","teacher","supplier","admin","platform_admin"]`; the `User` doc (`web/src/models/User.ts:6-30`) holds login/identity (email, phone, passwordHash, OTP fields, `status: pending|approved|rejected|suspended`).
- `web/src/models/School.ts:12-37` — the actual "institute profile," one-to-one with `User` via `userId` (unique ref, `School.ts:14`):
  ```
  schoolName, institutionType (school|college|puc|other), board (CBSE|ICSE|State|PUC|Other),
  city, state, officialPhone, officialEmail, website, logoUrl,
  branches: [ { name, address, city, state, pincode, phone } ],
  verificationStatus (pending|approved|rejected), rejectionReason, verifiedAt,
  plan (free|pro), suspended: boolean
  ```
- **No external-ref concept anywhere on `School` or `User`.** No field for a partner-platform ID, no linked-account table, nothing. A school today is identified purely by its own Mongo `_id` / login email — there is no plausible existing hook to say "this school's IDAP tenant is X" short of adding one (see §5).

### R2 (legacy)
- `server/models/Account.ts:4,20-60` — `AccountRole = 'institute'|'teacher'|'vendor'|'admin'|'marketing'|'sales'|'consultant'`; base identity record (name/email/password/role/isActive/isVerified).
- `server/models/InstituteProfile.ts:3-22` — one-to-one with `Account` via `accountId` (unique): `instituteName, contactPerson, instituteSearchability (bool), address {street city state pincode country}, verification {status: none|pending|verified|rejected, verifiedAt, verifiedBy}`.
- Same conclusion: **no external-ref field, no linked-partner concept**, in R2 either.

**Bottom line for §6:** neither repo has ever modeled "this school account is also known to some external system as Y." Any IDAP↔school linkage is 100% new schema work (the `SchoolIntegrationGrant` sketched in §5).
