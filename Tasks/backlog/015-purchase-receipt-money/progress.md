# Progress: Purchase receipt enrichment — money and the payment breakdown

## Checklist

- [ ] Probe /v1/purchase/receipt shape live; record in WL-API-NOTES
- [ ] purchase_receipt work type seeded from purchases missing m_total
- [ ] Parse + UPDATE money on purchase and purchase_item
- [ ] purchase_payment breakdown + account-credit handling
- [ ] Parser tests + live proof; idempotent re-run

## Last step

Not yet started. Split from 014 (structure done, money deferred).

## Blockers

None on access (dev live). Settle the receipt-shape probe before coding.

## Log

### 2026-08-21
- Created when 014 shipped purchase/purchase_item structure with money null.
  Receipt enrichment is its own fan-out (per k_purchase) and its own parsing.
