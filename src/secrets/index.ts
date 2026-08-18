import { AwsSecretsManagerProvider } from './aws-secrets-manager-provider.js';
import { EnvSecretsProvider } from './env-provider.js';
import { SecretsProviderError, type SecretsProvider } from './types.js';

export const SECRETS_PROVIDER_KINDS = ['env', 'aws-secrets-manager'] as const;
export type SecretsProviderKind = (typeof SECRETS_PROVIDER_KINDS)[number];

export const DEFAULT_SECRETS_PREFIX = 'royalty-sync';

export interface CreateSecretsProviderInput {
  kind: SecretsProviderKind;
  /** Bootstrap environment - supplies AWS_REGION / SECRETS_PREFIX when needed. */
  processEnv: Readonly<Record<string, string | undefined>>;
}

/**
 * Builds the provider named by SECRETS_PROVIDER.
 *
 * Adding a backend (Doppler, Vault, GCP Secret Manager) means adding a class
 * and one case here. No caller changes.
 */
export function createSecretsProvider(input: CreateSecretsProviderInput): SecretsProvider {
  switch (input.kind) {
    case 'env':
      return new EnvSecretsProvider(input.processEnv);

    case 'aws-secrets-manager': {
      const region = input.processEnv.AWS_REGION?.trim();
      if (!region) {
        throw new SecretsProviderError(
          'aws-secrets-manager',
          'AWS_REGION must be set when SECRETS_PROVIDER=aws-secrets-manager',
        );
      }
      const prefix = input.processEnv.SECRETS_PREFIX?.trim() || DEFAULT_SECRETS_PREFIX;
      return new AwsSecretsManagerProvider({ region, prefix });
    }
  }
}

export function isSecretsProviderKind(value: string): value is SecretsProviderKind {
  return (SECRETS_PROVIDER_KINDS as readonly string[]).includes(value);
}

export { AwsSecretsManagerProvider } from './aws-secrets-manager-provider.js';
export { EnvSecretsProvider } from './env-provider.js';
export * from './types.js';
