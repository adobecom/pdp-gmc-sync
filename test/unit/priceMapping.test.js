const {
  PRICE_UPDATE_MASK,
  SHIPPING_MASK_PATH,
  normalizeProduct,
  applyShippingRule,
  fingerprint,
  decideWrite,
  refreshAfterMs,
  buildPatchRequest,
  productInputName,
  DAY_MS
} = require('../../actions/lib/priceMapping')

const NOW = new Date('2026-11-10T08:15:00Z')
const UUID = '1e9d71ad-453e-5992-a679-666a6bfc92a4'
const flyer = {
  templateId: `urn:aaid:sc:VA6C2:${UUID}`,
  productId: '256000056979590641',
  minQuantity: 25,
  isInStock: true,
  isDiscontinued: false,
  price: 25.0,
  salePrice: 21.25,
  discountCode: 'ADBHOLCARD26',
  discountStart: '2026-10-18T11:00:00Z',
  discountEnd: '2026-11-26T07:59:00Z'
}
const target = { accountId: '5830778204', dataSource: 'accounts/5830778204/dataSources/10693230513', contentLanguage: 'en', feedLabel: 'US' }
const normalize = p => normalizeProduct(p, { currency: 'USD', now: NOW })

describe('normalizeProduct', () => {
  test('maps the minQuantity total as-is and strips the URN prefix', () => {
    const n = normalize(flyer)
    expect(n.ok).toBe(true)
    expect(n.offerId).toBe(UUID)
    expect(n.state).toEqual({
      currency: 'USD',
      priceMicros: '25000000',
      salePriceMicros: '21250000',
      saleStart: '2026-10-18T11:00:00.000Z',
      saleEnd: '2026-11-26T07:59:00.000Z',
      availability: 'IN_STOCK',
      discontinued: false
    })
  })

  test('no sale when salePrice is null, and dates are dropped with it', () => {
    const n = normalize({ ...flyer, salePrice: null })
    expect(n.state).toMatchObject({ salePriceMicros: null, saleStart: null, saleEnd: null })
  })

  test.each([
    ['ended', { discountEnd: '2026-11-01T00:00:00Z' }],
    ['not below price', { salePrice: 25 }],
    ['end before start', { discountStart: '2026-11-20T00:00:00Z', discountEnd: '2026-11-19T00:00:00Z' }]
  ])('ignores a sale that is %s', (_label, over) => {
    const n = normalize({ ...flyer, ...over })
    expect(n.state.salePriceMicros).toBeNull()
    expect(n.warnings).toHaveLength(1)
  })

  test('out of stock or discontinued -> OUT_OF_STOCK', () => {
    expect(normalize({ ...flyer, isInStock: false }).state.availability).toBe('OUT_OF_STOCK')
    expect(normalize({ ...flyer, isDiscontinued: true }).state).toMatchObject({ availability: 'OUT_OF_STOCK', discontinued: true })
  })

  test('rejects products without a usable templateId or price', () => {
    expect(normalize({ ...flyer, templateId: null })).toMatchObject({ ok: false, reason: 'missing templateId' })
    expect(normalize({ ...flyer, price: 0 })).toMatchObject({ ok: false, reason: expect.stringContaining('invalid price') })
  })
})

describe('shipping', () => {
  const shipping = [{ price: 9.99, country: 'US', service: 'Standard' }, { price: 17.74, country: 'US', service: 'Premium' }]
  const withShipping = over => normalizeProduct({ ...flyer, shipping, ...over }, { currency: 'USD', now: NOW, shipping: true })

  test('ignored unless enabled', () => {
    expect(normalize({ ...flyer, shipping }).state.shipping).toBeUndefined()
  })

  test('normalizes methods; empty stays empty; null or any bad entry means unknown', () => {
    expect(withShipping().state.shipping).toEqual([
      { priceMicros: '9990000', country: 'US', service: 'Standard' },
      { priceMicros: '17740000', country: 'US', service: 'Premium' }
    ])
    expect(withShipping({ shipping: [] }).state.shipping).toEqual([])
    expect(withShipping({ shipping: null }).state.shipping).toBeNull()
    const bad = withShipping({ shipping: [{ price: -1, country: 'US', service: 'Standard' }] })
    expect(bad.state.shipping).toBeNull()
    expect(bad.warnings).toHaveLength(1)
  })

  test('patch writes the methods; an empty list clears them; unknown leaves them alone', () => {
    const write = n => buildPatchRequest(UUID, n.state, target, { writeShipping: applyShippingRule(n.state).writeShipping })
    const full = write(withShipping())
    expect(full.updateMask.paths).toContain(SHIPPING_MASK_PATH)
    expect(full.productInput.productAttributes.shipping).toEqual([
      { price: { amountMicros: '9990000', currencyCode: 'USD' }, country: 'US', service: 'Standard' },
      { price: { amountMicros: '17740000', currencyCode: 'USD' }, country: 'US', service: 'Premium' }
    ])
    const empty = write(withShipping({ shipping: [] }))
    expect(empty.updateMask.paths).toContain(SHIPPING_MASK_PATH)
    expect(empty.productInput.productAttributes.shipping).toBeUndefined()
    expect(write(withShipping({ shipping: null })).updateMask.paths).not.toContain(SHIPPING_MASK_PATH)
  })

  test('unknown shipping carries forward what was last sent, so it is not a change', () => {
    const known = withShipping().state
    const record = { sent: { ...known, fingerprint: fingerprint(known) }, sentAt: NOW }
    const { state, writeShipping } = applyShippingRule(withShipping({ shipping: null }).state, record)
    expect(writeShipping).toBe(false)
    expect(decideWrite(UUID, state, record, { now: NOW })).toBe('unchanged')
  })
})

