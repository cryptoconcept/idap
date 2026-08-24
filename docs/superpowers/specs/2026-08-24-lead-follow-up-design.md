# Phase 3 — Lead Follow-up

**Date:** 2026-08-24
**Status:** Approved for planning
**Prior specs:** `docs/superpowers/specs/2026-08-23-idap-institution-profile-design.md`,
`docs/superpowers/specs/2026-08-24-idap-results-management-design.md`

---

## 1. What this is

Both prior phases flagged the same gap and neither took it: the Lead Network has no
follow-up mechanism. A lead has no assignee, no scheduled follow-up date, and there is
exactly one institution-side role — so nothing converts an enquiry into anything, and
no one owns the job of trying. Phase 2 made this more urgent, not less: Results
Management exists specifically to drive enquiries into a pipeline that still can't work
them.

This phase adds three things: a real staff role model (Counselor, Front Desk, alongside
the existing Institution Admin), lead assignment with an admin as the router, and a
follow-up date with a daily reminder push to the counselor who owns it.

### What this phase is not

**No applications changes.** Applications keep their current visibility — every
institution-side role sees every application, same as today. Only leads get assignment
and restricted visibility. The complaint this phase answers was specifically about
leads.

**No reassignment audit trail beyond the existing Activity log**, no bulk assignment,
no escalation logic. A follow-up that goes unworked shows as overdue; nothing
auto-reassigns it or pages anyone else.

**No self-service claiming.** A counselor who sees an unassigned lead in their own
queue cannot assign it to themselves — only an admin routes leads. This is a
deliberate choice, not an oversight; see §9.

**No time-of-day precision on follow-ups.** A follow-up is a date, not a moment. The
reminder job runs once daily.

---

## 2. Decision register

| # | Decision | Rationale |
|---|---|---|
| 1 | Two new roles — `COUNSELOR` and `FRONT_DESK` — not a generic "staff" role or a configurable permission system. | The brief named concrete, different jobs (routing intake vs. working a caseload). A single generic role would have needed a second axis of configuration to express the same split; naming the two roles directly is simpler for an admin to reason about ("make this person a Counselor") than assembling a permission bundle by hand. |
| 2 | Permissions are an explicit lookup table (`ROLE_PERMISSIONS: Record<UserRole, Set<Permission>>`), checked once per route, not inline `role === X \|\| role === Y` conditionals. | This codebase already has exactly this pattern for `ApiPermission` (external API client scopes). Reusing it means a permission moving between roles later is a one-line table edit, not an audit of every route that happens to check that role. |
| 3 | Leads are visible either to everyone (`LEADS_VIEW_ALL`) or to "mine plus unassigned" (`LEADS_VIEW_OWN`) — no third tier. | A real caseload model: a counselor's queue is their own work plus what's still up for grabs, never a colleague's assigned leads. This also makes "my queue" the natural default view rather than something to configure. |
| 4 | Only an admin can assign or reassign a lead. Front Desk creates and views but does not route. | Confirmed directly rather than assumed — Front Desk's job is intake, not deciding who works what. The cost is a real one: every new enquiry needs an admin's attention before it reaches a counselor. Accepted as a known limitation (§9), not solved here. |
| 5 | `assignedTo` may reference an Admin or a Counselor, never a Front Desk. | Front Desk doesn't do casework; the assignment dropdown should never offer them as a target even though they're a valid user. |
| 6 | Follow-up is a date, not a datetime. | Matches how this is actually worked — a daily queue, not a calendar appointment. Keeps the UI to a date picker and the reminder job to a once-daily cron instead of a 15-minute one, for a precision most admissions offices won't use anyway. |
| 7 | One push per counselor per day ("N follow-ups due today"), not one push per lead. | A counselor with five follow-ups due gets one notification, not five. Matches the existing `NotificationService` dispatch style (one message describing the event), just re-scoped from institution-wide to one user. |
| 8 | The new permission table governs only the cookie-session branch of any route that also accepts bearer tokens. | `/api/leads` is a unified handler (`requireApiUser`) reachable by both a dashboard session and a third-party `ApiClient`'s bearer token. An `ApiClient` has no staff role — its own `ApiPermission` scopes are untouched and orthogonal to this phase. Only `viaBearer === false` requests are subject to the new role checks. |
| 9 | `requireInstitution()` is not modified by this phase. | Verified directly against the routes it actually gates (profile, results, settings, API credentials — never leads or applications) before designing around it. The leads/applications flow already runs through `tenantFilter()`-based guards that accept any non-`SUPER_ADMIN` role today, so adding `COUNSELOR`/`FRONT_DESK` to `USER_ROLES` makes them reachable there with zero guard changes — and leaves `requireInstitution()`'s Admin-only routes correctly excluded by construction, not by a checklist of routes to remember to update. |
| 10 | Six pre-existing dashboard **pages** (`/profile`, `/results` and its two subpages, `/settings`, `/integration`) each get one added line explicitly restricting them to `INSTITUTION_ADMIN`. | Found by reading the actual page guards, not assumed: these pages check `role !== "SUPER_ADMIN"` at the page level — correct when only one institution role existed, silently wrong once Counselor and Front Desk exist, since both would newly pass that check. Their *write* APIs stay protected by unmodified `requireInstitution()` (decision 9), but the *page itself* would render for a Counselor or Front Desk session without this fix. `/integration` is the serious instance — it displays API client keys and secrets, not just a UI a non-admin shouldn't see. |

