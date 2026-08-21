# WellnessLiving and GoHighLevel API notes

Everything here was measured against the live UAT host on **19 Aug 2026**, not read
from documentation. Where the docs and the API disagree, the API is recorded and the
disagreement is called out.

Keep this updated when something new is discovered — several of these cost hours to
find and none of them are written down anywhere else.

## WellnessLiving

### Auth

Two different hosts. This trips people up.

| | Host | Used for |
|---|---|---|
| `WL_AUTH_HOST` | `access.api.…` | `/oauth2/token` only |
| `WL_API_HOST` | `api.…` | every data endpoint |

`client_credentials`, form-encoded. Tokens last an hour; the client refreshes at 55
minutes. No `id_region` or `k_business` on the token call — business scoping is
meaningless before there is a token.

### Success is in the body, not the status code

**This is the single most important thing about this API.** WL answers HTTP 200 for
errors:

```json
{
  "status": "id-empty",
  "a_error": [{ "sid": "id-empty", "s_message": "No ID is specified.",
                "s_field": "k_purchase_item" }]
}
```

`status === "ok"` is the only success. Anything else is a failure carried on a 200.
Trusting the status code writes empty rows and reports success.

`a_error[].sid` classifies it. Bad-parameter errors never succeed and should not
burn retries.

### Dates need a time component

```
dt_date=2026-08-19             ->  dt-date-invalid
dt_date=2026-08-19 00:00:00    ->  ok
```

A silent trap: the short form looks reasonable and fails with a message that does
not say why.

### `dt_` is UTC, `dtl_` is local

Confirmed on one purchase — `dt_add` `"2023-07-03 17:12:31"` against
`dtl_purchase` `"2023-07-03 13:12:31"`, exactly four hours apart.

**But `text_timezone` is `"ET"`** — an abbreviation, not an IANA name. It does not
say whether EST or EDT applied, so a local time cannot be reconstructed from the UTC
value alone. Store `dtl_` where local wall time matters.

### List endpoints return KEYED OBJECTS, not arrays

```json
"a_staff": { "343509": { … }, "344486": { … } }
```

The object key is the record key. Iterate with `Object.values()`; `.length` is
`undefined` and `.map` does not exist.

### `k_log` — WL's trace id — is mostly absent

| Endpoint | `k_log` |
|---|---|
| `/v1/business` | absent |
| `/v1/location/list` | absent |
| `/v1/staff/list` | absent |
| `/v1/user` | absent |
| `/v1/profile/purchase/list` | absent |
| `/v1/lead/info` | **present** — `"[31.77ldu]"` |
| a real error envelope | `"0"` — a placeholder |

WL's own Postman collection documents it on four endpoints with values like
`"[42.wiyy6]"`, so it is not switched off account-wide; it is per endpoint.

`"0"` is filtered out. Storing it is worse than storing nothing — it sends support
hunting a log entry that never existed. On errors it hides at
`a_error[0].a_message_source["[k_log]"]`, brackets included.

Because none of this can be relied on, the service generates its own trace id.

### Rate limits are undocumented and were never hit

Nothing in the Postman collection mentions a rate limit, throttling, 429 or quota.
Over 100 unthrottled probe calls in one session never triggered one.

The 5 req/s cap this project used to impose was **ours**, not WL's, and has been
removed. The backoff and requeue machinery remains for when WL does push back.

**Ask WL** what the real limits are before assuming a number.

### Working endpoints

| Data | Endpoint | Required params |
|---|---|---|
| Business | `/v1/business` | — |
| Locations | `/v1/location/list` | — |
| Staff | `/v1/staff/list` | — |
| Client detail | `/v1/user` | `uid` |
| Client search | `/v1/login/search/staff-app/list` | `text_search` |
| Client types | `/v1/login/type` | — |
| Purchases | `/v1/profile/purchase/list` | `uid` |
| **Money** | `/v1/purchase/receipt` | `uid`, `k_purchase` |
| Class definitions | `/v1/classes/list` | `k_location` |
| **Session + who taught** | `/v1/schedule/class/view` | `k_class_period`, `dt_date` |
| Client visits | `/v1/schedule/page/list` | `uid` |
| Calendar days | `/v1/schedule/class/list` | `k_location`, `dt_date` |
| Promotions | `/v1/classes/promotion` | `k_location` |
| Lead form definition | `/v1/lead/info` | — |

All GET unless noted. `id_region` and `k_business` are added by the client.

### Endpoints that do not work

| Endpoint | Result | Meaning |
|---|---|---|
| `/v1/collector/debt/list` | `subscription-access` | not on this plan |
| `/v1/collector/debt/transaction` | `subscription-access` | not on this plan |
| `/v1/login/attendance/list` | `date-incorrect` | **unsolved** — every date format tried fails |
| `/v1/report/query` | `method-nx` on GET | POST only |
| `/v1/report/data` | `report-nx` | needs a report sid |
| `POST` on most read endpoints | `method-nx` | GET only |

