import { describe, expect, it } from 'vitest';
import { AwsSecretsManagerProvider } from '../src/secrets/aws-secrets-manager-provider.js';
import { EnvSecretsProvider } from '../src/secrets/env-provider.js';
import { FileSettingsProvider } from '../src/secrets/file-provider.js';
import { createSecretsProvider, isSecretsProviderKind } from '../src/secrets/index.js';
import { SecretsProviderError } from '../src/secrets/types.js';
import { FAKE_BUNDLES } from './helpers/fixtures.js';

describe('EnvSecretsProvider', () => {
  it('reads known keys and ignores everything else', async () => {
    const provider = new EnvSecretsProvider({
      ...FAKE_BUNDLES.dev,
      SOMETHING_ELSE: 'ignored',
    });
    const bundle = await provider.load('dev');
    expect(bundle).toEqual(FAKE_BUNDLES.dev);
    expect(bundle).not.toHaveProperty('SOMETHING_ELSE');
  });

  it('trims values and treats a blank var as absent', async () => {
    const provider = new EnvSecretsProvider({
      WL_API_HOST: '  wl.example.test  ',
      WL_K_BUSINESS: '   ',
    });
    const bundle = await provider.load('dev');
    expect(bundle.WL_API_HOST).toBe('wl.example.test');
    expect(bundle.WL_K_BUSINESS).toBeUndefined();
  });
});

/** Drives the parsing path without an AWS account. */
class StubAwsProvider extends AwsSecretsManagerProvider {
  constructor(private readonly payload: string) {
    super({ region: 'test-region', prefix: 'royalty-sync' });
  }
  protected override fetchSecretString(): Promise<string> {
    return Promise.resolve(this.payload);
  }
}

describe('AwsSecretsManagerProvider', () => {
  it('resolves one secret id per environment', () => {
    const provider = new AwsSecretsManagerProvider({ region: 'r', prefix: 'royalty-sync' });
    expect(provider.secretId('dev')).toBe('royalty-sync/dev/config');
    expect(provider.secretId('prod')).toBe('royalty-sync/prod/config');
  });

  it('parses a JSON bundle and coerces numeric values to strings', async () => {
    const provider = new StubAwsProvider(
      JSON.stringify({ ...FAKE_BUNDLES.dev, WL_ID_REGION: 2, EXTRA: 'ignored' }),
    );
    const bundle = await provider.load('dev');
    expect(bundle.WL_ID_REGION).toBe('2');
    expect(bundle).not.toHaveProperty('EXTRA');
  });

  it('fails clearly on malformed secret payloads', async () => {
    await expect(new StubAwsProvider('not json').load('dev')).rejects.toThrow(/not valid JSON/);
    await expect(new StubAwsProvider('[1,2]').load('dev')).rejects.toThrow(/JSON object/);
  });
});

describe('createSecretsProvider', () => {
  it('defaults to the env provider', () => {
    expect(createSecretsProvider({ kind: 'env', processEnv: {} }).name).toBe('env');
  });

  it('requires AWS_REGION for the aws backend', () => {
    expect(() => createSecretsProvider({ kind: 'aws-secrets-manager', processEnv: {} })).toThrow(
      SecretsProviderError,
    );
    expect(
      createSecretsProvider({
        kind: 'aws-secrets-manager',
        processEnv: { AWS_REGION: 'test-region' },
      }).name,
    ).toBe('aws-secrets-manager');
  });

  it('validates provider names', () => {
    expect(isSecretsProviderKind('env')).toBe(true);
    expect(isSecretsProviderKind('vault')).toBe(false);
  });
});

describe('one settings shape across every provider', () => {
  const nested = {
    environment: 'prod',
    wellnessliving: {
      host: 'wl-live.example.test',
      idRegion: 1,
      kBusiness: '222222',
      clientId: 'prod-client-id-0000',
      clientSecret: 'prod-client-secret-0000',
    },
    supabase: {
      url: 'https://prod.supabase.example.test',
      serviceRoleKey: 'prod-service-role-key-0000',
    },
    gohighlevel: { apiToken: 'prod-ghl-token-0000', locationId: 'prod-location' },
  };

  it('reads the nested settings file shape straight out of the secrets manager', async () => {
    // The property that makes "upload config/settings.prod.json verbatim" safe:
    // the file provider and the secrets manager must agree on the shape, so no
    // hand-conversion can drop or mistype a key on the way in.
    const fromSecretsManager = await new StubAwsProvider(JSON.stringify(nested)).load('prod');
    const fromFile = await new FileSettingsProvider({
      dir: '/settings',
      readFileImpl: () => Promise.resolve(JSON.stringify(nested)),
    }).load('prod');

    expect(fromSecretsManager).toEqual(fromFile);
    expect(fromSecretsManager.WL_ID_REGION).toBe('1');
    expect(fromSecretsManager.WL_K_BUSINESS).toBe('222222');
  });

  it('still accepts a legacy flat bundle in the secrets manager', async () => {
    const flat = await new StubAwsProvider(JSON.stringify(FAKE_BUNDLES.dev)).load('dev');
    expect(flat).toEqual(FAKE_BUNDLES.dev);
  });

  it('rejects a mistyped section wherever it appears', async () => {
    await expect(
      new StubAwsProvider(JSON.stringify({ wellnessLiving: { host: 'x' } })).load('prod'),
    ).rejects.toThrow(/unrecognised section/);
  });
});
