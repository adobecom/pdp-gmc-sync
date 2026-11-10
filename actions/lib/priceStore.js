// Persistence for the daily price sync, on App Builder Database Storage
// (aio-lib-db). Two collections:
//   price_sync_offers — one doc per offerId: what this job last sent Google
//     and when (for diffing and the 30-day refresh), plus when it was last
//     returned by Zazzle (for deletes) and failure tracking (for alerts).
//   price_sync_runs — one doc per pass: status, resume cursor, counters.
// A third, price_sync_locks, holds a single lock doc so two invocations never
// run a pass concurrently. MemoryPriceStore implements the same interface for
// tests and local dry runs.

const OFFERS = 'price_sync_offers'
const RUNS = 'price_sync_runs'
const LOCKS = 'price_sync_locks'
const LOCK_ID = 'price-sync'

// Must match application.runtimeManifest.database.region in app.config.yaml.
const DB_REGION = 'amer'

function offerUpdate (runId, now, r) {
  const seen = { lastSeenRunId: runId, lastSeenAt: now }
  switch (r.outcome) {
    case 'written':
      return {
        filter: { _id: r.offerId },
        update: {
          $set: {
            ...seen,
            templateId: r.templateId,
            sent: { ...r.state, fingerprint: r.fingerprint },
            sentAt: now,
            failCount: 0,
            notInGmc: false
          },
          $unset: { lastError: '', lastFailedAt: '', notInGmcSince: '' }
        },
        upsert: true
      }
    case 'failed':
      return {
        filter: { _id: r.offerId },
        update: {
          $set: { ...seen, templateId: r.templateId, lastError: r.error, lastFailedAt: now },
          $inc: { failCount: 1 }
        },
        upsert: true
      }
    case 'notFound': {
      // Not in our data source: no longer something this job manages, so drop
      // `sent` (it can't become a delete candidate, and a later insert by the
      // DA tool makes it 'new' again).
      const set = { ...seen, templateId: r.templateId, notInGmc: true, notFoundAt: now, failCount: 0 }
      if (r.firstNotFound) set.notInGmcSince = now
      return {
        filter: { _id: r.offerId },
        update: { $set: set, $unset: { sent: '', sentAt: '', lastError: '', lastFailedAt: '' } },
        upsert: true
      }
    }
    case 'deleted':
      return null
    default:
      // 'unchanged' / 'skipped': only mark as seen, never create a doc.
      return { filter: { _id: r.offerId }, update: { $set: seen }, upsert: false }
  }
}

const UNSEEN_MANAGED = runId => ({ sentAt: { $ne: null }, lastSeenRunId: { $ne: runId } })

class DbPriceStore {
  constructor (client) {
    this.client = client
    this.offers = client.collection(OFFERS)
    this.runs = client.collection(RUNS)
    this.locks = client.collection(LOCKS)
  }

  async loadOffers (offerIds) {
    const map = new Map()
    if (!offerIds.length) return map
    const docs = await this.offers.find({ _id: { $in: offerIds } }).toArray()
    for (const d of docs) map.set(d._id, d)
    return map
  }

  async applyResults (runId, now, results) {
    const ops = []
    const deletedIds = []
    for (const r of results) {
      if (r.outcome === 'deleted') {
        deletedIds.push(r.offerId)
        continue
      }
      ops.push({ updateOne: offerUpdate(runId, now, r) })
    }
    if (ops.length) await this.offers.bulkWrite(ops, { ordered: false })
    if (deletedIds.length) await this.offers.deleteMany({ _id: { $in: deletedIds } })
  }

  async findUnseenManaged (runId, limit) {
    const filter = UNSEEN_MANAGED(runId)
    const [total, docs] = await Promise.all([
      this.offers.countDocuments(filter),
      this.offers.find(filter, { projection: { _id: 1 }, limit }).toArray()
    ])
    return { total, offerIds: docs.map(d => d._id) }
  }

  async removeOffers (offerIds) {
    if (offerIds.length) await this.offers.deleteMany({ _id: { $in: offerIds } })
  }

  async invalidateOffers (offerIds) {
    await this.removeOffers(offerIds)
  }

  async health ({ sentBefore, minFailCount, limit }) {
    const failFilter = { failCount: { $gte: minFailCount } }
    const [atRisk, notInGmc, repeatFailureCount, repeatFailures] = await Promise.all([
      this.offers.countDocuments({ sentAt: { $ne: null, $lt: sentBefore } }),
      this.offers.countDocuments({ notInGmc: true }),
      this.offers.countDocuments(failFilter),
      this.offers.find(failFilter, {
        projection: { _id: 1, failCount: 1, lastError: 1 },
        sort: { failCount: -1 },
        limit
      }).toArray()
    ])
    return {
      atRisk,
      notInGmc,
      repeatFailureCount,
      repeatFailures: repeatFailures.map(d => ({ offerId: d._id, failCount: d.failCount, lastError: d.lastError }))
    }
  }

  async getLatestRun () {
    const [run] = await this.runs.find({}, { sort: { startedAt: -1 }, limit: 1 }).toArray()
    return run || null
  }

  async getLastCompleteRun () {
    const [run] = await this.runs.find({ status: 'complete' }, { sort: { startedAt: -1 }, limit: 1 }).toArray()
    return run || null
  }

  async createRun (run) {
    await this.runs.insertOne(run)
  }

  async updateRun (runId, fields) {
    await this.runs.updateOne({ _id: runId }, { $set: fields })
  }

