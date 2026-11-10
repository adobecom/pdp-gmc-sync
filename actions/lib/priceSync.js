// Daily price sync: one pass over Zazzle's getbulkpricing, writing changed
// (or refresh-due) price state to Google Merchant Center with
// productInputs.patch, then — only after a complete pass — handling offers
// Zazzle no longer returns. Follows Zazzle's integration guide:
//   * retry the same `after` on errors; if a call keeps failing, stop and
//     delete nothing (the run is saved as 'aborted' and can resume later);
//   * a pass is complete when every call succeeded, every skippedCount was 0,
//     and returned + excluded products add up to the first call's totalCount;
//   * skip deletes if totalCount fell more than 5% since the last complete pass;
//   * one write per product per day.
// Every page's outcome is persisted before moving on, so a crash or timeout
// resumes from the saved cursor instead of starting over.

const crypto = require('crypto')
const { runPool } = require('./concurrency')
const { normalizeProduct, applyShippingRule, fingerprint, decideWrite, buildPatchRequest, buildDeleteRequest, DAY_MS } = require('./priceMapping')
const { patchPrices, deleteOffer } = require('./googleWrites')

const DEFAULTS = Object.freeze({
  mode: 'dry-run',
  deletes: 'report',
  shipping: 'ignore',
  concurrency: 10,
  refreshAfterDays: 20,
  refreshJitterDays: 6,
  runWindowHours: 20,
  maxResumes: 3,
  lockTtlMs: 30 * 60 * 1000,
  deadlineSafetyMs: 10 * 60 * 1000,
  maxTotalCountDropPct: 5,
  maxDeleteFractionPct: 5,
  deleteListLimit: 5000,
  repeatFailureThreshold: 3,
  expiryRiskDays: 27,
  notFoundRetryDays: 7,
  abortAfterFailedPages: 3,
  sampleLimit: 20
})

function newCounters () {
  return {
    pages: 0,
    zazzleAttempts: 0,
    returned: 0,
    excluded: 0,
    skippedByZazzle: 0,
    duplicates: 0,
    invalid: 0,
    warnings: 0,
    discontinued: 0,
    unchanged: 0,
    due: { new: 0, changed: 0, refresh: 0 },
    cappedByMaxWrites: 0,
    written: 0,
    notFound: 0,
    notInGmcSkipped: 0,
    failed: 0,
    deleted: 0,
    deleteFailed: 0
  }
}

function newSamples () {
  return { failed: [], notFound: [], invalid: [], warnings: [] }
}

function pushSample (list, item, limit) {
  if (list.length < limit) list.push(item)
}

function newRunId (now) {
  return `${now.toISOString()}-${crypto.randomBytes(3).toString('hex')}`
}

function cfg (opts) {
  return { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts || {}).filter(([, v]) => v !== undefined)) }
}

async function startOrResume (store, holder, now, o) {
  const latest = await store.getLatestRun()
  const withinWindow = latest && now.getTime() - new Date(latest.startedAt).getTime() < o.runWindowHours * 3600 * 1000
  if (withinWindow && !o.force) {
    if (latest.status === 'complete' || latest.status === 'incomplete') {
      return { skip: { reason: 'already-ran', runId: latest._id, status: latest.status } }
    }
    // 'running' here means a crashed invocation: we hold the lock, so nobody
    // else is running it.
    if (['aborted', 'stopped', 'running'].includes(latest.status) && (latest.resumeCount || 0) < o.maxResumes) {
      const run = { ...latest, resumeCount: (latest.resumeCount || 0) + 1, status: 'running', heartbeatAt: now }
      await store.updateRun(run._id, { resumeCount: run.resumeCount, status: 'running', heartbeatAt: now, holder, abortReason: null })
      return { run, resumed: true }
    }
  }
  const run = {
    _id: newRunId(now),
    mode: 'live',
    gmcEnv: o.gmcEnv || null,
    status: 'running',
    holder,
    startedAt: now,
    heartbeatAt: now,
    finishedAt: null,
    cursor: '0',
    firstTotalCount: null,
    currency: null,
    resumeCount: 0,
    counters: newCounters(),
    samples: newSamples(),
    abortReason: null
  }
  await store.createRun(run)
  return { run, resumed: false }
}

