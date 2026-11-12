// Operations behind the admin app (actions/admin-api). Every op is read-only
// except saveSettings and runNow, which need the editor role.

const { DEFAULTS } = require('./priceSync')
const { OFFER_VIEWS } = require('./priceStore')
const { effectiveSettings, validateSettings, deployMode, resolveDeletes, resolveShipping, nextRuns, TIME_ZONE } = require('./priceSyncSettings')
const { PRICE_SYNC_ACTION } = require('./priceSyncScheduler')

const MAX_RUNS = 50
const MAX_OFFERS = 2000
const STALE_MS = DEFAULTS.lockTtlMs + 5 * 60 * 1000

class AdminError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

function lockView (lock, now) {
  const held = !!lock && new Date(lock.heldUntil) > now
  return { held, heldUntil: held ? lock.heldUntil : null }
}

// A run left 'running' by an invocation that died shows as interrupted.
function displayStatus (run, lock, now) {
  if (run.status !== 'running') return run.status
  const quietFor = now - new Date(run.heartbeatAt || run.startedAt)
  return !lock.held && quietFor > STALE_MS ? 'interrupted' : 'running'
}

function runView (run, lock, now) {
  if (!run) return null
  const { _id: id, ...rest } = run
  const out = { id, ...rest, displayStatus: displayStatus(run, lock, now) }
  if (run.deletes) {
    out.deletes = { ...run.deletes }
    delete out.deletes.offerIds
  }
  return out
}

function intArg (v, def, min, max) {
  if (v == null || v === '') return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new AdminError(400, `expected a whole number from ${min} to ${max}`)
  return n
}

function requireEditor (user) {
  if (user.role !== 'editor') throw new AdminError(403, 'only editors can do this; ask an admin to add you to PRICE_SYNC_EDITORS')
}

const ops = {
  async overview ({ store, params, user, now }) {
    const [doc, lock, runs, lastComplete] = await Promise.all([
      store.getSettingsDoc(),
      store.getLock(),
      store.listRuns({ limit: 1 }),
      store.getLastCompleteRun()
    ])
    const eff = effectiveSettings(doc)
    const l = lockView(lock, now)
    const mode = deployMode(params)
    return {
      user,
      env: {
        gmcEnv: params.GMC_ENV || null,
        mode,
        deletesDefault: params.PRICE_SYNC_DELETES === 'enabled' ? 'enabled' : 'report',
        shippingDefault: params.PRICE_SYNC_SHIPPING === 'send' ? 'send' : 'ignore',
        timeZone: TIME_ZONE
      },
      settings: eff.settings,
      settingsMeta: { version: eff.version, updatedAt: eff.updatedAt, updatedBy: eff.updatedBy, problem: eff.problem },
      effective: { deletes: resolveDeletes(eff.settings, params), shipping: resolveShipping(eff.settings, params) },
      nextRuns: mode === 'off' ? [] : nextRuns(now, eff.settings),
      lock: l,
      latestRun: runView(runs[0], l, now),
      lastComplete: runView(lastComplete, l, now),
      limits: { expiryRiskDays: DEFAULTS.expiryRiskDays, repeatFailureThreshold: DEFAULTS.repeatFailureThreshold }
    }
  },

  async listRuns ({ store, args, now }) {
    const limit = intArg(args.limit, 25, 1, MAX_RUNS)
    const [runs, lock] = await Promise.all([store.listRuns({ limit, before: args.before || null }), store.getLock()])
    const l = lockView(lock, now)
    return { runs: runs.map(r => runView(r, l, now)), hasMore: runs.length === limit }
  },

  async getRun ({ store, args, now }) {
    if (!args.id) throw new AdminError(400, 'id is required')
    const [run, lock] = await Promise.all([store.getRun(String(args.id)), store.getLock()])
    if (!run) throw new AdminError(404, 'run not found')
    return { run: runView(run, lockView(lock, now), now) }
  },

  async deleteCandidates ({ store, args }) {
    if (!args.id) throw new AdminError(400, 'id is required')
    const offerIds = await store.getDeleteCandidates(String(args.id))
    if (!offerIds) throw new AdminError(404, 'run not found')
    return { offerIds }
  },

  async listOffers ({ store, args, now }) {
    if (!OFFER_VIEWS[args.view]) throw new AdminError(400, `view must be one of ${Object.keys(OFFER_VIEWS).join(', ')}`)
    const limit = intArg(args.limit, 500, 1, MAX_OFFERS)
    const page = await store.listOffers(args.view, { after: args.after || null, limit, now, days: DEFAULTS.expiryRiskDays })
    const last = page.offers[page.offers.length - 1]
    return { ...page, next: page.offers.length === limit ? last.offerId : null }
  },

  async settingsHistory ({ store, args }) {
    const limit = intArg(args.limit, 20, 1, 100)
    return { history: await store.listSettingsHistory(limit) }
  },

  async saveSettings ({ store, args, user, now }) {
    requireEditor(user)
    const { ok, value, errors } = validateSettings(args.settings)
    if (!ok) throw Object.assign(new AdminError(400, 'some settings are invalid'), { details: errors })
    const expectedVersion = intArg(args.expectedVersion, null, 0, Number.MAX_SAFE_INTEGER)
    if (expectedVersion == null) throw new AdminError(400, 'expectedVersion is required')
    const res = await store.saveSettings(value, { by: user.email, at: now, expectedVersion })
    if (res.conflict) throw new AdminError(409, 'someone else saved settings since you loaded them; reload and try again')
    return { settings: value, version: res.version }
  },

  async runNow ({ store, params, user, now, invoke }) {
    requireEditor(user)
    if (deployMode(params) === 'off') throw new AdminError(409, 'price sync is turned off for this environment (PRICE_SYNC_MODE=off)')
    if (lockView(await store.getLock(), now).held) throw new AdminError(409, 'a run is already in progress')
    const slot = `manual-${now.toISOString()}`
    await store.claimSlot(slot, { kind: 'manual', by: user.email, claimedAt: now })
    const activationId = await invoke(PRICE_SYNC_ACTION, { slot, trigger: 'manual', requestedBy: user.email })
    return { slot, activationId }
  }
}

async function handleAdmin (op, ctx) {
  const fn = Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : null
  if (!fn) throw new AdminError(400, `unknown op ${JSON.stringify(op)}`)
  return fn(ctx)
}

module.exports = { handleAdmin, AdminError, displayStatus, OPS: Object.keys(ops) }
