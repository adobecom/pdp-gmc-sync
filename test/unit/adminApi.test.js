const { MemoryPriceStore } = require('../../actions/lib/priceStore')
const { handleAdmin } = require('../../actions/lib/adminApi')
const { roleFor, authenticate, _cache } = require('../../actions/lib/adminAuth')
const { DEFAULT_SETTINGS } = require('../../actions/lib/priceSyncSettings')

const NOW = new Date('2026-11-12T12:00:00Z')
const params = { GMC_ENV: 'test', PRICE_SYNC_MODE: 'live', PRICE_SYNC_DELETES: 'report', PRICE_SYNC_SHIPPING: 'send' }
const editor = { email: 'ed@adobe.com', role: 'editor' }
const viewer = { email: 'vi@adobe.com', role: 'viewer' }

function setup () {
  const store = new MemoryPriceStore()
  const invoke = jest.fn(async () => 'act-9')
  const call = (op, args = {}, user = viewer, extra = {}) => handleAdmin(op, { store, params: { ...params, ...extra }, args, user, now: NOW, invoke })
  return { store, invoke, call }
}

describe('admin API', () => {
  test('overview: defaults, next runs, and a dead "running" run shown as interrupted', async () => {
    const { store, call } = setup()
    await store.createRun({ _id: 'r1', status: 'running', startedAt: new Date('2026-11-12T08:15:00Z'), heartbeatAt: new Date('2026-11-12T08:20:00Z'), deletes: { candidates: 2, offerIds: ['a', 'b'] }, samples: {} })
    const o = await call('overview')
    expect(o).toMatchObject({
      env: { mode: 'live', gmcEnv: 'test' },
      settings: DEFAULT_SETTINGS,
      settingsMeta: { version: 0 },
      effective: { deletes: 'report', shipping: 'send' },
      nextRuns: [new Date('2026-11-13T08:15:00Z'), expect.any(Date), expect.any(Date)],
      latestRun: { id: 'r1', displayStatus: 'interrupted', deletes: { candidates: 2 } }
    })
    expect(o.latestRun.deletes.offerIds).toBeUndefined()
  })

  test('saveSettings: editors only, validated, conflict-checked, and recorded in history', async () => {
    const { call } = setup()
    const next = { ...DEFAULT_SETTINGS, scheduleTimes: ['01:00'], deletes: 'enabled' }
    await expect(call('saveSettings', { settings: next, expectedVersion: 0 })).rejects.toMatchObject({ status: 403 })
    await expect(call('saveSettings', { settings: { ...next, refreshAfterDays: 99 }, expectedVersion: 0 }, editor)).rejects.toMatchObject({ status: 400, details: { refreshAfterDays: expect.any(String) } })
    expect(await call('saveSettings', { settings: next, expectedVersion: 0 }, editor)).toMatchObject({ version: 1 })
    await expect(call('saveSettings', { settings: next, expectedVersion: 0 }, editor)).rejects.toMatchObject({ status: 409 })
    expect((await call('overview')).effective.deletes).toBe('enabled')
    const { history } = await call('settingsHistory')
    expect(history).toEqual([expect.objectContaining({ by: 'ed@adobe.com', version: 1, before: null, after: next })])
  })

  test('runNow: editors only, refused while a run holds the lock or the mode is off', async () => {
    const { store, invoke, call } = setup()
    await expect(call('runNow', {}, viewer)).rejects.toMatchObject({ status: 403 })
    await expect(call('runNow', {}, editor, { PRICE_SYNC_MODE: 'off' })).rejects.toMatchObject({ status: 409 })
    await store.acquireLock('x', NOW, 60000)
    await expect(call('runNow', {}, editor)).rejects.toMatchObject({ status: 409 })
    await store.releaseLock('x')
    expect(await call('runNow', {}, editor)).toEqual({ slot: `manual-${NOW.toISOString()}`, activationId: 'act-9' })
    expect(invoke).toHaveBeenCalledWith('gmc-feed-sync/price-sync', { slot: `manual-${NOW.toISOString()}`, trigger: 'manual', requestedBy: 'ed@adobe.com' })
  })

  test('listOffers pages through not-in-GMC offers by id', async () => {
    const { store, call } = setup()
    for (const id of ['c', 'a', 'b']) store.offers.set(id, { _id: id, templateId: `t-${id}`, notInGmc: true, notInGmcSince: NOW })
    store.offers.set('z', { _id: 'z', sentAt: NOW })
    const first = await call('listOffers', { view: 'notInGmc', limit: 2 })
    expect(first).toMatchObject({ total: 3, next: 'b', offers: [{ offerId: 'a', templateId: 't-a' }, { offerId: 'b' }] })
    expect(await call('listOffers', { view: 'notInGmc', limit: 2, after: 'b' })).toMatchObject({ total: null, next: null, offers: [{ offerId: 'c' }] })
    await expect(call('listOffers', { view: 'everything' })).rejects.toMatchObject({ status: 400 })
  })

  test('unknown ops are rejected', async () => {
    await expect(setup().call('constructor')).rejects.toMatchObject({ status: 400 })
  })
})

describe('admin auth', () => {
  beforeEach(() => _cache.clear())

  test('editors by email, viewers by domain, everyone else refused', () => {
    const p = { PRICE_SYNC_EDITORS: ' Ed@Adobe.com, x@adobe.com' }
    expect(roleFor('ed@adobe.com', p)).toBe('editor')
    expect(roleFor('someone@adobe.com', p)).toBe('viewer')
    expect(roleFor('someone@example.com', p)).toBeNull()
    expect(roleFor('someone@notadobe.com', p)).toBeNull()
  })

  test('the token is checked with IMS; missing or rejected tokens get 401', async () => {
    const reply = (status, body) => async () => ({ status, ok: status < 300, json: async () => body })
    const withToken = { __ow_headers: { authorization: 'Bearer t1' } }
    expect(await authenticate({}, { fetchImpl: jest.fn() })).toMatchObject({ status: 401 })
    expect(await authenticate(withToken, { fetchImpl: reply(401) })).toMatchObject({ status: 401 })
    _cache.clear()
    expect(await authenticate(withToken, { fetchImpl: reply(200, { email: 'Max@Adobe.com' }) })).toEqual({ user: { email: 'max@adobe.com', name: null, role: 'viewer' } })
    _cache.clear()
    const outsider = { ...withToken, PRICE_SYNC_VIEWER_DOMAINS: 'example.com' }
    expect(await authenticate(outsider, { fetchImpl: reply(200, { email: 'someone@example.com' }) })).toMatchObject({ status: 403 })
  })
})
