# Mobile staff app — design

**Date:** 2026-08-22
**Status:** awaiting review
**Depends on:** the existing Next.js platform in this repository

---

## 1. What this is

An Android app for admissions staff, so an officer can be notified the moment an
application arrives and act on it without being at a desk.

It is a second client for the platform that already exists. It introduces no new
identity system and no new data: institution admins are already users, and every
record it shows is already reachable through the dashboard.

### Goals

1. A push notification when an enquiry or application arrives, tapping through to
   that record.
2. The review loop on a phone: list, search, filter, open, read every section,
   change status, add a note.
3. Share the application PDF to the Android share sheet.

### Non-goals for v1

Stated explicitly so they do not creep in:

- **iOS.** Same codebase will build for it later; not in this version.
- **Offline writes.** The app requires a connection. See §3.
- **One-tap call / WhatsApp.** Considered and deliberately cut.
- **Anything applicant-facing.** Parents do not log in. The hosted apply pages
  already serve them.
- **Platform-admin access.** Excluded by the same rule as the web dashboard.

---

## 2. Decisions already taken

| Decision | Choice | Why |
| --- | --- | --- |
| Audience | Institution staff only | Tightest scope; reuses existing accounts |
| Platform | Android, React Native via Expo | Play review is fast and cheap; covers the target market; iOS later from the same code |
| Distribution | Google Play | $25 one-off |
| Connectivity | Online only | See §3 |
| API strategy | Dual-auth the existing dashboard API | See §4 |
| Notification content | Includes the student's name | See §6 |

---

## 3. Why online-only

Full offline sync was rejected for v1. Two officers can change the same
application's status while both are offline, which needs conflict resolution and a
much larger test surface than the rest of this app combined.

The app shows a clear disconnected state and retries. Reads are not cached beyond
the lifetime of a screen.

---

## 4. Architecture

The app talks to the **existing dashboard API**, which learns to accept a bearer
token in addition to a session cookie. One implementation of every endpoint serves
both clients.

```
Android app  ──bearer token──┐
                             ├─→  /api/*  ──→  services  ──→  MongoDB
Web dashboard ──cookie───────┘                    │
                                                  └─→  push on create
External sites ──API key────→  /api/v1/*  ────────┘
```

The alternative — a parallel `/api/v1/staff` route tree — was rejected. It
duplicates every endpoint for versioning independence that is not needed yet, and
it would create a second path to the tenant-isolation logic. That guarantee
currently rests on a single `tenantFilter()`, and it should stay that way.

The trade this accepts: the dashboard API stops being freely changeable once an
app depends on it. Acceptable for a first-party app released by the same team. If
independent versioning is ever needed, a versioned staff API can be frozen later.

### Type safety across the boundary

The OpenAPI document is extended to cover the staff endpoints, and the app's API
types are generated from it with `openapi-typescript`. Client and server cannot
drift, and it reuses machinery that already exists.

---

## 5. Auth model

### Tokens

**Access token** — JWT, 15 minutes, sent as `Authorization: Bearer`. Signed with
the existing `AUTH_SECRET` but with audience **`aem-mobile`**, not
`aem-dashboard`.

That separation is load-bearing. `verifySessionToken` already pins the audience,
so a mobile token cannot be replayed as a dashboard session and a stolen session
cookie cannot be used against the mobile API. It falls out of the existing design
rather than fighting it.

**Refresh token** — opaque, 32 random bytes, never a JWT. Stored as an HMAC using
the same approach as API secrets. 30-day expiry, single-use, rotated on every
refresh.

### Reuse detection

Because refresh tokens are single-use and rotated, presenting one that has already
been consumed means it was copied. On detection, the **entire token family for
that device is revoked**, not just the presented token.

Without this, rotation is theatre: an attacker holding a copy simply refreshes
alongside the real user indefinitely.

### What comes free from the existing design

- `User.sessionVersion` already invalidates sessions. Bumping it kills access
  tokens too, so "sign out everywhere" needs no new machinery.
- The login rate limiter (8 attempts / 5 min per IP + account) sits in front of
  token issue unchanged.
- `SUPER_ADMIN` is refused at token issue, so the platform-admin boundary has no
  mobile back door.

### CSRF, conditionally

`assertSameOrigin()` currently guards every mutating dashboard request, because
browsers attach cookies automatically.

Bearer tokens are not attached automatically and are immune to CSRF by
construction; a native app also has no meaningful `Origin`. The check therefore
becomes **conditional on how the request authenticated** — kept for cookie
requests, skipped for bearer ones.

Applying it blindly breaks the app. Removing it entirely reopens CSRF on the web
dashboard. Both are easy mistakes and this is called out so neither is made.

### On-device storage

`expo-secure-store`, backed by the Android Keystore. Never `AsyncStorage`, which
is plain text and readable on a rooted device.

### New endpoints

```
POST /api/auth/token           email + password  → access + refresh
POST /api/auth/token/refresh   refresh           → new access + new refresh
POST /api/auth/token/revoke    refresh           → revoked (logout)
```

---

## 6. Push pipeline

### Trigger point

`LeadService.createLead()` and `ApplicationService.createApplication()` are already
the single funnel every submission passes through — external API, hosted form and
manual entry all converge there. `ActivityService.record()` sits in exactly that
spot for the same reason.

