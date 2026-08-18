import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { buildWlUrl, WL_PATHS } from '../src/wl/endpoint.js';
import { FakeProvider } from './helpers/fixtures.js';

const load = (env: 'dev' | 'prod') =>
  loadConfig({ processEnv: { APP_ENV: env }, provider: new FakeProvider() });

describe('buildWlUrl', () => {
  it('scopes every call with the configured region and business', async () => {
    const { wl } = await load('prod');
    const url = new URL(buildWlUrl(wl, WL_PATHS.staffList));

    expect(url.protocol).toBe('https:');
    expect(url.host).toBe(wl.host);
    expect(url.pathname).toBe(WL_PATHS.staffList);
    expect(url.searchParams.get('id_region')).toBe(String(wl.idRegion));
    expect(url.searchParams.get('k_business')).toBe(wl.kBusiness);
  });

  it('produces a different URL per environment from the same call site', async () => {
    const dev = await load('dev');
    const prod = await load('prod');

    const devUrl = buildWlUrl(dev.wl, WL_PATHS.reportQuery);
    const prodUrl = buildWlUrl(prod.wl, WL_PATHS.reportQuery);

    expect(devUrl).not.toBe(prodUrl);
    expect(new URL(devUrl).host).not.toBe(new URL(prodUrl).host);
    expect(new URL(devUrl).searchParams.get('id_region')).not.toBe(
      new URL(prodUrl).searchParams.get('id_region'),
    );
  });

  it('appends caller query params and drops undefined ones', async () => {
    const { wl } = await load('dev');
    const url = new URL(
      buildWlUrl(wl, WL_PATHS.scheduleClassList, {
        dt_date: '2026-08-01',
        i_limit: 100,
        s_sort: undefined,
      }),
    );
    expect(url.searchParams.get('dt_date')).toBe('2026-08-01');
    expect(url.searchParams.get('i_limit')).toBe('100');
    expect(url.searchParams.has('s_sort')).toBe(false);
  });

  it('rejects a path that is not rooted', async () => {
    const { wl } = await load('dev');
    expect(() => buildWlUrl(wl, 'v1/staff/list')).toThrow(/must start with/);
  });
});