### Three open questions for the WL integrations team

**1. Is there any endpoint that lists clients?**
`/v1/login/search/staff-app/list` requires a search term — `{}` returns 6 rows,
`"a"` returns 17. There is no way to enumerate the client base, which means the
`person` table can only be filled from the 20 in `/v1/staff/list`.
**This is the main blocker on a full sync.**

**2. How is a `k_staff_pay` resolved to an amount?**
`/v1/staff/list` returns `a_pay_rate` as keys only — `["310036","308721"]` — and
`a_staff_service` as `{"k_service":"142047","k_staff_pay":"310041"}`. None of the 75
endpoints in the collection resolves a key to a rate. Without this there is no
teacher cost and no margin.

**3. What are the correct parameters for `/v1/login/attendance/list`?**
It returns `date-incorrect` for `dt_date` in every format tried, including the
`YYYY-MM-DD HH:MM:SS` form that other endpoints require.

### `/v1/purchase/receipt` shape — where the money is

Probed live 21 Aug 2026. `profile/purchase/list` carries NO money; the receipt does,
one call per `k_purchase`:

| Block | Holds | Maps to |
|---|---|---|
| `a_price` (keyed object) | `m_sum`, `m_discount`, `m_tax`, `m_tip`, `m_total`, `text_currency` | `purchase` totals |
| `a_purchase_item[]` | per item `m_price_total`, `text_currency` | `purchase_item` money |
| `a_pay_method[]` | `text_pay_method`, `m_amount`, `text_currency` | `purchase_payment` |
| `a_account_rest[]` | `text_method`, `m_amount` (can be **negative** — a balance, not a payment), `text_currency` | `purchase_account_credit` |

Trap: **`a_purchase_item[].k_purchase_item` comes back as a NUMBER here**, though the
list endpoint sends the same key as a string. Coerce to text or the item is lost.

### Field notes worth remembering

| Field | Note |
|---|---|
| `uid` | 8 digits, the person id. Text |
| `k_staff` | 6 digits, the staff id. Text |
| `uid_staff` | always equals `uid` — a duplicate field, not a third id |
| `text_member` | 9 digits, the UI's "Client ID #". **Not** the uid, often empty, search-only |
| `k_login_type` | client type key, e.g. `1260510` = "Staff Client Profile" |
| Phones | already full international — `+NNNNNNNNNNN` (12) or `+NNNN-NNN-NNNN` (14) |
| `is_require` | inconsistently typed: `true`, `"1"`, `"0"` in the same response |
| `m_*` | money, always a quoted string |
| Client-type counts | 13 types on this business; 47 clients are "Staff Client Profile" while only 20 are staff |

## GoHighLevel

### Auth — no OAuth needed

`GHL_API_TOKEN` is a **Private Integration Token** (`pit-…`), which is already an
access token. No `/oauth/token` exchange, no refresh, no expiry to manage.

```bash
curl -s 'https://services.leadconnectorhq.com/contacts/?locationId=<LOC>&limit=20' \
  -H "Authorization: Bearer $GHL_API_TOKEN" \
  -H 'Version: 2021-07-28' \
  -H 'Accept: application/json'
```

**The `Version` header is required** — and it differs by endpoint family. Data
endpoints want `2021-07-28`; the OAuth endpoints want `v3`. Easy to get wrong.

`/oauth/location-token` needs an **Agency** token. Ours is Sub-Account level, so it
does not apply.

### The token has contacts scope only

| Endpoint | Result |
|---|---|
| `GET /contacts/` | ✅ 200 |
| `GET /locations/{id}` | ❌ 401 *token is not authorized for this scope* |
| `GET /users/` | ❌ 401 |
| `GET /opportunities/pipelines` | ❌ 401 |

Only read was tested. **Write scope is unverified** — matching will need it to set a
contact id, and there are 22,865 real contacts, so check the scopes in
GHL → Settings → Private Integrations rather than testing against live data.

### Contacts

**22,865 contacts** — against 47 WL clients. Matching is the real work.

Pagination is **cursor-based**, not page numbers:

```json
"meta": {
  "total": 22865,
  "nextPageUrl": "…&startAfter=1787077671368&startAfterId=I4B54A9Du8JQZp4EPvfX",
  "currentPage": 1, "nextPage": 2
}
```

`startAfter` (a timestamp) and `startAfterId` together — both are needed to resume.

Fields available for matching: `id`, `email`, `phone`, `firstName`, `lastName`,
`dateOfBirth`, `tags`, `dateAdded`, `dateUpdated`, `customFields`, plus address
fields. Phones are in the same `+1…` shape WL uses.

One observed contact carried `tags: ["closed","wellness member"]` — WL members
appear to be tagged, which may help matching.

### GHL always returns a trace id

```json
"traceId": "cdbc99cb-68d5-4250-8213-06fceb309aa4"
```

A real UUID, on every response — unlike WL's `k_log`. Worth storing and quoting on
a support ticket.