Push hooks in alongside it. One hook covers all three sources, with no path that
notifies and no path that does not.

### Failure is always silent

`ActivityService` establishes the pattern: side effects are wrapped and swallowed
so they cannot fail the action they describe. Push follows it exactly.

A family submitting at 11pm must never see an error because Firebase is
unavailable. A missing `FIREBASE_SERVICE_ACCOUNT` disables push cleanly rather
than crashing; the app remains usable without it.

### Device registration

`POST /api/devices` with the FCM token, bearer-authenticated.

The `institutionId` stored against a device is taken **from the session, never the
request body**. Otherwise a modified client could subscribe itself to another
institution's applications — a tenant-isolation hole that bypasses `tenantFilter()`
entirely.

Dead tokens are deleted when FCM reports `UNREGISTERED`, so the table does not
accumulate uninstalled devices.

### Notification content

Notifications **include the student's name**: *"New application — Rahul Kumar,
Grade 5"*.

Recorded as a deliberate decision. The trade-off was raised — this places applicant
names on lock screens and in the notification shade, readable by anyone holding the
phone, which sits in tension with the privacy posture applied to the platform
admin. The product owner chose usefulness for triage. A per-institution setting is
the natural escape hatch if that changes.

### Tap-through

The payload carries `{ type, applicationNumber }` as data, and Expo Router
deep-links to that record — not to a generic inbox.

---

## 7. Backend additions

New models:

| Model | Purpose |
| --- | --- |
| `RefreshToken` | Hashed token, user, device, family id, `expiresAt` (TTL), `replacedBy`, `revokedAt` |
| `Device` | FCM token, user, institution, platform, `lastSeenAt` |

New service:

| Service | Purpose |
| --- | --- |
| `NotificationService` | Resolve an institution's devices, send via FCM, prune dead tokens |

Changed:

- `requireUser()` / `requireTenantUser()` accept a bearer token as well as a cookie.
- `assertSameOrigin()` becomes conditional on the auth method.
- `LeadService.createLead` and `ApplicationService.createApplication` fire a
  notification.
- The OpenAPI document gains the staff endpoints.

Everything else — services, tenant scoping, validation, PDF — is untouched.

---

## 8. App structure

```
mobile/
  app/                     Expo Router
    (auth)/sign-in
    (app)/
      index                queue: applications + enquiries, search, filters
      applications/[n]     detail, status change, notes, share PDF
      enquiries/[n]        detail, status change, notes
      settings             account, sign out, notification permission
  lib/
    api/                   generated types + fetch client with refresh
    auth/                  secure-store session, refresh-on-401
    push/                  registration, permission, deep-link handling
  components/              shared UI, monochrome to match the platform
```

The API client owns token refresh: on a `401` it refreshes once, retries the
original request, and signs out if the refresh itself fails. Screens never handle
tokens.

Visual language matches the web platform — monochrome, identifiers in monospace,
status by fill weight rather than colour.

---

## 9. Error handling

The API's error envelope is already uniform, so the app maps it directly:

| Condition | App behaviour |
| --- | --- |
| `401` | Refresh once, retry, then sign out |
| `403` | "You do not have access to this" — no retry |
| `404` | "This record no longer exists" — return to the queue |
| `429` | Back off, show a retry countdown |
| `500` / network | "Something went wrong", retry button |

The server already never leaks internals in these messages.

---

## 10. Testing

Backend additions extend the existing Vitest suite (131 tests):

- Token issue, refresh rotation, **reuse detection revokes the family**
- Audience separation: a dashboard token is rejected by the mobile API and vice versa
- `SUPER_ADMIN` refused at token issue
- CSRF check skipped for bearer, still enforced for cookie
- Device registration ignores a body-supplied `institutionId`
- Notifications target only the owning institution's devices
- A push failure does not fail the submission
- Dead-token pruning

App: component tests for the queue and detail screens against a mocked client, plus
a manual pass on a physical device for push and the share sheet, which emulators
model poorly.

---

## 11. External dependencies to provision

| Dependency | For | Who |
| --- | --- | --- |
| Firebase project + `google-services.json` | Push | Product owner |
| Firebase service account key | Server-side send | Product owner → Vercel env |
| Expo account | EAS Build | Product owner (free tier) |
| Google Play developer account | Distribution | Product owner ($25 one-off) |

---

## 12. Risks

**The dashboard API becomes a contract.** Once an app is installed, changing those
endpoints breaks it. Mitigated by generating client types from the OpenAPI document
so drift is caught at build time, not by users.

**Push is the whole value proposition.** If Firebase is not provisioned, this
reduces to a mobile-shaped view of the dashboard. Worth confirming before the build
starts.

**Applicant names on lock screens.** Accepted deliberately (§6).

**MongoDB is not yet provisioned on Vercel.** Unrelated to this work, but the
platform is not functional in production until it is.

---

## 13. Build order

1. Backend auth: tokens, refresh, rotation, reuse detection, conditional CSRF
2. Backend push: `Device`, `NotificationService`, hooks, FCM
3. OpenAPI extension + generated client types
4. App shell: Expo, routing, secure session, sign-in
5. Queue and detail screens
6. Push registration and deep links
7. PDF share
8. Play internal testing track

Phases 1–3 are independently shippable and testable without any app existing,
which is where the tenant-isolation and token risk lives.
