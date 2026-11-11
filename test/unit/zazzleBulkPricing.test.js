const { fetchBulkPricingPage, validatePage, buildUrl } = require('../../actions/lib/zazzleBulkPricing')

const okBody = (over = {}) => ({
  success: true,
  data: {
    currency: 'USD',
    totalCount: 3,
    nextAfter: '256000056586932959',
    excludedCount: 0,
    skippedCount: 0,
    promo: { code: 'ADBHOLCARD26' },
    products: [{ templateId: 'urn:aaid:sc:VA6C2:abc', price: 15 }],
    ...over
  }
})

function fakeFetch (responses) {
  const calls = []
  const fn = jest.fn(async url => {
    calls.push(url)
    const r = responses.shift()
    if (r instanceof Error) throw r
    return { status: r.status ?? 200, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }
  })
  fn.calls = calls
  return fn
}

const fast = { retryDelaysMs: [0, 0] }

describe('zazzle getbulkpricing client', () => {
  test('builds the URL with after and market params', () => {
    const url = new URL(buildUrl(undefined, '123', { zcur: 'USD', lang: 'en', region: 'us' }))
    expect(url.origin + url.pathname).toBe('https://www.zazzle.com/svc/partner/adobeexpress/v1/getbulkpricing')
    expect(Object.fromEntries(url.searchParams)).toEqual({ after: '123', zcur: 'USD', lang: 'en', region: 'us' })
  })

  test('returns a normalized page', async () => {
    const fetchImpl = fakeFetch([{ body: okBody({ nextAfter: null, excludedCount: 2 }) }])
    const page = await fetchBulkPricingPage('0', { fetchImpl, ...fast })
    expect(page).toMatchObject({ currency: 'USD', totalCount: 3, nextAfter: null, excludedCount: 2, skippedCount: 0, attempts: 1 })
    expect(page.products).toHaveLength(1)
  })

  test('retries the same after on success:false, then succeeds', async () => {
    const fetchImpl = fakeFetch([{ body: { success: false, error: 'temporarily unavailable' } }, { body: okBody() }])
    const page = await fetchBulkPricingPage('42', { fetchImpl, ...fast })
    expect(page.attempts).toBe(2)
    expect(fetchImpl.calls.map(u => new URL(u).searchParams.get('after'))).toEqual(['42', '42'])
  })

  test('does not retry a rate-limited response (error object)', async () => {
    const fetchImpl = fakeFetch([{ body: { success: false, error: { limit: 4999, retryAfter: 3600 } } }])
    await expect(fetchBulkPricingPage('0', { fetchImpl, ...fast })).rejects.toMatchObject({ rateLimited: true, attempts: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('gives up after the retry budget on non-200 / non-JSON / network errors', async () => {
    const fetchImpl = fakeFetch([{ status: 502, body: 'bad gateway' }, { body: '<html>' }, new Error('ECONNRESET')])
    await expect(fetchBulkPricingPage('0', { fetchImpl, ...fast })).rejects.toMatchObject({ attempts: 3, message: expect.stringContaining('ECONNRESET') })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  test('rejects malformed success bodies', () => {
    expect(() => validatePage({ success: true, data: { currency: 'USD', totalCount: 1 } })).toThrow(/products/)
    expect(() => validatePage({ success: true, data: { products: [], totalCount: 1 } })).toThrow(/currency/)
    expect(() => validatePage({ success: true, data: { products: [], currency: 'USD' } })).toThrow(/totalCount/)
  })
})