  // Insert the lock doc if absent, else take it over only if it has expired,
  // then read it back: whoever's id is stored holds the lock.
  async acquireLock (holder, now, ttlMs) {
    const heldUntil = new Date(now.getTime() + ttlMs)
    try {
      await this.locks.insertOne({ _id: LOCK_ID, holder, heldUntil })
    } catch {
      await this.locks.updateOne({ _id: LOCK_ID, heldUntil: { $lt: now } }, { $set: { holder, heldUntil } })
    }
    const doc = await this.locks.findOne({ _id: LOCK_ID })
    return doc?.holder === holder
  }

  async refreshLock (holder, now, ttlMs) {
    await this.locks.updateOne({ _id: LOCK_ID, holder }, { $set: { heldUntil: new Date(now.getTime() + ttlMs) } })
  }

  async releaseLock (holder) {
    await this.locks.deleteOne({ _id: LOCK_ID, holder })
  }

  async close () {
    await this.client.close()
  }
}

class MemoryPriceStore {
  constructor () {
    this.offers = new Map()
    this.runs = new Map()
    this.lock = null
  }

  async loadOffers (offerIds) {
    const map = new Map()
    for (const id of offerIds) if (this.offers.has(id)) map.set(id, structuredClone(this.offers.get(id)))
    return map
  }

  async applyResults (runId, now, results) {
    for (const r of results) {
      if (r.outcome === 'deleted') {
        this.offers.delete(r.offerId)
        continue
      }
      const { update, upsert } = offerUpdate(runId, now, r)
      const existing = this.offers.get(r.offerId)
      if (!existing && !upsert) continue
      const doc = existing || { _id: r.offerId }
      for (const k of Object.keys(update.$unset || {})) delete doc[k]
      Object.assign(doc, structuredClone(update.$set || {}))
      for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + v
      this.offers.set(r.offerId, doc)
    }
  }

  async findUnseenManaged (runId, limit) {
    const ids = [...this.offers.values()].filter(d => d.sentAt != null && d.lastSeenRunId !== runId).map(d => d._id)
    return { total: ids.length, offerIds: ids.slice(0, limit) }
  }

  async removeOffers (offerIds) {
    for (const id of offerIds) this.offers.delete(id)
  }

  async invalidateOffers (offerIds) {
    await this.removeOffers(offerIds)
  }

  async health ({ sentBefore, minFailCount, limit }) {
    const docs = [...this.offers.values()]
    const failing = docs.filter(d => (d.failCount || 0) >= minFailCount).sort((a, b) => b.failCount - a.failCount)
    return {
      atRisk: docs.filter(d => d.sentAt != null && d.sentAt < sentBefore).length,
      notInGmc: docs.filter(d => d.notInGmc === true).length,
      repeatFailureCount: failing.length,
      repeatFailures: failing.slice(0, limit).map(d => ({ offerId: d._id, failCount: d.failCount, lastError: d.lastError }))
    }
  }

  async getLatestRun () {
    const runs = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt)
    return runs[0] ? structuredClone(runs[0]) : null
  }

  async getLastCompleteRun () {
    const runs = [...this.runs.values()].filter(r => r.status === 'complete').sort((a, b) => b.startedAt - a.startedAt)
    return runs[0] ? structuredClone(runs[0]) : null
  }

  async createRun (run) {
    this.runs.set(run._id, structuredClone(run))
  }

  async updateRun (runId, fields) {
    Object.assign(this.runs.get(runId), structuredClone(fields))
  }

  async acquireLock (holder, now, ttlMs) {
    if (!this.lock || this.lock.heldUntil < now) this.lock = { holder, heldUntil: new Date(now.getTime() + ttlMs) }
    return this.lock.holder === holder
  }

  async refreshLock (holder, now, ttlMs) {
    if (this.lock?.holder === holder) this.lock.heldUntil = new Date(now.getTime() + ttlMs)
  }

  async releaseLock (holder) {
    if (this.lock?.holder === holder) this.lock = null
  }

  async close () {}
}

async function openPriceStore (params) {
  const { generateAccessToken } = require('@adobe/aio-sdk').Core.AuthClient
  const libDb = require('@adobe/aio-lib-db')
  const token = await generateAccessToken(params)
  const db = await libDb.init({ token: token.access_token, region: DB_REGION })
  const client = await db.connect()
  return new DbPriceStore(client)
}

// sync-products replaces whole product inputs (including price) in the same
// data source, so after it writes, our record of "what we last sent" is no
// longer true. Dropping the record makes the next price-sync pass treat the
// offer as new and rewrite its price fields. Best-effort: never throws, and
// skipped when the action isn't deployed with include-ims-credentials.
async function invalidatePriceRecords (params, offerIds, logger, { timeoutMs = 5000, open = openPriceStore } = {}) {
  if (!offerIds?.length || !params?.__ims_oauth_s2s) return { skipped: true }
  let timer
  const work = (async () => {
    const store = await open(params)
    try {
      await store.invalidateOffers(offerIds)
    } finally {
      await store.close().catch(() => {})
    }
  })()
  try {
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    await Promise.race([work, timeout])
    return { ok: true }
  } catch (e) {
    work.catch(() => {})
    logger?.error?.(`invalidatePriceRecords failed for ${offerIds.length} offer(s): ${e.message}`)
    return { ok: false, error: e.message }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { DbPriceStore, MemoryPriceStore, openPriceStore, invalidatePriceRecords, offerUpdate, DB_REGION, OFFERS, RUNS, LOCKS }
