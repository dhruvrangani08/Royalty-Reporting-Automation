import { SECRET_KEYS, type AppEnv, type SecretBundle, type SecretsProvider } from './types.js';

/**
 * Reads secrets from the process environment.
 *
 * This is the local-development and CI default, and it is also the shape a
 * hosting platform's injected environment takes. Key names are read verbatim
 * (WL_API_HOST, ...) - the environment is already scoped to one deployment, so
 * no per-env prefixing is applied.
 */
export class EnvSecretsProvider implements SecretsProvider {
  readonly name = 'env';

  constructor(private readonly source: Readonly<Record<string, string | undefined>>) {}

  load(_env: AppEnv): Promise<SecretBundle> {
    const bundle: SecretBundle = {};
    for (const key of SECRET_KEYS) {
      const raw = this.source[key];
      if (raw === undefined) continue;
      const trimmed = raw.trim();
      // A blank var is treated as absent, so an empty line in a .env file
      // produces a clear "missing key" error instead of a confusing one.
      if (trimmed.length === 0) continue;
      bundle[key] = trimmed;
    }
    return Promise.resolve(bundle);
  }
}
