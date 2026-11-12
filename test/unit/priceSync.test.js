const { runPriceSync, formatPriceSyncDigest, alertsFor } = require('../../actions/lib/priceSync')
const { MemoryPriceStore } = require('../../actions/lib/priceStore')
const { DAY_MS } = require('../../actions/lib/priceMapping')

const T0 = new Date('2026-11-10T08:15:00Z')
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const product = (n, over = {}) => ({
  templateId: `urn:aaid:sc:VA6C2:${uuid(n)}`,
  productId: String(1000 + n),
  productOptions: 'style=x',
  minQuantity: 1,
  isInStock: true,
  isDiscontinued: false,
  price: 15,
  salePrice: 12,
  discountCode: 'X',
  discountStart: '2026-11-01T07:00:00Z',
  discountEnd: '2026-11-26T07:59:00Z',
  ...over
})

function zazzle (products, { pageSize = 2, totalCount = products.length, skipped = 0, failAt = null, failTimes = Infinity } = {}) {
  const pages = new Map()
  let after = '0'
  for (let i = 0; i < products.length; i += pageSize) {
    const chunk = products.slice(i, i + pageSize)
    const nextAfter = i + pageSize < products.length ? chunk[chunk.length - 1].productId : null
    pages.set(after, { currency: 'USD', totalCount, nextAfter, excludedCount: 0, skippedCount: i === 0 ? skipped : 0, products: chunk, attempts: 1 })
    after = nextAfter
  }
  let failures = 0
  return jest.fn(async a => {
    if (failAt != null && String(a) === String(failAt) && failures < failTimes) {
      failures++
      throw Object.assign(new Error('HTTP 503'), { attempts: 5 })
    }
    return structuredClone(pages.get(String(a)))
  })
}

const offerOf = req => (req.productInput?.name || req.name).split('~').pop()

function google ({ notFound = [], errors = {} } = {}) {
  const nf = new Set(notFound.map(uuid))
  return {
    updateProductInput: jest.fn(async req => {
      const id = offerOf(req)
      if (errors[id]) throw errors[id]
      if (nf.has(id)) throw Object.assign(new Error('not found'), { code: 5 })
      return [{}]
    }),
    deleteProductInput: jest.fn(async () => [{}])
  }
}

const quietLogger = { info () {}, warn () {}, error () {}, debug () {} }
const baseOpts = {
  mode: 'live',
  accountId: '1',
  dataSource: 'accounts/1/dataSources/2',
  contentLanguage: 'en',
  feedLabel: 'US',
  expectedCurrency: 'USD',
  concurrency: 3,
  settleMs: 0
}

function harness () {
  let now = T0
  const store = new MemoryPriceStore()
  const run = (fetchPage, productInputs, opts = {}) => runPriceSync(
    { store, productInputs, fetchPage, logger: quietLogger, now: () => now, retry: { retryDelaysMs: [] } },
    { ...baseOpts, ...opts }
  )
  return { store, run, advance: ms => { now = new Date(now.getTime() + ms) } }
}