function passCompleteness (run) {
  const c = run.counters
  const reasons = []
  if (c.skippedByZazzle !== 0) reasons.push(`skippedCount totalled ${c.skippedByZazzle}`)
  if (c.returned + c.excluded !== run.firstTotalCount) {
    reasons.push(`returned ${c.returned} + excluded ${c.excluded} != totalCount ${run.firstTotalCount}`)
  }
  return { complete: reasons.length === 0, reasons }
}

async function processPage (page, ctx) {
  const { o, run, store, now, live, seen } = ctx
  const c = run.counters
  const s = run.samples
  const normalized = page.products.map(p => normalizeProduct(p, { currency: page.currency, now: now(), shipping: o.shipping === 'send' }))
  const ids = [...new Set(normalized.map(n => n.offerId).filter(Boolean))]
  const records = await store.loadOffers(ids)

  const results = []
  const writes = []
  for (const n of normalized) {
    if (n.offerId && seen.has(n.offerId)) {
      c.duplicates++
      continue
    }
    if (n.offerId) seen.add(n.offerId)
    if (!n.ok) {
      c.invalid++
      pushSample(s.invalid, { templateId: n.templateId, reason: n.reason }, o.sampleLimit)
      if (n.offerId) results.push({ offerId: n.offerId, templateId: n.templateId, outcome: 'failed', error: n.reason })
      continue
    }
    if (n.warnings.length) {
      c.warnings++
      pushSample(s.warnings, { offerId: n.offerId, warnings: n.warnings }, o.sampleLimit)
    }
    if (n.state.discontinued) c.discontinued++

    const record = records.get(n.offerId)
    // An offer missing from the data source only gets there through the DA
    // tool (whose sync-products drops our record), so recheck it weekly
    // rather than spending a NOT_FOUND call on it every day.
    if (record?.notInGmc && !o.retryNotFound && record.notFoundAt &&
        now().getTime() - new Date(record.notFoundAt).getTime() < o.notFoundRetryDays * DAY_MS) {
      c.notInGmcSkipped++
      results.push({ offerId: n.offerId, templateId: n.templateId, outcome: 'skipped' })
      continue
    }
    // Google asks for discontinued products to be removed. Until deletes are
    // enabled they are written OUT_OF_STOCK instead (Zazzle's `?doc=1` rule).
    if (n.state.discontinued && o.deletes === 'enabled') {
      if (record?.notInGmc) {
        c.unchanged++
        results.push({ offerId: n.offerId, templateId: n.templateId, outcome: 'unchanged' })
        continue
      }
      writes.push({ kind: 'delete', offerId: n.offerId, templateId: n.templateId, record })
      continue
    }
    const { state, writeShipping } = applyShippingRule(n.state, record)
    const decision = decideWrite(n.offerId, state, record, {
      now: now(),
      refreshAfterDays: o.refreshAfterDays,
      refreshJitterDays: o.refreshJitterDays
    })
    if (decision === 'unchanged') {
      c.unchanged++
      results.push({ offerId: n.offerId, templateId: n.templateId, outcome: 'unchanged' })
      continue
    }
    c.due[decision]++
    writes.push({ kind: 'patch', offerId: n.offerId, templateId: n.templateId, state, writeShipping, record })
  }

  let toRun = writes
  if (o.maxWrites != null) {
    const remaining = Math.max(0, o.maxWrites - ctx.writesThisInvocation)
    if (writes.length > remaining) {
      toRun = writes.slice(0, remaining)
      for (const w of writes.slice(remaining)) {
        c.cappedByMaxWrites++
        results.push({ offerId: w.offerId, templateId: w.templateId, outcome: 'skipped' })
      }
    }
  }
  ctx.writesThisInvocation += toRun.length

  let pageFailures = 0
  let fatal = null
  if (live && toRun.length) {
    const target = { accountId: o.accountId, dataSource: o.dataSource, contentLanguage: o.contentLanguage, feedLabel: o.feedLabel }
    const outcomes = await runPool(toRun, w => (w.kind === 'delete'
      ? deleteOffer(ctx.productInputs, buildDeleteRequest(w.offerId, target), w.offerId, ctx.retry)
      : patchPrices(ctx.productInputs, buildPatchRequest(w.offerId, w.state, target, { writeShipping: w.writeShipping }), w.offerId, ctx.retry)), o.concurrency)

    outcomes.forEach((r, i) => {
      const w = toRun[i]
      const base = { offerId: w.offerId, templateId: w.templateId }
      if (w.kind === 'delete') {
        if (r.ok) {
          c.deleted++
          // Keep a notInGmc tombstone so tomorrow's pass doesn't delete it again.
          results.push({ ...base, outcome: 'notFound', firstNotFound: true })
        } else {
          c.deleteFailed++
          pageFailures++
          pushSample(s.failed, { offerId: w.offerId, op: 'delete', status: r.status, message: r.message }, o.sampleLimit)
          results.push({ ...base, outcome: 'failed', error: `delete ${r.status}: ${r.message}` })
          if (r.fatal) fatal = r
        }
        return
      }
      if (r.ok) {
        c.written++
        results.push({ ...base, outcome: 'written', state: w.state, fingerprint: fingerprint(w.state) })
      } else if (r.notFound) {
        c.notFound++
        pushSample(s.notFound, w.offerId, o.sampleLimit)
        results.push({ ...base, outcome: 'notFound', firstNotFound: w.record?.notInGmc !== true })
      } else {
        c.failed++
        pageFailures++
        pushSample(s.failed, { offerId: w.offerId, op: 'patch', status: r.status, message: r.message }, o.sampleLimit)
        results.push({ ...base, outcome: 'failed', error: `${r.status}: ${r.message}` })
        if (r.fatal) fatal = r
      }
    })
  }

  if (live) await store.applyResults(run._id, now(), results)
  const allFailed = toRun.length >= 10 && pageFailures === toRun.length
  return { fatal, allFailed }
}