---

## 3. Architecture

No new module, no new master-identity attachment. This extends the existing Lead
Network in place.

```
Institution
     │
     ├── Users
     │     role: SUPER_ADMIN | INSTITUTION_ADMIN | COUNSELOR | FRONT_DESK   ◀── extended
     │
     └── Leads
           assignedTo, assignedAt, followUpAt, followUpNotifiedAt          ◀── new fields
                 │
                 ▼
     Daily cron ──▶ finds due follow-ups ──▶ one push per counselor
```

### Layer separation

Same discipline as both prior phases: routes handle auth/CSRF/validation/envelope; a
new `requirePermission()` helper (built once, used everywhere) is the sole place a
permission is checked; `LeadService` gains the assignment/follow-up methods; nothing
about `Application`, `Document`, `Note`, or `Activity` changes shape.

---

## 4. Data model

### 4.1 `User` — role extension

```
USER_ROLES = ["SUPER_ADMIN", "INSTITUTION_ADMIN", "COUNSELOR", "FRONT_DESK"]
```

No new fields on `User` itself. `institutionId` is already required for every
non-`SUPER_ADMIN` role, which already covers Counselor and Front Desk.

### 4.2 `Lead` — new fields

| Field | Type | Notes |
|---|---|---|
| `assignedTo` | ObjectId ref `User`, nullable | The Admin or Counselor working this lead. Never a Front Desk user (enforced at the service layer, not the schema — see §5). |
| `assignedAt` | Date, nullable | Set whenever `assignedTo` changes, cleared when unassigned. |
| `followUpAt` | Date, nullable | Date-only semantics; stored as a `Date` at midnight UTC for the given calendar date. |
| `followUpNotifiedAt` | Date, nullable | Stamped by the reminder job the day it fires for the *current* `followUpAt`. Cleared to `null` whenever `followUpAt` is set to a new value, so editing the date re-arms the reminder. |

Follow-up context (why, what was discussed) goes through the existing `Note` model
(`entityType: "LEAD"`, already built) — no new field duplicates that.

### 4.3 Indexes

```
LeadSchema.index({ institutionId: 1, assignedTo: 1, createdAt: -1 })   -- "my queue"
LeadSchema.index({ followUpAt: 1, followUpNotifiedAt: 1 })              -- the daily cron's query
```

The cron index is deliberately not institution-scoped — the job runs once across the
whole platform and groups results by institution/counselor in application code, not in
the query.

---

## 5. Permissions

### 5.1 The permission set

