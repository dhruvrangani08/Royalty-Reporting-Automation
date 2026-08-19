#!/usr/bin/env node
import { loadConfig } from '../config/index.js';
import { ConfigValidationError } from '../config/schema.js';
import { createLogger } from '../logging/logger.js';
import { credentialValues, describeConfig, redact } from '../logging/redact.js';
import { MissingSecretsError, SecretsProviderError } from '../secrets/types.js';
import { checkAll } from '../health/index.js';
import { runWellnessSync } from '../wl/sync.js';

const USAGE = `royalty-sync <command>

Commands:
  healthcheck     Resolve config, then probe every dependency. Exit 1 on failure.
  sync:wellness   Authenticate against WellnessLiving, then run one read-only pass.
  config:check    Resolve and validate config only. Makes no network calls.
  config:show     Print the resolved config with credentials fingerprinted.
  help            Show this message.

Environment:
  APP_ENV           dev | prod                       (required)
  SECRETS_PROVIDER  env | aws-secrets-manager        (default: env)

See .env.example and docs/RUNBOOK.md.`;

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

  if (!['healthcheck', 'config:check', 'config:show', 'sync:wellness'].includes(command)) {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }

  const config = await loadConfig();
  const logger = createLogger({
    level: config.runtime.logLevel,
    secrets: credentialValues(config),
  });

  switch (command) {
    case 'config:check': {
      logger.info('configuration resolved', {
        env: config.env,
        secretsProvider: config.secretsProviderName,
      });
      console.log('OK');
      return 0;
    }

    case 'config:show': {
      console.log(JSON.stringify(describeConfig(config), null, 2));
      return 0;
    }

    case 'sync:wellness': {
      const summary = await runWellnessSync(config);
      for (const step of summary.steps) {
        const fields = { step: step.name, kLog: step.kLog, latencyMs: step.latencyMs };
        if (step.ok) logger.info('sync step ok', fields);
        else logger.error('sync step FAILED', { ...fields, detail: step.detail });
      }
      console.log(JSON.stringify(summary, null, 2));
      return summary.ok ? 0 : 1;
    }

    case 'healthcheck': {
      const results = await checkAll(config);
      for (const result of results) {
        const fields = {
          target: result.target,
          detail: result.detail,
          latencyMs: result.latencyMs,
          ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        };
        if (result.ok) logger.info('health ok', fields);
        else logger.error('health FAILED', fields);
      }
      const allOk = results.every((r) => r.ok);
      console.log(
        JSON.stringify(
          { env: config.env, secretsProvider: config.secretsProviderName, ok: allOk, results },
          null,
          2,
        ),
      );
      return allOk ? 0 : 1;
    }
  }

  return 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Startup failures print a bare message: at this point there is no logger,
    // and a stack trace from a secrets backend can echo request context.
    if (
      error instanceof MissingSecretsError ||
      error instanceof SecretsProviderError ||
      error instanceof ConfigValidationError
    ) {
      console.error(`startup failed: ${error.message}`);
    } else if (error instanceof Error) {
      console.error(`startup failed: ${redact(error.message, [])}`);
    } else {
      console.error('startup failed: unknown error');
    }
    process.exitCode = 1;
  });
