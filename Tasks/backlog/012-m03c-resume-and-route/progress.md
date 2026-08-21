# Progress: M03c — resume cursor, sync_run accounting, and route wiring

## Checklist

- [ ] Add sync_job_state cursor + report_handle resume
- [ ] Write one sync_run per invocation (ok/partial/failed)
- [ ] Rewire api/wellness-sync.ts to a bounded slice
- [ ] Move STATUS off 'not started' with the date

## Last step

Not yet started.

## Blockers

None on access — dev env is live (healthcheck green 2026-08-21): WL auth + fetch
and Supabase REST all confirmed, all 8 tables present. Blocked only on the task(s)
in depends_on landing first.

## Log

### 2026-08-21
- Created as an M03 sub-task when PRD 009 was green-lit. Decisions live in 009.
