# Phase 3 — Lead Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Lead Network a real staff role model (Counselor, Front Desk, alongside Institution Admin), route leads to a counselor, and remind them with a daily push when a follow-up date arrives.

**Architecture:** Extends the existing Lead Network in place — no new module, no new master-identity attachment. Three additive layers: a role/permission extension (`USER_ROLES` + a `ROLE_PERMISSIONS` lookup table, mirroring the codebase's existing `ApiPermission` pattern), new fields on `Lead` (`assignedTo`, `followUpAt`, and their bookkeeping), and a daily Vercel Cron that pushes one notification per counselor with a due follow-up.

**Tech Stack:** Next.js 16 App Router, Mongoose 8, Zod 4, TypeScript, Vitest 3, Vercel Cron.

**Spec:** `docs/superpowers/specs/2026-08-24-lead-follow-up-design.md`

## Global Constraints

Copied from the spec. Every task's requirements implicitly include these.

- **`requireInstitution()` is never modified.** It stays the Admin-only guard it already is (`role !== "INSTITUTION_ADMIN"`), correctly excluding Counselor and Front Desk from profile/results/settings/API-credential routes by construction. No task in this plan touches `src/lib/tenant/index.ts`'s `requireInstitution()` function body.
- **The leads/applications flow already accepts any non-`SUPER_ADMIN` role** via `tenantFilter()`/`requireTenantUser()`/`requireTenantUserPage()`/`requireApiUser()`. Adding `COUNSELOR`/`FRONT_DESK` to `USER_ROLES` makes those routes admit the new roles with zero changes to those guards — the new `requirePermission()` layer is purely additive on top.
- **Permissions are an explicit lookup table**, `ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>>`, checked via one `requirePermission(user, permission)` call per route — never inline `role === X || role === Y` conditionals.
- **`LEADS_UPDATE` and `LEADS_SET_FOLLOWUP` are ownership-scoped for `COUNSELOR`.** Holding the permission is necessary but not sufficient — the service layer additionally checks `lead.assignedTo === currentUser.id` before allowing the write. `INSTITUTION_ADMIN` holds every permission unscoped.
- **`FRONT_DESK` holds `LEADS_VIEW_OWN`, not `LEADS_VIEW_ALL`.** Since `assignedTo` never points at a Front Desk user, the same "mine + unassigned" filter degrades correctly to "unassigned only" for them — their intake queue, nothing a counselor has already claimed.
- **`assignedTo` may reference an `INSTITUTION_ADMIN` or a `COUNSELOR`, never a `FRONT_DESK` user.** Enforced at the service layer, not the schema.
- **Only an admin (`LEADS_ASSIGN`) can assign or reassign a lead.** Front Desk creates and views but does not route.
- **Follow-up is a date, not a datetime.** Stored as a `Date` at midnight UTC for the given calendar date.
- **`followUpNotifiedAt` is cleared whenever `followUpAt` changes** (including being cleared to `null`) — this is what re-arms the daily reminder after a date is edited.
- **The reminder job sends one push per counselor per day** ("N follow-ups due today"), never one push per lead.
- **A cross-tenant or invalid target returns `NOT_FOUND`, never `FORBIDDEN`** — matching every prior phase's convention.
- **The platform admin (`SUPER_ADMIN`) holds zero permissions in `ROLE_PERMISSIONS`** and has no route to any of this — documentation of an existing fact (`tenantFilter()` already rejects `SUPER_ADMIN`), not a new check.
- **Every guard is verified by mutation**: remove it, confirm the named test fails, restore it.
- **The pre-existing 402 tests must stay green** at every commit.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `src/lib/tenant/permissions.ts` | `Permission`, `ROLE_PERMISSIONS`, `requirePermission()`, `leadVisibilityFilter()`. |
| `src/services/staff.service.ts` | Create/list/deactivate Counselor and Front Desk accounts. |
| `src/lib/validation/staff.ts` | Zod shapes for staff creation. |
| `src/app/api/staff/route.ts` | GET list, POST create. |
| `src/app/api/staff/[id]/route.ts` | PATCH (deactivate/reactivate). |
| `src/app/api/leads/[id]/assign/route.ts` | POST assign/unassign. |
| `src/app/api/cron/follow-up-reminders/route.ts` | The daily reminder job. |
| `src/app/(dashboard)/staff/page.tsx` | Staff list + create form. |
| `src/components/staff/staff-list-view.tsx`, `create-staff-form.tsx` | Staff management UI. |
| `src/components/leads/lead-assign-control.tsx`, `lead-followup-control.tsx` | Per-lead controls, mirroring `lead-status-control.tsx`. |
| `vercel.json` | The cron schedule. |

**Modified:** `src/lib/constants.ts` (roles, labels), `src/models/Lead.ts` (new fields + indexes), `src/services/lead.service.ts` (assign, setFollowUp, visibility-aware list), `src/lib/validation/lead.ts` (query/patch schemas), `src/app/api/leads/route.ts`, `src/app/api/leads/[id]/route.ts` (permission checks, `followUpAt` on PATCH), `src/services/device.service.ts` (`forUser`), `src/services/notification.service.ts` (`notifyFollowUpsDue`), `src/components/leads/leads-list-view.tsx`, `src/app/(dashboard)/enquiries/[leadNumber]/page.tsx`, `src/components/dashboard/nav-config.ts`, `.env.example`.

---

### Task 1: Roles, permissions, and the permission table

**Files:**
- Modify: `src/lib/constants.ts` (append)
- Create: `src/lib/tenant/permissions.ts`
- Test: `tests/unit/role-permissions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `USER_ROLES` gains `"COUNSELOR"`, `"FRONT_DESK"`
  - `USER_ROLE_LABELS: Record<UserRole, string>`
  - `PERMISSIONS = ["LEADS_VIEW_ALL", "LEADS_VIEW_OWN", "LEADS_CREATE", "LEADS_UPDATE", "LEADS_ASSIGN", "LEADS_SET_FOLLOWUP", "LEADS_DELETE", "LEADS_EXPORT", "STAFF_MANAGE"] as const`
  - `type Permission = (typeof PERMISSIONS)[number]`
  - `ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>>`
  - `requirePermission(user: CurrentUser, permission: Permission): void` — throws `forbidden()`
  - `hasPermission(user: CurrentUser, permission: Permission): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/role-permissions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hasPermission, requirePermission } from "@/lib/tenant/permissions";
import { PERMISSIONS, ROLE_PERMISSIONS, USER_ROLES } from "@/lib/constants";
import { AppError } from "@/lib/api/errors";
import type { CurrentUser } from "@/lib/auth/current-user";

function userOf(role: (typeof USER_ROLES)[number]): CurrentUser {
  return { id: "u1", name: "Test", email: "t@example.test", role, institutionId: "INS0001" };
}

describe("ROLE_PERMISSIONS", () => {
  it("has an entry for every role, including SUPER_ADMIN", () => {
    for (const role of USER_ROLES) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
    }
  });

  it("gives SUPER_ADMIN zero permissions", () => {
    expect(ROLE_PERMISSIONS.SUPER_ADMIN.size).toBe(0);
  });

  it("gives INSTITUTION_ADMIN every permission", () => {
    for (const permission of PERMISSIONS) {
      expect(ROLE_PERMISSIONS.INSTITUTION_ADMIN.has(permission)).toBe(true);
    }
  });

  it("gives COUNSELOR exactly LEADS_VIEW_OWN, LEADS_UPDATE, LEADS_SET_FOLLOWUP", () => {
    expect([...ROLE_PERMISSIONS.COUNSELOR].sort()).toEqual(
      ["LEADS_SET_FOLLOWUP", "LEADS_UPDATE", "LEADS_VIEW_OWN"].sort(),
    );
  });

  it("gives FRONT_DESK exactly LEADS_VIEW_OWN and LEADS_CREATE — never LEADS_VIEW_ALL", () => {
    expect([...ROLE_PERMISSIONS.FRONT_DESK].sort()).toEqual(
      ["LEADS_CREATE", "LEADS_VIEW_OWN"].sort(),
    );
    expect(ROLE_PERMISSIONS.FRONT_DESK.has("LEADS_VIEW_ALL")).toBe(false);
  });

  it("never gives COUNSELOR or FRONT_DESK STAFF_MANAGE, LEADS_ASSIGN, LEADS_DELETE, or LEADS_EXPORT", () => {
    for (const role of ["COUNSELOR", "FRONT_DESK"] as const) {
      for (const permission of ["STAFF_MANAGE", "LEADS_ASSIGN", "LEADS_DELETE", "LEADS_EXPORT"] as const) {
        expect(ROLE_PERMISSIONS[role].has(permission)).toBe(false);
      }
    }
  });
});

