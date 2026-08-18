# royalty-sync-service

Sync service for the WellnessLiving → GoHighLevel → Supabase pipeline (project `HRRAFEBAV`).

This repository is the **foundation layer** only: environment configuration, the secrets
layer, the Supabase reachability check and CI. It does **not** call WellnessLiving yet —
`src/wl/endpoint.ts` builds URLs and nothing sends them.

Reference: `2026-08-06_HRRAFEBAV_Sync-Architecture_v1.md` §2a · PRD module M01.

## Requirements

- Node.js ≥ 20.11 (`.nvmrc` pins 20.11.0; CI runs 20 and 22)
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

| Command | What it does |
| --- | --- |
| `npm run verify` | Everything CI runs: format check, lint, typecheck, tests |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run test:coverage` | Vitest with 70% thresholds |
| `npm run lint` / `npm run lint:fix` | ESLint (type-aware) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Emits `dist/` |
| `npm start -- <cmd>` | Runs the built CLI |

CLI commands: `healthcheck`, `config:check`, `config:show`, `help`.

- `config:check` — resolves and validates config. No network calls. Exit 1 if anything is
  missing or malformed.
- `config:show` — prints the resolved config with credentials reduced to fingerprints.
- `healthcheck` — resolves config, then probes Supabase. Exit 1 if any probe fails.

## How configuration works

Two environment variables bootstrap everything:

| Variable | Values | Meaning |
| --- | --- | --- |
| `APP_ENV` | `dev` \| `prod` | Which environment bundle to load |
| `SECRETS_PROVIDER` | `env` \| `aws-secrets-manager` | Where to load it from (default `env`) |

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

- **`env`** — reads the key names verbatim from the process environment. Local development,
  CI, and any host that injects env vars.
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

## Secret hygiene

Three independent layers, all running in CI:

1. **`.gitignore`** — `.env*` (except `.env.example`), key material, credential files.
2. **`tests/no-hardcoded-config.test.ts`** — scans `src/` for hostname shapes, assigned
   `id_region` / `k_business` literals, bare 6+ digit numbers, JWT-shaped strings, GHL
   token shapes and `client_secret` assignments. Patterns only — the real values are not in
   the test either.
3. **gitleaks** — scans the working tree *and the full git history* on every push
   (`.gitleaks.toml`, `.github/workflows/ci.yml`).

Credential rotation procedure: [docs/RUNBOOK.md](docs/RUNBOOK.md).
