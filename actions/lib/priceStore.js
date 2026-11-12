// Persistence for the daily price sync, on App Builder Database Storage
// (aio-lib-db). Two collections:
//   price_sync_offers — one doc per offerId: what this job last sent Google
//     and when (for diffing and the 30-day refresh), plus when it was last
//     returned by Zazzle (for deletes) and failure tracking (for alerts).
//   price_sync_runs — one doc per pass: status, resume cursor, counters.
// A third, price_sync_locks, holds a single lock doc so two invocations never
// run a pass concurrently. The admin app adds price_sync_settings (one doc),
// price_sync_settings_history (who changed what) and price_sync_slots (one
// doc per scheduled or manual run request, so each is started only once).
// MemoryPriceStore implements the same interface for tests and local dry runs.

const crypto = require('crypto')

const OFFERS = 'price_sync_offers'
const RUNS = 'price_sync_runs'
const LOCKS = 'price_sync_locks'
const SETTINGS = 'price_sync_settings'
const SETTINGS_HISTORY = 'price_sync_settings_history'
const SLOTS = 'price_sync_slots'
const LOCK_ID = 'price-sync'
const SETTINGS_ID = 'current'
const DAY_MS = 24 * 3600 * 1000

// List views leave out the bulky parts of a run doc (the delete list can hold
// thousands of ids) to keep admin responses small.
const RUN_LIST_EXCLUDE = ['cursor', 'holder', 'samples', 'deletes.offerIds', 'deletes.sample', 'health.repeatFailures']
const RUN_DETAIL_EXCLUDE = ['cursor', 'holder', 'deletes.offerIds']

// Offer exports for the admin app, paged by _id.
const OFFER_VIEWS = {
  notInGmc: {
    filter: () => ({ notInGmc: true }),
    match: () => d => d.notInGmc === true,
    fields: ['templateId', 'notInGmcSince', 'notFoundAt', 'lastSeenAt']
  },
  failing: {
    filter: () => ({ failCount: { $gte: 1 } }),
    match: () => d => (d.failCount || 0) >= 1,
    fields: ['templateId', 'failCount', 'lastError', 'lastFailedAt']
  },
  atRisk: {
    filter: ({ now, days }) => ({ sentAt: { $ne: null, $lt: new Date(now.getTime() - days * DAY_MS) } }),
    match: ({ now, days }) => d => d.sentAt != null && new Date(d.sentAt) < new Date(now.getTime() - days * DAY_MS),
    fields: ['templateId', 'sentAt', 'lastSeenAt']
  }
}

const exclusion = paths => Object.fromEntries(paths.map(p => [p, 0]))

function omitPaths (doc, paths) {
  const out = structuredClone(doc)
  for (const p of paths) {
    const keys = p.split('.')
    const parent = keys.slice(0, -1).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), out)
    if (parent && typeof parent === 'object') delete parent[keys[keys.length - 1]]
  }
  return out
}

const SETTINGS_META = ['_id', 'version', 'updatedAt', 'updatedBy']

function settingsFields (doc) {
  return doc ? Object.fromEntries(Object.entries(doc).filter(([k]) => !SETTINGS_META.includes(k))) : null
}

const historyId = at => `${new Date(at).toISOString()}-${crypto.randomBytes(3).toString('hex')}`

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

// App Builder Database answers a duplicate insert with HTTP 409 / E11000.
function isDuplicateKeyError (e) {
  return e?.httpStatusCode === 409 || /E11000/.test(String(e?.message))
}

const UNSEEN_MANAGED = runId => ({ sentAt: { $ne: null }, lastSeenRunId: { $ne: runId } })