describe("hasPermission / requirePermission", () => {
  it("hasPermission reflects the table", () => {
    expect(hasPermission(userOf("COUNSELOR"), "LEADS_UPDATE")).toBe(true);
    expect(hasPermission(userOf("COUNSELOR"), "LEADS_ASSIGN")).toBe(false);
  });

  it("requirePermission throws FORBIDDEN when the role lacks the permission", () => {
    expect(() => requirePermission(userOf("FRONT_DESK"), "LEADS_ASSIGN")).toThrow(AppError);
    try {
      requirePermission(userOf("FRONT_DESK"), "LEADS_ASSIGN");
    } catch (error) {
      expect((error as AppError).code).toBe("FORBIDDEN");
    }
  });

  it("requirePermission does not throw when the role holds the permission", () => {
    expect(() => requirePermission(userOf("INSTITUTION_ADMIN"), "STAFF_MANAGE")).not.toThrow();
  });

  it("requirePermission throws for SUPER_ADMIN on every permission", () => {
    for (const permission of PERMISSIONS) {
      expect(() => requirePermission(userOf("SUPER_ADMIN"), permission)).toThrow(AppError);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/role-permissions.test.ts
```

Expected: FAIL — cannot resolve `@/lib/tenant/permissions`, and `USER_ROLES`/`PERMISSIONS`/`ROLE_PERMISSIONS` don't exist yet.

- [ ] **Step 3: Extend `src/lib/constants.ts`**

Find the existing line:

```ts
export const USER_ROLES = ["SUPER_ADMIN", "INSTITUTION_ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];
```

Replace with:

```ts
export const USER_ROLES = ["SUPER_ADMIN", "INSTITUTION_ADMIN", "COUNSELOR", "FRONT_DESK"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: "Platform administrator",
  INSTITUTION_ADMIN: "Institution admin",
  COUNSELOR: "Counselor",
  FRONT_DESK: "Front desk",
};
```

This is the only edit to the existing `USER_ROLES` block — do not reorder or touch anything else in this file. Append the new permission tuple at the very end of the file:

```ts
export const PERMISSIONS = [
  "LEADS_VIEW_ALL",
  "LEADS_VIEW_OWN",
  "LEADS_CREATE",
  "LEADS_UPDATE",
  "LEADS_ASSIGN",
  "LEADS_SET_FOLLOWUP",
  "LEADS_DELETE",
  "LEADS_EXPORT",
  "STAFF_MANAGE",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Who can do what. Checked once per route via `requirePermission()` — never
 * inline `role === X || role === Y` conditionals, so moving a permission
 * between roles later is a one-line edit here, not an audit of every route
 * that happens to check that role.
 *
 * `COUNSELOR`'s LEADS_UPDATE/LEADS_SET_FOLLOWUP and `FRONT_DESK`'s
 * LEADS_VIEW_OWN are further scoped at the service layer (ownership, and the
 * "mine + unassigned" filter) — this table only says which permissions a
 * role holds at all, not what document-level scoping applies.
 */
export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  SUPER_ADMIN: new Set([]),
  INSTITUTION_ADMIN: new Set([
    "LEADS_VIEW_ALL",
    "LEADS_CREATE",
    "LEADS_UPDATE",
    "LEADS_ASSIGN",
    "LEADS_SET_FOLLOWUP",
    "LEADS_DELETE",
    "LEADS_EXPORT",
    "STAFF_MANAGE",
  ]),
  COUNSELOR: new Set(["LEADS_VIEW_OWN", "LEADS_UPDATE", "LEADS_SET_FOLLOWUP"]),
  FRONT_DESK: new Set(["LEADS_VIEW_OWN", "LEADS_CREATE"]),
};
```

- [ ] **Step 4: Create `src/lib/tenant/permissions.ts`**

```ts
import "server-only";
import { ROLE_PERMISSIONS, type Permission } from "@/lib/constants";
import { forbidden } from "@/lib/api/errors";
import type { CurrentUser } from "@/lib/auth/current-user";

export function hasPermission(user: CurrentUser, permission: Permission): boolean {
  return ROLE_PERMISSIONS[user.role]?.has(permission) ?? false;
}

/** The sole place a route asks "may this user do this specific thing." */
export function requirePermission(user: CurrentUser, permission: Permission): void {
  if (!hasPermission(user, permission)) throw forbidden();
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tests/unit/role-permissions.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 6: Run the full suite to confirm nothing regressed**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: typecheck clean, 402 pre-existing + 10 new = 412 passing. Widening `USER_ROLES` is additive to the enum; nothing pre-existing constructs a `UserRole` by exhaustively listing the old two values in a way that would break — but confirm this directly rather than assume it, since it's exactly the kind of silent-drift risk a wider enum can cause.

- [ ] **Step 7: Commit**

```bash
git add src/lib/constants.ts src/lib/tenant/permissions.ts tests/unit/role-permissions.test.ts
git commit -m "feat: add Counselor and Front Desk roles with a permission table"
```

---

### Task 2: `leadVisibilityFilter()` and the ownership check

**Files:**
- Modify: `src/lib/tenant/permissions.ts`
- Test: `tests/unit/lead-visibility.test.ts`

**Interfaces:**
- Consumes: `hasPermission`, `ROLE_PERMISSIONS` (Task 1).
- Produces:
  - `leadVisibilityFilter(user: CurrentUser): Record<string, unknown>`
  - `assertOwnsLead(user: CurrentUser, lead: { assignedTo?: string | null }): void` — throws `notFound()` (never `forbidden()` — matches the platform's cross-tenant convention) when a `COUNSELOR` holds `LEADS_UPDATE`/`LEADS_SET_FOLLOWUP` but the lead isn't theirs. `INSTITUTION_ADMIN` always passes.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lead-visibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertOwnsLead, leadVisibilityFilter } from "@/lib/tenant/permissions";
import { AppError } from "@/lib/api/errors";
import type { CurrentUser } from "@/lib/auth/current-user";

function userOf(role: CurrentUser["role"], id = "u1"): CurrentUser {
  return { id, name: "Test", email: "t@example.test", role, institutionId: "INS0001" };
}

describe("leadVisibilityFilter", () => {
  it("returns an empty filter for a role holding LEADS_VIEW_ALL", () => {
    expect(leadVisibilityFilter(userOf("INSTITUTION_ADMIN"))).toEqual({});
  });

  it("returns a mine-or-unassigned filter for a role holding only LEADS_VIEW_OWN", () => {
    expect(leadVisibilityFilter(userOf("COUNSELOR", "c1"))).toEqual({
      $or: [{ assignedTo: "c1" }, { assignedTo: null }],
    });
  });

  it("produces the same shape for FRONT_DESK, whose assignedTo is always null in practice", () => {
    expect(leadVisibilityFilter(userOf("FRONT_DESK", "f1"))).toEqual({
      $or: [{ assignedTo: "f1" }, { assignedTo: null }],
    });
  });
});

describe("assertOwnsLead", () => {
  it("never throws for INSTITUTION_ADMIN, regardless of assignedTo", () => {
    expect(() => assertOwnsLead(userOf("INSTITUTION_ADMIN"), { assignedTo: "someone-else" })).not.toThrow();
    expect(() => assertOwnsLead(userOf("INSTITUTION_ADMIN"), { assignedTo: null })).not.toThrow();
  });

  it("passes for a COUNSELOR when the lead is assigned to them", () => {
    expect(() => assertOwnsLead(userOf("COUNSELOR", "c1"), { assignedTo: "c1" })).not.toThrow();
  });

  it("throws NOT_FOUND — never FORBIDDEN — for a COUNSELOR on someone else's lead", () => {
    expect(() => assertOwnsLead(userOf("COUNSELOR", "c1"), { assignedTo: "c2" })).toThrow(AppError);
    try {
      assertOwnsLead(userOf("COUNSELOR", "c1"), { assignedTo: "c2" });
    } catch (error) {
      expect((error as AppError).code).toBe("NOT_FOUND");
    }
  });

  it("throws NOT_FOUND for a COUNSELOR on an unassigned lead — ownership, not just visibility", () => {
    expect(() => assertOwnsLead(userOf("COUNSELOR", "c1"), { assignedTo: null })).toThrow(AppError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/lead-visibility.test.ts
```

Expected: FAIL — `leadVisibilityFilter`/`assertOwnsLead` not exported.

- [ ] **Step 3: Add to `src/lib/tenant/permissions.ts`**

Add this import at the top:

```ts
import { notFound } from "@/lib/api/errors";
```

Add these two functions:

```ts
/**
 * A role holding LEADS_VIEW_ALL sees everything; otherwise the query is
 * scoped to leads assigned to this user plus unassigned ones. This degrades
 * correctly for FRONT_DESK, who is never a valid assignment target — their
 * "mine" clause simply never matches, leaving only unassigned leads, which is
 * exactly their intake queue.
 */
export function leadVisibilityFilter(user: CurrentUser): Record<string, unknown> {
  if (hasPermission(user, "LEADS_VIEW_ALL")) return {};
  return { $or: [{ assignedTo: user.id }, { assignedTo: null }] };
}

/**
 * Ownership, not just visibility: even a lead a COUNSELOR can see (because it
 * is unassigned) is not theirs to update or set a follow-up on. NOT_FOUND
 * rather than FORBIDDEN, matching the platform's cross-tenant convention —
 * a lead outside your reach is indistinguishable from one that isn't there.
 * INSTITUTION_ADMIN always passes; this check exists only because the table
 * grants COUNSELOR its permissions without per-document scoping.
 */
export function assertOwnsLead(
  user: CurrentUser,
  lead: { assignedTo?: string | null },
): void {
  if (user.role === "INSTITUTION_ADMIN") return;
  if (lead.assignedTo !== user.id) throw notFound("Enquiry not found");
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/unit/lead-visibility.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-check the guards**

| Mutation | Test that must fail |
|---|---|
| Delete the `hasPermission(user, "LEADS_VIEW_ALL")` early return | `returns an empty filter for a role holding LEADS_VIEW_ALL` |
| Change `assertOwnsLead` to `if (user.role === "INSTITUTION_ADMIN" \|\| user.role === "COUNSELOR") return;` | `throws NOT_FOUND — never FORBIDDEN — for a COUNSELOR on someone else's lead` |
| Change the thrown error to `forbidden()` instead of `notFound()` | the same test — assert on `.code === "NOT_FOUND"` will fail |

- [ ] **Step 6: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: typecheck clean, 412 pre-existing + 7 new = 419 passing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tenant/permissions.ts tests/unit/lead-visibility.test.ts
git commit -m "feat: add lead visibility filtering and ownership checks"
```

---

### Task 3: `Lead` model — assignment and follow-up fields

**Files:**
- Modify: `src/models/Lead.ts`
- Test: `tests/unit/lead-model.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `LeadDoc` gains `assignedTo?: string`, `assignedAt?: Date`, `followUpAt?: Date`, `followUpNotifiedAt?: Date`. Two new indexes.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lead-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Lead } from "@/models/Lead";

describe("Lead model — assignment and follow-up fields", () => {
  it("defaults a new lead to unassigned with no follow-up", () => {
    const doc = new Lead({
      leadNumber: "INS0001-LD000001",
      institutionId: "INS0001",
      studentName: "Test Student",
      phone: "9876543210",
      status: "NEW",
      source: "API",
    });

    expect(doc.assignedTo).toBeUndefined();
    expect(doc.assignedAt).toBeUndefined();
    expect(doc.followUpAt).toBeUndefined();
    expect(doc.followUpNotifiedAt).toBeUndefined();
  });

  it("accepts an assignedTo id and a followUpAt date", () => {
    const doc = new Lead({
      leadNumber: "INS0001-LD000002",
      institutionId: "INS0001",
      studentName: "Test Student",
      phone: "9876543210",
      status: "NEW",
      source: "API",
      assignedTo: "6a887abd755db527bea51204",
      assignedAt: new Date(),
      followUpAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.assignedTo).toBe("6a887abd755db527bea51204");
  });

  it("declares the assignment-queue and follow-up-cron indexes", () => {
    const indexes = Lead.schema.indexes();

    expect(
      indexes.some(
        ([fields]) =>
          fields.institutionId === 1 && fields.assignedTo === 1 && fields.createdAt === -1,
      ),
    ).toBe(true);

    expect(
      indexes.some(([fields]) => fields.followUpAt === 1 && fields.followUpNotifiedAt === 1),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/lead-model.test.ts
```

Expected: FAIL — `assignedTo` etc. are not schema paths, so `doc.assignedTo` is `undefined` by accident rather than by design, and the second test's `validateSync()` may pass coincidentally; the third test fails for real (indexes don't exist).

- [ ] **Step 3: Modify `src/models/Lead.ts`**

Add these fields to `LeadSchema`'s definition object, after `sourceUrl`:

```ts
    // The counselor (or admin) working this lead. Never a Front Desk user —
    // enforced at the service layer, since Front Desk doesn't do casework.
    assignedTo: { type: String, index: true },
    assignedAt: { type: Date },
    // Date-only semantics: stored at midnight UTC for the given calendar day.
    followUpAt: { type: Date },
    // Stamped by the daily reminder job the day it fires for the CURRENT
    // followUpAt. Cleared to undefined whenever followUpAt changes, which is
    // what re-arms the reminder after a date is edited.
    followUpNotifiedAt: { type: Date },
```

Add these two indexes alongside the existing ones (after `LeadSchema.index({ institutionId: 1, status: 1, createdAt: -1 });`):

```ts
// "My queue": a counselor's own assigned leads, newest first.
LeadSchema.index({ institutionId: 1, assignedTo: 1, createdAt: -1 });
// The daily reminder job's query. Deliberately not institution-scoped — the
// job runs once across the whole platform and groups by institution/
// counselor in application code, not in the query.
LeadSchema.index({ followUpAt: 1, followUpNotifiedAt: 1 });
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/unit/lead-model.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: typecheck clean, 419 pre-existing + 3 new = 422 passing.

- [ ] **Step 6: Commit**

```bash
git add src/models/Lead.ts tests/unit/lead-model.test.ts
git commit -m "feat: add assignment and follow-up fields to the Lead model"
```

---

### Task 4: `LeadService` — assign, setFollowUp, visibility-aware list

**Files:**
- Modify: `src/services/lead.service.ts`
- Modify: `src/lib/types.ts` (extend `LeadDTO`)
- Test: `tests/integration/lead-assignment.test.ts`, `tests/integration/lead-followup.test.ts`

**Interfaces:**
- Consumes: `leadVisibilityFilter`, `assertOwnsLead`, `hasPermission` (Tasks 1-2); `CurrentUser` type.
- Produces:
  - `LeadDTO` gains `assignedTo?: string`, `assignedToName?: string`, `assignedAt?: string`, `followUpAt?: string`, `followUpNotifiedAt?: string`
  - `LeadService.assign(input: { tenantClause: Record<string, unknown>; id: string; assignedTo: string | null; actor: { id: string; name: string } }): Promise<LeadDTO>` — throws `notFound` for a cross-tenant lead or an invalid target
  - `LeadService.setFollowUp(input: { tenantClause: Record<string, unknown>; id: string; followUpAt: string | null; user: CurrentUser }): Promise<LeadDTO>` — calls `assertOwnsLead` internally
  - `LeadService.list()`'s existing signature is unchanged, but callers now pass a filter that already includes `leadVisibilityFilter()`'s clause merged into `tenantClause` — no signature change needed here since `buildFilter` already spreads `tenantClause` first.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/lead-assignment.test.ts`:

```ts
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { LeadService } from "@/services/lead.service";
import { tenantFilter } from "@/lib/tenant";
import { Lead } from "@/models";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(() => startTestDatabase("lead-assignment"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

async function makeLead(institutionId: string) {
  return LeadService.createLead({
    institutionId,
    data: { studentName: "Test Student", phone: "9876543210" },
    source: "API",
  });
}

describe("LeadService.assign", () => {
  it("assigns a lead to a counselor and stamps assignedAt", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "counselor@infinityschool.edu.in");
    const lead = await makeLead("INS0001");

    const updated = await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselor._id),
      actor,
    });

    expect(updated.assignedTo).toBe(String(counselor._id));
    expect(updated.assignedAt).toBeDefined();
  });

  it("unassigns when assignedTo is null", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "counselor@infinityschool.edu.in");
    const lead = await makeLead("INS0001");
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselor._id),
      actor,
    });

    const updated = await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: null,
      actor,
    });

    expect(updated.assignedTo).toBeUndefined();
  });

  it("refuses a Front Desk user as an assignment target", async () => {
    const frontDesk = await makeUser("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");
    const lead = await makeLead("INS0001");

    await expect(
      LeadService.assign({
        tenantClause: { institutionId: "INS0001" },
        id: lead.id,
        assignedTo: String(frontDesk._id),
        actor,
      }),
    ).rejects.toThrow(/counselor or admin/i);
  });

  it("returns NOT_FOUND for a target user in a different institution", async () => {
    const foreignCounselor = await makeUser("INS0002", "COUNSELOR", "counselor@intelligentpublic.edu.in");
    const lead = await makeLead("INS0001");

    await expect(
      LeadService.assign({
        tenantClause: { institutionId: "INS0001" },
        id: lead.id,
        assignedTo: String(foreignCounselor._id),
        actor,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns NOT_FOUND for a lead in a different institution", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "counselor@infinityschool.edu.in");
    const lead = await makeLead("INS0002");

    await expect(
      LeadService.assign({
        tenantClause: { institutionId: "INS0001" },
        id: lead.id,
        assignedTo: String(counselor._id),
        actor,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("records an Activity entry naming old and new assignee on reassignment", async () => {
    const counselorA = await makeUser("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const counselorB = await makeUser("INS0001", "COUNSELOR", "b@infinityschool.edu.in");
    const lead = await makeLead("INS0001");

    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselorA._id),
      actor,
    });
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselorB._id),
      actor,
    });

    const { Activity } = await import("@/models");
    const entries = await Activity.find({ institutionId: "INS0001", entityType: "LEAD" })
      .sort({ createdAt: 1 })
      .lean();
    const reassignEntry = entries[entries.length - 1];
    expect(reassignEntry.action).toMatch(/reassign/i);
  });
});

describe("LeadService.list — visibility", () => {
  it("scopes a counselor's list to their own assigned leads plus unassigned ones", async () => {
    const counselorA = await makeUser("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const counselorB = await makeUser("INS0001", "COUNSELOR", "b@infinityschool.edu.in");
    const leadA = await makeLead("INS0001");
    const leadB = await makeLead("INS0001");
    const leadUnassigned = await makeLead("INS0001");

    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: leadA.id,
      assignedTo: String(counselorA._id),
      actor,
    });
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: leadB.id,
      assignedTo: String(counselorB._id),
      actor,
    });

    const { leadVisibilityFilter } = await import("@/lib/tenant/permissions");
    const currentUser = {
      id: String(counselorA._id),
      name: "A",
      email: "a@infinityschool.edu.in",
      role: "COUNSELOR" as const,
      institutionId: "INS0001",
    };
    const result = await LeadService.list(
      { institutionId: "INS0001", ...leadVisibilityFilter(currentUser) },
      {},
    );

    const ids = result.items.map((item) => item.id).sort();
    expect(ids).toEqual([leadA.id, leadUnassigned.id].sort());
  });
});
```

Create `tests/integration/lead-followup.test.ts`:

```ts
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { LeadService } from "@/services/lead.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

beforeAll(() => startTestDatabase("lead-followup"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});

async function makeLead() {
  return LeadService.createLead({
    institutionId: "INS0001",
    data: { studentName: "Test Student", phone: "9876543210" },
    source: "API",
  });
}

describe("LeadService.setFollowUp", () => {
  it("an admin can set a follow-up date on any lead", async () => {
    const lead = await makeLead();
    const admin = {
      id: "6a887abd755db527bea51204",
      name: "Admin",
      email: "admin@infinityschool.edu.in",
      role: "INSTITUTION_ADMIN" as const,
      institutionId: "INS0001",
    };

    const updated = await LeadService.setFollowUp({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      followUpAt: "2026-09-01",
      user: admin,
    });

    expect(updated.followUpAt).toContain("2026-09-01");
  });

  it("a counselor can set a follow-up only on their own assigned lead", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const lead = await makeLead();
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselor._id),
      actor,
    });

    const counselorUser = {
      id: String(counselor._id),
      name: "C",
      email: "c@infinityschool.edu.in",
      role: "COUNSELOR" as const,
      institutionId: "INS0001",
    };

    const updated = await LeadService.setFollowUp({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      followUpAt: "2026-09-01",
      user: counselorUser,
    });
    expect(updated.followUpAt).toContain("2026-09-01");
  });

  it("returns NOT_FOUND for a counselor setting a follow-up on someone else's lead", async () => {
    const counselorA = await makeUser("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const counselorB = await makeUser("INS0001", "COUNSELOR", "b@infinityschool.edu.in");
    const lead = await makeLead();
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselorA._id),
      actor,
    });

    const counselorBUser = {
      id: String(counselorB._id),
      name: "B",
      email: "b@infinityschool.edu.in",
      role: "COUNSELOR" as const,
      institutionId: "INS0001",
    };

    await expect(
      LeadService.setFollowUp({
        tenantClause: { institutionId: "INS0001" },
        id: lead.id,
        followUpAt: "2026-09-01",
        user: counselorBUser,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("clears followUpNotifiedAt whenever followUpAt changes", async () => {
    const lead = await makeLead();
    const admin = {
      id: "6a887abd755db527bea51204",
      name: "Admin",
      email: "admin@infinityschool.edu.in",
      role: "INSTITUTION_ADMIN" as const,
      institutionId: "INS0001",
    };

    await LeadService.setFollowUp({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      followUpAt: "2026-09-01",
      user: admin,
    });

    const { Lead } = await import("@/models");
    await Lead.updateOne({ _id: lead.id }, { $set: { followUpNotifiedAt: new Date() } });

    const updated = await LeadService.setFollowUp({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      followUpAt: "2026-09-15",
      user: admin,
    });

    const row = await Lead.findById(updated.id).lean();
    expect(row?.followUpNotifiedAt).toBeUndefined();
  });

  it("clearing followUpAt to null also clears followUpNotifiedAt", async () => {
    const lead = await makeLead();
    const admin = {
      id: "6a887abd755db527bea51204",
      name: "Admin",
      email: "admin@infinityschool.edu.in",
      role: "INSTITUTION_ADMIN" as const,
      institutionId: "INS0001",
    };
    await LeadService.setFollowUp({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      followUpAt: "2026-09-01",
      user: admin,
    });

    const updated = await LeadService.setFollowUp({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      followUpAt: null,
      user: admin,
    });

    expect(updated.followUpAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/integration/lead-assignment.test.ts tests/integration/lead-followup.test.ts
```

Expected: FAIL — `LeadService.assign`/`setFollowUp` are not functions.

- [ ] **Step 3: Extend `LeadDTO` in `src/lib/types.ts`**

Add to the existing `LeadDTO` type, after `sourceUrl`:

```ts
  assignedTo?: string;
  assignedToName?: string;
  assignedAt?: string;
  followUpAt?: string;
  followUpNotifiedAt?: string;
```

- [ ] **Step 4: Modify `src/services/lead.service.ts`**

`assignedToName` cannot be filled in by `serialize()` alone — a lead row only stores
`assignedTo` (a user id), and `serialize()` is synchronous with no database access of
its own. Resolve names in a small batch lookup at the two call sites that need them
(`list` and `getById`), not inside `serialize()` itself.

Update the `serialize` function to accept an optional name-lookup map:

```ts
function serialize(row: LeadRow, assigneeNames?: Map<string, string>): LeadDTO {
  return {
    id: String(row._id),
    leadNumber: row.leadNumber,
    institutionId: row.institutionId,
    studentName: row.studentName,
    parentName: row.parentName ?? undefined,
    phone: row.phone,
    email: row.email ?? undefined,
    classInterested: row.classInterested ?? undefined,
    message: row.message ?? undefined,
    status: row.status as LeadStatus,
    source: row.source as Source,
    sourceApplication: row.sourceApplication ?? undefined,
    sourceUrl: row.sourceUrl ?? undefined,
    assignedTo: row.assignedTo ?? undefined,
    assignedToName: row.assignedTo ? assigneeNames?.get(row.assignedTo) : undefined,
    assignedAt: row.assignedAt ? requiredIso(row.assignedAt) : undefined,
    followUpAt: row.followUpAt ? requiredIso(row.followUpAt) : undefined,
    followUpNotifiedAt: row.followUpNotifiedAt ? requiredIso(row.followUpNotifiedAt) : undefined,
    createdAt: requiredIso(row.createdAt),
    updatedAt: requiredIso(row.updatedAt),
  };
}

/** Batch-resolves assignee names for a set of leads in one query, not N+1. */
async function resolveAssigneeNames(rows: LeadRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.assignedTo).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();

  const users = await User.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(users.map((user) => [String(user._id), user.name]));
}
```

Add these imports at the top:

```ts
import { User } from "@/models";
import { notFound, validationError } from "@/lib/api/errors";
import { assertOwnsLead } from "@/lib/tenant/permissions";
import type { CurrentUser } from "@/lib/auth/current-user";
```

(`notFound` is likely already imported — check before duplicating.)

Update the existing `list` method to resolve names before serializing:

```ts
  async list(
    tenantClause: Record<string, unknown>,
    query: Partial<LeadQuery>,
  ): Promise<Paginated<LeadDTO>> {
    await connectToDatabase();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const filter = buildFilter(tenantClause, query);

    const [rows, total] = await Promise.all([
      Lead.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Lead.countDocuments(filter),
    ]);

    const assigneeNames = await resolveAssigneeNames(rows as LeadRow[]);

    return {
      items: rows.map((row) => serialize(row as LeadRow, assigneeNames)),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  },
```

Update the existing `getById` method the same way:

```ts
  async getById(tenantClause: Record<string, unknown>, id: string): Promise<LeadDTO> {
    await connectToDatabase();
    const filter: FilterQuery<LeadDoc> = { ...tenantClause };
    if (Types.ObjectId.isValid(id)) {
      filter._id = new Types.ObjectId(id);
    } else {
      filter.leadNumber = id;
    }

    const row = await Lead.findOne(filter).lean();
    if (!row) throw notFound("Enquiry not found");

    const assigneeNames = await resolveAssigneeNames([row as LeadRow]);
    return serialize(row as LeadRow, assigneeNames);
  },
```

This is the only change to `list`/`getById` in this task — everything else about them
(filtering, pagination, the not-found path) is unchanged.

Add these two methods to the `LeadService` object, after `updateStatus`:

```ts
  async assign(input: {
    tenantClause: Record<string, unknown>;
    id: string;
    assignedTo: string | null;
    actor: { id: string; name: string };
  }): Promise<LeadDTO> {
    await connectToDatabase();
    const existing = await LeadService.getById(input.tenantClause, input.id);

    let targetName: string | undefined;
    if (input.assignedTo) {
      const target = await User.findOne({
        _id: input.assignedTo,
        institutionId: existing.institutionId,
      })
        .select("role name")
        .lean();
      if (!target) throw notFound("Enquiry not found");
      if (target.role !== "INSTITUTION_ADMIN" && target.role !== "COUNSELOR") {
        throw validationError("assignedTo: must be a counselor or admin at this institution");
      }
      targetName = target.name;
    }

    const previousAssignee = existing.assignedTo;
    const updated = await Lead.findOneAndUpdate(
      { _id: new Types.ObjectId(existing.id), ...input.tenantClause },
      input.assignedTo
        ? { $set: { assignedTo: input.assignedTo, assignedAt: new Date() } }
        : { $unset: { assignedTo: "", assignedAt: "" } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Enquiry not found");

    const action = !previousAssignee
      ? "Lead assigned"
      : !input.assignedTo
        ? "Lead unassigned"
        : "Lead reassigned";
    await ActivityService.record({
      institutionId: updated.institutionId,
      entityType: "LEAD",
      entityId: updated._id,
      entityRef: updated.leadNumber,
      action,
      description: input.assignedTo
        ? `Assigned to ${targetName}`
        : "Unassigned",
      performedBy: input.actor.id,
      performedByName: input.actor.name,
    });

    return serialize(updated as LeadRow);
  },

  async setFollowUp(input: {
    tenantClause: Record<string, unknown>;
    id: string;
    followUpAt: string | null;
    user: CurrentUser;
  }): Promise<LeadDTO> {
    await connectToDatabase();
    const existing = await LeadService.getById(input.tenantClause, input.id);
    assertOwnsLead(input.user, { assignedTo: existing.assignedTo ?? null });

    // followUpNotifiedAt is always $unset, never $set — a field cannot appear in
    // both operators on the same update, and $unset alone is what re-arms the
    // reminder (Global Constraint: "followUpNotifiedAt is cleared whenever
    // followUpAt changes").
    const update = input.followUpAt
      ? { $set: { followUpAt: new Date(input.followUpAt) }, $unset: { followUpNotifiedAt: "" } }
      : { $unset: { followUpAt: "", followUpNotifiedAt: "" } };

    const updated = await Lead.findOneAndUpdate(
      { _id: new Types.ObjectId(existing.id), ...input.tenantClause },
      update,
      { new: true },
    ).lean();
    if (!updated) throw notFound("Enquiry not found");

    await ActivityService.record({
      institutionId: updated.institutionId,
      entityType: "LEAD",
      entityId: updated._id,
      entityRef: updated.leadNumber,
      action: input.followUpAt ? "Follow-up date set" : "Follow-up date cleared",
      performedBy: input.user.id,
      performedByName: input.user.name,
    });

    return serialize(updated as LeadRow);
  },
```


- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run tests/integration/lead-assignment.test.ts tests/integration/lead-followup.test.ts
```

Expected: PASS, 7 tests + 5 tests = 12 tests (`lead-assignment.test.ts` has two `describe` blocks — `LeadService.assign` with 6 tests, and a separate `LeadService.list — visibility` with 1 more).

- [ ] **Step 6: Mutation-check the guards**

| Mutation | Test that must fail |
|---|---|
| Remove the `target.role !== "INSTITUTION_ADMIN" && target.role !== "COUNSELOR"` check | `refuses a Front Desk user as an assignment target` |
| Remove the `institutionId: existing.institutionId` clause from the target lookup | `returns NOT_FOUND for a target user in a different institution` |
| Remove `assertOwnsLead(...)` from `setFollowUp` | `returns NOT_FOUND for a counselor setting a follow-up on someone else's lead` |
| Remove the `$unset: { followUpNotifiedAt: "" }` on the follow-up branch | `clears followUpNotifiedAt whenever followUpAt changes` |

- [ ] **Step 7: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 422 pre-existing + 12 new = 434 passing.

- [ ] **Step 8: Commit**

```bash
git add src/services/lead.service.ts src/lib/types.ts tests/integration/lead-assignment.test.ts tests/integration/lead-followup.test.ts
git commit -m "feat: add lead assignment and follow-up date to LeadService"
```

---

### Task 5: Wire permissions into the lead routes; assignment route; follow-up on PATCH

**Files:**
- Modify: `src/lib/validation/lead.ts`
- Modify: `src/services/lead.service.ts` (`updateStatus` gains ownership scoping)
- Modify: `src/app/api/leads/route.ts`
- Modify: `src/app/api/leads/[id]/route.ts`
- Create: `src/app/api/leads/[id]/assign/route.ts`
- Test: `tests/integration/lead-routes-permissions.test.ts`

**Interfaces:**
- Consumes: `requirePermission`, `leadVisibilityFilter`, `assertOwnsLead` (Tasks 1-2); `LeadService.assign`, `LeadService.setFollowUp` (Task 4).
- Produces:
  - `LeadService.updateStatus`'s `actor: {id, name}` param becomes `user: CurrentUser` (ownership-scoped internally via `assertOwnsLead`) — the only signature change to an existing method in this plan.
  - `POST /api/leads/:id/assign` — body `{ assignedTo: string | null }`.
  - `PATCH /api/leads/:id` — now branches on `followUpAt` vs `status`.

- [ ] **Step 1: Write the failing test**

Read `tests/integration/profile-routes.test.ts` first (or `tests/integration/results-routes.test.ts`) to confirm the current cookie-session test convention — `signSession()` from `@/lib/auth/session`, a stubbed `next/headers` `cookies()`, `makeUser()` from `tests/helpers/factories.ts`. Use that exact pattern; do not invent a mocking convention.

Create `tests/integration/lead-routes-permissions.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { GET as listLeads, POST as createLead } from "@/app/api/leads/route";
import { PATCH as patchLead } from "@/app/api/leads/[id]/route";
import { POST as assignLead } from "@/app/api/leads/[id]/assign/route";
import { LeadService } from "@/services/lead.service";
import type { NextRequest } from "next/server";

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/leads");
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  headers.set("host", "localhost");
  return {
    headers,
    nextUrl: url,
    url: url.toString(),
    json: async () => init.body ?? {},
  } as unknown as NextRequest;
}

async function signIn(institutionId: string, role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK", email: string) {
  const user = await makeUser(institutionId, role, email);
  const token = await signSession({
    sub: String(user._id),
    role,
    institutionId,
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
  return user;
}

beforeAll(() => startTestDatabase("lead-routes-permissions"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("lead routes — permission enforcement", () => {
  it("a Counselor cannot create a lead — 403", async () => {
    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");

    const response = await createLead(
      cookieRequest({ body: { studentName: "Test", phone: "9876543210" }, origin: "http://localhost" }),
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk user can create a lead", async () => {
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await createLead(
      cookieRequest({ body: { studentName: "Test", phone: "9876543210" }, origin: "http://localhost" }),
    );
    expect(response.status).toBe(200);
  });

  it("a Front Desk user cannot update a lead's status — 403", async () => {
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "Test", phone: "9876543210" },
      source: "API",
    });
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await patchLead(
      cookieRequest({
        url: `http://localhost/api/leads/${lead.id}`,
        body: { status: "CONTACTED" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk user cannot assign a lead — 403", async () => {
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "Test", phone: "9876543210" },
      source: "API",
    });
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await assignLead(
      cookieRequest({
        url: `http://localhost/api/leads/${lead.id}/assign`,
        body: { assignedTo: String(counselor._id) },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );
    expect(response.status).toBe(403);
  });

  it("an admin can assign a lead over HTTP", async () => {
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "Test", phone: "9876543210" },
      source: "API",
    });
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await assignLead(
      cookieRequest({
        url: `http://localhost/api/leads/${lead.id}/assign`,
        body: { assignedTo: String(counselor._id) },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.lead.assignedTo).toBe(String(counselor._id));
  });

  it("a counselor can set a follow-up date on their own lead via PATCH", async () => {
    const lead = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "Test", phone: "9876543210" },
      source: "API",
    });
    const counselor = await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: lead.id,
      assignedTo: String(counselor._id),
      actor: { id: "x", name: "x" },
    });

    const response = await patchLead(
      cookieRequest({
        url: `http://localhost/api/leads/${lead.id}`,
        body: { followUpAt: "2026-09-01" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ id: lead.id }) } as never,
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.lead.followUpAt).toContain("2026-09-01");
  });

  it("a counselor's list only shows their own leads plus unassigned ones, over real HTTP", async () => {
    const counselorA = await makeUser("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const counselorB = await makeUser("INS0001", "COUNSELOR", "b@infinityschool.edu.in");
    const leadA = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "A's lead", phone: "9876543210" },
      source: "API",
    });
    const leadB = await LeadService.createLead({
      institutionId: "INS0001",
      data: { studentName: "B's lead", phone: "9876543211" },
      source: "API",
    });
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: leadA.id,
      assignedTo: String(counselorA._id),
      actor: { id: "x", name: "x" },
    });
    await LeadService.assign({
      tenantClause: { institutionId: "INS0001" },
      id: leadB.id,
      assignedTo: String(counselorB._id),
      actor: { id: "x", name: "x" },
    });

    await signIn("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const response = await listLeads(cookieRequest({ origin: "http://localhost" }));
    const payload = await response.json();

    const names = payload.items.map((item: { studentName: string }) => item.studentName);
    expect(names).toEqual(["A's lead"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/lead-routes-permissions.test.ts
```

Expected: FAIL — the assign route doesn't exist; existing routes don't yet check permissions or apply visibility filtering.

- [ ] **Step 3: Extend `src/lib/validation/lead.ts`**

Add after `updateLeadSchema`:

```ts
export const assignLeadSchema = z.object({
  assignedTo: z.string().min(1).nullable(),
});
export type AssignLeadInput = z.infer<typeof assignLeadSchema>;
```

Add `followUpAt` to the existing `updateLeadSchema`:

```ts
export const updateLeadSchema = z
  .object({
    status: z.enum(LEAD_STATUSES).optional(),
    classInterested: optionalText(80),
    parentName: optionalText(120),
    email: optionalEmailSchema,
    followUpAt: z.string().trim().nullable().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Nothing to update",
  });
```

- [ ] **Step 4: Give `LeadService.updateStatus` ownership scoping**

In `src/services/lead.service.ts`, change the method signature and add the ownership check:

```ts
  async updateStatus(input: {
    tenantClause: Record<string, unknown>;
    id: string;
    status: LeadStatus;
    user: CurrentUser;
  }): Promise<LeadDTO> {
    await connectToDatabase();
    const existing = await LeadService.getById(input.tenantClause, input.id);
    assertOwnsLead(input.user, { assignedTo: existing.assignedTo ?? null });
    if (existing.status === input.status) return existing;

    const updated = await Lead.findOneAndUpdate(
      { _id: new Types.ObjectId(existing.id), ...input.tenantClause },
      { $set: { status: input.status } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Enquiry not found");

    await ActivityService.record({
      institutionId: updated.institutionId,
      entityType: "LEAD",
      entityId: updated._id,
      entityRef: updated.leadNumber,
      action: `Status changed to ${input.status}`,
      description: `Status changed from ${existing.status} to ${input.status}`,
      performedBy: input.user.id,
      performedByName: input.user.name,
    });

    return serialize(updated as LeadRow);
  },
```

This replaces the existing `actor: { id: string; name: string }` parameter with `user: CurrentUser` — the only call site is `PATCH /api/leads/[id]`, updated in Step 6 below.

- [ ] **Step 5: Add `requirePermission` to `src/app/api/leads/route.ts`**

```ts
import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { requirePermission, leadVisibilityFilter } from "@/lib/tenant/permissions";
import { leadQuerySchema, createLeadSchema } from "@/lib/validation/lead";
import { LeadService } from "@/services/lead.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { getClientIp } from "@/lib/security/request";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { user } = await requireApiUser(request);
    const query = leadQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const clause = { ...tenantFilter(user), ...leadVisibilityFilter(user) };

    const result = await LeadService.list(clause, query);
    return jsonSuccess({ ...result });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Manual enquiry entry from the dashboard. */
export async function POST(request: NextRequest) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    if (!viaBearer) requirePermission(user, "LEADS_CREATE");
    const clause = tenantFilter(user);

    const body = await request.json().catch(() => ({}));
    const data = createLeadSchema.parse(body);

    const lead = await LeadService.createLead({
      institutionId: clause.institutionId,
      data,
      source: viaBearer ? "API" : "MANUAL",
      actor: { id: user.id, name: user.name },
      ipAddress: getClientIp(request),
    });

    return jsonSuccess({ lead });
  } catch (error) {
    return handleApiError(error);
  }
}
```

Read the CURRENT full file before editing — this shows the target shape for `GET`/`POST`, but the exact `source`/error-handling details in the real file may differ slightly (e.g. the actual `source` value passed for a bearer-token creation, or additional fields on `createLead`'s input). Preserve everything not shown here; only add the `requirePermission` gate on the cookie branch (`!viaBearer`) and merge `leadVisibilityFilter(user)` into the `GET` clause.

**Note the `if (!viaBearer)` guard on `requirePermission`** — an `ApiClient`'s bearer token is governed by its own `ApiPermission` scopes, checked separately (and already, before this plan) inside `resolveBearerUser`/wherever the bearer flow validates `CREATE_LEAD`; the new `requirePermission` call must never run against a bearer-authenticated request, per Global Constraint 2 and spec §5.6.

- [ ] **Step 6: Rewrite `src/app/api/leads/[id]/route.ts`'s `PATCH`**

```ts
export async function PATCH(request: NextRequest, context: RouteContext<"/api/leads/[id]">) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const patch = updateLeadSchema.parse(body);

    if (patch.followUpAt !== undefined) {
      if (!viaBearer) requirePermission(user, "LEADS_SET_FOLLOWUP");
      const lead = await LeadService.setFollowUp({
        tenantClause: tenantFilter(user),
        id,
        followUpAt: patch.followUpAt,
        user,
      });
      return jsonSuccess({ lead });
    }

    if (!patch.status) throw validationError("status: only status or followUpAt changes are supported");
    if (!viaBearer) requirePermission(user, "LEADS_UPDATE");

    const lead = await LeadService.updateStatus({
      tenantClause: tenantFilter(user),
      id,
      status: patch.status,
      user,
    });

    return jsonSuccess({ lead });
  } catch (error) {
    return handleApiError(error);
  }
}
```

`GET` in this same file is unchanged — read-only, no permission gate needed beyond the existing `tenantFilter`.

- [ ] **Step 7: Create `src/app/api/leads/[id]/assign/route.ts`**

```ts
import type { NextRequest } from "next/server";
import { requireApiUser, tenantFilter } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { assignLeadSchema } from "@/lib/validation/lead";
import { LeadService } from "@/services/lead.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/leads/[id]/assign">,
) {
  try {
    const { user, viaBearer } = await requireApiUser(request);
    assertSameOrigin(request, { viaBearer });
    if (!viaBearer) requirePermission(user, "LEADS_ASSIGN");
    const { id } = await context.params;

    const body = await request.json().catch(() => ({}));
    const { assignedTo } = assignLeadSchema.parse(body);

    const lead = await LeadService.assign({
      tenantClause: tenantFilter(user),
      id,
      assignedTo,
      actor: { id: user.id, name: user.name },
    });

    return jsonSuccess({ lead });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
npx vitest run tests/integration/lead-routes-permissions.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 9: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 434 pre-existing + 7 new = 441 passing. `updateStatus`'s signature change is the one place to watch — confirm every existing test file that calls `LeadService.updateStatus` directly (not just through the route) was updated to pass `user` instead of `actor`; grep for `updateStatus(` across `tests/` before running to catch every call site.

- [ ] **Step 10: Commit**

```bash
git add src/lib/validation/lead.ts src/services/lead.service.ts src/app/api/leads tests/integration/lead-routes-permissions.test.ts
git commit -m "feat: wire permissions and assignment into the lead routes"
```

---

### Task 6: `StaffService` — create, list, deactivate

**Files:**
- Create: `src/lib/validation/staff.ts`
- Create: `src/services/staff.service.ts`
- Test: `tests/integration/staff-management.test.ts`

**Interfaces:**
- Consumes: `hashPassword` from `@/lib/security/password`; `User` model.
- Produces:
  - `createStaffSchema`, `type CreateStaffInput`
  - `type StaffDTO = { id: string; name: string; email: string; role: "COUNSELOR" | "FRONT_DESK"; active: boolean; createdAt: string }`
  - `StaffService.create(institutionId: string, input: CreateStaffInput): Promise<StaffDTO>` — throws `CONFLICT` on duplicate email
  - `StaffService.list(institutionId: string): Promise<StaffDTO[]>`
  - `StaffService.setActive(institutionId: string, id: string, active: boolean): Promise<StaffDTO>`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/staff-management.test.ts`:

```ts
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { StaffService } from "@/services/staff.service";

beforeAll(() => startTestDatabase("staff-management"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});

const input = {
  name: "Priya Counselor",
  email: "priya@infinityschool.edu.in",
  password: "Password!2026",
  role: "COUNSELOR" as const,
};

describe("StaffService", () => {
  it("creates a Counselor account scoped to the institution", async () => {
    const staff = await StaffService.create("INS0001", input);
    expect(staff.role).toBe("COUNSELOR");
    expect(staff.active).toBe(true);
  });

  it("creates a Front Desk account", async () => {
    const staff = await StaffService.create("INS0001", { ...input, email: "fd@infinityschool.edu.in", role: "FRONT_DESK" });
    expect(staff.role).toBe("FRONT_DESK");
  });

  it("refuses a duplicate email across the whole platform", async () => {
    await StaffService.create("INS0001", input);
    await expect(StaffService.create("INS0002", input)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lists only the calling institution's staff", async () => {
    await StaffService.create("INS0001", input);
    await StaffService.create("INS0002", { ...input, email: "other@intelligentpublic.edu.in" });

    const list = await StaffService.list("INS0001");
    expect(list).toHaveLength(1);
    expect(list[0]?.email).toBe(input.email);
  });

  it("deactivates and reactivates a staff account", async () => {
    const staff = await StaffService.create("INS0001", input);
    const deactivated = await StaffService.setActive("INS0001", staff.id, false);
    expect(deactivated.active).toBe(false);

    const reactivated = await StaffService.setActive("INS0001", staff.id, true);
    expect(reactivated.active).toBe(true);
  });

  it("returns NOT_FOUND when deactivating a staff account from another institution", async () => {
    const staff = await StaffService.create("INS0001", input);
    await expect(StaffService.setActive("INS0002", staff.id, false)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/staff-management.test.ts
```

Expected: FAIL — cannot resolve `@/services/staff.service`.

- [ ] **Step 3: Create `src/lib/validation/staff.ts`**

```ts
import { z } from "zod";
import { requiredText, emailSchema } from "./common";

export const createStaffSchema = z.object({
  name: requiredText("Name", 120),
  email: emailSchema,
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["COUNSELOR", "FRONT_DESK"]),
});
export type CreateStaffInput = z.infer<typeof createStaffSchema>;
```

Check `src/lib/validation/common.ts` for the exact export name of the required-email schema before using it — `emailSchema` is the name used in Phase 1/2's code, but confirm.

- [ ] **Step 4: Create `src/services/staff.service.ts`**

```ts
import "server-only";
import { connectToDatabase } from "@/lib/db/mongoose";
import { User } from "@/models";
import { hashPassword } from "@/lib/security/password";
import { AppError, notFound } from "@/lib/api/errors";
import type { CreateStaffInput } from "@/lib/validation/staff";

export type StaffDTO = {
  id: string;
  name: string;
  email: string;
  role: "COUNSELOR" | "FRONT_DESK";
  active: boolean;
  createdAt: string;
};

function serialize(row: {
  _id: unknown;
  name: string;
  email: string;
  role: string;
  active?: boolean;
  createdAt?: Date;
}): StaffDTO {
  return {
    id: String(row._id),
    name: row.name,
    email: row.email,
    role: row.role as "COUNSELOR" | "FRONT_DESK",
    active: row.active ?? true,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
  };
}

export const StaffService = {
  async create(institutionId: string, input: CreateStaffInput): Promise<StaffDTO> {
    await connectToDatabase();
    const duplicate = await User.findOne({ email: input.email }).select("_id").lean();
    if (duplicate) {
      throw new AppError("CONFLICT", "A user with that email address already exists");
    }

    const created = await User.create({
      institutionId,
      name: input.name,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      active: true,
    });

    return serialize(created.toObject());
  },

  async list(institutionId: string): Promise<StaffDTO[]> {
    await connectToDatabase();
    const rows = await User.find({
      institutionId,
      role: { $in: ["COUNSELOR", "FRONT_DESK"] },
    })
      .sort({ createdAt: -1 })
      .lean();
    return rows.map(serialize);
  },

  async setActive(institutionId: string, id: string, active: boolean): Promise<StaffDTO> {
    await connectToDatabase();
    const updated = await User.findOneAndUpdate(
      { _id: id, institutionId, role: { $in: ["COUNSELOR", "FRONT_DESK"] } },
      { $set: { active } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Staff account not found");
    return serialize(updated);
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tests/integration/staff-management.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Mutation-check the guards**

| Mutation | Test that must fail |
|---|---|
| Remove the duplicate-email check | `refuses a duplicate email across the whole platform` |
| Remove `institutionId` from `list`'s filter | `lists only the calling institution's staff` |
| Remove `institutionId` from `setActive`'s filter | `returns NOT_FOUND when deactivating a staff account from another institution` |

- [ ] **Step 7: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 441 pre-existing + 6 new = 447 passing.

- [ ] **Step 8: Commit**

```bash
git add src/lib/validation/staff.ts src/services/staff.service.ts tests/integration/staff-management.test.ts
git commit -m "feat: add StaffService for Counselor and Front Desk accounts"
```

---

### Task 7: Staff API routes

**Files:**
- Create: `src/app/api/staff/route.ts`
- Create: `src/app/api/staff/[id]/route.ts`
- Test: `tests/integration/staff-routes.test.ts`

**Interfaces:**
- Consumes: `StaffService`, `createStaffSchema` (Task 6); `requirePermission` (Task 1).
- Produces: `GET/POST /api/staff`, `PATCH /api/staff/:id` (body `{ active: boolean }`).

- [ ] **Step 1: Write the failing test**

Create `tests/integration/staff-routes.test.ts`, following the same real-cookie convention as Task 5's test:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { GET as listStaff, POST as createStaff } from "@/app/api/staff/route";
import { PATCH as patchStaff } from "@/app/api/staff/[id]/route";
import { StaffService } from "@/services/staff.service";
import type { NextRequest } from "next/server";

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/staff");
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  headers.set("host", "localhost");
  return {
    headers,
    nextUrl: url,
    url: url.toString(),
    json: async () => init.body ?? {},
  } as unknown as NextRequest;
}

async function signIn(institutionId: string, role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK", email: string) {
  const user = await makeUser(institutionId, role, email);
  const token = await signSession({
    sub: String(user._id),
    role,
    institutionId,
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
}

beforeAll(() => startTestDatabase("staff-routes"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("staff routes", () => {
  it("an admin can create a staff account over HTTP", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createStaff(
      cookieRequest({
        body: { name: "Priya", email: "priya@infinityschool.edu.in", password: "Password!2026", role: "COUNSELOR" },
        origin: "http://localhost",
      }),
    );
    expect(response.status).toBe(200);
  });

  it("a Counselor cannot create a staff account — 403", async () => {
    await signIn("INS0001", "COUNSELOR", "c@infinityschool.edu.in");

    const response = await createStaff(
      cookieRequest({
        body: { name: "Priya", email: "priya@infinityschool.edu.in", password: "Password!2026", role: "COUNSELOR" },
        origin: "http://localhost",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk user cannot list staff — 403", async () => {
    await signIn("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");
    const response = await listStaff();
    expect(response.status).toBe(403);
  });

  it("an admin can deactivate a staff account over HTTP", async () => {
    const staff = await StaffService.create("INS0001", {
      name: "Priya",
      email: "priya@infinityschool.edu.in",
      password: "Password!2026",
      role: "COUNSELOR",
    });
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await patchStaff(
      cookieRequest({ url: `http://localhost/api/staff/${staff.id}`, body: { active: false }, origin: "http://localhost" }),
      { params: Promise.resolve({ id: staff.id }) } as never,
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.staff.active).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/staff-routes.test.ts
```

Expected: FAIL — routes don't exist.

- [ ] **Step 3: Create `src/app/api/staff/route.ts`**

```ts
import type { NextRequest } from "next/server";
import { requireInstitution } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { createStaffSchema } from "@/lib/validation/staff";
import { StaffService } from "@/services/staff.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { user, institution } = await requireInstitution();
    requirePermission(user, "STAFF_MANAGE");
    const staff = await StaffService.list(institution.institutionId);
    return jsonSuccess({ staff });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    requirePermission(user, "STAFF_MANAGE");
    const input = createStaffSchema.parse(await request.json().catch(() => ({})));

    const staff = await StaffService.create(institution.institutionId, input);
    return jsonSuccess({ staff });
  } catch (error) {
    return handleApiError(error);
  }
}
```

`requireInstitution()` here is deliberate and correct — staff management is exactly the kind of institution-configuration surface `requireInstitution()` was already gating before this phase (alongside profile/results/settings), so `/staff` joins that existing Admin-only boundary rather than needing a new one. `requirePermission(user, "STAFF_MANAGE")` is technically redundant given `requireInstitution()` already means "Admin," but keep it — it documents intent explicitly and costs nothing, matching the pattern of every other route in this plan checking a named permission rather than relying on an implicit role gate.

- [ ] **Step 4: Create `src/app/api/staff/[id]/route.ts`**

```ts
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireInstitution } from "@/lib/tenant";
import { requirePermission } from "@/lib/tenant/permissions";
import { StaffService } from "@/services/staff.service";
import { assertSameOrigin } from "@/lib/api/csrf";
import { handleApiError, jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";

const patchStaffSchema = z.object({ active: z.boolean() });

export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/staff/[id]">,
) {
  try {
    assertSameOrigin(request);
    const { user, institution } = await requireInstitution();
    requirePermission(user, "STAFF_MANAGE");
    const { id } = await context.params;
    const { active } = patchStaffSchema.parse(await request.json().catch(() => ({})));

    const staff = await StaffService.setActive(institution.institutionId, id, active);
    return jsonSuccess({ staff });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tests/integration/staff-routes.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 447 pre-existing + 4 new = 451 passing.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/staff tests/integration/staff-routes.test.ts
git commit -m "feat: add staff management routes"
```

---

### Task 8: Staff management dashboard — `/staff`

**Files:**
- Create: `src/app/(dashboard)/staff/page.tsx`
- Create: `src/components/staff/staff-list-view.tsx`
- Create: `src/components/staff/create-staff-dialog.tsx`

**Interfaces:**
- Consumes: `StaffService.list` (Task 6); `USER_ROLE_LABELS` (Task 1); `getCurrentUser`/`getCurrentInstitution` (existing, unchanged); `hasPermission` (Task 1).
- Produces: the `/staff` page and its two client components.

- [ ] **Step 1: Create `src/components/staff/create-staff-dialog.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createStaffSchema, type CreateStaffInput } from "@/lib/validation/staff";
import { USER_ROLE_LABELS } from "@/lib/constants";

const ASSIGNABLE_ROLES = ["COUNSELOR", "FRONT_DESK"] as const;

export function CreateStaffDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateStaffInput>({
    resolver: zodResolver(createStaffSchema),
    defaultValues: { role: "COUNSELOR" },
  });

  async function onSubmit(values: CreateStaffInput) {
    try {
      const response = await fetch("/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        toast.error(payload?.error?.message ?? "Could not create the account. Please try again.");
        return;
      }

      toast.success(`${values.name} added as ${USER_ROLE_LABELS[values.role]}`);
      reset({ role: "COUNSELOR" });
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Could not reach the server. Please try again.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          Add staff account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <DialogHeader>
            <DialogTitle>Add a staff account</DialogTitle>
            <DialogDescription>
              They'll sign in with this email and password — share the password with them directly.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" aria-invalid={Boolean(errors.name)} {...register("name")} />
              {errors.name ? <p className="text-xs text-muted-foreground">{errors.name.message}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" aria-invalid={Boolean(errors.email)} {...register("email")} />
              {errors.email ? <p className="text-xs text-muted-foreground">{errors.email.message}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" aria-invalid={Boolean(errors.password)} {...register("password")} />
              {errors.password ? <p className="text-xs text-muted-foreground">{errors.password.message}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role">Role</Label>
              <Select value={watch("role")} onValueChange={(value) => setValue("role", value as CreateStaffInput["role"])}>
                <SelectTrigger id="role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>{USER_ROLE_LABELS[role]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

Before writing this file, read `src/components/profile/publish-dialog.tsx` and `src/components/ui/dialog.tsx` to confirm the `Dialog`/`DialogTrigger`/`DialogContent`/etc. exports and props match what's used above — adapt only if a name genuinely differs, and note what you changed in your report.

- [ ] **Step 2: Create `src/components/staff/staff-list-view.tsx`**

```tsx
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
```

- [ ] **Step 3: Create `src/app/(dashboard)/staff/page.tsx`**

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentInstitution } from "@/lib/tenant";
import { hasPermission } from "@/lib/tenant/permissions";
import { StaffService } from "@/services/staff.service";
import { StaffListView } from "@/components/staff/staff-list-view";

export const metadata: Metadata = { title: "Staff" };
export const dynamic = "force-dynamic";

/**
 * Manual redirect checks, matching every other dashboard page in this
 * codebase (see profile/page.tsx) — `requireInstitution()` throws rather
 * than redirects, which is right for an API route and wrong for a page.
 * The `hasPermission` check below is new to this phase: before Counselor and
 * Front Desk existed, "any non-SUPER_ADMIN session" was equivalent to
 * "admin," so no page needed a finer check. Now it isn't, and this page
 * needs one explicitly rather than inheriting a guarantee that no longer
 * holds.
 */
export default async function StaffPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (!hasPermission(user, "STAFF_MANAGE")) redirect("/dashboard");

  const institution = await getCurrentInstitution();
  if (!institution) redirect("/login");

  const staff = await StaffService.list(institution.institutionId);

  return <StaffListView staff={staff} />;
}
```

- [ ] **Step 4: Verify manually**

No component test harness exists in this codebase (confirmed in prior phases). Start the dev server if one isn't already running (`lsof -nP -iTCP:3000 -sTCP:LISTEN` first), sign in as the seeded INS0001 admin, visit `/staff`, create a Counselor account through the dialog, confirm it appears in the list, deactivate it, confirm the status flips, reactivate it. Then sign out and sign in as that new Counselor account directly (a real login, not a simulated session) and confirm visiting `/staff` redirects to `/dashboard`.

- [ ] **Step 5: Run typecheck and the full suite**

```bash
npx tsc --noEmit
npm run lint
npm test -- --run
```

Expected: typecheck and lint clean, 451 passing (unchanged — this task adds no automated tests, matching the "no component harness" pattern already established).

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/staff" src/components/staff
git commit -m "feat: add the staff management dashboard"
```

---

### Task 9: Restrict pre-existing Admin-only pages now that other institution roles exist

**Why this task exists.** Before this phase, `role !== "SUPER_ADMIN"` was equivalent to
`role === "INSTITUTION_ADMIN"`, because no other institution-side role existed. Several
pages that should stay Admin-only were written against that equivalence rather than an
explicit role check, because at the time there was no difference. Adding `COUNSELOR`
and `FRONT_DESK` breaks the equivalence silently: these pages' write paths are still
correctly protected (`requireInstitution()`, unmodified — see the Global Constraints),
but the *pages themselves* would newly render for a Counselor or Front Desk session.
The most serious instance is `/integration`, which displays API client keys and
secrets — not a UX nicety, a credential-exposure gap. This was found by reading the
actual page guards during planning, not assumed; verify it still holds against the
real files before starting, since the codebase may have changed since this plan was
written.

**Files:**
- Modify: `src/app/(dashboard)/profile/page.tsx`
- Modify: `src/app/(dashboard)/results/page.tsx`
- Modify: `src/app/(dashboard)/results/[resultId]/page.tsx`
- Modify: `src/app/(dashboard)/results/new/page.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx`
- Modify: `src/app/(dashboard)/integration/page.tsx`
- Test: `tests/integration/admin-only-pages.test.ts`

**Interfaces:**
- Consumes: nothing new — every one of these pages already imports `getCurrentUser`
  or resolves a `user` some other way.
- Produces: each page redirects a `COUNSELOR`/`FRONT_DESK` session to `/dashboard`,
  identically to how it already redirects `SUPER_ADMIN` to `/admin`.

- [ ] **Step 1: Read the current guard in each file**

Before editing, read the first ~15 lines of each file listed above and locate its
existing role check (most are `if (user.role === "SUPER_ADMIN") redirect(...)`, but
`/integration` uses `requireTenantUserPage()` — a different shape, see Step 3).
Confirm this matches what's described here; if a file's guard has already changed
shape since this plan was written, adapt the fix to that shape and note it in your
report rather than forcing the exact diff below.

- [ ] **Step 2: Add the role check to `profile/page.tsx`, `results/page.tsx`, `results/[resultId]/page.tsx`, `results/new/page.tsx`, `settings/page.tsx`**

Each of these already has the shape:

```ts
const user = await getCurrentUser();
if (!user) redirect("/login");
if (user.role === "SUPER_ADMIN") redirect("/admin");
```

Add one line immediately after the `SUPER_ADMIN` check:

```ts
const user = await getCurrentUser();
if (!user) redirect("/login");
if (user.role === "SUPER_ADMIN") redirect("/admin");
if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");
```

This is the same one-line addition in five files — do it as one pass, not five
separate investigations, since the surrounding shape is identical in each.

- [ ] **Step 3: Add the same protection to `integration/page.tsx`**

This file uses `requireTenantUserPage()` instead of manual `getCurrentUser()` checks
— read its current signature (`src/lib/tenant/index.ts`) before editing. Add an
explicit role check right after the existing call:

```ts
const user = await requireTenantUserPage();
if (user.role !== "INSTITUTION_ADMIN") redirect("/dashboard");
```

`redirect` is likely already imported in this file (it redirects `SUPER_ADMIN`
internally via `requireTenantUserPage()`) — confirm before adding a duplicate import.

- [ ] **Step 4: Write the test**

Read `tests/integration/profile-routes.test.ts` for the cookie-session convention.
Create `tests/integration/admin-only-pages.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";

async function signIn(role: "COUNSELOR" | "FRONT_DESK", email: string) {
  const user = await makeUser("INS0001", role, email);
  const token = await signSession({
    sub: String(user._id),
    role,
    institutionId: "INS0001",
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
}

beforeAll(() => startTestDatabase("admin-only-pages"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("pages that must stay Admin-only now that other roles exist", () => {
  it("a Counselor loading /profile is redirected to /dashboard", async () => {
    await signIn("COUNSELOR", "c@infinityschool.edu.in");
    const { default: ProfilePage } = await import("@/app/(dashboard)/profile/page");

    await expect(ProfilePage()).rejects.toMatchObject({ digest: expect.stringContaining("/dashboard") });
  });

  it("a Front Desk user loading /integration is redirected to /dashboard", async () => {
    await signIn("FRONT_DESK", "fd@infinityschool.edu.in");
    const { default: IntegrationPage } = await import("@/app/(dashboard)/integration/page");

    await expect(IntegrationPage()).rejects.toMatchObject({ digest: expect.stringContaining("/dashboard") });
  });

  it("a Counselor loading /results is redirected to /dashboard", async () => {
    await signIn("COUNSELOR", "c@infinityschool.edu.in");
    const { default: ResultsPage } = await import("@/app/(dashboard)/results/page");

    await expect(ResultsPage()).rejects.toMatchObject({ digest: expect.stringContaining("/dashboard") });
  });
});
```

Next's `redirect()` throws a special error carrying the destination in `.digest`
(format `NEXT_REDIRECT;push;/dashboard;...`) rather than actually navigating in a
server-side test — `expect(...).rejects.toMatchObject({ digest: expect.stringContaining(...) })`
is the established way to assert on it. If this codebase already has a test that
asserts on a `redirect()` call this way, read it first and match its exact assertion
style rather than inventing a new one.

- [ ] **Step 5: Run the test to verify it fails**

```bash
npx vitest run tests/integration/admin-only-pages.test.ts
```

Expected: FAIL — all three pages currently render instead of redirecting for
Counselor/Front Desk sessions.

- [ ] **Step 6: Apply the fixes from Steps 2-3, then re-run**

```bash
npx vitest run tests/integration/admin-only-pages.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 451 pre-existing + 3 new = 454 passing.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(dashboard)/profile/page.tsx" "src/app/(dashboard)/results" "src/app/(dashboard)/settings/page.tsx" "src/app/(dashboard)/integration/page.tsx" tests/integration/admin-only-pages.test.ts
git commit -m "fix: keep profile, results, settings and integration pages Admin-only"
```

---

### Task 10: Lead assignment and follow-up UI

**Files:**
- Modify: `src/services/lead.service.ts` (add `listAssignees`)
- Create: `src/components/leads/lead-assign-control.tsx`
- Create: `src/components/leads/lead-followup-control.tsx`
- Modify: `src/app/(dashboard)/enquiries/[leadNumber]/page.tsx`
- Modify: `src/components/leads/leads-table.tsx`
- Modify: `src/components/leads/leads-list-view.tsx`
- Test: `tests/integration/lead-assignees.test.ts`

**Interfaces:**
- Consumes: `hasPermission` (Task 1); `LeadDTO.assignedTo`/`assignedToName`/`followUpAt` (Task 4); the assign/follow-up routes (Task 5).
- Produces: `LeadService.listAssignees(institutionId: string): Promise<{ id: string; name: string }[]>` — Admins and Counselors only, for the assignment dropdown.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/lead-assignees.test.ts`:

```ts
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { LeadService } from "@/services/lead.service";

beforeAll(() => startTestDatabase("lead-assignees"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});

describe("LeadService.listAssignees", () => {
  it("includes admins and counselors, never front desk", async () => {
    const admin = await makeUser("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    await makeUser("INS0001", "FRONT_DESK", "fd@infinityschool.edu.in");

    const assignees = await LeadService.listAssignees("INS0001");
    const ids = assignees.map((a) => a.id).sort();

    expect(ids).toEqual([String(admin._id), String(counselor._id)].sort());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/lead-assignees.test.ts
```

Expected: FAIL — `listAssignees` is not a function.

- [ ] **Step 3: Add `listAssignees` to `src/services/lead.service.ts`**

```ts
  async listAssignees(institutionId: string): Promise<{ id: string; name: string }[]> {
    await connectToDatabase();
    const rows = await User.find({
      institutionId,
      role: { $in: ["INSTITUTION_ADMIN", "COUNSELOR"] },
      active: true,
    })
      .select("name")
      .sort({ name: 1 })
      .lean();
    return rows.map((row) => ({ id: String(row._id), name: row.name }));
  },
```

`User` is already imported by this file from Task 4's changes.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/integration/lead-assignees.test.ts
```

Expected: PASS, 1 test.

- [ ] **Step 5: Create `src/components/leads/lead-assign-control.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const UNASSIGNED = "__unassigned__";

export function LeadAssignControl({
  leadId,
  assignedTo,
  assignees,
}: {
  leadId: string;
  assignedTo?: string;
  assignees: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(assignedTo ?? UNASSIGNED);
  const [saving, setSaving] = useState(false);

  async function change(next: string) {
    const previous = value;
    setValue(next);
    setSaving(true);

    try {
      const response = await fetch(`/api/leads/${leadId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedTo: next === UNASSIGNED ? null : next }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        setValue(previous);
        toast.error(payload?.error?.message ?? "Could not reassign. Please try again.");
        return;
      }

      toast.success(next === UNASSIGNED ? "Unassigned" : "Assigned");
      router.refresh();
    } catch {
      setValue(previous);
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Select value={value} onValueChange={change} disabled={saving}>
      <SelectTrigger size="sm" className="min-w-[168px]" aria-label="Assigned to">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
        {assignees.map((person) => (
          <SelectItem key={person.id} value={person.id}>{person.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

- [ ] **Step 6: Create `src/components/leads/lead-followup-control.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";

/** Renders followUpAt (an ISO datetime string) as a plain YYYY-MM-DD for the date input. */
function toDateInputValue(iso?: string): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

export function LeadFollowUpControl({
  leadId,
  followUpAt,
}: {
  leadId: string;
  followUpAt?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(toDateInputValue(followUpAt));
  const [saving, setSaving] = useState(false);

  async function save(next: string) {
    const previous = value;
    setValue(next);
    setSaving(true);

    try {
      const response = await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ followUpAt: next || null }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.success) {
        setValue(previous);
        toast.error(payload?.error?.message ?? "Could not update the follow-up date. Please try again.");
        return;
      }

      toast.success(next ? "Follow-up date set" : "Follow-up date cleared");
      router.refresh();
    } catch {
      setValue(previous);
      toast.error("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Input
      type="date"
      value={value}
      disabled={saving}
      onChange={(event) => save(event.target.value)}
      className="w-40"
      aria-label="Follow-up date"
    />
  );
}
```

- [ ] **Step 7: Wire both controls into the lead detail page**

Modify `src/app/(dashboard)/enquiries/[leadNumber]/page.tsx`. Add these imports:

```ts
import { LeadAssignControl } from "@/components/leads/lead-assign-control";
import { LeadFollowUpControl } from "@/components/leads/lead-followup-control";
import { hasPermission } from "@/lib/tenant/permissions";
```

`requireTenantUserPage()` already returns `user` at the top of this file — after that line, fetch the assignee list only when needed:

```ts
const assignees = hasPermission(user, "LEADS_ASSIGN")
  ? await LeadService.listAssignees(lead.institutionId)
  : [];
```

Add two fields to the existing `FieldGrid` in the "Enquiry details" section, after the `Status` field:

```tsx
              <Field
                label="Assigned to"
                value={
                  hasPermission(user, "LEADS_ASSIGN") ? (
                    <LeadAssignControl leadId={lead.id} assignedTo={lead.assignedTo} assignees={assignees} />
                  ) : (
                    lead.assignedToName ?? "Unassigned"
                  )
                }
              />
              <Field
                label="Follow-up"
                value={
                  hasPermission(user, "LEADS_SET_FOLLOWUP") &&
                  (user.role === "INSTITUTION_ADMIN" || lead.assignedTo === user.id) ? (
                    <LeadFollowUpControl leadId={lead.id} followUpAt={lead.followUpAt} />
                  ) : (
                    lead.followUpAt ?? "Not set"
                  )
                }
              />
```

`lead.assignedToName` is already populated by `getById` (Task 4's `resolveAssigneeNames`
addition) — this page calls `LeadService.getById` to load `lead`, so no further lookup
is needed here.

- [ ] **Step 8: Add an "Assigned to" column to the leads table (Admin only)**

Read `src/components/leads/leads-list-view.tsx` and `leads-table.tsx` in full first —
`LeadsTable` currently takes `leads` and a `variant`. Add an optional prop so the
column only renders when the caller (the list view, which knows the current user's
permissions) opts in:

```tsx
export function LeadsTable({
  leads,
  variant = "table",
  showAssignee = false,
}: {
  leads: LeadDTO[];
  variant?: "table" | "list";
  showAssignee?: boolean;
}) {
```

Add a conditional `<TableHead>Assigned to</TableHead>` after the existing `Status`
column header, and a matching `<TableCell>{lead.assignedToName ?? "—"}</TableCell>`
in the row — both wrapped in `{showAssignee ? ... : null}`. In
`leads-list-view.tsx`, thread through `showAssignee={hasPermission(user, "LEADS_ASSIGN")}`
from whatever `user` that component already has access to (check how it currently
receives the current user, if at all — it may need a new prop from its own caller,
`enquiries/page.tsx`).

- [ ] **Step 9: Run the full suite**

```bash
npx tsc --noEmit
npm run lint
npm test -- --run
```

Expected: 454 pre-existing + 1 new = 455 passing.

- [ ] **Step 10: Verify manually**

Start the dev server, sign in as an admin, create two Counselor accounts via `/staff`,
open an enquiry, assign it to one counselor, confirm the assignment persists on
refresh, set a follow-up date, confirm it persists. Sign in as that counselor
directly and confirm they see the lead in their queue with a working follow-up
control, and confirm they do NOT see the assign control (read-only "Assigned to"
text instead).

- [ ] **Step 11: Commit**

```bash
git add src/services/lead.service.ts src/components/leads "src/app/(dashboard)/enquiries" tests/integration/lead-assignees.test.ts
git commit -m "feat: add lead assignment and follow-up controls to the dashboard"
```

---

### Task 11: Per-user push — `DeviceService.forUser` and `NotificationService.notifyFollowUpsDue`

**Files:**
- Modify: `src/services/device.service.ts`
- Modify: `src/services/notification.service.ts`
- Test: `tests/integration/notify-followups-due.test.ts`

**Interfaces:**
- Consumes: `sendPush`, `PushMessage` (existing, unchanged); `Device` model (existing).
- Produces:
  - `DeviceService.forUser(userId: string): Promise<{ id: string; pushToken: string }[]>`
  - `NotificationService.notifyFollowUpsDue(input: { userId: string; institutionId: string; count: number }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Read `tests/integration/notifications.test.ts` first to confirm the existing test
pattern for asserting a push was sent (it likely stubs or intercepts `sendPush`, or
seeds real `Device` rows and checks `DeviceService`/`Device` collection state
afterward — match whichever it actually does).

Create `tests/integration/notify-followups-due.test.ts`, adapting the confirmed
pattern:

```ts
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { DeviceService } from "@/services/device.service";
import { NotificationService } from "@/services/notification.service";
import * as fcm from "@/lib/push/fcm";

beforeAll(() => startTestDatabase("notify-followups-due"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  vi.restoreAllMocks();
});

describe("DeviceService.forUser", () => {
  it("returns only the given user's devices", async () => {
    const counselorA = await makeUser("INS0001", "COUNSELOR", "a@infinityschool.edu.in");
    const counselorB = await makeUser("INS0001", "COUNSELOR", "b@infinityschool.edu.in");

    await DeviceService.register({
      userId: String(counselorA._id),
      institutionId: "INS0001",
      deviceId: "device-a",
      pushToken: "token-a",
      platform: "android",
    });
    await DeviceService.register({
      userId: String(counselorB._id),
      institutionId: "INS0001",
      deviceId: "device-b",
      pushToken: "token-b",
      platform: "android",
    });

    const devices = await DeviceService.forUser(String(counselorA._id));
    expect(devices.map((d) => d.pushToken)).toEqual(["token-a"]);
  });
});

describe("NotificationService.notifyFollowUpsDue", () => {
  it("sends exactly one push naming the count, to the given user's devices only", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    await DeviceService.register({
      userId: String(counselor._id),
      institutionId: "INS0001",
      deviceId: "device-1",
      pushToken: "token-1",
      platform: "android",
    });

    const sendPushSpy = vi.spyOn(fcm, "sendPush").mockResolvedValue({ deadTokens: [] });

    await NotificationService.notifyFollowUpsDue({
      userId: String(counselor._id),
      institutionId: "INS0001",
      count: 3,
    });

    expect(sendPushSpy).toHaveBeenCalledTimes(1);
    const [messages] = sendPushSpy.mock.calls[0]!;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.pushToken).toBe("token-1");
    expect(messages[0]!.title).toContain("3");
  });

  it("does nothing when the user has no registered devices", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const sendPushSpy = vi.spyOn(fcm, "sendPush").mockResolvedValue({ deadTokens: [] });

    await NotificationService.notifyFollowUpsDue({
      userId: String(counselor._id),
      institutionId: "INS0001",
      count: 1,
    });

    expect(sendPushSpy).not.toHaveBeenCalled();
  });
});
```

If `tests/integration/notifications.test.ts` asserts differently (e.g. it never mocks
`sendPush` and instead checks real FCM-adjacent state, or mocks a different module
path), rewrite this test to match that established approach exactly rather than
introducing a second testing convention for the same kind of code — note what you
changed and why.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/notify-followups-due.test.ts
```

Expected: FAIL — `DeviceService.forUser`/`NotificationService.notifyFollowUpsDue` are
not functions.

- [ ] **Step 3: Add `forUser` to `src/services/device.service.ts`**

Add this method, mirroring the existing `forInstitution`:

```ts
  async forUser(userId: string) {
    await connectToDatabase();
    const rows = await Device.find({ userId }).select("pushToken").lean();
    return rows.map((row) => ({ id: String(row._id), pushToken: row.pushToken }));
  },
```

- [ ] **Step 4: Add `notifyFollowUpsDue` to `src/services/notification.service.ts`**

Add this method to the `NotificationService` object, alongside the existing
`notifyNewApplication`/`notifyNewLead`:

```ts
  async notifyFollowUpsDue(input: { userId: string; institutionId: string; count: number }) {
    const devices = await DeviceService.forUser(input.userId);
    if (devices.length === 0) return;

    const { deadTokens } = await sendPush(
      devices.map((device) => ({
        pushToken: device.pushToken,
        title: input.count === 1 ? "1 follow-up due today" : `${input.count} follow-ups due today`,
        body: "Open your queue to see who's waiting.",
        data: { type: "follow-up-reminder" },
      })),
    );
    await DeviceService.remove(deadTokens);
  },
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tests/integration/notify-followups-due.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Mutation-check the guards**

| Mutation | Test that must fail |
|---|---|
| Change `forUser`'s filter from `{ userId }` to `{}` | `returns only the given user's devices` |
| Remove the `devices.length === 0` early return | `does nothing when the user has no registered devices` (the mock would still resolve, but the test's `not.toHaveBeenCalled()` catches a call with an empty array — confirm this is actually what happens; if `sendPush([])` would be called instead of skipped, that's still a behavior difference worth having a real early return for) |

- [ ] **Step 7: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 455 pre-existing + 3 new = 458 passing.

- [ ] **Step 8: Commit**

```bash
git add src/services/device.service.ts src/services/notification.service.ts tests/integration/notify-followups-due.test.ts
git commit -m "feat: add per-user push for follow-up reminders"
```

---

### Task 12: The daily follow-up reminder cron

**Files:**
- Create: `src/app/api/cron/follow-up-reminders/route.ts`
- Create: `vercel.json`
- Modify: `.env.example`
- Test: `tests/integration/follow-up-reminder-cron.test.ts`

**Interfaces:**
- Consumes: `NotificationService.notifyFollowUpsDue` (Task 11); `Lead` model (Task 3).
- Produces: `GET /api/cron/follow-up-reminders`, secret-gated, idempotent per day.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/follow-up-reminder-cron.test.ts`:

```ts
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { Lead } from "@/models";
import { LeadService } from "@/services/lead.service";
import * as fcm from "@/lib/push/fcm";

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeAll(() => startTestDatabase("follow-up-reminder-cron"));
afterAll(() => {
  process.env.CRON_SECRET = ORIGINAL_SECRET;
  return stopTestDatabase();
});
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  process.env.CRON_SECRET = "test-secret";
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function cronRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  return { headers } as unknown as Request;
}

async function makeLead(institutionId: string) {
  return LeadService.createLead({
    institutionId,
    data: { studentName: "Test Student", phone: "9876543210" },
    source: "API",
  });
}

describe("GET /api/cron/follow-up-reminders", () => {
  it("401s without the correct CRON_SECRET", async () => {
    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    const response = await GET(cronRequest("wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("401s with no authorization header at all", async () => {
    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    const response = await GET(cronRequest());
    expect(response.status).toBe(401);
  });

  it("sends exactly one push for a counselor with a due follow-up, and stamps followUpNotifiedAt", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const lead = await makeLead("INS0001");
    await Lead.updateOne(
      { _id: lead.id },
      { $set: { assignedTo: String(counselor._id), followUpAt: new Date("2020-01-01T00:00:00.000Z") } },
    );
    const sendPushSpy = vi.spyOn(fcm, "sendPush").mockResolvedValue({ deadTokens: [] });

    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    const response = await GET(cronRequest("test-secret"));

    expect(response.status).toBe(200);
    expect(sendPushSpy).not.toHaveBeenCalled(); // counselor has no registered device — nothing to send to, and that's correct

    const row = await Lead.findById(lead.id).lean();
    expect(row?.followUpNotifiedAt).toBeDefined();
  });

  it("groups multiple due leads for the same counselor into a single notification, not one per lead", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const { DeviceService } = await import("@/services/device.service");
    await DeviceService.register({
      userId: String(counselor._id),
      institutionId: "INS0001",
      deviceId: "d1",
      pushToken: "token-1",
      platform: "android",
    });

    const leadA = await makeLead("INS0001");
    const leadB = await makeLead("INS0001");
    const past = new Date("2020-01-01T00:00:00.000Z");
    await Lead.updateOne({ _id: leadA.id }, { $set: { assignedTo: String(counselor._id), followUpAt: past } });
    await Lead.updateOne({ _id: leadB.id }, { $set: { assignedTo: String(counselor._id), followUpAt: past } });

    const sendPushSpy = vi.spyOn(fcm, "sendPush").mockResolvedValue({ deadTokens: [] });
    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    await GET(cronRequest("test-secret"));

    expect(sendPushSpy).toHaveBeenCalledTimes(1);
    const [messages] = sendPushSpy.mock.calls[0]!;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.title).toContain("2");
  });

  it("skips a lead already notified today", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const { DeviceService } = await import("@/services/device.service");
    await DeviceService.register({
      userId: String(counselor._id),
      institutionId: "INS0001",
      deviceId: "d1",
      pushToken: "token-1",
      platform: "android",
    });
    const lead = await makeLead("INS0001");
    await Lead.updateOne(
      { _id: lead.id },
      {
        $set: {
          assignedTo: String(counselor._id),
          followUpAt: new Date("2020-01-01T00:00:00.000Z"),
          followUpNotifiedAt: new Date(),
        },
      },
    );

    const sendPushSpy = vi.spyOn(fcm, "sendPush").mockResolvedValue({ deadTokens: [] });
    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    await GET(cronRequest("test-secret"));

    expect(sendPushSpy).not.toHaveBeenCalled();
  });

  it("skips a lead in a terminal status even if its follow-up is due", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const { DeviceService } = await import("@/services/device.service");
    await DeviceService.register({
      userId: String(counselor._id),
      institutionId: "INS0001",
      deviceId: "d1",
      pushToken: "token-1",
      platform: "android",
    });
    const lead = await makeLead("INS0001");
    await Lead.updateOne(
      { _id: lead.id },
      {
        $set: {
          assignedTo: String(counselor._id),
          followUpAt: new Date("2020-01-01T00:00:00.000Z"),
          status: "ADMITTED",
        },
      },
    );

    const sendPushSpy = vi.spyOn(fcm, "sendPush").mockResolvedValue({ deadTokens: [] });
    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    await GET(cronRequest("test-secret"));

    expect(sendPushSpy).not.toHaveBeenCalled();
  });

  it("does not notify a lead whose follow-up is in the future", async () => {
    const counselor = await makeUser("INS0001", "COUNSELOR", "c@infinityschool.edu.in");
    const { DeviceService } = await import("@/services/device.service");
    await DeviceService.register({
      userId: String(counselor._id),
      institutionId: "INS0001",
      deviceId: "d1",
      pushToken: "token-1",
      platform: "android",
    });
    const lead = await makeLead("INS0001");
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
    await Lead.updateOne(
      { _id: lead.id },
      { $set: { assignedTo: String(counselor._id), followUpAt: farFuture } },
    );

    const sendPushSpy = vi.spyOn(fcm, "sendPush").mockResolvedValue({ deadTokens: [] });
    const { GET } = await import("@/app/api/cron/follow-up-reminders/route");
    await GET(cronRequest("test-secret"));

    expect(sendPushSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/follow-up-reminder-cron.test.ts
```

Expected: FAIL — the route doesn't exist.

- [ ] **Step 3: Create `src/app/api/cron/follow-up-reminders/route.ts`**

```ts
import { connectToDatabase } from "@/lib/db/mongoose";
import { Lead } from "@/models";
import { NotificationService } from "@/services/notification.service";
import { jsonSuccess } from "@/lib/api/response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function startOfTodayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Vercel signs its own cron requests with this header when CRON_SECRET is
 * set — no session, no CSRF, this is a machine-to-machine endpoint.
 */
export async function GET(request: Request) {
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== expected) {
    return new Response(null, { status: 401 });
  }

  await connectToDatabase();

  const due = await Lead.find({
    followUpAt: { $lte: startOfTodayUTC() },
    followUpNotifiedAt: null,
    status: { $nin: ["ADMITTED", "REJECTED"] },
    assignedTo: { $ne: null },
  })
    .select("assignedTo institutionId")
    .lean();

  const byCounselor = new Map<string, { institutionId: string; leadIds: string[] }>();
  for (const lead of due) {
    const key = String(lead.assignedTo);
    const entry = byCounselor.get(key) ?? { institutionId: lead.institutionId, leadIds: [] };
    entry.leadIds.push(String(lead._id));
    byCounselor.set(key, entry);
  }

  for (const [counselorId, entry] of byCounselor) {
    await NotificationService.notifyFollowUpsDue({
      userId: counselorId,
      institutionId: entry.institutionId,
      count: entry.leadIds.length,
    });
  }

  if (due.length > 0) {
    await Lead.updateMany(
      { _id: { $in: due.map((lead) => lead._id) } },
      { $set: { followUpNotifiedAt: new Date() } },
    );
  }

  return jsonSuccess({ notified: byCounselor.size, leads: due.length });
}
```

- [ ] **Step 4: Create `vercel.json`**

```json
{
  "crons": [
    {
      "path": "/api/cron/follow-up-reminders",
      "schedule": "0 2 * * *"
    }
  ]
}
```

If `vercel.json` already exists in this repository by the time this task runs (it did
not at plan-writing time — confirm with `ls vercel.json` first), merge this `crons`
entry into the existing file rather than overwriting it.

- [ ] **Step 5: Document `CRON_SECRET` in `.env.example`**

Add near the other secret-bearing variables:

```
# Required in production. Vercel signs its cron requests with this as a bearer
# token; the follow-up reminder route (/api/cron/follow-up-reminders) 401s
# without a match. Any long random string — it is never read by a person.
CRON_SECRET=replace-me-with-a-long-random-string
```

If `.env.example` is gitignored in this repository (check `.gitignore` for a
`.env*` pattern before committing) — it was in prior phases, and the addition was
left uncommitted and flagged rather than force-added. Do the same here: make the
local edit for developer convenience, but do not force-add a gitignored file.

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run tests/integration/follow-up-reminder-cron.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 7: Mutation-check the guards**

| Mutation | Test that must fail |
|---|---|
| Delete the `CRON_SECRET` check entirely (always proceed) | `401s without the correct CRON_SECRET` and `401s with no authorization header at all` |
| Group by lead instead of by counselor (one push per lead) | `groups multiple due leads for the same counselor into a single notification, not one per lead` |
| Remove `followUpNotifiedAt: null` from the query filter | `skips a lead already notified today` |
| Remove `status: { $nin: [...] }` from the query filter | `skips a lead in a terminal status even if its follow-up is due` |
| Change `$lte` to `$gte` (or remove the date filter) | `does not notify a lead whose follow-up is in the future` |

- [ ] **Step 8: Run the full suite**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: 458 pre-existing + 7 new = 465 passing.

- [ ] **Step 9: Commit**

```bash
git add src/app/api/cron vercel.json tests/integration/follow-up-reminder-cron.test.ts
git commit -m "feat: add the daily follow-up reminder cron"
```

---

### Task 13: Navigation, the route-level role-boundary regression test, and final verification

**Files:**
- Modify: `src/components/dashboard/nav-config.ts`
- Test: `tests/integration/role-boundary.test.ts`

**Interfaces:**
- Consumes: `USER_ROLES`, `Permission` (Task 1) — not used directly here, but `nav-config.ts` gains its own `adminOnly` filtering, a distinct mechanism from the `ROLE_PERMISSIONS` table (nav visibility for Profile/Results/Integration/Settings/Staff isn't a Lead/Staff permission — it mirrors each page's own Admin-only guard from Task 9, so it's checked the same way: a direct role comparison, not a borrowed permission from an unrelated table).
- Produces: `NavItem` gains `adminOnly?: boolean`; `navForRole()` filters accordingly.

- [ ] **Step 1: Modify `src/components/dashboard/nav-config.ts`**

Add `Users` to the `lucide-react` import:

```ts
import {
  Building2,
  FileText,
  GraduationCap,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Plug,
  Settings,
  Users,
} from "lucide-react";
```

Add `adminOnly?: boolean` to `NavItem`:

```ts
export type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Match nested routes, e.g. /applications/INS0001-APP-000001. */
  prefix?: boolean;
  /**
   * Hidden from Counselor and Front Desk sessions. Mirrors each target page's
   * own guard (Profile, Results, Integration, Settings, Staff are all
   * INSTITUTION_ADMIN-only — see the page-level fixes and the new /staff
   * route). This is a direct role check, not a `ROLE_PERMISSIONS` lookup —
   * that table only covers Leads and Staff-management actions, and repurposing
   * `STAFF_MANAGE` to also mean "is admin" for unrelated pages would be a
   * semantic mismatch.
   */
  adminOnly?: boolean;
};
```

Replace `INSTITUTION_NAV` with:

```ts
const INSTITUTION_NAV: NavGroup[] = [
  {
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/enquiries", label: "Enquiries", icon: Inbox, prefix: true },
      { href: "/applications", label: "Applications", icon: FileText, prefix: true },
      { href: "/results", label: "Results", icon: GraduationCap, prefix: true, adminOnly: true },
    ],
  },
  {
    items: [
      { href: "/staff", label: "Staff", icon: Users, adminOnly: true },
      { href: "/profile", label: "Institution Profile", icon: Building2, adminOnly: true },
      { href: "/integration", label: "Integration", icon: Plug, adminOnly: true },
      { href: "/settings", label: "Settings", icon: Settings, adminOnly: true },
    ],
  },
];
```

Replace `navForRole`:

```ts
export function navForRole(role: UserRole): { title: string; groups: NavGroup[] } {
  if (role === "SUPER_ADMIN") return { title: "Admin", groups: SUPER_ADMIN_NAV };

  const groups = INSTITUTION_NAV.map((group) => ({
    items: group.items.filter((item) => !item.adminOnly || role === "INSTITUTION_ADMIN"),
  })).filter((group) => group.items.length > 0);

  return { title: "I-DAP", groups };
}
```

- [ ] **Step 2: Verify manually**

Start the dev server, sign in as a Counselor account (created via `/staff` in an
earlier task's manual verification), confirm the nav shows only Dashboard/Enquiries/
Applications — no Results, Staff, Institution Profile, Integration, or Settings link.
Sign in as the admin and confirm all seven links are present, unchanged from before
this phase.

- [ ] **Step 3: Write the route-level role-boundary regression test**

This proves the premise the whole plan rests on (Global Constraint 1, spec §5.5):
since `requireInstitution()` is never modified, Admin-only *routes* (not just pages)
must still reject Counselor and Front Desk exactly as they always rejected every
non-admin role. This is not a new behavior this plan adds — it's a regression test
guarding against a *future* change accidentally loosening `requireInstitution()`.

Create `tests/integration/role-boundary.test.ts`, using the same cookie-session
convention as every prior test in this plan:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { PATCH as patchInstitution } from "@/app/api/settings/institution/route";
import { POST as publishResults } from "@/app/api/settings/results/route";
import type { NextRequest } from "next/server";

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/institution");
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  headers.set("host", "localhost");
  return {
    headers,
    nextUrl: url,
    url: url.toString(),
    json: async () => init.body ?? {},
  } as unknown as NextRequest;
}

async function signIn(role: "COUNSELOR" | "FRONT_DESK", email: string) {
  const user = await makeUser("INS0001", role, email);
  const token = await signSession({
    sub: String(user._id),
    role,
    institutionId: "INS0001",
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
}

beforeAll(() => startTestDatabase("role-boundary"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("requireInstitution() still rejects the new roles — unchanged by this phase", () => {
  it("a Counselor session gets 403 patching the institution profile", async () => {
    await signIn("COUNSELOR", "c@infinityschool.edu.in");

    const response = await patchInstitution(
      cookieRequest({ body: { academic: { board: "CBSE" } }, origin: "http://localhost" }),
    );
    expect(response.status).toBe(403);
  });

  it("a Front Desk session gets 403 creating a results cycle", async () => {
    await signIn("FRONT_DESK", "fd@infinityschool.edu.in");

    const response = await publishResults(
      cookieRequest({
        url: "http://localhost/api/settings/results",
        body: { board: "CBSE", level: "CLASS_10", stream: null, academicYear: "2025-26", appeared: 10, passed: 10 },
        origin: "http://localhost",
      }),
    );
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 4: Run the test to verify it passes without any code change**

```bash
npx vitest run tests/integration/role-boundary.test.ts
```

Expected: PASS, 2 tests, immediately — this is a regression test for behavior that
already holds, not a new feature. If either test fails, `requireInstitution()` has
somehow already changed since this plan was written, or one of these routes doesn't
actually call it — stop and investigate rather than "fixing" the test to match
whatever the code currently does.

- [ ] **Step 5: Run the complete final verification**

```bash
npx tsc --noEmit
npm run lint
npm test -- --run
```

Expected: typecheck clean, lint clean, 465 pre-existing + 2 new = 467 passing.

Walk the spec's Definition of Done (§12) one item at a time against the actual code
and tests, not just against task completion — this is the same discipline the two
prior phases' final reviews applied:

- Every permission in §5.2 has a test proving it's held or withheld correctly per
  role (Task 1's `role-permissions.test.ts`), and ownership scoping is proven for
  both `LEADS_UPDATE` (Task 5's `updateStatus` tests via the route permission test)
  and `LEADS_SET_FOLLOWUP` (Task 4's `lead-followup.test.ts`).
- `requireInstitution()` is provably unmodified (`git diff main -- src/lib/tenant/index.ts`
  should show no changes to the `requireInstitution` function body), and a
  representative Admin-only route still rejects both new roles (Task 13, this task).
- A Counselor's queue genuinely shows only their own assigned leads plus unassigned
  ones, verified over real HTTP (Task 5's `lead-routes-permissions.test.ts`).
- The reminder cron sends exactly one push per counselor per day regardless of lead
  count, verified by mutation (Task 12).
- The platform admin has no route to any of this — `SUPER_ADMIN` holds zero
  permissions in `ROLE_PERMISSIONS` (Task 1), and no `/staff` or lead-assignment
  route exists under `/admin`.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/nav-config.ts tests/integration/role-boundary.test.ts
git commit -m "feat: filter dashboard navigation by role; add the role-boundary regression test"
```

---

## Plan self-review

Run against the spec after writing; findings recorded here rather than silently fixed.

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| §4.1 role extension | 1 |
| §4.2–4.3 Lead fields, indexes | 3 |
| §5.1–5.3 permission set, table, `requirePermission` | 1 |
| §5.4 platform admin boundary | 1 |
| §5.5 `requireInstitution()` untouched + the page-guard gap it surfaced | 9 (fix), 13 (regression test) |
| §5.6 bearer-token boundary | 5 |
| §6.1 visibility filter | 2 |
| §6.2 assignment | 4, 5 |
| §6.3 follow-up date | 4, 5 |
| §7.1–7.3 reminder trigger, route, dispatch | 11, 12 |
| §8.1 staff management UI | 6, 7, 8 |
| §8.2–8.3 leads list/detail UI | 10 |
| §8.4 navigation | 13 |
| §9 known limitations | no task — deliberately not implemented |
| §10 migration | no task needed — nullable fields, zero-downtime by construction (Task 3) |
| §11 testing | every listed file has a corresponding task; several additional files added beyond the spec's list (routes-permissions, staff-routes, lead-assignees, admin-only-pages) |
| §12 definition of done | Task 13 Step 5 walks each item explicitly |

**Four things found and fixed during this self-review, not left for an implementer to discover:**

1. **Task 2 was missing its full-suite verification step entirely**, which silently broke the running test-count chain every later task depended on. Added the missing step, then found two further off-by-one miscounts while verifying the chain programmatically against the actual `it()` blocks in each task's test code (Task 1 claimed 9 but has 10; Task 4's `lead-assignment.test.ts` has two `describe` blocks and I'd only counted one, claiming 11 where the real total is 12). Fixed all three and recalculated the full chain end to end: 402 → 412 → 419 → 422 → 434 → 441 → 447 → 451 → 451 → 454 → 455 → 458 → 465 → 467, verified by direct count against every task's test file, not by re-deriving arithmetic from memory.
2. **A real Mongo conflict in `setFollowUp`'s update object** — `followUpNotifiedAt` appeared in both `$set` (as `undefined`) and `$unset` in the same update, which MongoDB rejects. Originally left as "re-check once written, fix if needed" — an implementer-facing placeholder for something I could resolve myself. Fixed directly: the field is only ever `$unset`, never `$set`.
3. **`LeadDTO.assignedToName` was declared as a field but never actually populated anywhere** — `serialize()` has no database access to resolve a name from an id, and I'd left Task 10 telling the implementer to "prefer the simplest correct option" for wiring it up. Resolved properly: `serialize()` now takes an optional name-lookup map, and a new `resolveAssigneeNames()` batch-fetches it once per `list()`/`getById()` call (not N+1 per row).
4. **`/staff/page.tsx` used `requireInstitution()` directly**, which throws rather than redirects — correct for an API route, wrong for a page (would surface as Next's default error boundary instead of a graceful redirect for a non-admin session). Caught by checking how every *other* Admin-adjacent page in this codebase actually handles this (manual `getCurrentUser()`/`redirect()` checks, never `requireInstitution()` in a page component) — fixed to match, and the same check surfaced a materially bigger issue: **`/profile`, `/results` and its two subpages, `/settings`, and `/integration` all used the same now-outdated "not `SUPER_ADMIN`" page guard**, which silently under-restricts the moment Counselor/Front Desk exist. `/integration` is the serious instance — it displays API credentials. This became Task 9, and the spec was updated to record it as decision 10 rather than only living in the plan.

**Type consistency** — checked across tasks: `LeadService.updateStatus`'s signature change (`actor` → `user: CurrentUser`) is made exactly once, in Task 5, and Task 4 (which touches the same file) doesn't collide with it. `assertOwnsLead`'s signature (Task 2) is used identically in Task 4 (`setFollowUp`) and Task 5 (`updateStatus`). `hasPermission`/`requirePermission` (Task 1) take the same `CurrentUser` shape everywhere they're called, including the page-level `hasPermission` calls in Tasks 8, 9, and 10 (which use `hasPermission` for read-only decisions and never the throwing `requirePermission` in a page component, matching the same throw-vs-redirect distinction the self-review surfaced above). `NavItem.adminOnly` (Task 13) is a deliberately separate mechanism from `ROLE_PERMISSIONS` (Task 1) — checked once, in Task 13's own reasoning, to confirm this isn't an accidental second permission system but a considered choice not to overload `STAFF_MANAGE` for unrelated pages.
