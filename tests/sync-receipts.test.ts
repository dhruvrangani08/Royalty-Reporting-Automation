import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlResponse } from '../src/wl/client.js';
import { parseReceipt, writeReceipt } from '../src/sync/receipts.js';

const K_BUSINESS = '111111';
const K_PURCHASE = '143051';

function receiptBody(): unknown {
  return {
    text_purchase_id: '000000143051',
    a_price: {
      m_sum: '280.00',
      m_discount: '0.00',
      m_tax: '0.00',
      m_tip: '0.00',
      m_total: '280.00',
      text_currency: 'usd',
    },
    a_purchase_item: {
      '0': { k_purchase_item: 'item-1', m_price_total: '280.00', text_currency: 'usd' },
    },
    a_pay_method: {
      '0': { text_pay_method: 'Account', m_amount: '280.00', text_currency: 'usd' },
      '1': { m_amount: '5.00' }, // no method: skipped (NOT NULL column)
    },
    a_account_rest: {
      '0': { text_method: 'Account Balance', m_amount: '-700.00', text_currency: 'usd' },
    },
  };
}

function response(body: unknown): WlResponse<unknown> {
  return { body, traceId: 'r.1', kLog: null, httpStatus: 200, latencyMs: 9 };
}

describe('parseReceipt', () => {
  it('maps a_price to purchase money as strings, never floats', () => {
    const { purchaseMoney } = parseReceipt(receiptBody(), K_PURCHASE, K_BUSINESS);
    expect(purchaseMoney).toEqual({
      m_sum: '280.00',
      m_discount: '0.00',
      m_tax: '0.00',
      m_tip: '0.00',
      m_total: '280.00',
      text_currency: 'usd',
      text_purchase_id: '000000143051',
    });
  });

  it('maps item prices, payment methods and account credit', () => {
    const { itemMoney, payments, credits } = parseReceipt(receiptBody(), K_PURCHASE, K_BUSINESS);
    expect(itemMoney).toEqual([
      {
        k_purchase_item: 'item-1',
        k_purchase: K_PURCHASE,
        k_business: K_BUSINESS,
        m_price_total: '280.00',
        text_currency: 'usd',
      },
    ]);
    // The malformed pay method (no text_pay_method) is dropped.
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ text_pay_method: 'Account', m_amount: '280.00' });
    // A negative balance is a credit, kept out of payments.
    expect(credits[0]).toMatchObject({ text_method: 'Account Balance', m_amount: '-700.00' });
  });

  it('coerces a numeric k_purchase_item to text (the receipt sends a number)', () => {
    const body = {
      a_purchase_item: { '0': { k_purchase_item: 142604, m_price_total: '99.00' } },
    };
    const { itemMoney } = parseReceipt(body, K_PURCHASE, K_BUSINESS);
    expect(itemMoney).toHaveLength(1);
    expect(itemMoney[0]!.k_purchase_item).toBe('142604'); // string, matches the list key
  });

  it('returns null purchase money and empty lists for a bare body', () => {
    const parsed = parseReceipt({}, K_PURCHASE, K_BUSINESS);
    expect(parsed.purchaseMoney).toBeNull();
    expect(parsed.itemMoney).toEqual([]);
    expect(parsed.payments).toEqual([]);
  });
});

describe('writeReceipt', () => {
  function fakeDb() {
    const calls: Array<{ op: string; table: string; query?: string; rows?: unknown[] }> = [];
    const db = {
      insert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'insert', table, rows });
        return Promise.resolve(table === 'raw_wl' ? [{ id: 'raw-r' }] : rows);
      }),
      upsert: vi.fn((table: string, rows: unknown[]) => {
        calls.push({ op: 'upsert', table, rows });
        return Promise.resolve(rows);
      }),
      update: vi.fn((table: string, _p: unknown, query: string) => {
        calls.push({ op: 'update', table, query });
        return Promise.resolve([]);
      }),
      delete: vi.fn((table: string, query: string) => {
        calls.push({ op: 'delete', table, query });
        return Promise.resolve();
      }),
    } as unknown as SupabaseClient;
    return { db, calls };
  }

  it('updates the purchase, upserts item money, and replaces payments/credits', async () => {
    const { db, calls } = fakeDb();

    const result = await writeReceipt(db, {
      kBusiness: K_BUSINESS,
      kPurchase: K_PURCHASE,
      response: response(receiptBody()),
      runId: 'run',
    });

    const seq = calls.map((c) => `${c.op}:${c.table}`);
    expect(seq).toEqual([
      'insert:raw_wl',
      'update:purchase',
      'insert:raw_link',
      'upsert:purchase_item',
      'insert:raw_link',
      'delete:purchase_payment',
      'insert:purchase_payment',
      'delete:purchase_account_credit',
      'insert:purchase_account_credit',
    ]);
    // Idempotent: payments are deleted for this purchase before being reinserted.
    expect(calls.find((c) => c.op === 'delete' && c.table === 'purchase_payment')!.query).toBe(
      `k_purchase=eq.${K_PURCHASE}`,
    );
    expect(result).toMatchObject({ itemsPriced: 1, payments: 1, credits: 1 });
  });

  it('still deletes stale payments even when the receipt has none', async () => {
    const { db, calls } = fakeDb();
    await writeReceipt(db, {
      kBusiness: K_BUSINESS,
      kPurchase: K_PURCHASE,
      response: response({ a_price: { m_total: '0.00' } }),
      runId: 'run',
    });
    // No a_pay_method, but the delete still runs so an old payment cannot linger.
    expect(calls.some((c) => c.op === 'delete' && c.table === 'purchase_payment')).toBe(true);
    expect(calls.some((c) => c.op === 'insert' && c.table === 'purchase_payment')).toBe(false);
  });
});
