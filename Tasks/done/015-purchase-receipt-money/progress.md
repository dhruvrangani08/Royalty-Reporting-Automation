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

### 2026-08-21 — done
- Probed the receipt shape live (recorded in WL-API-NOTES): a_price -> purchase
  totals, a_purchase_item -> item money, a_pay_method -> purchase_payment,
  a_account_rest -> purchase_account_credit (negative = balance, kept separate).
- src/sync/receipts.ts: parseReceipt + writeReceipt (UPDATE purchase money, upsert
  item money, delete-then-insert payments/credits for idempotency). Added
  SupabaseClient.delete + runReceiptSyncPass (seeds from purchases missing m_total).
- Two live bugs fixed: purchase_payment/credit have no k_business column; the receipt
  sends k_purchase_item as a NUMBER (coerced). Both mutation-covered.
- Proven live: priced 49+24 purchases (totals 840/299/280), payment "Account 280",
  credit -700, item prices written. Resumable (partial with pending). verify 262 green.
