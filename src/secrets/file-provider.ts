import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { bundleFromSettings } from './settings-shape.js';
import {
  SecretsProviderError,
  type AppEnv,
  type SecretBundle,
  type SecretsProvider,
} from './types.js';

export interface FileSettingsProviderOptions {
  /** Directory holding settings.<env>.json. Relative paths resolve from cwd. */
  dir: string;
  /** Injectable reader so tests need no temp files. */
  readFileImpl?: (path: string) => Promise<string>;
}

/**
 * Reads one settings file per environment:
 *
 *   config/settings.dev.json
 *   config/settings.prod.json
 *
 * Switching APP_ENV switches the whole file, so the WellnessLiving host,
 * id_region, k_business and the Supabase connection all change together and
 * cannot be mixed between environments by accident. The real files are
 * git-ignored; config/settings.example.json documents the shape.
 *
 * The file format is identical to what the secrets manager stores, so the same
 * JSON can be uploaded verbatim - see docs/RUNBOOK.md.
 */
export class FileSettingsProvider implements SecretsProvider {
  readonly name = 'file';

  private readonly read: (path: string) => Promise<string>;

  constructor(private readonly options: FileSettingsProviderOptions) {
    this.read = options.readFileImpl ?? ((path) => readFile(path, 'utf8'));
  }

  /** Absolute path of the settings file for `env`. Shown in error messages. */
  settingsPath(env: AppEnv): string {
    const dir = isAbsolute(this.options.dir)
      ? this.options.dir
      : resolve(process.cwd(), this.options.dir);
    return resolve(dir, `settings.${env}.json`);
  }

  async load(env: AppEnv): Promise<SecretBundle> {
    const path = this.settingsPath(env);
    const raw = await this.readSettingsFile(path, env);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new SecretsProviderError(
        this.name,
        `${path} is not valid JSON. Check for a trailing comma or an unquoted value ` +
          '(JSON does not allow comments).',
        { cause },
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SecretsProviderError(this.name, `${path} must contain a JSON object`);
    }

    return bundleFromSettings(parsed as Record<string, unknown>, this.name, path);
  }

  private async readSettingsFile(path: string, env: AppEnv): Promise<string> {
    try {
      return await this.read(path);
    } catch (cause) {
      const code = (cause as { code?: string } | null)?.code;
      if (code === 'ENOENT') {
        // The most common first-run failure, so it gets a message that says
        // exactly what to do rather than a bare stack trace.
        throw new SecretsProviderError(
          this.name,
          `no settings file for APP_ENV="${env}".\n` +
            `  Expected: ${path}\n` +
            '  Create it by copying the documented example:\n' +
            `    cp config/settings.example.json config/settings.${env}.json\n` +
            '  Then fill in the values. The file is git-ignored; see docs/RUNBOOK.md.',
        );
      }
      if (code === 'EACCES') {
        throw new SecretsProviderError(this.name, `${path} exists but is not readable (EACCES)`);
      }
      throw new SecretsProviderError(this.name, `could not read ${path}`, { cause });
    }
  }
}

export { SETTINGS_PATHS } from './settings-shape.js';
