import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  SecretsProviderError,
  type AppEnv,
  type SecretBundle,
  type SecretKey,
  type SecretsProvider,
} from './types.js';

/**
 * Maps the human-authored settings file shape onto the flat key names the rest
 * of the application uses.
 *
 * Single-sourced here so the file format, the example file and the validation
 * error messages can never disagree about what a setting is called.
 */
export const SETTINGS_PATHS = {
  'wellnessliving.host': 'WL_API_HOST',
  'wellnessliving.idRegion': 'WL_ID_REGION',
  'wellnessliving.kBusiness': 'WL_K_BUSINESS',
  'wellnessliving.clientId': 'WL_CLIENT_ID',
  'wellnessliving.clientSecret': 'WL_CLIENT_SECRET',
  'supabase.url': 'SUPABASE_URL',
  'supabase.serviceRoleKey': 'SUPABASE_SERVICE_ROLE_KEY',
  'gohighlevel.apiToken': 'GHL_API_TOKEN',
  'gohighlevel.locationId': 'GHL_LOCATION_ID',
} as const satisfies Record<string, SecretKey>;

/** Keys allowed at the top level of a settings file but carrying no setting. */
const METADATA_KEYS = new Set(['$schema', '//', 'note', 'environment']);

const SECTIONS = new Set(['wellnessliving', 'supabase', 'gohighlevel']);

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

    const root = parsed as Record<string, unknown>;
    this.rejectUnknownSections(root, path);

    const bundle: SecretBundle = {};
    for (const [dotted, key] of Object.entries(SETTINGS_PATHS)) {
      const value = readDotted(root, dotted);
      if (value === undefined || value === null) continue;

      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new SecretsProviderError(
          this.name,
          `${dotted} in ${path} must be a string, number or boolean`,
        );
      }

      const trimmed = String(value).trim();
      if (trimmed.length === 0) continue;
      bundle[key] = trimmed;
    }
    return bundle;
  }

  private async readSettingsFile(path: string, env: AppEnv): Promise<string> {
    try {
      return await this.read(path);
    } catch (cause) {
      const code = (cause as { code?: string } | null)?.code;
      if (code === 'ENOENT') {
        // The single most common first-run failure, so it gets a message that
        // says exactly what to do rather than a bare stack trace.
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

  /** A typo like "wellnessLiving" must fail loudly, not silently read as absent. */
  private rejectUnknownSections(root: Record<string, unknown>, path: string): void {
    const unknown = Object.keys(root).filter(
      (key) => !SECTIONS.has(key) && !METADATA_KEYS.has(key),
    );
    if (unknown.length > 0) {
      throw new SecretsProviderError(
        this.name,
        `unrecognised section(s) in ${path}: ${unknown.join(', ')}. ` +
          `Expected only: ${[...SECTIONS].join(', ')}. Compare against config/settings.example.json.`,
      );
    }
  }
}

function readDotted(root: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = root;
  for (const part of dotted.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
