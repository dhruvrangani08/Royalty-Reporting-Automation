import {
  SECRET_KEYS,
  SecretsProviderError,
  type AppEnv,
  type SecretBundle,
  type SecretsProvider,
} from './types.js';

export interface AwsSecretsManagerProviderOptions {
  /** AWS region holding the secrets. */
  region: string;
  /** Secret name prefix; the resolved id is `${prefix}/${env}/config`. */
  prefix: string;
}

/**
 * Reads ONE JSON secret per environment from AWS Secrets Manager:
 *
 *   royalty-sync/dev/config    { "WL_API_HOST": "...", "WL_ID_REGION": "...", ... }
 *   royalty-sync/prod/config   { ... }
 *
 * One bundle per environment is what makes "switch environment, get a different
 * host, region and business id" a configuration change and not a code change.
 *
 * The AWS SDK is an optional dependency, imported lazily, so env-only
 * deployments never need it installed.
 */
export class AwsSecretsManagerProvider implements SecretsProvider {
  readonly name = 'aws-secrets-manager';

  constructor(private readonly options: AwsSecretsManagerProviderOptions) {}

  secretId(env: AppEnv): string {
    return `${this.options.prefix}/${env}/config`;
  }

  async load(env: AppEnv): Promise<SecretBundle> {
    const secretId = this.secretId(env);
    const raw = await this.fetchSecretString(secretId);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new SecretsProviderError(this.name, `secret "${secretId}" is not valid JSON`, {
        cause,
      });
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SecretsProviderError(
        this.name,
        `secret "${secretId}" must be a JSON object of key/value pairs`,
      );
    }

    const record = parsed as Record<string, unknown>;
    const bundle: SecretBundle = {};
    for (const key of SECRET_KEYS) {
      const value = record[key];
      if (value === undefined || value === null) continue;

      // Numbers and booleans are accepted because a JSON secret is easy to
      // author with `"WL_ID_REGION": 2`. Anything else is a mistake in the
      // secret itself and must not be silently stringified to [object Object].
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new SecretsProviderError(
          this.name,
          `key "${key}" in secret "${secretId}" must be a string, number or boolean`,
        );
      }

      const trimmed = String(value).trim();
      if (trimmed.length === 0) continue;
      bundle[key] = trimmed;
    }
    return bundle;
  }

  /** Split out so tests can drive the parsing path without an AWS account. */
  protected async fetchSecretString(secretId: string): Promise<string> {
    const sdk = await importAwsSdk(this.name);
    const client = new sdk.SecretsManagerClient({ region: this.options.region });
    try {
      const response = await client.send(new sdk.GetSecretValueCommand({ SecretId: secretId }));
      if (typeof response.SecretString !== 'string' || response.SecretString.length === 0) {
        throw new SecretsProviderError(
          this.name,
          `secret "${secretId}" has no SecretString (binary secrets are not supported)`,
        );
      }
      return response.SecretString;
    } catch (cause) {
      if (cause instanceof SecretsProviderError) throw cause;
      // Never re-throw the raw SDK error: its message can echo request context.
      throw new SecretsProviderError(this.name, `could not read secret "${secretId}"`, { cause });
    } finally {
      client.destroy();
    }
  }
}

interface AwsSdkShape {
  SecretsManagerClient: new (config: { region: string }) => {
    send(command: unknown): Promise<{ SecretString?: string }>;
    destroy(): void;
  };
  GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
}

/**
 * Held in a variable rather than inlined so TypeScript does not try to resolve
 * the module at compile time: it is an optional dependency, and typecheck must
 * pass on an env-only install where it is absent.
 */
const AWS_SDK_MODULE_ID = '@aws-sdk/client-secrets-manager';

async function importAwsSdk(providerName: string): Promise<AwsSdkShape> {
  try {
    const imported: unknown = await import(AWS_SDK_MODULE_ID);
    return imported as AwsSdkShape;
  } catch (cause) {
    throw new SecretsProviderError(
      providerName,
      'the optional dependency @aws-sdk/client-secrets-manager is not installed. ' +
        'Run: npm install @aws-sdk/client-secrets-manager',
      { cause },
    );
  }
}