describe('runPriceSync', () => {
  test('first pass writes every product; the same data the next day writes nothing', async () => {
    const h = harness()
    const products = [1, 2, 3, 4, 5].map(n => product(n))
    const g = google()
    const first = await h.run(zazzle(products), g)
    expect(first).toMatchObject({ status: 'complete', pass: { complete: true, totalCount: 5 } })
    expect(first.counters).toMatchObject({ pages: 3, returned: 5, written: 5, due: { new: 5, changed: 0, refresh: 0 } })
    expect(g.updateProductInput).toHaveBeenCalledTimes(5)
    expect(h.store.offers.get(uuid(1))).toMatchObject({ sentAt: T0, failCount: 0, sent: { priceMicros: '15000000', salePriceMicros: '12000000' } })

    h.advance(DAY_MS)
    const g2 = google()
    const second = await h.run(zazzle(products), g2)
    expect(second.counters).toMatchObject({ unchanged: 5, written: 0 })
    expect(g2.updateProductInput).not.toHaveBeenCalled()
  })

  test('only changed products are written, and an ended sale is cleared via the mask', async () => {
    const h = harness()
    await h.run(zazzle([product(1), product(2)]), google())
    h.advance(DAY_MS)
    const g = google()
    const summary = await h.run(zazzle([product(1, { salePrice: null }), product(2)]), g)
    expect(summary.counters).toMatchObject({ written: 1, unchanged: 1, due: { changed: 1 } })
    const [[req]] = g.updateProductInput.mock.calls
    expect(offerOf(req)).toBe(uuid(1))
    expect(req.productInput.productAttributes.salePrice).toBeUndefined()
    expect(req.updateMask.paths).toContain('product_attributes.sale_price')
  })

  test('refreshes an unchanged offer before Google’s 30-day expiry', async () => {
    const h = harness()
    await h.run(zazzle([product(1, { salePrice: null })]), google())
    h.advance(27 * DAY_MS)
    const g = google()
    const summary = await h.run(zazzle([product(1, { salePrice: null })]), g)
    expect(summary.counters.due.refresh).toBe(1)
    expect(g.updateProductInput).toHaveBeenCalledTimes(1)
  })

  test('a second invocation the same day is a no-op unless forced', async () => {
    const h = harness()
    await h.run(zazzle([product(1)]), google())
    h.advance(2 * 60 * 60 * 1000)
    expect(await h.run(zazzle([product(1)]), google())).toMatchObject({ skipped: true, reason: 'already-ran', status: 'complete' })
    expect(await h.run(zazzle([product(1)]), google(), { force: true })).toMatchObject({ status: 'complete' })
  })

  test('skips when another invocation holds the lock, saying who and until when', async () => {
    const h = harness()
    await h.store.acquireLock('someone-else', T0, 60000)
    expect(await h.run(zazzle([product(1)]), google())).toMatchObject({
      skipped: true, reason: 'locked', lockHolder: 'someone-else', lockHeldUntil: new Date(T0.getTime() + 60000)
    })
  })

  test('a lock left behind by a crashed invocation is taken over once it expires', async () => {
    const h = harness()
    await h.store.acquireLock('crashed', T0, 60000)
    h.advance(61000)
    expect(await h.run(zazzle([product(1)]), google())).toMatchObject({ status: 'complete' })
    expect(h.store.lock).toBeNull()
  })

  test('if acquiring the lock throws, nothing is left locked and the error surfaces', async () => {
    const h = harness()
    const original = h.store.acquireLock.bind(h.store)
    h.store.acquireLock = async (holder, now, ttl) => {
      await original(holder, now, ttl)
      throw new Error('Document not found')
    }
    await expect(h.run(zazzle([product(1)]), google())).rejects.toThrow('Document not found')
    expect(h.store.lock).toBeNull()
  })

  test('NOT_FOUND offers are reported, tracked, and never become delete candidates', async () => {
    const h = harness()
    const summary = await h.run(zazzle([product(1), product(2)]), google({ notFound: [2] }))
    expect(summary.counters).toMatchObject({ written: 1, notFound: 1 })
    expect(summary.samples.notFound).toEqual([uuid(2)])
    expect(h.store.offers.get(uuid(2))).toMatchObject({ notInGmc: true, notInGmcSince: T0 })
    expect(h.store.offers.get(uuid(2)).sentAt).toBeUndefined()

    h.advance(DAY_MS)
    const g = google({ notFound: [2] })
    const next = await h.run(zazzle([product(1), product(2)]), g)
    expect(next.deletes.candidates).toBe(0)
    expect(next.counters).toMatchObject({ notInGmcSkipped: 1, notFound: 0 })
    expect(g.updateProductInput).not.toHaveBeenCalled()

    h.advance(7 * DAY_MS)
    const weekly = await h.run(zazzle([product(1), product(2)]), google({ notFound: [2] }))
    expect(weekly.counters).toMatchObject({ notFound: 1, notInGmcSkipped: 0 })
  })

  test('a Zazzle failure aborts without deletes; the next invocation resumes from the saved cursor', async () => {
    const h = harness()
    const products = [1, 2, 3, 4, 5, 6].map(n => product(n))
    const failing = zazzle(products, { failAt: products[1].productId })
    const g = google()
    const aborted = await h.run(failing, g)
    expect(aborted).toMatchObject({ status: 'aborted', deletes: { blockedReason: expect.stringContaining('pass not finished') } })
    expect(aborted.counters).toMatchObject({ pages: 1, written: 2 })

    h.advance(2 * 60 * 60 * 1000)
    const fetchPage = zazzle(products)
    const resumed = await h.run(fetchPage, g)
    expect(resumed).toMatchObject({ status: 'complete', resumed: true, runId: aborted.runId })
    expect(fetchPage.mock.calls.map(([a]) => a)).toEqual([products[1].productId, products[3].productId])
    expect(resumed.counters).toMatchObject({ pages: 3, returned: 6, written: 6 })
    expect(g.updateProductInput).toHaveBeenCalledTimes(6)
  })

  test('offers Zazzle stops returning are listed, and deleted only when enabled', async () => {
    const products = Array.from({ length: 40 }, (_, i) => product(i + 1))
    const h = harness()
    await h.run(zazzle(products, { pageSize: 10 }), google())

    h.advance(DAY_MS)
    const report = await h.run(zazzle(products.slice(0, 39), { pageSize: 10 }), google())
    expect(report.deletes).toMatchObject({ mode: 'report', candidates: 1, sample: [uuid(40)], blockedReason: expect.stringContaining('report mode') })
    expect(report.deleteOfferIds).toEqual([uuid(40)])
    expect(h.store.offers.has(uuid(40))).toBe(true)

    h.advance(DAY_MS)
    const g = google()
    const enabled = await h.run(zazzle(products.slice(0, 39), { pageSize: 10 }), g, { deletes: 'enabled' })
    expect(enabled.deletes).toMatchObject({ candidates: 1, deleted: 1, blockedReason: null })
    expect(g.deleteProductInput).toHaveBeenCalledWith({ name: `accounts/1/productInputs/en~US~${uuid(40)}`, dataSource: 'accounts/1/dataSources/2' })
    expect(h.store.offers.has(uuid(40))).toBe(false)
  })

  test('an offer seen this pass is never a delete candidate, even if the database read lags', async () => {
    const products = Array.from({ length: 40 }, (_, i) => product(i + 1))
    const h = harness()
    await h.run(zazzle(products, { pageSize: 10 }), google())
    h.advance(DAY_MS)
    const real = h.store.findUnseenManaged.bind(h.store)
    h.store.findUnseenManaged = async (runId, limit) => {
      const r = await real(runId, limit)
      return { total: r.total + 1, offerIds: [...r.offerIds, uuid(40)] }
    }
    const sleep = jest.fn(async () => {})
    const summary = await runPriceSync(
      { store: h.store, productInputs: google(), fetchPage: zazzle(products, { pageSize: 10 }), logger: quietLogger, now: () => new Date(T0.getTime() + DAY_MS), sleep, retry: { retryDelaysMs: [] } },
      { ...baseOpts, settleMs: 5000 }
    )
    expect(sleep).toHaveBeenCalledWith(5000)
    expect(summary.deletes).toMatchObject({ candidates: 0, sample: [] })
  })

  test('no deletes after an incomplete pass, a >5% totalCount drop, or too many candidates', async () => {
    const products = Array.from({ length: 40 }, (_, i) => product(i + 1))
    const h = harness()
    await h.run(zazzle(products, { pageSize: 10 }), google())

    h.advance(DAY_MS)
    const skipped = await h.run(zazzle(products.slice(0, 39), { pageSize: 10, skipped: 1 }), google(), { deletes: 'enabled' })
    expect(skipped).toMatchObject({ status: 'incomplete', deletes: { blockedReason: expect.stringContaining('skippedCount') } })

    h.advance(DAY_MS)
    const dropped = await h.run(zazzle(products.slice(0, 37), { pageSize: 10 }), google(), { deletes: 'enabled' })
    expect(dropped.deletes.blockedReason).toMatch(/totalCount fell 7\.5%/)
    expect(alertsFor(dropped)).toEqual(expect.arrayContaining([expect.stringContaining('Deletes blocked')]))

    h.advance(DAY_MS)
    const many = await h.run(zazzle(products.slice(0, 38), { pageSize: 10 }), google(), { deletes: 'enabled', maxTotalCountDropPct: 50 })
    expect(many.deletes.blockedReason).toMatch(/exceed 5% of totalCount/)
  })

  test('discontinued products: OUT_OF_STOCK in report mode; deleted once, with a tombstone, when enabled', async () => {
    const h = harness()
    const g1 = google()
    const report = await h.run(zazzle([product(1, { isDiscontinued: true })]), g1)
    expect(report.counters).toMatchObject({ discontinued: 1, written: 1 })
    expect(g1.updateProductInput.mock.calls[0][0].productInput.productAttributes.availability).toBe('OUT_OF_STOCK')

    h.advance(DAY_MS)
    const g2 = google()
    const enabled = await h.run(zazzle([product(1, { isDiscontinued: true })]), g2, { deletes: 'enabled' })
    expect(enabled.counters.deleted).toBe(1)
    expect(g2.deleteProductInput).toHaveBeenCalledTimes(1)
    expect(h.store.offers.get(uuid(1))).toMatchObject({ notInGmc: true })

    h.advance(DAY_MS)
    const g3 = google()
    await h.run(zazzle([product(1, { isDiscontinued: true })]), g3, { deletes: 'enabled' })
    expect(g3.deleteProductInput).not.toHaveBeenCalled()
  })

  test('maxWrites caps writes; capped offers stay due for the next run', async () => {
    const h = harness()
    const products = [1, 2, 3, 4].map(n => product(n))
    const capped = await h.run(zazzle(products), google(), { maxWrites: 1 })
    expect(capped.counters).toMatchObject({ written: 1, cappedByMaxWrites: 3 })

    h.advance(DAY_MS)
    const next = await h.run(zazzle(products), google())
    expect(next.counters).toMatchObject({ written: 3, unchanged: 1 })
  })

  test('aborts on an auth error instead of failing every product', async () => {
    const h = harness()
    const products = [1, 2, 3, 4].map(n => product(n))
    const auth = Object.assign(new Error('bad creds'), { code: 16 })
    const g = google({ errors: { [uuid(1)]: auth } })
    const summary = await h.run(zazzle(products), g)
    expect(summary).toMatchObject({ status: 'aborted', abortReason: expect.stringContaining('UNAUTHENTICATED') })
    expect(h.store.offers.get(uuid(1))).toMatchObject({ failCount: 1 })
  })

  test('aborts before writing when the currency is unexpected', async () => {
    const h = harness()
    const fetchPage = jest.fn(async () => ({ currency: 'CAD', totalCount: 1, nextAfter: null, excludedCount: 0, skippedCount: 0, products: [product(1)] }))
    const g = google()
    expect(await h.run(fetchPage, g)).toMatchObject({ status: 'aborted', abortReason: expect.stringContaining('CAD') })
    expect(g.updateProductInput).not.toHaveBeenCalled()
  })

  test('shipping (when enabled): written when known, left alone when Zazzle could not read it', async () => {
    const h = harness()
    const rates = [{ price: 9.99, country: 'US', service: 'Standard' }]
    const g1 = google()
    await h.run(zazzle([product(1, { shipping: rates })]), g1, { shipping: 'send' })
    expect(g1.updateProductInput.mock.calls[0][0].productInput.productAttributes.shipping).toHaveLength(1)

    h.advance(DAY_MS)
    const g2 = google()
    const unknown = await h.run(zazzle([product(1, { shipping: null })]), g2, { shipping: 'send' })
    expect(unknown.counters.unchanged).toBe(1)
    expect(g2.updateProductInput).not.toHaveBeenCalled()

    h.advance(DAY_MS)
    const g3 = google()
    await h.run(zazzle([product(1, { shipping: [] })]), g3, { shipping: 'send' })
    const [[req]] = g3.updateProductInput.mock.calls
    expect(req.updateMask.paths).toContain('product_attributes.shipping')
    expect(req.productInput.productAttributes.shipping).toBeUndefined()
  })

  test('maxPages stops (not aborts) and the next invocation continues the same pass', async () => {
    const h = harness()
    const products = [1, 2, 3, 4].map(n => product(n))
    const stopped = await h.run(zazzle(products), google(), { maxPages: 1 })
    expect(stopped).toMatchObject({ status: 'stopped', abortReason: 'stopped after maxPages=1' })
    expect(alertsFor(stopped)).toEqual([])
    const resumed = await h.run(zazzle(products), google())
    expect(resumed).toMatchObject({ status: 'complete', resumed: true, runId: stopped.runId })
  })

  test('dry-run computes what would change without writing anything', async () => {
    const h = harness()
    const g = google()
    const summary = await h.run(zazzle([product(1), product(2)]), g, { mode: 'dry-run' })
    expect(summary).toMatchObject({ mode: 'dry-run', status: 'complete', counters: { due: { new: 2 }, written: 0 } })
    expect(alertsFor(summary)).toEqual([])
    expect(g.updateProductInput).not.toHaveBeenCalled()
    expect(h.store.offers.size).toBe(0)
    expect(h.store.runs.size).toBe(0)
    expect(formatPriceSyncDigest(summary, { env: 'test' })).toContain('2 new')
  })
})
