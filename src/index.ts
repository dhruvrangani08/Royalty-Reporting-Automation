/** Public surface of the sync service foundation layer. */

export { loadConfig, type LoadConfigInput } from './config/index.js';
export type {
  AppConfig,
  GhlConfig,
  LogLevel,
  RuntimeConfig,
  SupabaseConfig,
  WlConfig,
} from './config/schema.js';
export { ConfigValidationError } from './config/schema.js';

export { createLogger, type Logger } from './logging/logger.js';
export {
  credentialValues,
  describeConfig,
  fingerprint,
  redact,
  REDACTED,
} from './logging/redact.js';

export {
  createSecretsProvider,
  isSecretsProviderKind,
  SECRETS_PROVIDER_KINDS,
  type SecretsProviderKind,
} from './secrets/index.js';
export {
  APP_ENVS,
  CREDENTIAL_KEYS,
  MissingSecretsError,
  SECRET_KEYS,
  SecretsProviderError,
  type AppEnv,
  type SecretBundle,
  type SecretKey,
  type SecretsProvider,
} from './secrets/types.js';

export { checkAll, checkSupabaseReachable, type HealthCheckResult } from './supabase/health.js';
export { buildWlUrl, WL_PATHS, type WlPathName } from './wl/endpoint.js';