```
LEADS_VIEW_ALL        LEADS_VIEW_OWN        LEADS_CREATE
LEADS_UPDATE          LEADS_ASSIGN          LEADS_SET_FOLLOWUP
LEADS_DELETE          LEADS_EXPORT          STAFF_MANAGE
```

`LEADS_UPDATE` covers status changes and notes. `LEADS_SET_FOLLOWUP` is separate from
`LEADS_UPDATE` because a Counselor holds it only for their *own* assigned leads —
`LEADS_UPDATE`'s ownership scoping is identical, so the two are checked together in
practice, but are named separately because they are conceptually distinct actions.

### 5.2 The table

```ts
export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  SUPER_ADMIN: new Set([]),  // platform admin has zero permissions here — see §5.4
  INSTITUTION_ADMIN: new Set([
    "LEADS_VIEW_ALL", "LEADS_CREATE", "LEADS_UPDATE", "LEADS_ASSIGN",
    "LEADS_SET_FOLLOWUP", "LEADS_DELETE", "LEADS_EXPORT", "STAFF_MANAGE",
  ]),
  COUNSELOR: new Set(["LEADS_VIEW_OWN", "LEADS_UPDATE", "LEADS_SET_FOLLOWUP"]),
  FRONT_DESK: new Set(["LEADS_VIEW_OWN", "LEADS_CREATE"]),
};
```

`LEADS_UPDATE` and `LEADS_SET_FOLLOWUP` are ownership-scoped for `COUNSELOR`: holding
the permission is necessary but not sufficient — the service layer additionally checks
`lead.assignedTo === currentUser.id` before allowing the write. `INSTITUTION_ADMIN`
holds every permission unscoped.

