# Progress: Live-verification checklist for behaviour only mocks can prove today

## Checklist

- [ ] Get UAT WL access confirmed working (health check passes against UAT)
- [ ] Walk the task.md checklist against UAT, row by row
- [ ] For each confirmed row: tick it, add date + observation
- [ ] For any contradiction: open a fix task and link it, leave the row unchecked
- [ ] Add rows as 004 and 006 land

## Last step

Not yet started. This is a standing ledger — it stays open by design.

## Blockers

None to start recording. Actually running the live checks needs working UAT WL
credentials (see docs/RUNBOOK.md).

## Log

### 2026-08-21
- Task created. Seeded from the four error-handling fixes (001, 002, 003, 005),
  all of which are unit-verified against a mocked `fetch` only. The rows capture
  the WL behaviours those mocks assume but no live call has confirmed.
- Rule for this task: when a later fix bakes in a WL assumption, add a row here in
  the same session rather than leaving the gap unrecorded.

### 2026-08-21 — dev env confirmed live
- healthcheck green: WL oauth2 token issued, Supabase REST reachable + service key
  accepted. sync:wellness fetched business + 1 location + 20 staff live. All 8
  control/data tables present in dev.
- This confirms the *link*, not the behavioural rows below — throttle, Retry-After,
  mid-pass token rotation, body reset still need their specific live conditions.

### 2026-08-21 — first live confirmations
- Verified against live UAT (dev env):
  - 200-for-errors + a_error[].sid: profile/purchase/list with no uid → HTTP 200,
    sid "uid-nx", classified permanent. The core envelope the whole client rests on.
  - k_log per endpoint: business/staff/location = null; /v1/lead/info = "[31.gswzy]".
    Exactly as trace.ts documents. Row ticked.
- Still unconfirmable without forcing the condition (a real throttle, a mid-stream
  reset, a mid-run token rotation, a long Retry-After): those rows stay unchecked.
  They need fault injection (a proxy) or catching a real throttle in production.