async function handleDeletes (ctx, completeness) {
  const { o, run, store, now, live } = ctx
  const report = { mode: o.deletes, blockedReason: null, candidates: 0, sample: [], deleted: 0, failed: 0 }
  if (!live) {
    report.blockedReason = 'not evaluated in dry-run'
    return report
  }
  if (!completeness.complete) {
    report.blockedReason = `incomplete pass: ${completeness.reasons.join('; ')}`
    return report
  }
  const unseen = await store.findUnseenManaged(run._id, o.deleteListLimit)
  report.candidates = unseen.total
  report.sample = unseen.offerIds.slice(0, o.sampleLimit)
  report.offerIds = unseen.offerIds
  if (!unseen.total) return report

  const last = await store.getLastCompleteRun()
  if (last?.firstTotalCount && run.firstTotalCount < last.firstTotalCount * (1 - o.maxTotalCountDropPct / 100)) {
    const drop = (100 * (last.firstTotalCount - run.firstTotalCount) / last.firstTotalCount).toFixed(1)
    report.blockedReason = `totalCount fell ${drop}% since the last complete pass (${last.firstTotalCount} -> ${run.firstTotalCount})`
    return report
  }
  if (unseen.total > run.firstTotalCount * (o.maxDeleteFractionPct / 100)) {
    report.blockedReason = `${unseen.total} candidates exceed ${o.maxDeleteFractionPct}% of totalCount ${run.firstTotalCount}`
    return report
  }
  if (o.deletes !== 'enabled') {
    report.blockedReason = 'deletes are in report mode (PRICE_SYNC_DELETES=report)'
    return report
  }

  const target = { accountId: o.accountId, dataSource: o.dataSource, contentLanguage: o.contentLanguage, feedLabel: o.feedLabel }
  const outcomes = await runPool(unseen.offerIds, id => deleteOffer(ctx.productInputs, buildDeleteRequest(id, target), id, ctx.retry), o.concurrency)
  const deletedIds = []
  outcomes.forEach(r => {
    if (r.ok) deletedIds.push(r.offerId)
    else {
      report.failed++
      pushSample(run.samples.failed, { offerId: r.offerId, op: 'delete', status: r.status, message: r.message }, o.sampleLimit)
    }
  })
  await store.applyResults(run._id, now(), deletedIds.map(offerId => ({ offerId, outcome: 'deleted' })))
  report.deleted = deletedIds.length
  run.counters.deleted += deletedIds.length
  run.counters.deleteFailed += report.failed
  return report
}

