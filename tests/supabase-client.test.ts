import { describe, expect, it, vi } from 'vitest';
import type { SupabaseConfig } from '../src/config/schema.js';
import { SupabaseClient, SupabaseError } from '../src/supabase/client.js';

const config: SupabaseConfig = {
  url: 'https://project.supabase.example.test',
  serviceRoleKey: 'service-role-key-secret-0000',
};

function calledUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return '';
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('SupabaseClient', () => {
  it('inserts as a POST asking for the stored rows back', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse([{ id: 'a' }]));
    const client = new SupabaseClient(config, { fetch: fetchMock });

    const rows = await client.insert('person', [{ uid: '1' }]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl(url)).toBe(`${config.url}/rest/v1/person`);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as { headers: Record<string, string> }).headers.Prefer).toBe(
      'return=representation',
    );
    expect(rows).toEqual([{ id: 'a' }]);
  });

  it('upserts with the conflict target and merge-duplicates', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse([{ id: 'a' }]));
    const client = new SupabaseClient(config, { fetch: fetchMock });

    await client.upsert('purchase', [{ k_purchase: '9' }], { onConflict: 'k_purchase' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl(url)).toContain('on_conflict=k_purchase');
    expect((init as { headers: Record<string, string> }).headers.Prefer).toBe(
      'resolution=merge-duplicates,return=representation',
    );
  });

  it('does not call the network for an empty write', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    const client = new SupabaseClient(config, { fetch: fetchMock });

    const rows = await client.insert('person', []);

    expect(rows).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the service-role key as a header, never in the URL', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse([]));
    const client = new SupabaseClient(config, { fetch: fetchMock });

    await client.select('person', 'uid=eq.1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl(url)).not.toContain(config.serviceRoleKey);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.apikey).toBe(config.serviceRoleKey);
    expect(headers.Authorization).toBe(`Bearer ${config.serviceRoleKey}`);
  });

  it('raises a typed error on a PostgREST rejection, with code and message', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        jsonResponse(
          { code: '23505', message: 'duplicate key value violates unique constraint' },
          409,
        ),
      );
    const client = new SupabaseClient(config, { fetch: fetchMock });

    const error = (await client
      .upsert('purchase', [{ k_purchase: '9' }], { onConflict: 'k_purchase' })
      .catch((e: unknown) => e)) as SupabaseError;

    expect(error).toBeInstanceOf(SupabaseError);
    expect(error.table).toBe('purchase');
    expect(error.httpStatus).toBe(409);
    expect(error.message).toContain('23505');
    // The key must never appear in an error surfaced to a log.
    expect(error.message).not.toContain(config.serviceRoleKey);
  });

  it('redacts a network failure to its error class, never the host', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error(`connect ECONNREFUSED ${config.url}`));
    const client = new SupabaseClient(config, { fetch: fetchMock });

    const error = (await client.select('person').catch((e: unknown) => e)) as SupabaseError;

    expect(error).toBeInstanceOf(SupabaseError);
    expect(error.httpStatus).toBeNull();
    expect(error.message).not.toContain(config.url);
  });
});
