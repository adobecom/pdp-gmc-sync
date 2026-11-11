const mockLines = []
jest.mock('@adobe/aio-sdk', () => ({
  Core: {
    Logger: () => ({
      debug () {},
      info: m => mockLines.push(m),
      warn: m => mockLines.push(m),
      error: m => mockLines.push(m)
    })
  }
}))
jest.mock('../../actions/lib/gmcClients', () => ({
  makeClients: jest.fn(() => ({ productInputs: {} }))
}))
jest.mock('../../actions/lib/priceStore', () => {
  const actual = jest.requireActual('../../actions/lib/priceStore')
  return { ...actual, openPriceStore: jest.fn() }
})
jest.mock('../../actions/lib/priceSync', () => {
  const actual = jest.requireActual('../../actions/lib/priceSync')
  return { ...actual, runPriceSync: jest.fn() }
})

const { openPriceStore, MemoryPriceStore } = require('../../actions/lib/priceStore')
const { runPriceSync } = require('../../actions/lib/priceSync')
const { main, resolveMode } = require('../../actions/price-sync/index')

const env = {
  GMC_ENV: 'test',
  GMC_MERCHANT_ACCOUNT_ID: '5830778204',
  GMC_DATASOURCE_ID: '10693230513',
  GMC_SERVICE_ACCOUNT_JSON: '{}'
}

const linesWith = prefix => mockLines.filter(l => String(l).startsWith(prefix))

const summary = {
  runId: 'r1',
  mode: 'live',
  status: 'complete',
  durationMs: 60000,
  pass: { totalCount: 1, complete: true, incompleteReasons: [] },
  counters: { pages: 1, returned: 1, excluded: 0, skippedByZazzle: 0, invalid: 0, unchanged: 0, due: { new: 1, changed: 0, refresh: 0 }, written: 1, notFound: 0, failed: 0, deleted: 0, deleteFailed: 0 },
  deletes: { mode: 'report', candidates: 0, sample: [] },
  deleteOfferIds: [],
  health: null
}

beforeEach(() => {
  jest.clearAllMocks()
  mockLines.length = 0
  openPriceStore.mockResolvedValue(new MemoryPriceStore())
  runPriceSync.mockResolvedValue(summary)
})

describe('price-sync action', () => {
  test('mode defaults to off; invocation params can downgrade live to dry-run but never enable writes', () => {
    expect(resolveMode({})).toBe('off')
    expect(resolveMode({ PRICE_SYNC_MODE: 'live', dryRun: 'true' })).toBe('dry-run')
    expect(resolveMode({ PRICE_SYNC_MODE: 'off', dryRun: false })).toBe('off')
    expect(() => resolveMode({ PRICE_SYNC_MODE: 'false' })).toThrow(/PRICE_SYNC_MODE/)
  })

  test('off: returns without touching Zazzle, Google or the database', async () => {
    const res = await main({ ...env })
    expect(res).toEqual({ statusCode: 200, body: { skipped: true, reason: 'PRICE_SYNC_MODE=off' } })
    expect(openPriceStore).not.toHaveBeenCalled()
    expect(runPriceSync).not.toHaveBeenCalled()
  })

  test('rejects malformed invocation params', async () => {
    const res = await main({ ...env, PRICE_SYNC_MODE: 'live', maxPages: 'lots' })
    expect(res.error.statusCode).toBe(400)
  })

  test('live without a database fails loudly instead of rewriting everything', async () => {
    openPriceStore.mockRejectedValue(new Error('403 Forbidden'))
    const res = await main({ ...env, PRICE_SYNC_MODE: 'live' })
    expect(res.error.statusCode).toBe(503)
    expect(runPriceSync).not.toHaveBeenCalled()
    expect(linesWith('PRICE_SYNC_RESULT')).toEqual(['PRICE_SYNC_RESULT env=test status=failed alerts=1'])
    expect(linesWith('PRICE_SYNC_ALERT')).toEqual(['PRICE_SYNC_ALERT env=test run=none :: price-sync failed: database unavailable: 403 Forbidden'])
  })

  test('dry-run without a database falls back to an in-memory store', async () => {
    openPriceStore.mockRejectedValue(new Error('403 Forbidden'))
    const res = await main({ ...env, PRICE_SYNC_MODE: 'dry-run' })
    expect(res.statusCode).toBe(200)
    expect(runPriceSync.mock.calls[0][0].store).toBeInstanceOf(MemoryPriceStore)
  })

  test('an aborted pass logs single-token values plus one alert line per problem', async () => {
    runPriceSync.mockResolvedValue({ ...summary, status: 'aborted', abortReason: 'zazzle after=0: HTTP 503 "busy"', pass: { ...summary.pass, complete: false } })
    await main({ ...env, PRICE_SYNC_MODE: 'live' })
    expect(linesWith('PRICE_SYNC_RESULT')[0]).toMatch(/^PRICE_SYNC_RESULT env=test status=aborted .* alerts=1$/)
    expect(linesWith('PRICE_SYNC_ALERT')).toEqual(['PRICE_SYNC_ALERT env=test run=r1 :: Pass aborted: zazzle after=0: HTTP 503 "busy"'])
  })

  test('live: passes config through, logs the result line, and closes the store', async () => {
    const store = new MemoryPriceStore()
    store.close = jest.fn(async () => {})
    openPriceStore.mockResolvedValue(store)
    const res = await main({ ...env, PRICE_SYNC_MODE: 'live', PRICE_SYNC_DELETES: 'enabled', maxWrites: '50' })
    expect(res.statusCode).toBe(200)
    const [deps, opts] = runPriceSync.mock.calls[0]
    expect(deps.productInputs).toBeDefined()
    expect(opts).toMatchObject({
      mode: 'live',
      deletes: 'enabled',
      accountId: '5830778204',
      dataSource: 'accounts/5830778204/dataSources/10693230513',
      contentLanguage: 'en',
      feedLabel: 'US',
      expectedCurrency: 'USD',
      maxWrites: 50
    })
    expect(linesWith('PRICE_SYNC_RESULT')).toEqual([
      'PRICE_SYNC_RESULT env=test status=complete mode=live run=r1 resumed=no durationMin=1.0 total=1 returned=1 new=1 changed=0 refresh=0 unchanged=0 written=1 notFound=0 failed=0 deleted=0 deleteCandidates=0 alerts=0'
    ])
    expect(linesWith('PRICE_SYNC_ALERT')).toEqual([])
    expect(store.close).toHaveBeenCalled()
  })
})
