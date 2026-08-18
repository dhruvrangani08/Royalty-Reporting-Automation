# Supabase environment setup — dev and prod

Creating the two Supabase projects requires an authenticated Supabase account and is the one
part of this task that cannot be scripted from this repository. Follow the steps below once
per environment; the sync service is already written to work against both.

Acceptance target: _dev and prod Supabase projects exist and both are reachable from the
sync service_ — provable with `npm start -- healthcheck` at the end of §4.

---

## 1. Create the projects

In the Supabase dashboard, create **two separate projects** in the same organisation:

| Setting           | dev                                       | prod                                        |
| ----------------- | ----------------------------------------- | ------------------------------------------- |
| Name              | `royalty-report-dev`                      | `royalty-report-prod`                       |
| Region            | closest to the sync service host          | closest to the sync service host            |
| Database password | generated, stored in the password manager | generated, stored in the password manager   |
| Plan              | Free is sufficient for dev                | Pro (needed for daily backups + no pausing) |

Two projects, not two schemas in one project. The service role key bypasses RLS, so a shared
project would let a dev-side mistake write production rows.

> Free-tier projects pause after a week of inactivity. If dev is on Free and `healthcheck`
> starts reporting "not reachable", check whether the project is paused before debugging the
> service.

## 2. Collect the values

| Dashboard location                    | Field                                              | Goes into                   |
| ------------------------------------- | -------------------------------------------------- | --------------------------- |
| Settings → **Data API**               | Project URL                                        | `SUPABASE_URL`              |
| Settings → **API Keys** → Secret keys | the `sb_secret_…` value (reveal with the eye icon) | `SUPABASE_SERVICE_ROLE_KEY` |

The Project URL is **not** on the API Keys page — it lives under Data API. It is also always
`https://<project-ref>.supabase.co`, and the project ref is in the dashboard address bar.

Supabase now issues two key types, and the dashboard shows both systems:

| Key                       | Privileges                                  | Use here                                |
| ------------------------- | ------------------------------------------- | --------------------------------------- |
| `sb_publishable_…`        | none beyond RLS policies; safe in a browser | ❌ never — writes will fail             |
| `sb_secret_…`             | full, bypasses RLS                          | ✅ this one                             |
| legacy `anon` JWT         | same as publishable                         | ❌                                      |
| legacy `service_role` JWT | same as secret                              | ✅ if the project predates the new keys |

The env var is still named `SUPABASE_SERVICE_ROLE_KEY` because that is what the privilege
level _means_; either the `sb_secret_…` key or a legacy `service_role` JWT satisfies it.

Do not paste either value into this repository, a ticket, or a chat message. They go straight
into the secrets manager — see [RUNBOOK.md §2](RUNBOOK.md).

## 3. Store them

Add both to the environment's bundle in the secrets manager, alongside the WL and GHL keys:

```
royalty-sync/dev/config     -> { ..., "SUPABASE_URL": "...", "SUPABASE_SERVICE_ROLE_KEY": "..." }
royalty-sync/prod/config    -> { ..., "SUPABASE_URL": "...", "SUPABASE_SERVICE_ROLE_KEY": "..." }
```

For local development, put the **dev** values in `.env` only. Never put prod values in a local
`.env`.

## 4. Prove reachability

```bash
npm run build

APP_ENV=dev  npm start -- healthcheck
APP_ENV=prod npm start -- healthcheck
```

Expected, for each:

```json
{
  "env": "dev",
  "secretsProvider": "env",
  "ok": true,
  "results": [
    {
      "target": "supabase:rest",
      "ok": true,
      "detail": "reachable, service role key accepted",
      "httpStatus": 200,
      "latencyMs": 180
    }
  ]
}
```

Exit code 0. The probe hits the PostgREST root rather than a table, so it works before any
schema exists.

| Reported detail                                    | Meaning                                     | Fix                                        |
| -------------------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| `reachable, service role key accepted`             | done                                        | —                                          |
| `reachable, but the service role key was rejected` | project answered, key wrong                 | re-copy the `service_role` key             |
| `not reachable: TimeoutError`                      | wrong URL, network block, or paused project | check `SUPABASE_URL`, check project status |
| `not reachable: TypeError`                         | URL does not resolve                        | check `SUPABASE_URL` for typos             |

## 5. Settings worth applying now

Cheap to do at creation, awkward later:

- **prod**: enable daily backups (Pro plan) and Point-in-Time Recovery if the budget allows.
- **both**: Settings → Database → restrict direct Postgres connections to known IPs if the
  sync service has a static egress address.
- **both**: leave "Enable Row Level Security" on for every new table. The schema task (PRD
  M02) depends on RLS being the default, since the portal reads the same database.
- **prod**: turn on log drains or at least note where logs are read from, so a rejected key
  or a failed sync can be traced.

## 6. What is not set up here

- No tables, views, RLS policies, or functions — that is PRD module M02
  (`04_Development/2026-08-05_HRRAFEBAV_Supabase-Schema-DDL_v2.sql`).
- No Supabase Auth configuration — that is the portal's task.
- No storage buckets — that is the uploads/artifacts task.