class DbPriceStore {
  constructor (client) {
    this.client = client
    this.offers = client.collection(OFFERS)
    this.runs = client.collection(RUNS)
    this.locks = client.collection(LOCKS)
    this.settings = client.collection(SETTINGS)
    this.settingsHistory = client.collection(SETTINGS_HISTORY)
    this.slots = client.collection(SLOTS)
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

  // Decided from write results only: reads can briefly lag writes, and
  // findOne throws when the document isn't visible yet. A successful insert
  // of the fixed _id creates the lock; on a duplicate, an expired lock is
  // taken over atomically (matchedCount 1). The read at the end only reports
  // who holds it.
  async acquireLock (holder, now, ttlMs) {
    const heldUntil = new Date(now.getTime() + ttlMs)
    try {
      await this.locks.insertOne({ _id: LOCK_ID, holder, heldUntil })
      return { acquired: true }
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e
    }
    const res = await this.locks.updateOne({ _id: LOCK_ID, heldUntil: { $lt: now } }, { $set: { holder, heldUntil } })
    if (res?.matchedCount === 1) return { acquired: true, tookOver: true }
    const [current] = await this.locks.find({ _id: LOCK_ID }).toArray()
    return { acquired: false, holder: current?.holder ?? null, heldUntil: current?.heldUntil ?? null }
  }

  async refreshLock (holder, now, ttlMs) {
    await this.locks.updateOne({ _id: LOCK_ID, holder }, { $set: { heldUntil: new Date(now.getTime() + ttlMs) } })
  }

  async releaseLock (holder) {
    await this.locks.deleteOne({ _id: LOCK_ID, holder })
  }

  async getLock () {
    const [lock] = await this.locks.find({ _id: LOCK_ID }).toArray()
    return lock || null
  }

  // One run per slot: the insert of the slot's _id is the claim.
  async claimSlot (slotId, info) {
    try {
      await this.slots.insertOne({ _id: slotId, ...info })
      return true
    } catch (e) {
      if (isDuplicateKeyError(e)) return false
      throw e
    }
  }

  async releaseSlot (slotId) {
    await this.slots.deleteOne({ _id: slotId })
  }

  async getSlot (slotId) {
    const [slot] = await this.slots.find({ _id: slotId }).toArray()
    return slot || null
  }

  // Atomic: only one caller moves a slot from `attempts` to `attempts + 1`.
  async retrySlot (slotId, attempts, now) {
    const res = await this.slots.updateOne({ _id: slotId, attempts }, { $set: { lastInvokedAt: now }, $inc: { attempts: 1 } })
    return res?.matchedCount === 1
  }

  async hasRunForSlot (slot) {
    const runs = await this.runs.find({ slot }, { projection: { _id: 1 }, limit: 1 }).toArray()
    return runs.length > 0
  }

  async getSettingsDoc () {
    const [doc] = await this.settings.find({ _id: SETTINGS_ID }).toArray()
    return doc || null
  }

  // Optimistic concurrency: the save only lands if nobody saved since the
  // editor loaded `expectedVersion` (0 = never saved).
  async saveSettings (value, { by, at, expectedVersion }) {
    const before = settingsFields(await this.getSettingsDoc())
    const version = expectedVersion + 1
    const doc = { ...value, version, updatedAt: at, updatedBy: by }
    if (expectedVersion === 0) {
      try {
        await this.settings.insertOne({ _id: SETTINGS_ID, ...doc })
      } catch (e) {
        if (isDuplicateKeyError(e)) return { conflict: true }
        throw e
      }
    } else {
      const res = await this.settings.updateOne({ _id: SETTINGS_ID, version: expectedVersion }, { $set: doc })
      if (res?.matchedCount !== 1) return { conflict: true }
    }
    await this.settingsHistory.insertOne({ _id: historyId(at), at, by, version, before, after: value })
    return { ok: true, version }
  }

  async listSettingsHistory (limit) {
    return this.settingsHistory.find({}, { sort: { at: -1 }, limit }).toArray()
  }

  async listRuns ({ limit, before }) {
    const filter = before ? { startedAt: { $lt: new Date(before) } } : {}
    return this.runs.find(filter, { sort: { startedAt: -1 }, limit, projection: exclusion(RUN_LIST_EXCLUDE) }).toArray()
  }

  async getRun (runId) {
    const [run] = await this.runs.find({ _id: runId }, { projection: exclusion(RUN_DETAIL_EXCLUDE) }).toArray()
    return run || null
  }

  async getDeleteCandidates (runId) {
    const [run] = await this.runs.find({ _id: runId }, { projection: { 'deletes.offerIds': 1 } }).toArray()
    return run ? run.deletes?.offerIds || [] : null
  }

  async listOffers (view, { after, limit, now, days }) {
    const v = OFFER_VIEWS[view]
    const base = v.filter({ now, days })
    const filter = after ? { ...base, _id: { $gt: after } } : base
    const projection = Object.fromEntries(v.fields.map(f => [f, 1]))
    const [docs, total] = await Promise.all([
      this.offers.find(filter, { sort: { _id: 1 }, limit, projection }).toArray(),
      after ? Promise.resolve(null) : this.offers.countDocuments(base)
    ])
    return { total, offers: docs.map(d => ({ offerId: d._id, ...Object.fromEntries(v.fields.map(f => [f, d[f] ?? null])) })) }
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
    if (!this.lock || this.lock.heldUntil < now) {
      const tookOver = !!this.lock
      this.lock = { holder, heldUntil: new Date(now.getTime() + ttlMs) }
      return tookOver ? { acquired: true, tookOver } : { acquired: true }
    }
    return { acquired: false, holder: this.lock.holder, heldUntil: this.lock.heldUntil }
  }

  async refreshLock (holder, now, ttlMs) {
    if (this.lock?.holder === holder) this.lock.heldUntil = new Date(now.getTime() + ttlMs)
  }

  async releaseLock (holder) {
    if (this.lock?.holder === holder) this.lock = null
  }

  async getLock () {
    return this.lock ? { _id: LOCK_ID, ...structuredClone(this.lock) } : null
  }

  async claimSlot (slotId, info) {
    this.slotClaims = this.slotClaims || new Map()
    if (this.slotClaims.has(slotId)) return false
    this.slotClaims.set(slotId, { _id: slotId, ...structuredClone(info) })
    return true
  }

  async releaseSlot (slotId) {
    this.slotClaims?.delete(slotId)
  }

  async getSlot (slotId) {
    const slot = this.slotClaims?.get(slotId)
    return slot ? structuredClone(slot) : null
  }

  async retrySlot (slotId, attempts, now) {
    const slot = this.slotClaims?.get(slotId)
    if (!slot || slot.attempts !== attempts) return false
    slot.attempts++
    slot.lastInvokedAt = now
    return true
  }

  async hasRunForSlot (slot) {
    return [...this.runs.values()].some(r => r.slot === slot)
  }

  async getSettingsDoc () {
    return this.settingsDoc ? structuredClone(this.settingsDoc) : null
  }

  async saveSettings (value, { by, at, expectedVersion }) {
    if ((this.settingsDoc?.version || 0) !== expectedVersion) return { conflict: true }
    const before = settingsFields(this.settingsDoc)
    const version = expectedVersion + 1
    this.settingsDoc = { _id: SETTINGS_ID, ...structuredClone(value), version, updatedAt: at, updatedBy: by }
    this.history = this.history || []
    this.history.push({ _id: historyId(at), at, by, version, before, after: structuredClone(value) })
    return { ok: true, version }
  }

  async listSettingsHistory (limit) {
    return [...(this.history || [])].sort((a, b) => b.at - a.at).slice(0, limit).map(h => structuredClone(h))
  }

  async listRuns ({ limit, before }) {
    return [...this.runs.values()]
      .filter(r => !before || new Date(r.startedAt) < new Date(before))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map(r => omitPaths(r, RUN_LIST_EXCLUDE))
  }

  async getRun (runId) {
    const run = this.runs.get(runId)
    return run ? omitPaths(run, RUN_DETAIL_EXCLUDE) : null
  }

  async getDeleteCandidates (runId) {
    const run = this.runs.get(runId)
    return run ? [...(run.deletes?.offerIds || [])] : null
  }

  async listOffers (view, { after, limit, now, days }) {
    const v = OFFER_VIEWS[view]
    const matching = [...this.offers.values()].filter(v.match({ now, days })).sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
    const page = matching.filter(d => !after || d._id > after).slice(0, limit)
    return {
      total: after ? null : matching.length,
      offers: page.map(d => ({ offerId: d._id, ...Object.fromEntries(v.fields.map(f => [f, d[f] ?? null])) }))
    }
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

module.exports = { DbPriceStore, MemoryPriceStore, openPriceStore, invalidatePriceRecords, offerUpdate, isDuplicateKeyError, OFFER_VIEWS, DB_REGION, OFFERS, RUNS, LOCKS, SETTINGS, SETTINGS_HISTORY, SLOTS }
