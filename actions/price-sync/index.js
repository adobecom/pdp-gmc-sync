// Scheduled daily (see the price-sync-daily trigger in app.config.yaml) and
// invokable by namespace holders for testing:
//   aio rt action invoke gmc-feed-sync/price-sync -p dryRun true -p maxPages 2
// Deploy-time inputs (final, not overridable per invocation):
//   PRICE_SYNC_MODE     off (default) | dry-run | live
//   PRICE_SYNC_DELETES  report (default) | enabled
//   PRICE_SYNC_SHIPPING ignore (default) | send — write Zazzle's per-offer shipping
// Invocation params: dryRun, force, maxPages, maxWrites, concurrency, retryNotFound.

const { Core } = require('@adobe/aio-sdk')
const { makeClients } = require('../lib/gmcClients')
const { resolveAccount, resolveDataSource } = require('../lib/config')
const { fetchBulkPricingPage, DEFAULT_URL } = require('../lib/zazzleBulkPricing')
const { openPriceStore, MemoryPriceStore } = require('../lib/priceStore')
const { runPriceSync, formatPriceSyncDigest, alertsFor } = require('../lib/priceSync')
const { redact } = require('../lib/redact')
const { errorResponse } = require('../utils')
const defaults = require('../../config/defaults.json')

const MODES = new Set(['off', 'dry-run', 'live'])
const DELETE_LIST_LOG_CHUNK = 500

function isTrue (v) {
  return v === true || String(v).trim().toLowerCase() === 'true'
}

function resolveMode (params) {
  const configured = String(params.PRICE_SYNC_MODE || 'off').trim().toLowerCase()
  if (!MODES.has(configured)) throw new Error(`PRICE_SYNC_MODE must be off, dry-run or live, got ${JSON.stringify(params.PRICE_SYNC_MODE)}`)
  if (configured === 'live' && isTrue(params.dryRun)) return 'dry-run'
  return configured
}

function intParam (value, min, max) {
  if (value == null || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`expected an integer between ${min} and ${max}, got ${JSON.stringify(value)}`)
  return n
}

