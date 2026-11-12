# pdpgmcsync — GMC Feed Sync

Server-side Adobe I/O Runtime (App Builder) service that submits Adobe Express
Print product listings to Google Merchant Center via the **Merchant API v1
(stable)**. Headless — the browser (DA Document Generator) POSTs product rows
to these actions.

Authoritative spec: [`GMC-Feed-Sync-Handoff.md`](./GMC-Feed-Sync-Handoff.md).
Sections **§4 (corrections)** and **§15 (security)** are non-negotiable.

## Actions

| Action | Type | Purpose |
| --- | --- | --- |
| `sync-products` | web (`require-adobe-auth: true`) | Map export rows → v1 `productInputs.insert` via a bounded concurrent pool. Retry-once on 5xx/429. Returns per-item results — one failure never aborts the batch. |
| `diagnostics` | web (`require-adobe-auth: true`) | Returns detailed `product_view` status and item issues for processed products owned by the configured data source. Optional `offerIds` narrows the report. Posts a digest to Slack + log. |
| `bootstrap-datasource` | admin (`web: no`) | One-off per environment. Creates a primary API data source and prints its ID. Store the ID in `.env` as `GMC_DATASOURCE_ID_{TEST\|PROD}`. |
| `price-sync` | scheduled (`web: no`) | Daily pass over Zazzle's `getbulkpricing`; patches changed price / sale / availability (and optionally shipping) onto existing offers. See [Daily price sync](#daily-price-sync-price-sync). |
| `price-sync-scheduler` | trigger, every 15 min (`web: no`) | Starts `price-sync` at the times set in the admin app and resumes passes that were cut short. |
| `admin-api` | web (IMS user token, checked in `lib/adminAuth.js`) | Backend for the [admin app](#admin-app): runs, health, CSV exports, settings, Run now. |

Package name in the manifest: `gmc-feed-sync`. Runtime: `nodejs:22`. All web
actions are marked `final: true` so injected secrets cannot be overridden by
invocation params. Each web action also validates its bearer token with
`@adobe/aio-lib-ims` before creating a Merchant Center client.

## Setup

1. **Install deps.** `npm install`.
2. **Populate `.env`** by copying `.env.example` and filling in real values.
   `.env` is gitignored. The Adobe I/O values (`AIO_runtime_*`) are already
   populated in this project — leave them.
3. **Confirm developer registration.** The GCP project backing the GMC
   credentials must be registered against the Merchant Center account
   (`developerRegistration.registerGcp`), otherwise every call fails with
   `AUTH_GCP_NOT_REGISTERED`. This is a one-time admin step (handoff §4).
4. **Create data sources.** Run `bootstrap-datasource` once for each
   environment; store the returned `dataSourceId` in `.env` as
   `GMC_DATASOURCE_ID_TEST` and `GMC_DATASOURCE_ID_PROD`.
5. **Confirm the PDP host allowlist** in
   [`config/defaults.json`](./config/defaults.json) still matches the two
   valid hosts (adobe.com production, aem.live preview). `google_product_category`
   is mandatory (see below) — populate [`config/category-map.json`](./config/category-map.json)
   for every `product_type` the DA tool can send, or the DA tool must supply
   `google_product_category` directly on rows whose `product_type` isn't mapped.

## Merchant API authentication

This service uses `express-tools-gcp-account@adbe-gcp1060.iam.gserviceaccount.com`
from GCP project `adbe-gcp1060`. Set `GMC_SERVICE_ACCOUNT_JSON` to that
account's complete JSON key, including `private_key`, and keep it only in
`.env` or the deployment secret store. Set `GMC_SERVICE_ACCOUNT_EMAIL` and
`GMC_GCP_PROJECT_ID` to the expected values so a key for another identity is
rejected before an API call.

After placing the unmodified GCP JSON key at `gmc-service-account.json`, run:

```bash
npm run check:gmc-auth
```

The check validates the key locally, obtains an access token without printing
it, and performs a read-only `products.list` request against test Merchant
account `5830778204`.

`GMC_MERCHANT_ACCOUNT_ID_{TEST|PROD}` identifies the Merchant Center account
to operate on. The GCP project ID is used during the one-time developer
registration and credential validation; it is not itself an API credential.
The confirmed test Merchant account ID is `5830778204`; the production account ID
remains a separate deployment value.

### Expected input row shape (from the DA tool)

Each object in the POST payload's `products` can have the following fields.:

| Field | Required | Notes |
| --- | --- | --- |
| `product_id` | ✓ | Zazzle URN (`urn:aaid:sc:...`) — colons are normalized to hyphens for the GMC `offerId`. |
| `title` | ✓ | Truncated to 150 chars. |
| `link` | ✓ | Full PDP URL. Must be HTTPS and its hostname must be in `pdpAllowedHosts`. |
| `initial_pretty_preferred_view_url` or `image_link` | ✓ | HTTPS image URL. |
| `additional_images` | optional | Array of HTTPS image URLs, distinct from the main image above. Capped at 10 (Google's limit) — see "Additional images" below. |
| `price` | ✓ | Numeric or string (`"12.99"`, `"$12.99"`). Converted to integer micros. |
| `description` | ✓ | String; 5000 chars max. Hard-required by Google's product data spec — missing/empty is now a validation rejection, not a silent default. |
| `google_product_category` | ✓ (indirectly) | Mandatory — but resolved, not necessarily supplied directly. Provide `google_product_category` directly on the row **or** a `product_type` that has an entry in [`config/category-map.json`](./config/category-map.json). If neither resolves to a value, the row is rejected. An explicit `google_product_category` always wins over the `product_type` lookup. |
| `product_type` | required unless `google_product_category` is given directly | Raw Zazzle string (e.g. `zazzle_shirt`). Used for the category-map lookup — see `google_product_category` above. |
| `department_name` | optional | Zazzle department string (e.g. `"Men's T-Shirts"`). Drives the human-readable `productTypes` label, `"Print > " + department_name`. |
| `sale_price` | optional | Numeric advertised sale price. Only submitted when `sale_price_end_date` is still in the future at mapping time. |
| `sale_price_end_date` | optional | ISO datetime string — the raw Zazzle discount end date. Omit the row field entirely (rather than sending `null`) when there's no active discount. |
| `material`, `color`, `printing_type`, `size`, `age_group`, `gender`, `capacity` | optional | Variant attributes, product-type-conditional (e.g. a business card has none). Pass-through only. |
| `custom_label_0` | optional | Pass-through only — provenance still unconfirmed (business/reporting taxonomy). |
| `shipping_label` | optional | Pass-through only — no composition logic. |
| `minimum_order_quantity` | optional | Defaults to `1` (print-on-demand single unit) when the row omits it. |
| `brand`, `availability`, `condition`, `gtin`/`gtins` | optional | Row-level overrides — see [`config/defaults.json`](./config/defaults.json). |

## Product diagnostics

Invoke `diagnostics` with `env` and, optionally, an `offerIds` array. The action
uses the environment's configured `GMC_DATASOURCE_ID_{TEST|PROD}` and returns
only products owned by that data source. For compatibility with Adobe action
parameter serialization, a single comma-separated `offerIds` value is unpacked
into individual IDs, though a JSON array remains the preferred request shape.
At most 50 unique `offerIds` are accepted per call. This matches the
`sync-products` chunk limit and keeps detailed diagnostics below Adobe
Runtime's fixed 1 MB action-result limit.

Google's MCQL `product_view` does not expose a `data_source` field. To keep the
scope exact, the action first calls `products.list`, retains products whose
`dataSource` matches the configured source, and then queries those product IDs
through `reports.search`. The MCQL request selects the documented product
identity, category, price, inventory, status-per-reporting-context,
`item_issues`, and click-potential fields. Product IDs are split into bounded
MCQL `IN` batches.

The response includes:

- `dataSource`: the exact source resource used for filtering.
- `counts`: active, limited, pending, disapproved, and unknown product totals.
- `itemIssueTop`: issue counts grouped by code, canonical attribute, severity,
  and resolution.
- `results`: detailed `productView` objects using the API's camelCase response
  field names, including `aggregatedReportingContextStatus`,
  `statusPerReportingContext`, and `itemIssues`. `diagnosticSource` is
  `reports` when MCQL supplied the row. If the processed Product is already
  available from `products.list` but has not reached `product_view` yet, the
  action derives the same diagnostic fields from `productStatus` and sets
  `diagnosticSource` to `products`; this includes real per-context
  `pendingCountries` returned by Google.
- `missingOfferIds`: present when `offerIds` was requested; these products are
  not yet visible as processed products in the configured data source. Google
  does not expose their unprocessed ProductInput through `products.get/list` or
  `reports.search`.
- `requestedOfferCount`: total deduplicated input IDs.

If even a valid request would produce a result larger than Runtime's 1 MB
limit, diagnostics returns `413` before returning the oversized payload. Retry
with fewer offer IDs. A full data-source sweep without `offerIds` is still
supported, but large data sources can hit this guard; in that case call the
action with explicit subsets of up to 50 IDs.

Google exposes two distinct stages that should not be conflated. An accepted
`ProductInput` awaiting creation of its processed `Product` is not readable:
the ProductInput API has only `insert`, `patch`, and `delete`. Once a processed
Product exists, `products.list/get` can return real per-context
`pendingCountries`, and `product_view` can return the aggregate `PENDING`
status. Diagnostics reports only these Google-sourced statuses; it does not
synthesize pending results for unprocessed inputs.

After Google returns a product through either `products.list` or
`product_view`, diagnostics deletes that offer's `pushed_at` timestamp from
Adobe State because the propagation marker is no longer needed. Requested
offers still listed in `missingOfferIds` remain cached for a later diagnostics
call. State cleanup is best-effort: a State outage is logged but does not change
the successful Merchant API response.

New or updated inputs can take several minutes to become processed products, so
they might initially appear in `missingOfferIds` or be absent from a full-source
report.

## Daily price sync (`price-sync`)

Keeps Merchant Center prices in step with what the PDPs show, using Zazzle's
bulk pricing endpoint (`getbulkpricing`, 100 products per call, ~520 calls per
pass). DA documents are not touched: they carry no prices, and the PDP reads
prices live from Zazzle.

**Schedule.** Set in the [admin app](#admin-app): 1–4 times a day in Pacific
time, default 12:15 AM (just after promos change over at midnight Pacific;
Zazzle asks for one pass daily shortly after 07:00 UTC). The `price-sync-tick`
alarm fires `price-sync-scheduler` every 15 minutes; when a scheduled time has
come, it claims that time slot in `price_sync_slots` (so it starts once) and
invokes `price-sync` non-blocking with `slot` and `trigger=schedule`. Each slot
is its own pass: invoking the same slot again resumes or skips it, a new slot
starts over (marking an unfinished older pass `interrupted`). If `price-sync`
fails before it creates the slot's run (e.g. the database was unavailable),
the scheduler invokes it again 10 minutes later, up to 3 attempts. A pass cut short
(`aborted`, or `running` with no progress for 35 minutes) is resumed by the
scheduler, at most hourly and 3 times. Nothing starts while a run holds the
lock, while scheduled runs are paused, or with `PRICE_SYNC_MODE=off`.

**What a pass does.**
1. Pages through `getbulkpricing`. A failing call is retried on the same
   `after`; if it keeps failing (or Zazzle rate-limits us) the pass stops,
   deletes nothing, and saves its cursor so the next invocation resumes there.
2. Maps each product (Zazzle's rules): `price`/`salePrice` are totals for
   `minQuantity` items and are sent as-is; the sale window comes from
   `discountStart`/`discountEnd`; out of stock or discontinued → `OUT_OF_STOCK`.
3. Compares it with what this job last sent (App Builder Database, keyed by
   offerId). Only new, changed, or refresh-due offers are written. Refreshes
   are spread over days 20–26 after the last write so offers never reach
   Google's 30-day expiry.
4. Writes with `productInputs.patch` on the primary data source, naming
   price, sale price, sale window and availability in `updateMask` every time
   (a masked field missing from the body is cleared, which is how an ended
   sale is removed). Offers that aren't in the data source come back
   `NOT_FOUND` and are reported, not created: new PDPs are added through the
   DA tool. Known-missing offers are rechecked weekly (or with
   `-p retryNotFound true`), not daily.
5. After a **complete** pass (all calls succeeded, every `skippedCount` 0,
   returned + excluded = the first `totalCount`), lists offers Zazzle no
   longer returns. They are deleted only with `PRICE_SYNC_DELETES=enabled`,
   and never if `totalCount` fell >5% since the last complete pass or the list
   exceeds 5% of the catalog.
6. Logs one `PRICE_SYNC_RESULT` line per invocation and one `PRICE_SYNC_ALERT`
   line per problem (aborted or incomplete pass, failed writes, offers failing
   3+ days running, offers close to expiry), plus a readable digest and the
   delete-candidate list. See [Monitoring](#monitoring).

`sync-products` re-inserts whole products, prices included, so after it
writes it drops those offers' price-sync records; the next pass rewrites their
prices from `getbulkpricing`.

**Configuration (deploy-time, `final`).**

| Input | Values | Stage | Prod |
| --- | --- | --- | --- |
| `PRICE_SYNC_MODE` | `off` (default), `dry-run`, `live` | `live` | `off` |
| `PRICE_SYNC_DELETES` | `report` (default), `enabled` | `report` | `report` |
| `PRICE_SYNC_SHIPPING` | `ignore` (default), `send` | `send` | `send` |
| `PRICE_SYNC_EDITORS` | comma-separated emails (GitHub environment variable `vars.PRICE_SYNC_EDITORS`) | `maxn@adobe.com` | `maxn@adobe.com` |

`PRICE_SYNC_MODE` is the ceiling: the admin app can't turn on writes.
`PRICE_SYNC_DELETES` and `PRICE_SYNC_SHIPPING` are defaults until someone
picks a value in the admin app's Settings.

With `PRICE_SYNC_SHIPPING=send`, each offer's `shipping` is written from
Zazzle's list (empty list → cleared so account shipping settings apply; null
→ left unchanged).

**Database setup (once per workspace).** Add the **App Builder Data
Services** API to the Stage and Production workspaces in Adobe Developer
Console, then update the `SCOPES` GitHub environment secret to the
credential's new scope list. The next `aio app deploy` provisions the
database (`database.auto-provision` in `app.config.yaml`, region `amer`).
`price-sync` and `sync-products` get their database token through the
`include-ims-credentials` annotation.

**Manual runs** (after `aio login` and `aio app use <workspace json>`).
Invoke without `--result`, then fetch the result by activation id: a blocking
invoke whose action errors comes back as HTTP 502, which the aio CLI silently
retries (twice), starting extra runs and hiding the original error.
```bash
# read-only: read + diff, no Google writes
aio runtime action invoke gmc-feed-sync/price-sync -p dryRun true -p maxPages 3
# limited live run: first 3 pages (300 products), ends with status=stopped
aio runtime action invoke gmc-feed-sync/price-sync -p maxPages 3
# each invoke prints an activation id; after it finishes:
aio runtime activation result <activationId>
aio runtime activation list --limit 10      # recent runs, with duration and status
# rehearse against live Zazzle from your machine (no credentials, writes nothing)
node scripts/price-sync-dry-run.js --pages 5
```
Without `slot`, an invocation resumes or skips a pass started in the last 20
hours; `force` starts a new pass anyway. A pass stopped by `maxPages` is
resumed by the next invocation. CLI runs ignore the admin app's pause.

`reason: locked` means another invocation is running, or one crashed without
releasing the lock; the response's `lockHeldUntil` says when it frees up (at
most 30 minutes after the holder's last progress). To check or clear it by
hand, only when you're sure nothing is running:
```bash
aio app db document find price_sync_locks '{}'
aio app db document delete price_sync_locks '{"_id": "price-sync"}'
```

### Admin app

A web UI for people who don't use the CLI: the **Runs** tab shows the latest
run, the next scheduled run, health (offers close to expiry, failing
repeatedly, missing from Merchant Center), run history with per-run details,
and CSV downloads of the missing / failing / near-expiry offers and of a run's
delete candidates. The **Settings** tab sets the schedule, pause, deletes,
shipping, the refresh window, a per-run write cap and how often missing
offers are rechecked, with a change history, and has **Run now**.

Open it through Experience Cloud so it gets your Adobe sign-in:
- Stage: <https://experience.adobe.com/?devMode=true#/custom-apps/?localDevUrl=https://14257-pdpgmcsync-stage.adobeio-static.net/index.html>
- Production: the same with the production workspace's static host
  (`https://<prod namespace>.adobeio-static.net/index.html`).

`devMode=true` works without any approval. Listing it in the Experience
Cloud app switcher needs an org admin to approve a published app.

**Access.** The browser sends the user's IMS token; `admin-api` asks IMS for
the profile (which validates the token) and allows anyone with an
`@adobe.com` email to view (hard-coded in `lib/adminAuth.js`), and only emails in `PRICE_SYNC_EDITORS` to save
settings or start a run. To add an editor, edit the `PRICE_SYNC_EDITORS`
variable in the repo's **stage** / **production** environment settings and
redeploy (push to `main` for stage, a release for prod).

**Settings** live in `price_sync_settings` (one doc, versioned so two
editors can't overwrite each other) with every change in
`price_sync_settings_history`. A run reads them when it starts. Saved
settings that no longer validate fall back to the defaults, with a warning on
the Runs tab.

| Setting | Default | Rule |
| --- | --- | --- |
| Run times (Pacific) | 12:15 AM | 1–4, quarter hours, ≥2 h apart |
| Paused | off | scheduled runs only; Run now still works |
| Deletes | deploy default | report / enabled |
| Shipping | deploy default | send / ignore |
| Resend unchanged after / spread over (days) | 20 / 6 | sum ≤ 26 (Google expires offers at 30) |
| Most updates per run | no limit | over-limit offers go next run |
| Recheck missing offers every (days) | 7 | 1–30 |

**Local UI development.** `aio app run` serves `web-src` on localhost; outside
Experience Cloud there's no IMS token, so point it at a deployed workspace
and open it through the `devMode` URL with `localDevUrl=https://localhost:9080`.

### Monitoring

Each invocation logs, for example:
```
PRICE_SYNC_RESULT env=test status=complete mode=live run=2026-11-11T08:15:00.412Z-3fa2c1 resumed=no durationMin=31.2 total=52321 returned=52321 new=0 changed=118 refresh=7406 unchanged=44797 written=7524 notFound=0 knownMissing=0 failed=0 deleted=0 deleteCandidates=0 atRisk=0 repeatFailures=0 alerts=0
PRICE_SYNC_ALERT env=test run=... :: Pass aborted: zazzle after=2560...: HTTP 503
```
`status` is `complete`, `incomplete` (finished but Zazzle skipped products,
so no deletes), `aborted` (stopped on an error; the scheduler resumes it),
`stopped` (manual `maxPages`), `skipped` (already ran / locked / paused) or
`failed` (couldn't start). Run docs also show `interrupted` (replaced by a
newer pass). `trigger=` is `schedule`, `manual` (Run now) or `cli`. The
scheduler logs a `PRICE_SYNC_SCHEDULER` line only when it starts or resumes a
run.

Where to look:
- **Logs:** [Adobe Developer Console](https://developer.adobe.com/console) →
  project → workspace → **App Builder Logs**; filter to `price-sync` and
  search `PRICE_SYNC`. CLI: `aio app logs --action gmc-feed-sync/price-sync`.
- **Action result** (full summary, kept 7 days):
  `aio runtime activation list --limit 20` (find the `price-sync` rows),
  then `aio runtime activation result <activationId>`.
- **Database** (`aio app db` ships with aio CLI 11+; run from the repo root
  after `aio login` and `aio app use <workspace json>`):
  ```bash
  aio app db document find price_sync_runs '{}' --sort '{"startedAt": -1}' --limit 5
  aio app db document count price_sync_offers '{"notInGmc": true}'
  aio app db document find price_sync_offers '{"failCount": {"$gte": 1}}' --sort '{"failCount": -1}'
  ```

Splunk (after log forwarding is set up for the workspace; `wcmsops_milo_np`
is the shared non-prod index, `wcmsops_milo_prd` prod):
```
# problem alert: latest real run in the last 24h didn't complete cleanly
index=wcmsops_milo_np "PRICE_SYNC_RESULT" earliest=-24h
| rex "PRICE_SYNC_RESULT env=(?<env>\S+) status=(?<status>\S+)"
| rex "alerts=(?<alerts>\d+)"
| where status!="skipped"
| stats latest(status) as status latest(alerts) as alerts latest(_time) as last_run by env
| where status!="complete" OR alerts>0

# missed-run alert: trigger when this returns 0 results
index=wcmsops_milo_np "PRICE_SYNC_RESULT" "status=complete" earliest=-26h

# alert details
index=wcmsops_milo_np "PRICE_SYNC_ALERT" earliest=-24h
| rex "PRICE_SYNC_ALERT env=(?<env>\S+) run=(?<run>\S+) :: (?<alert>[^\"\\]+)"
| table _time env run alert
```

**Filling the test account.** Patches only reach offers that already exist,
so to exercise the full catalog in the test account, copy production's
products into the test data source first (reads production, writes only to a
`GMC_ENV=test` account; dry run unless `--write`):
```bash
node scripts/seed-test-account.js                    # counts per data source, writes nothing
node scripts/seed-test-account.js --write --limit 100
node scripts/seed-test-account.js --write            # the rest; already-copied offers are skipped
```

## Local dev

- `aio app run` — local dev server; actions still deployed to Runtime.
- `aio app dev` — actions run locally; logs stream to the terminal.
- Direct invocation (deployed):
  ```bash
  aio runtime action invoke gmc-feed-sync/sync-products \
    --param env test --param-file ./sample-chunk.json --result
  ```
- Bootstrap:
  ```bash
  aio runtime action invoke gmc-feed-sync/bootstrap-datasource \
    --param env test --result
  ```
- Production diagnostics:
  ```bash
  aio runtime action invoke gmc-feed-sync/diagnostics \
    --param env prod --result
  ```
- Logs: `aio app logs --limit 20`, `aio runtime activation list`.

Deploys and pushes are performed by the repo owner — not by this tooling.

## Testing

- **Unit tests (no network):**
  ```bash
  npm test
  ```
  Covers `toMicros`, `mapProduct`, `validate`, `parseGoogleError`, `redact`,
  `runPool`, `insertWithRetry`, `resolveAccount/DataSource`, the
  `sync-products` action's guards + happy path (Google clients mocked), and
  the price sync: Zazzle client, mapping (including a Merchant API proto
  round-trip), Database store, and full passes against fakes.
- **Integration tests (real Merchant API, test account only):** gated on
  `GMC_RUN_INTEGRATION=1`; see [`test/integration/README.md`](./test/integration/README.md).
  Skipped under `npm test`. Never point them at prod.

## Security posture (handoff §15)

- Secrets are read from action `params`, **never** `process.env` (handoff §7).
  Adobe I/O encrypts default params.
- Every log line goes through [`redact.js`](./actions/lib/redact.js) — GMC
  client secret, refresh token, service-account JSON, Slack webhook, and the
  Authorization header are replaced with `<hidden>`.
- All web actions are `require-adobe-auth: true` + `final: true`. Consider
  `disable-download: true` on production actions once stable (one-way).
- Bearer tokens are extracted from the request header and validated with IMS.
  Invalid tokens return `401`; an IMS outage fails closed with `503`.
- `admin-api` (the admin app's backend) is `require-adobe-auth: false` +
  `final: true` and checks callers itself: the user's IMS token must return
  a profile from IMS (`401` otherwise), viewing needs an `@adobe.com` email
  (`403` otherwise) and changes need an email in `PRICE_SYNC_EDITORS`. If IMS
  can't be reached it fails closed with `502`. Settings changes and Run now
  are logged with the editor's email.
- Incoming rows are allowlist-validated in [`validate.js`](./actions/lib/validate.js).
  Chunks are capped at 100 products, sized against measured per-chunk latency
  to stay well under the 60s blocking web-action timeout (payload size isn't
  the binding constraint at this scale — 100 rows is nowhere near Adobe I/O
  Runtime's 1MB limit).
- Outbound calls are HTTPS-only. `rejectUnauthorized: false` is banned.
- `.env`, `.aio`, `console.json`, `*service-account*.json`, `credentials.json`,
  `*.pem` are all gitignored.

## Layout

```
actions/
  sync-products/index.js
  diagnostics/index.js
  bootstrap-datasource/index.js
  price-sync/index.js               # daily Zazzle → GMC price pass
  price-sync-scheduler/index.js     # 15-minute tick: starts/resumes price-sync per the admin settings
  admin-api/index.js                # web backend for the admin app
  utils.js                          # scaffold helpers (errorResponse, checkMissingRequestInputs, ...)
  lib/
    auth.js                         # validates service-account JSON and constructs GoogleAuth
    gmcClients.js                   # constructs v1 clients from auth
    config.js                       # env → account/data source resolution
    mapProduct.js                   # export row → v1 productInput (price → integer micros)
    validate.js                     # allowlist validation for incoming rows
    concurrency.js                  # bounded worker pool
    insertWithRetry.js              # single insert + retry-once on 5xx/429
    googleError.js                  # gax/gRPC + REST → { code, status, reason, retriable }
    diagnostics.js                  # data-source ownership + MCQL product diagnostics
    imsAuth.js                      # validates incoming bearer tokens with Adobe IMS
    slack.js                        # digest POST to webhook (HTTPS-only)
    redact.js                       # log-safe stringifier
    zazzleBulkPricing.js            # getbulkpricing client (validation, retry same `after`)
    priceMapping.js                 # Zazzle product → price state, diffing, patch requests
    priceStore.js                   # App Builder Database store (last-sent records, runs, lock)
    priceSync.js                    # pass orchestration: resume, writes, deletes, digest
    priceSyncSettings.js            # admin settings: defaults, validation, Pacific-time schedule
    priceSyncScheduler.js           # scheduler tick: claim due slot, resume cut-short passes
    adminApi.js / adminAuth.js      # admin app operations and IMS-profile access check
    runtimeInvoke.js                # non-blocking action invoke via the Runtime REST API
    googleWrites.js                 # productInputs.patch/delete with backoff
config/
  defaults.json                     # brand, availability, condition, currency, feedLabel, contentLanguage, pdpBaseUrl (TODO)
  category-map.json                 # product_type → googleProductCategory (empty by default)
web-src/                          # admin app (React Spectrum): Runs + Settings tabs
test/
  unit/                             # 100 tests; no network
  integration/                      # env-gated, test account only
```

## Open items (handoff §20)

Answered (wired into the code):

- ~~**§20 Q1** — Auth type~~ → service account
  `express-tools-gcp-account@adbe-gcp1060.iam.gserviceaccount.com` in project
  `adbe-gcp1060`; the JSON signing key still must be supplied as a secret.
- ~~**§20 Q2** — PDP canonical URL~~ → DA tool supplies a full `link`
  column; service validates against `pdpAllowedHosts` (adobe.com,
  aem.live preview).
- ~~**§20 Q3** — Price source~~ → DA tool will fetch price from Zazzle and
  add a `price` column to its export.
- ~~**§20 Q5** — Brand~~ → static `"Adobe Express"` for all products.
- ~~**§20 Q6** — Identifiers~~ → Zazzle URNs are not GTIN/MPN; the mapper
  sends `identifierExists: false` universally.

Still open (unblocks prod, no code work required yet):

- **§20 Q4** — Populate [`config/category-map.json`](./config/category-map.json)
  when a `product_type` → `googleProductCategory` mapping arrives. Keys
  are raw Zazzle strings (e.g. `zazzle_hoodie`).
- **§20 Q7** — Confirm a GMC test account exists (owner is checking).
- **§20 Q8** — Create the GCP project and complete `developerRegistration.registerGcp`
  against the Merchant Center account.
- **§20 Q9** — Stage/Prod workspace mapping (assumed: Stage → GMC test
  account, Prod → GMC prod account).
