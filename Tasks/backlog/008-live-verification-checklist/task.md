---
id: 008
title: Live-verification checklist for behaviour only mocks can prove today
status: backlog
priority: high
depends_on: []
created: 2026-08-21
---

# Live-verification checklist for behaviour only mocks can prove today

## Goal

Every WL fix so far is verified by unit test against a **mocked** `fetch`. That
proves our classification and control flow are correct *given an assumed WL
behaviour* — it does not prove WL actually behaves that way. This task is the
standing ledger of those assumptions: each row is a thing to confirm against the
live API (UAT first, prod only where safe), so a green suite is never mistaken
for a green integration.

It is **long-lived**: it does not "finish" when the current rows are checked. As
later tasks land with their own mock-only assumptions, add rows here rather than
letting the gap go unrecorded.

## Scope

- One checklist (below), one row per assumption a live call must confirm.
- Kept current: when a fix lands that assumes a WL behaviour, add a row; when a
  row is confirmed live, check it and record the date + what was observed.
- Health-check style probes are fine; this must read no more real customer data
  than a check needs, and never writes.

## Out of scope

- The fixes themselves — those are their own tasks. This only tracks the live
  confirmation of assumptions they bake in.
- Building a live integration-test harness. If one is built, link it here; until
  then these are run by hand against UAT and the observation recorded.

## How to use this list

Each row: **[ ] unchecked** = assumed but unconfirmed. **[x] checked** = observed
live; append the date and what was seen. If a live call contradicts the
assumption, do **not** just tick it — open a fix task, link it, and leave the row
unchecked with a note pointing at the contradiction.

## The checklist

### From task 001 — retry ladder bound
- [ ] WL genuinely answers a throttle as **HTTP 200 with a transient `status`/`sid`
      in the body** (not a 429), so the ladder is what catches it. *(Assumed from
      the architecture doc; not yet seen live on a real throttle.)*
- [ ] WL sometimes sends a `Retry-After` header, and its units match
      `parseRetryAfter` (seconds or HTTP-date). *(Never observed live — the whole
      Retry-After path is untested against WL.)*
- [ ] A sustained throttle actually terminates our pass with a requeue rather than
      the platform killing the function. *(The failure mode 001 fixes — confirm it
      no longer happens under real load.)*

### From task 002 — body-read failures
- [ ] A real mid-stream connection reset from WL surfaces as a transient
      `WlRequestError`, not an uncaught throw. *(Mock simulates a rejecting
      `text()`; confirm a real network cut behaves the same — e.g. induce with a
      proxy or a killed connection.)*

### From task 003 — mid-pass token failure
- [ ] A token that WL rejects **mid-run** (rotated/revoked under us) returns a 401
      on the data call, and the refetch returns the `invalid_client`-shaped body
      our message assumes. *(Confirm the credential-rotation path end to end.)*
- [ ] `WlTokenClient` classifies WL's real token-error responses the way the
      `auth`/`transient`/`permanent` split assumes (400/401/403 vs 5xx/429).

### From task 004 — per-request deadline
- [ ] A genuinely slow WL call (approaching the 30s per-attempt timeout) combined
      with a throttle actually causes the pass to stop starting retries and
      requeue, rather than the Vercel function being killed. *(The deadline is
      derived from the budget and unit-tested with a fake clock; confirm the real
      timing against UAT under a slow response.)*

### From task 006 — retry ladder semantics
- [ ] WL actually sends a `Retry-After` header on a real throttle, and it is
      seconds/HTTP-date as `parseRetryAfter` assumes. *(The whole honour-vs-requeue
      split rests on this; never observed live.)*
- [ ] A real `Retry-After` longer than 25s is requeued with that delay rather than
      slept in-process. *(Confirm once a live throttle with a long delay is seen.)*

### From task 005 — route error redaction
- [ ] Confirm no genuine deploy-time error path returns a host in the response
      body — exercise the route against UAT with a deliberately wrong host and
      read the actual JSON returned.

### Standing assumptions worth a live look (not tied to one fix)
- [ ] `k_log` presence per endpoint matches what trace.ts documents (present on
      `/v1/lead/info`, absent on the sync endpoints). *(Documented 19 Aug 2026;
      re-confirm before relying on it for support.)*
- [ ] WL publishes no rate limit we should pre-empt — confirm with WL Integrations
      rather than inferring from the absence of 429s. *(Ties to STATUS.md's open
      "real rate limits" decision.)*

## Acceptance criteria

This task is "current", not "done". It is in good standing when:

- [ ] Every fix task that assumes a WL behaviour has a corresponding row here
- [ ] Each row is either unchecked (honestly unconfirmed) or checked with a date
      and the observation
- [ ] Any contradiction found live has a linked fix task, not a silent tick

## Constraints & notes

- UAT host for all of these unless a row explicitly needs prod. Reads only.
- Blocked items in `docs/STATUS.md` (client enumeration, pay rates, attendance
  date format) are separate — those are "can't build yet", these are "built on an
  assumption not yet checked live". Keep the two lists distinct.
- All current fix tasks (001–006) have their rows above.
