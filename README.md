# royalty-sync-service

Sync service for the WellnessLiving → GoHighLevel → Supabase pipeline (project `HRRAFEBAV`).

This repository is the **foundation layer** only: environment configuration, the secrets
layer, the Supabase reachability check and CI. It does **not** call WellnessLiving yet —
`src/wl/endpoint.ts` builds URLs and nothing sends them.

Reference: `2026-08-06_HRRAFEBAV_Sync-Architecture_v1.md` §2a · PRD module M01.

## Requirements

- Node.js 22.x (`.nvmrc` pins 22.20.0; CI runs 22; Node 20 is end-of-life)
- npm 10+

## Quick start

```bash
npm install
cp .env.example .env    # then fill in real values from the secrets manager
npm run verify          # format + lint + typecheck + test
npm run build
npm start -- healthcheck
```

`.env` is git-ignored. Real values never enter this repository — see [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Commands

| Command                             | What it does                                             |
| ----------------------------------- | -------------------------------------------------------- |
| `npm run verify`                    | Everything CI runs: format check, lint, typecheck, tests |
| `npm test` / `npm run test:watch`   | Vitest                                                   |
| `npm run test:coverage`             | Vitest with 70% thresholds                               |
| `npm run lint` / `npm run lint:fix` | ESLint (type-aware)                                      |
| `npm run typecheck`                 | `tsc --noEmit`                                           |
| `npm run build`                     | Emits `dist/`                                            |
| `npm start -- <cmd>`                | Runs the built CLI                                       |

CLI commands: `healthcheck`, `config:check`, `config:show`, `help`.

- `config:check` — resolves and validates config. No network calls. Exit 1 if anything is
  missing or malformed.
- `config:show` — prints the resolved config with credentials reduced to fingerprints.
- `healthcheck` — resolves config, then probes Supabase. Exit 1 if any probe fails.

## How configuration works

Two environment variables bootstrap everything:

| Variable           | Values                                   | Meaning                               |
| ------------------ | ---------------------------------------- | ------------------------------------- |
| `APP_ENV`          | `dev` \| `prod`                          | Which environment bundle to load      |
| `SECRETS_PROVIDER` | `file` \| `env` \| `aws-secrets-manager` | Where to load it from (default `env`) |

Everything else — WL host, region, business id, all credentials — is resolved at startup by
a `SecretsProvider`:

```
APP_ENV=prod ──► SecretsProvider.load('prod') ──► validate ──► frozen AppConfig
```

Switching `APP_ENV` changes the WL host, `id_region` and `k_business` with **no code
change**. This is enforced by a test (`tests/config.test.ts`), not just by convention: the
architecture doc records that docs use the UAT host and region 2 while production uses a
different host and region 1, and hardcoding either is a named project risk.

Startup **fails closed**. A missing or malformed key aborts the process and lists every
offending key — it never starts half-configured, and never echoes a rejected value.

### Providers

- **`file`** — one settings file per environment, `config/settings.<APP_ENV>.json`. The
  recommended local-development option: switching `APP_ENV` switches the whole file, so the
  WL host, region, business id and Supabase connection always move together and cannot be
  mixed between environments. Real files are git-ignored;
  [config/settings.example.json](config/settings.example.json) documents the shape and is the
  only one committed.

  ```jsonc
  {
    "wellnessliving": {
      "host": "…",
      "idRegion": 2,
      "kBusiness": "…",
      "clientId": "…",
      "clientSecret": "…",
    },
    "supabase": { "url": "https://…", "serviceRoleKey": "…" },
    "gohighlevel": { "apiToken": "…", "locationId": "…" },
  }
  ```

  A mistyped section (`wellnessLiving`) is rejected rather than read as absent. Override the
  directory with `SETTINGS_DIR`.

- **`env`** — reads the key names verbatim from the process environment. CI, Vercel, and any
  host that injects env vars — anywhere a file cannot be placed.
- **`aws-secrets-manager`** — reads one JSON secret per environment,
  `<SECRETS_PREFIX>/<APP_ENV>/config`, whose keys are the same names. Requires `AWS_REGION`.
  The AWS SDK is an optional dependency, imported lazily.

Adding a backend (Doppler, Vault, GCP Secret Manager) means one class plus one `case` in
`src/secrets/index.ts`. No caller changes.

## Layout

```
src/
  config/      env bootstrap, zod validation, the frozen AppConfig
  secrets/     SecretsProvider interface + env and AWS implementations
  logging/     structured logger + credential redaction
  supabase/    reachability / key-acceptance probe
  wl/          WL URL builder (no network calls yet)
  cli/         healthcheck, config:check, config:show
tests/         48 tests, including a guard that scans src/ for leaked values
docs/          RUNBOOK.md (rotation), SUPABASE-SETUP.md (project creation)
```

## Deployment (Vercel)

Vercel deploys **only** a token-protected health endpoint plus a static status page. It does
not — and cannot — run the sync itself: a Vercel function is capped at 60s on Hobby and 300s
on Pro, while the daily sync is budgeted at two hours and the backfill at eight. Those run on
a scheduled job elsewhere.

| Path          | What                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`           | Static status page (`public/index.html`), `noindex`                                                                                                              |
| `/api/health` | `GET`, requires `Authorization: Bearer <HEALTHCHECK_TOKEN>`. 200 all healthy · 503 a dependency is down · 401 bad or absent token · 500 config could not resolve |

`vercel.json` sets `outputDirectory: public` and a no-op-safe build; `api/health.ts` is
compiled by Vercel's own builder.

### Required Vercel environment variables

Project Settings → Environment Variables. The endpoint fails closed until all are present:

`APP_ENV` · `SECRETS_PROVIDER` · `WL_API_HOST` · `WL_ID_REGION` · `WL_K_BUSINESS` ·
`WL_CLIENT_ID` · `WL_CLIENT_SECRET` · `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` ·
`GHL_API_TOKEN` · `GHL_LOCATION_ID` · `HEALTHCHECK_TOKEN`

`HEALTHCHECK_TOKEN` is a secret you generate — treat it like any other credential. Without
it the endpoint returns 401 to everyone, which is the intended locked state.

### Keeping the build warning-free

Set Project Settings → **Node.js Version to 22.x** so it agrees with `engines.node`. A
mismatch makes Vercel print a notice on every build saying `package.json` wins.

`overrides.glob` in `package.json` exists to silence a deprecation warning: `test-exclude`
(via `@vitest/coverage-v8`) pins `glob@^10`, and every version below 13 is deprecated
upstream. Pinned to `^13.0.6`; verified coverage still works. Remove it once vitest ships a
current glob.

## Secret hygiene

Three independent layers, all running in CI:

1. **`.gitignore`** — `.env*` (except `.env.example`), key material, credential files.
2. **`tests/no-hardcoded-config.test.ts`** — scans `src/` for hostname shapes, assigned
   `id_region` / `k_business` literals, bare 6+ digit numbers, JWT-shaped strings, GHL
   token shapes and `client_secret` assignments. Patterns only — the real values are not in
   the test either.
3. **gitleaks** — scans the working tree _and the full git history_ on every push
   (`.gitleaks.toml`, `.github/workflows/ci.yml`).

Credential rotation procedure: [docs/RUNBOOK.md](docs/RUNBOOK.md).
