import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../api/wellness-sync.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';

const TOKEN = 'sync-trigger-token-0000';

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${TOKEN}` },
    ...overrides,
  };
}

/** Captures what the handler sent, the way the platform would. */
function makeResponse() {
  const sent: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res: HttpResponse = {
    status(code) {
      sent.status = code;
      return res;
    },
    json(body) {
      sent.body = body;
    },
    setHeader(name, value) {
      sent.headers[name] = value;
    },
  };
  return { res, sent };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('/api/wellness-sync - the door', () => {
  it('refuses when no trigger token is configured - unset means locked', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', '');
    vi.stubEnv('CRON_SECRET', '');
    const { res, sent } = makeResponse();

    await handler(request(), res);

    expect(sent.status).toBe(401);
    expect(sent.body).toEqual({ error: 'unauthorized' });
  });

  it('refuses a wrong token with the same response as an unconfigured one', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', TOKEN);
    const { res, sent } = makeResponse();

    await handler(request({ headers: { authorization: 'Bearer nope' } }), res);

    expect(sent.status).toBe(401);
    expect(sent.body).toEqual({ error: 'unauthorized' });
  });

  it('refuses a missing Authorization header', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', TOKEN);
    const { res, sent } = makeResponse();

    await handler(request({ headers: {} }), res);

    expect(sent.status).toBe(401);
  });

  it('accepts CRON_SECRET, which is what Vercel Cron sends', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', '');
    vi.stubEnv('CRON_SECRET', TOKEN);
    vi.stubEnv('APP_ENV', '');
    const { res, sent } = makeResponse();

    await handler(request(), res);

    // Past the door: it failed on config, not on authorization.
    expect(sent.status).not.toBe(401);
  });

  it('rejects methods a cron would never use', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', TOKEN);
    const { res, sent } = makeResponse();

    await handler(request({ method: 'DELETE' }), res);

    expect(sent.status).toBe(405);
  });

  it('always sets no-store so a sync verdict is never cached', async () => {
    const { res, sent } = makeResponse();
    await handler(request(), res);
    expect(sent.headers['Cache-Control']).toBe('no-store');
  });
});

describe('/api/wellness-sync - the verdict', () => {
  it('returns 500 naming missing keys when authorized but unconfigured', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', TOKEN);
    vi.stubEnv('APP_ENV', 'dev');
    for (const key of [
      'WL_API_HOST',
      'WL_AUTH_HOST',
      'WL_ID_REGION',
      'WL_K_BUSINESS',
      'WL_CLIENT_ID',
      'WL_CLIENT_SECRET',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'GHL_API_TOKEN',
      'GHL_LOCATION_ID',
    ]) {
      vi.stubEnv(key, '');
    }
    const { res, sent } = makeResponse();

    await handler(request(), res);

    expect(sent.status).toBe(500);
    const body = sent.body as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toContain('WL_CLIENT_ID');
  });

  it('returns 503, not 200, when a step fails', async () => {
    vi.stubEnv('SYNC_TRIGGER_TOKEN', TOKEN);
    vi.stubEnv('APP_ENV', 'dev');
    vi.stubEnv('WL_API_HOST', 'wl.example.test');
    vi.stubEnv('WL_AUTH_HOST', 'wl-auth.example.test');
    vi.stubEnv('WL_ID_REGION', '1');
    vi.stubEnv('WL_K_BUSINESS', '111111');
    vi.stubEnv('WL_CLIENT_ID', 'client-id-0000');
    vi.stubEnv('WL_CLIENT_SECRET', 'client-secret-0000');
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.example.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-0000');
    vi.stubEnv('GHL_API_TOKEN', 'ghl-token-0000');
    vi.stubEnv('GHL_LOCATION_ID', 'location-0000');

    // Credentials resolve, but WL refuses them: a real partial-failure verdict.
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: 401 })),
    );
    const { res, sent } = makeResponse();

    await handler(request(), res);

    expect(sent.status).toBe(503);
    const body = sent.body as { ok: boolean; authError?: string };
    expect(body.ok).toBe(false);
    expect(body.authError).toContain('env "dev"');
  });
});