`FRONT_DESK` holds `LEADS_VIEW_OWN`, not `LEADS_VIEW_ALL` — not because Front Desk has
a caseload (`assignedTo` never points at a Front Desk user, per decision 5), but
because the same filter degrades correctly for them: `{$or: [{assignedTo: self},
{assignedTo: null}]}` with no leads ever assigned to self is just "unassigned leads,"
which is exactly their intake queue. They never see a lead once it's been routed to a
counselor — matching the original framing ("can't see other staff's assigned leads
unless reassigned") rather than the broader "sees everything" reading a first draft of
this table drifted into.

### 5.3 `requirePermission()`

```ts
export function requirePermission(user: CurrentUser, permission: Permission): void {
  if (!ROLE_PERMISSIONS[user.role]?.has(permission)) {
    throw forbidden();
  }
}
```

Called once, at the top of each route, after the existing tenant guard for that route
(`requireTenantUser()`, `requireTenantUserPage()`, or `requireApiUser()` +
`tenantFilter()` — see §5.5). Ownership scoping (a Counselor's own lead) is checked
separately, inside `LeadService`, because it needs the actual document.

### 5.4 The platform admin boundary is unchanged

`SUPER_ADMIN` holds no lead-related permission at all. This isn't new — Phase 1 and 2
both stated the platform admin has zero access to institution enquiry/application data,
enforced by `tenantFilter()` rejecting the role outright before any permission table is
even consulted. This phase doesn't touch that boundary; the empty permission set above
is documentation of the existing fact, not a new check.

### 5.5 `requireInstitution()` is untouched — a different guard already does the right thing

This matters enough to correct explicitly: an earlier draft of this design assumed the
leads/applications flow ran through `requireInstitution()` (the Admin-only guard used
by profile, results, and institution settings) and planned to generalize it. It
doesn't. Checked directly against the routes and pages that actually serve leads and
applications (`/enquiries`, `/enquiries/[leadNumber]`, `/applications`,
`/api/leads`, `/api/leads/[id]`):

```ts
// src/lib/tenant/index.ts — already exists, already correct, not modified by this phase
export function tenantFilter(user: CurrentUser): { institutionId: string } {
  if (user.role === "SUPER_ADMIN") throw forbidden(PLATFORM_ADMIN_DENIED);
  if (!user.institutionId) throw forbidden();
  return { institutionId: user.institutionId };
}
```

`tenantFilter()` — and the `requireTenantUser()` / `requireTenantUserPage()` /
`requireApiUser()` guards built on it — already accept **any** non-`SUPER_ADMIN` role.
Adding `COUNSELOR` and `FRONT_DESK` to `USER_ROLES` makes every lead/application route
and page admit them automatically, with zero code change to any of these guards.

`requireInstitution()` is a *different, narrower* guard (`role !== "INSTITUTION_ADMIN"`,
hard-coded), used exclusively by `src/app/api/settings/institution/*`,
`src/app/api/settings/results/*`, and `src/app/api/api-clients/route.ts` — profile
editing, results publishing, and API credential issuance. **This phase does not touch
`requireInstitution()` at all.** It stays exactly as strict as it already is, which
means Counselor and Front Desk are excluded from all of those routes by construction —
the same reason they were excluded before this phase existed, not a new check this
phase has to remember to add. There is no audit list, because there is nothing to
audit: the guard that must stay Admin-only was never going to change.

`requirePermission()` (§5.3) is therefore purely additive: it layers *finer* checks on
top of guards that are already correctly role-inclusive for leads/applications, and it
is never consulted by the routes that must stay Admin-only, because those routes don't
call it — they call `requireInstitution()`, unchanged.

### 5.6 The bearer-token boundary

`requireApiUser()` resolves either a bearer-token `ApiClient` or a cookie session.
Only the cookie branch (`viaBearer === false`) is subject to `requirePermission()`.
An `ApiClient`'s own `ApiPermission` scopes (`CREATE_LEAD` etc.) are unrelated and
untouched — a third-party website's integration key has no staff role and never will.

---

## 6. Assignment & visibility

### 6.1 Visibility, concretely

```ts
function leadVisibilityFilter(user: CurrentUser): FilterQuery<LeadDoc> {
  if (ROLE_PERMISSIONS[user.role].has("LEADS_VIEW_ALL")) return {};
  return { $or: [{ assignedTo: user.id }, { assignedTo: null }] };
}
```

Applied inside `tenantFilter()`'s existing institution-scoping, not as a separate
query — the two compose (`{ institutionId, ...visibility }`).

### 6.2 Assignment

`POST /api/leads/:id/assign` (new), `LEADS_ASSIGN` required, body `{ assignedTo:
string | null }`. Setting `null` unassigns. The target user must be
`INSTITUTION_ADMIN` or `COUNSELOR` in the same institution — a Front Desk id, another
institution's user, or a nonexistent id all 400. Sets `assignedAt`, records an
`Activity` entry (`"Lead assigned"` / `"Lead unassigned"` / `"Lead reassigned"`,
naming both the old and new assignee where applicable).

### 6.3 Follow-up date

`PATCH /api/leads/:id` gains `followUpAt: string | null` (ISO date, or `null` to
clear). Requires `LEADS_SET_FOLLOWUP`, and for a Counselor, `lead.assignedTo ===
user.id`. Setting a new value clears `followUpNotifiedAt`; clearing the date to `null`
also clears `followUpNotifiedAt` (nothing to notify about).

---

## 7. The reminder job

### 7.1 Trigger

Vercel Cron, once daily. `vercel.json`:

```json
{
  "crons": [{ "path": "/api/cron/follow-up-reminders", "schedule": "0 2 * * *" }]
}
```

`0 2 * * *` is 2am UTC — 7:30am IST, chosen as a reasonable "before the office opens"
time for this platform's primary market; trivially adjustable later, not worth a
design debate now.

A plain `vercel.json` `crons` array, not `vercel.ts` — this project has no existing
Vercel config file, and a single cron entry doesn't need `vercel.ts`'s TypeScript
rewrites/redirects machinery.

### 7.2 The route

`GET /api/cron/follow-up-reminders`. Authenticated by Vercel's own convention: when
`CRON_SECRET` is set, Vercel signs its request with `Authorization: Bearer
<CRON_SECRET>`; the route checks that header and 401s otherwise. No session, no CSRF —
this is a machine-to-machine endpoint, same trust model as any other secret-gated
route already in this codebase.

```ts
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) return unauthorizedResponse();

  const due = await Lead.find({
    followUpAt: { $lte: startOfTodayUTC() },
    followUpNotifiedAt: null,
    status: { $nin: ["ADMITTED", "REJECTED"] },
    assignedTo: { $ne: null },
  }).select("assignedTo institutionId").lean();

  const byCounselor = groupBy(due, (lead) => String(lead.assignedTo));
  for (const [counselorId, leads] of byCounselor) {
    await NotificationService.notifyFollowUpsDue({
      userId: counselorId,
      institutionId: leads[0].institutionId,
      count: leads.length,
    });
  }

  await Lead.updateMany(
    { _id: { $in: due.map((l) => l._id) } },
    { $set: { followUpNotifiedAt: new Date() } },
  );

  return jsonSuccess({ notified: byCounselor.size, leads: due.length });
}
```

Terminal-status leads (`ADMITTED`, `REJECTED`) are excluded — a follow-up date on a
closed lead is stale, not due.

### 7.3 Notification dispatch

`DeviceService` gains `forUser(userId: string)`, mirroring the existing
`forInstitution(institutionId: string)` but scoped to one person — a small addition,
not a new pattern.

`NotificationService` gains:

```ts
async notifyFollowUpsDue(input: { userId: string; institutionId: string; count: number }) {
  const devices = await DeviceService.forUser(input.userId);
  if (devices.length === 0) return;
  const { deadTokens } = await sendPush(devices.map((d) => ({
    pushToken: d.pushToken,
    title: input.count === 1 ? "1 follow-up due today" : `${input.count} follow-ups due today`,
    body: "Open your queue to see who's waiting.",
    data: { type: "follow-up-reminder" },
  })));
  await DeviceService.remove(deadTokens);
}
```

---

## 8. Dashboard

### 8.1 Staff management — `/staff` (Admin only, `STAFF_MANAGE`)

List of the institution's Counselor and Front Desk accounts (name, email, role,
active/inactive), a "Create staff account" form (name, email, role, initial
password — same creation pattern as how the seed script creates users today), and a
deactivate toggle per row. No self-service password reset in this phase — an admin
resets a staff member's password the same way institution accounts are managed today.

### 8.2 Leads list — extended

- **Admin**: unchanged list, plus a new filter (All / Unassigned / by Counselor) and
  an "Assign to…" control per row.
- **Counselor**: the same list, server-side scoped to `LEADS_VIEW_OWN` — defaults to
  showing their queue with no client-side filter needed. A due/overdue badge per row,
  computed from `followUpAt` vs. today.
- **Front Desk**: the same list, server-side scoped to `LEADS_VIEW_OWN` — which shows
  only unassigned leads, since `assignedTo` never points at a Front Desk user. No
  assignment control (no `LEADS_ASSIGN`), no status/note editing (no `LEADS_UPDATE`).

### 8.3 Lead detail — extended

- **Follow-up date field** — a date picker, visible to whoever holds
  `LEADS_SET_FOLLOWUP` for this specific lead (Admin always; Counselor only when
  `assignedTo === self`). Read-only display otherwise.
- **Assigned to** — shown to everyone who can see the lead at all; editable only
  behind `LEADS_ASSIGN` (Admin).

### 8.4 Navigation

`/staff` added to `INSTITUTION_NAV`, visible only when the current user holds
`STAFF_MANAGE` (i.e., Admin only) — Counselor and Front Desk sessions simply don't see
the entry, mirroring how the platform admin's nav already omits things they can't
reach.

---

## 9. Known limitations

Recorded honestly, matching both prior phases:

- **No self-service claiming.** A counselor cannot assign an unassigned lead to
  themselves; every routing decision goes through an admin. Accepted deliberately per
  your own explicit choice — worth knowing this is a real workflow bottleneck for a
  busy front desk, not something this phase tried and failed to solve.
- **No reassignment audit trail** beyond what the existing `Activity` log already
  records generically.
- **No bulk assignment** — one lead at a time.
- **No escalation logic.** An overdue follow-up is a badge, not an automated
  reassignment or a second notification to the admin.
- **The reminder job is once-daily and date-only.** A follow-up "due" at any point in
  the day fires once at 2am UTC; there is no intraday precision.

---

## 10. Migration

Zero-downtime, same shape as both prior phases:

- `assignedTo`/`assignedAt`/`followUpAt`/`followUpNotifiedAt` are all nullable and
  absent on every existing lead — no backfill.
- No existing user is auto-converted. Every current institution-side account remains
  `INSTITUTION_ADMIN` until the institution deliberately creates Counselor/Front Desk
  accounts.
- `CRON_SECRET` is a new required env var for production (the cron route 401s without
  it) — added to `.env.example` and the deployment checklist, not silently assumed.

---

## 11. Testing

Mirroring both prior phases' unit/integration split.

**Unit**
- `role-permissions.test.ts` — every permission in `ROLE_PERMISSIONS` asserted present
  or absent per role, including the platform-admin-holds-nothing case (§5.4).
- `lead-visibility.test.ts` — `leadVisibilityFilter()` produces the right query shape
  for each role.

**Integration**
- `lead-assignment.test.ts` — assign/reassign/unassign; a Front-Desk-id target 400s;
  a cross-institution target 404s (never 403, matching the platform's existing
  cross-tenant convention); `Activity` records the change.
- `lead-followup.test.ts` — setting/clearing the date; a Counselor can set it only on
  their own lead (403 on someone else's); an Admin can set it on any lead.
- `follow-up-reminder-cron.test.ts` — a due, unassigned-notified lead triggers exactly
  one push per counselor regardless of how many of their leads are due; a lead already
  notified today (`followUpNotifiedAt` set) is skipped; a terminal-status lead is
  skipped; the route 401s without the correct `CRON_SECRET` header.
- `staff-management.test.ts` — create/deactivate a Counselor and a Front Desk account;
  a non-admin session 403s on every `/staff` route.
- `role-boundary.test.ts` — confirms §5.5's premise rather than a regression risk:
  since `requireInstitution()` is untouched by this phase, a Counselor and a Front
  Desk session both still 403 on a representative Admin-only route (institution
  settings PATCH, results publish). One test each, guarding against a future change
  accidentally loosening `requireInstitution()` rather than against anything this
  phase itself does.

**Method.** Every guard is verified by mutation: remove the guard, confirm the test
fails, restore it — same discipline as both prior phases.

---

## 12. Definition of done

- All tests green, and the pre-existing suite (402 as of Phase 2) still green.
- `npx tsc --noEmit` clean; lint clean.
- Every permission in §5.2 has a test proving it's held or withheld correctly per
  role, and ownership scoping is proven for both `LEADS_UPDATE` and
  `LEADS_SET_FOLLOWUP`.
- `requireInstitution()` is provably unmodified by this phase's diff, and a
  representative Admin-only route still rejects Counselor and Front Desk sessions
  (§5.5).
- A Counselor's queue genuinely shows only their own assigned leads plus unassigned
  ones, verified over real HTTP with two counselor sessions.
- The reminder cron sends exactly one push per counselor per day regardless of lead
  count, verified by mutation (remove the grouping, confirm a test catches N
  individual pushes instead of one).
- The platform admin has no route to any of this — verified by absence, matching both
  prior phases.

---

## 13. Recommended Phase 4

Not named yet. The two items flagged during Phase 2's final review — archive/delete
controls for results (API exists, no UI) and the `examLabel` public-visibility
decision — are smaller than a phase and can land as standalone bounded changes
whenever convenient, not blocking anything here. Beyond that, no further phase has
been scoped; the next one should come from what actually turns out to hurt once
Counselor/Front Desk accounts are real and in use — self-service claiming (§9) is the
most likely candidate, but validating that against real usage first is worth more than
guessing now.