/**
 * Runs (or resumes) one pass.
 *
 * deps: { store, productInputs, fetchPage(after) => page, logger, now() => Date,
 *         deadlineMs (absolute epoch ms, optional), retry (googleWrites options) }
 * opts: see DEFAULTS, plus accountId, dataSource, contentLanguage, feedLabel,
 *       expectedCurrency, gmcEnv, force, maxPages, maxWrites.
 */
async function runPriceSync (deps, opts) {
  const o = cfg(opts)
  const now = deps.now || (() => new Date())
  const logger = deps.logger || console
  const live = o.mode === 'live'
  const startedMs = now().getTime()
  const holder = newRunId(now())

  if (live) {
    const acquired = await deps.store.acquireLock(holder, now(), o.lockTtlMs)
    if (!acquired) return { skipped: true, reason: 'locked', message: 'another price-sync invocation holds the lock' }
  }

  try {
    let run
    let resumed = false
    if (live) {
      const started = await startOrResume(deps.store, holder, now(), o)
      if (started.skip) return { skipped: true, ...started.skip }
      run = started.run
      resumed = started.resumed
    } else {
      run = { _id: `dry-run-${holder}`, cursor: '0', firstTotalCount: null, counters: newCounters(), samples: newSamples() }
    }

    const ctx = {
      o, run, live, now, logger,
      store: deps.store,
      productInputs: deps.productInputs,
      retry: deps.retry,
      seen: new Set(),
      writesThisInvocation: 0
    }

    let cursor = run.cursor
    let abortReason = null
    let stoppedReason = null
    let failedPagesInARow = 0
    let pagesThisInvocation = 0
    while (cursor != null) {
      if (deps.deadlineMs && now().getTime() > deps.deadlineMs - o.deadlineSafetyMs) {
        abortReason = 'action deadline reached; will resume'
        break
      }
      if (o.maxPages != null && pagesThisInvocation >= o.maxPages) {
        stoppedReason = `stopped after maxPages=${o.maxPages}`
        break
      }
      let page
      try {
        page = await deps.fetchPage(cursor)
      } catch (e) {
        run.counters.zazzleAttempts += e.attempts || 1
        abortReason = `zazzle after=${cursor}: ${e.message}${e.rateLimited ? ' (rate limited)' : ''}`
        break
      }
      pagesThisInvocation++
      run.counters.pages++
      run.counters.zazzleAttempts += page.attempts || 1
      if (run.firstTotalCount == null) run.firstTotalCount = page.totalCount
      if (run.currency == null) run.currency = page.currency
      if (page.currency !== (o.expectedCurrency || 'USD')) {
        abortReason = `unexpected currency ${page.currency} (expected ${o.expectedCurrency || 'USD'})`
        break
      }
      run.counters.returned += page.products.length
      run.counters.excluded += page.excludedCount
      run.counters.skippedByZazzle += page.skippedCount

      const { fatal, allFailed } = await processPage(page, ctx)
      cursor = page.nextAfter
      run.cursor = cursor
      if (live) {
        await deps.store.updateRun(run._id, {
          cursor, counters: run.counters, samples: run.samples,
          firstTotalCount: run.firstTotalCount, currency: run.currency, heartbeatAt: now()
        })
        await deps.store.refreshLock(holder, now(), o.lockTtlMs)
      }
      if (fatal) {
        abortReason = `Google ${fatal.status}: ${fatal.message}`
        break
      }
      failedPagesInARow = allFailed ? failedPagesInARow + 1 : 0
      if (failedPagesInARow >= o.abortAfterFailedPages) {
        abortReason = `every write failed on ${failedPagesInARow} pages in a row`
        break
      }
    }

    const unfinishedReason = abortReason || stoppedReason
    const finishedPass = cursor == null && !unfinishedReason
    const completeness = finishedPass ? passCompleteness(run) : { complete: false, reasons: [unfinishedReason] }
    const deletes = finishedPass ? await handleDeletes(ctx, completeness) : { mode: o.deletes, blockedReason: `pass not finished: ${unfinishedReason}`, candidates: 0, sample: [] }

    let health = null
    if (live) {
      health = {
        ...await deps.store.health({
          sentBefore: new Date(now().getTime() - o.expiryRiskDays * DAY_MS),
          minFailCount: o.repeatFailureThreshold,
          limit: o.sampleLimit
        }),
        repeatFailureThreshold: o.repeatFailureThreshold,
        expiryRiskDays: o.expiryRiskDays
      }
    }

    const status = abortReason ? 'aborted' : stoppedReason ? 'stopped' : completeness.complete ? 'complete' : 'incomplete'
    if (live) {
      const { offerIds: deleteOfferIds, ...deleteSummary } = deletes
      await deps.store.updateRun(run._id, {
        status,
        abortReason: unfinishedReason,
        finishedAt: finishedPass ? now() : null,
        counters: run.counters,
        samples: run.samples,
        completeness,
        deletes: { ...deleteSummary, offerIds: deleteOfferIds || [] },
        health,
        heartbeatAt: now()
      })
    }

    const { offerIds: deleteOfferIds, ...deleteSummary } = deletes
    return {
      runId: run._id,
      mode: o.mode,
      status,
      resumed,
      abortReason: unfinishedReason,
      durationMs: now().getTime() - startedMs,
      pass: {
        totalCount: run.firstTotalCount,
        currency: run.currency,
        complete: completeness.complete,
        incompleteReasons: completeness.reasons
      },
      counters: run.counters,
      samples: run.samples,
      deletes: deleteSummary,
      deleteOfferIds: deleteOfferIds || [],
      health
    }
  } finally {
    if (live) {
      try {
        await deps.store.releaseLock(holder)
      } catch (e) {
        logger.error?.(`price-sync: releaseLock failed: ${e.message}`)
      }
    }
  }
}

