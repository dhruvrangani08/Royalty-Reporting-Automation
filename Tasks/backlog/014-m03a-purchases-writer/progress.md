# Progress: M03a-purchases — location, purchase, payment, service writer

## Checklist

- [ ] Settle the open question: which uids seed the purchase pull
- [ ] location/list → location parser + raw_link
- [ ] Derive payer person from purchase/receipt data
- [ ] purchase/payment/service parsers, FK-safe write order
- [ ] Idempotent upserts on natural keys; unit + live proof, mutation-verified

## Last step

Not yet started. Split from 010 on 2026-08-21.

## Blockers

Open question (purchase uid source) to settle first. Full client enumeration
remains blocked upstream; this task covers only payers it actually fetches.

## Log

### 2026-08-21
- Created by splitting the purchase path out of 010, which shipped the staff slice.
  Reason: FK ordering (location, payer person) + the per-client fetch shape are a
  separate sitting from the clean staff→person parser.
