---
id: 012
title: M03c — resume cursor, sync_run accounting, and route wiring
status: backlog
priority: high
depends_on: [011]
created: 2026-08-21
---

# M03c — resume cursor, sync_run accounting, and route wiring

Sub-task of [009](../009-m03-sync-engine-writer/task.md). Makes a run resumable and
puts it behind the cron route with an honest verdict.

## Goal

A part-finished pass resumes exactly where it stopped, each invocation records what
it did, and the deployed route runs one bounded slice instead of today's read-only
pass.

## Scope

- `sync_job_state`: a cursor per job so a part-finished list resumes without
  re-reading, including `report_handle` for `/v1/report/data`.
- `sync_run`: one row per invocation keyed by `client.runId`, ending
  `ok` / `partial` / `failed`. `partial` (budget ran out — the normal ending) is
  distinct from `failed` and must not alert like one.
- Rewire `api/wellness-sync.ts`: claim + run one bounded slice per invocation; keep
  the existing 200-vs-503 verdict, adding `partial` as its own signal.

## Out of scope

- The writer (010) and the queue loop (011) — consumed here, not rebuilt.
- attendance, margin, wider client base — deferred (see 009).

## Acceptance criteria

- [ ] A run stopped by the budget writes a cursor such that the next invocation
      resumes with no duplicated and no dropped work
- [ ] Each invocation writes exactly one `sync_run` keyed by `runId`, with
      `partial` distinct from `ok` and `failed`
- [ ] The route runs a real bounded slice; a fully-caught-up pass reports complete,
      a budget-stopped one reports partial, neither reads as failure
- [ ] STATUS moves M03 off "not started" with the date; ARCHITECTURE flow updated
- [ ] Resume and run-state tests are mutation-proven

## Constraints & notes

- `sync_run.run_id` is the id the code already generates and every `traceId`
  carries — a log line joins straight to its run row.
- The route is capped at 60s; this slice must fit the step budget and report when
  it doesn't rather than being killed (the 004 deadline already enforces this
  per request).