function alertsFor (summary) {
  if (summary.skipped) return []
  const alerts = []
  if (summary.status === 'aborted') alerts.push(`Pass aborted: ${summary.abortReason}`)
  if (summary.status === 'incomplete') alerts.push(`Pass incomplete, no deletes: ${summary.pass.incompleteReasons.join('; ')}`)
  const c = summary.counters
  if (c.failed || c.deleteFailed) alerts.push(`${c.failed} patch(es) and ${c.deleteFailed} delete(s) failed`)
  const d = summary.deletes
  if (d.blockedReason && /totalCount fell|exceed/.test(d.blockedReason)) alerts.push(`Deletes blocked: ${d.blockedReason}`)
  const h = summary.health
  if (h?.repeatFailureCount) alerts.push(`${h.repeatFailureCount} offer(s) failed on ${h.repeatFailureThreshold}+ consecutive runs`)
  if (h?.atRisk) alerts.push(`${h.atRisk} offer(s) not written for ${h.expiryRiskDays}+ days (Google expires them at 30)`)
  return alerts
}

function formatPriceSyncDigest (summary, { env } = {}) {
  if (summary.skipped) return `*GMC price sync* — env: \`${env}\` — skipped (${summary.reason})`
  const c = summary.counters
  const minutes = (summary.durationMs / 60000).toFixed(1)
  const lines = [
    `*GMC price sync* — env: \`${env}\` — mode: \`${summary.mode}\` — status: *${summary.status}*${summary.resumed ? ' (resumed)' : ''} — ${minutes} min`,
    `Zazzle: ${c.returned} products on ${c.pages} pages (totalCount ${summary.pass.totalCount}, excluded ${c.excluded}, skipped ${c.skippedByZazzle}, invalid ${c.invalid})`,
    `Due: ${c.due.new} new, ${c.due.changed} changed, ${c.due.refresh} refresh — unchanged ${c.unchanged}${c.cappedByMaxWrites ? ` — capped ${c.cappedByMaxWrites}` : ''}`,
    `Google: ${c.written} written, ${c.notFound} not in data source${c.notInGmcSkipped ? ` (+${c.notInGmcSkipped} known missing, rechecked weekly)` : ''}, ${c.failed} failed, ${c.deleted} deleted`,
    `Deletes (${summary.deletes.mode}): ${summary.deletes.candidates} candidate(s)${summary.deletes.blockedReason ? ` — ${summary.deletes.blockedReason}` : ''}`
  ]
  const alerts = alertsFor(summary)
  if (alerts.length) {
    lines.push('*Alerts:*')
    for (const a of alerts) lines.push(`• ${a}`)
  }
  return lines.join('\n')
}

module.exports = { runPriceSync, formatPriceSyncDigest, alertsFor, passCompleteness, DEFAULTS }