// Every invocation logs one PRICE_SYNC_RESULT line and one PRICE_SYNC_ALERT
// line per problem, for Splunk searches and email alerts (see README). Values
// are single tokens with no spaces or quotes, so plain text searches such as
// "status=complete" and rex extractions work however the log forwarder wraps
// the line.
function resultLine (env, fields) {
  const pairs = Object.entries({ env, ...fields })
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v).replace(/[\s"\\]+/g, '_')}`)
  return `PRICE_SYNC_RESULT ${pairs.join(' ')}`
}

function alertLine (env, runId, message) {
  return `PRICE_SYNC_ALERT env=${env} run=${runId || 'none'} :: ${message}`
}

function summaryFields (summary) {
  if (summary.skipped) return { status: 'skipped', reason: summary.reason, run: summary.runId }
  const c = summary.counters
  return {
    status: summary.status,
    mode: summary.mode,
    run: summary.runId,
    resumed: summary.resumed ? 'yes' : 'no',
    durationMin: (summary.durationMs / 60000).toFixed(1),
    total: summary.pass.totalCount,
    returned: c.returned,
    new: c.due.new,
    changed: c.due.changed,
    refresh: c.due.refresh,
    unchanged: c.unchanged,
    written: c.written,
    notFound: c.notFound,
    knownMissing: c.notInGmcSkipped,
    failed: c.failed,
    deleted: c.deleted,
    deleteCandidates: summary.deletes.candidates,
    atRisk: summary.health?.atRisk,
    repeatFailures: summary.health?.repeatFailureCount,
    alerts: alertsFor(summary).length
  }
}

function logSummary (env, summary, logger) {
  logger.info(resultLine(env, summaryFields(summary)))
  for (const a of alertsFor(summary)) logger.warn(alertLine(env, summary.runId, a))
}

function logFailure (params, message, logger) {
  logger.error(resultLine(params.GMC_ENV, { status: 'failed', alerts: 1 }))
  logger.error(alertLine(params.GMC_ENV, null, `price-sync failed: ${message}`))
}

function logDeleteList (summary, logger) {
  const ids = summary.deleteOfferIds || []
  for (let i = 0; i < ids.length; i += DELETE_LIST_LOG_CHUNK) {
    logger.info(`price-sync delete candidates [${i + 1}-${Math.min(i + DELETE_LIST_LOG_CHUNK, ids.length)} of ${summary.deletes.candidates}]: ${ids.slice(i, i + DELETE_LIST_LOG_CHUNK).join(',')}`)
  }
}

async function main (params) {
  const logger = Core.Logger('price-sync', { level: params.LOG_LEVEL || 'info' })
  logger.debug(redact(params))

  let mode, maxPages, maxWrites, concurrency
  try {
    mode = resolveMode(params)
    maxPages = intParam(params.maxPages, 1, 100000)
    maxWrites = intParam(params.maxWrites, 0, 10000000)
    concurrency = intParam(params.concurrency, 1, 50)
  } catch (e) {
    return errorResponse(400, e.message, logger)
  }
  if (mode === 'off') {
    logger.info('price-sync: PRICE_SYNC_MODE=off, nothing to do')
    return { statusCode: 200, body: { skipped: true, reason: 'PRICE_SYNC_MODE=off' } }
  }

  let accountId, dataSource, productInputs
  try {
    accountId = resolveAccount(params)
    dataSource = resolveDataSource(params, accountId)
    if (mode === 'live') ({ productInputs } = makeClients(params))
  } catch (e) {
    logger.error(`price-sync config/auth error: ${e.message}`)
    logFailure(params, 'server misconfigured (see activation logs)', logger)
    return errorResponse(500, 'server misconfigured — see logs', logger)
  }

  let store
  try {
    store = await openPriceStore(params)
  } catch (e) {
    if (mode === 'live') {
      logger.error(`price-sync: database unavailable: ${e.message}`)
      logFailure(params, `database unavailable: ${e.message}`, logger)
      return errorResponse(503, 'database unavailable — see logs', logger)
    }
    logger.warn(`price-sync: database unavailable (${e.message}); dry run treats every product as new`)
    store = new MemoryPriceStore()
  }

  const deadlineMs = Number(process.env.__OW_DEADLINE) || undefined
  try {
    const summary = await runPriceSync({
      store,
      productInputs,
      logger,
      deadlineMs,
      fetchPage: after => fetchBulkPricingPage(after, {
        baseUrl: params.ZAZZLE_BULK_PRICING_URL || DEFAULT_URL,
        query: { zcur: defaults.currency || 'USD', lang: defaults.contentLanguage || 'en', region: String(defaults.feedLabel || 'US').toLowerCase() },
        logger
      })
    }, {
      mode,
      deletes: params.PRICE_SYNC_DELETES === 'enabled' ? 'enabled' : 'report',
      shipping: params.PRICE_SYNC_SHIPPING === 'send' ? 'send' : 'ignore',
      gmcEnv: params.GMC_ENV,
      accountId,
      dataSource,
      contentLanguage: defaults.contentLanguage || 'en',
      feedLabel: defaults.feedLabel || 'US',
      expectedCurrency: defaults.currency || 'USD',
      force: isTrue(params.force),
      retryNotFound: isTrue(params.retryNotFound),
      maxPages,
      maxWrites,
      concurrency
    })

    logSummary(params.GMC_ENV, summary, logger)
    if (summary.skipped) return { statusCode: 200, body: summary }
    logger.info(formatPriceSyncDigest(summary, { env: params.GMC_ENV }))
    logDeleteList(summary, logger)
    return { statusCode: 200, body: summary }
  } catch (e) {
    logger.error(`price-sync failed: ${e.stack || e.message}`)
    logFailure(params, e.message, logger)
    return errorResponse(500, `price-sync failed: ${e.message}`, logger)
  } finally {
    try {
      await store.close()
    } catch (e) {
      logger.warn(`price-sync: closing the database failed: ${e.message}`)
    }
  }
}

module.exports = { main, resolveMode }