describe('decideWrite', () => {
  const state = normalize(flyer).state
  const sent = { sent: { fingerprint: fingerprint(state) }, sentAt: new Date(NOW.getTime() - DAY_MS) }

  test('new / unchanged / changed', () => {
    expect(decideWrite(UUID, state, undefined, { now: NOW })).toBe('new')
    expect(decideWrite(UUID, state, { notInGmc: true }, { now: NOW })).toBe('new')
    expect(decideWrite(UUID, state, sent, { now: NOW })).toBe('unchanged')
    expect(decideWrite(UUID, { ...state, salePriceMicros: null }, sent, { now: NOW })).toBe('changed')
  })

  test('refresh once the per-offer threshold (base + jitter) has passed', () => {
    const opts = { refreshAfterDays: 20, refreshJitterDays: 6 }
    const threshold = refreshAfterMs(UUID, opts)
    expect(threshold).toBeGreaterThanOrEqual(20 * DAY_MS)
    expect(threshold).toBeLessThanOrEqual(26 * DAY_MS)
    const at = ms => ({ ...sent, sentAt: new Date(NOW.getTime() - ms) })
    expect(decideWrite(UUID, state, at(threshold - 1), { now: NOW, ...opts })).toBe('unchanged')
    expect(decideWrite(UUID, state, at(threshold), { now: NOW, ...opts })).toBe('refresh')
  })
})

describe('buildPatchRequest', () => {
  test('sends price, sale, sale window and availability with all four fields in the mask', () => {
    const req = buildPatchRequest(UUID, normalize(flyer).state, target)
    expect(req).toEqual({
      productInput: {
        name: `accounts/5830778204/productInputs/en~US~${UUID}`,
        productAttributes: {
          price: { amountMicros: '25000000', currencyCode: 'USD' },
          salePrice: { amountMicros: '21250000', currencyCode: 'USD' },
          salePriceEffectiveDate: {
            startTime: { seconds: Date.parse('2026-10-18T11:00:00Z') / 1000 },
            endTime: { seconds: Date.parse('2026-11-26T07:59:00Z') / 1000 }
          },
          availability: 'IN_STOCK'
        }
      },
      updateMask: { paths: [...PRICE_UPDATE_MASK] },
      dataSource: target.dataSource
    })
  })

  test('no sale: sale fields are absent from the body but still masked, so Google clears them', () => {
    const req = buildPatchRequest(UUID, normalize({ ...flyer, salePrice: null }).state, target)
    expect(Object.keys(req.productInput.productAttributes).sort()).toEqual(['availability', 'price'])
    expect(req.updateMask.paths).toEqual(expect.arrayContaining(['product_attributes.sale_price', 'product_attributes.sale_price_effective_date']))
  })

  test('sale without dates clears only the effective date', () => {
    const req = buildPatchRequest(UUID, normalize({ ...flyer, discountStart: null, discountEnd: null }).state, target)
    expect(req.productInput.productAttributes.salePrice).toEqual({ amountMicros: '21250000', currencyCode: 'USD' })
    expect(req.productInput.productAttributes.salePriceEffectiveDate).toBeUndefined()
  })

  test('encodes the product input name when the offerId has reserved characters', () => {
    const name = productInputName('1', 'en', 'US', 'a~b')
    expect(name).toBe(`accounts/1/productInputs/${Buffer.from('en~US~a~b').toString('base64url')}`)
  })

  test('survives the Merchant API proto encoding (unknown field names would be dropped silently)', () => {
    const { protos } = require('@google-shopping/products')
    const T = protos.google.shopping.merchant.products.v1.UpdateProductInputRequest
    const state = normalizeProduct({ ...flyer, shipping: [{ price: 9.99, country: 'US', service: 'Standard' }] }, { currency: 'USD', now: NOW, shipping: true }).state
    const req = buildPatchRequest(UUID, state, target, { writeShipping: true })
    const round = T.toObject(T.fromObject(req), { enums: String, longs: String })
    expect(round.productInput.productAttributes).toEqual({
      shipping: [{ price: { amountMicros: '9990000', currencyCode: 'USD' }, country: 'US', service: 'Standard' }],
      price: { amountMicros: '25000000', currencyCode: 'USD' },
      salePrice: { amountMicros: '21250000', currencyCode: 'USD' },
      salePriceEffectiveDate: {
        startTime: { seconds: String(Date.parse('2026-10-18T11:00:00Z') / 1000) },
        endTime: { seconds: String(Date.parse('2026-11-26T07:59:00Z') / 1000) }
      },
      availability: 'IN_STOCK'
    })
    expect(round.updateMask.paths).toEqual([...PRICE_UPDATE_MASK, SHIPPING_MASK_PATH])
    expect(round.dataSource).toBe(target.dataSource)
  })
})
