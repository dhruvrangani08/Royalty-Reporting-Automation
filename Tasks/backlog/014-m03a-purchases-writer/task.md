---
id: 014
title: M03a-purchases — location, purchase, payment, service writer
status: backlog
priority: high
depends_on: [010]
created: 2026-08-21
---

# M03a-purchases — location, purchase, payment, service writer

Split from [010](../../done/010-m03a-writer-raw-link/task.md) when it was narrowed
to the staff slice. The purchase path is heavier than a parser: it has FK ordering
and touches the client-enumeration boundary, so it gets its own sitting.

## Goal

Write the royalty rows — a purchase and its line items — into `purchase`,
`payment`, `service`, each traced back through `raw_link`, respecting the foreign
keys that a purchase depends on.

## Scope

- **`location`** parser (`/v1/location/list` → `location`), because
  `purchase.k_location` references it. Must exist before any purchase row.
- **Payer `person`** derived from purchase/receipt data, because
  `purchase.uid_payer` → `person` is `ON DELETE RESTRICT`. The payer is a client,
  not staff — this is how `person` gains client rows without a client-list endpoint.
- **`purchase` / `payment` / `service`** parsers from `/v1/profile/purchase/list`
  + `/v1/purchase/receipt`. Money is `numeric(12,2)` from WL's string; all keys
  `text`; `dt_add` gets a time component.
- Write order that satisfies the FKs: location → payer person → purchase →
  payment/service. `raw_link` for every typed row.
- Idempotent upserts on natural keys: `k_location`, `uid`, `k_purchase`,
  `k_service`, and the payment key. Confirm each against the migrations.

## Out of scope

- Enumerating the full client base — still blocked (no paged client endpoint). This
  task fills `person` only with payers seen in the purchases it actually fetches.
- The queue loop (011) and route (012) — they drive this writer, not rebuild it.
- Margin / pay rates — blocked, `teacher_cost` stays null.

## Open question to settle first

- **Where do the purchase uids come from?** `/v1/profile/purchase/list` is fetched
  per client uid. With no client-list endpoint, which uids seed the purchase pull —
  staff only, the ~47 "Staff Client Profile" clients, or payers discovered
  iteratively? This bounds what a run can actually cover; decide before coding.

## Acceptance criteria

- [ ] A location-list fetch writes `location` rows + `raw_link`
- [ ] A purchase + receipt fetch writes `purchase` (+ payer `person`, + `payment`/
      `service`) in FK-safe order, each linked to its payload
- [ ] Money is `numeric(12,2)` from WL's string; all keys `text`; `dt_add` has a
      time component
- [ ] Re-running upserts on natural keys — no duplicate rows
- [ ] Parser tests on captured UAT payloads + a live proof against dev; mutation-proven

## Constraints & notes

- Dev env is live (WL + Supabase confirmed 2026-08-21); the staff writer (010) and
  the Supabase client (013) are done and reused here.
- Read [DATA-MODEL.md](../../../docs/DATA-MODEL.md): the purchase **item** is the
  royalty row, one human is one `person`.
- Register any new file in ARCHITECTURE; add a task-008 row for any WL purchase
  behaviour the tests mock.
