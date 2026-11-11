// Maps one getbulkpricing product to the price state this job manages in
// Google Merchant Center (price, sale price + window, availability), decides
// whether it needs writing, and builds the productInputs.patch request.
// Mapping rules follow Zazzle's integration guide (Slack handoff + `?doc=1`).

const crypto = require('crypto')
const { sanitizeOfferId } = require('./mapProduct')

const DAY_MS = 24 * 60 * 60 * 1000

// Every patch names all four managed fields. A field named in updateMask but
// absent from the body is deleted from the product input, which is how an
// ended sale (or a sale with no dates) gets cleared. Paths use proto field
// names because the Node client talks gRPC.
const PRICE_UPDATE_MASK = Object.freeze([
  'product_attributes.price',
  'product_attributes.sale_price',
  'product_attributes.sale_price_effective_date',
  'product_attributes.availability'
])
const SHIPPING_MASK_PATH = 'product_attributes.shipping'

function toMicros (value) {
  return String(Math.round(value * 1000000))
}

function parseIso (value) {
  if (value == null || value === '') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

// Zazzle: `shipping` lists methods to the market's own country, each priced as
// the total for minQuantity items. An empty list means send none (account
// shipping settings apply); null means the rates couldn't be read this time.
function normalizeShipping (raw, warnings) {
  if (raw == null) return null
  if (!Array.isArray(raw)) {
    warnings.push('ignored non-array shipping')
    return null
  }
  const out = []
  for (const e of raw) {
    const price = e?.price
    const country = typeof e?.country === 'string' ? e.country.trim().toUpperCase() : ''
    const service = typeof e?.service === 'string' ? e.service.trim() : ''
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || !/^[A-Z]{2}$/.test(country) || !service) {
      warnings.push(`ignored shipping with an invalid entry ${JSON.stringify(e).slice(0, 200)}`)
      return null
    }
    out.push({ priceMicros: toMicros(price), country, service })
  }
  return out
}

/**
 * Normalizes a getbulkpricing product. Returns { ok: true, offerId, templateId,
 * state, warnings } or { ok: false, offerId, templateId, reason }.
 */
function normalizeProduct (product, { currency, now = new Date(), shipping = false }) {
  const templateId = product?.templateId == null ? '' : String(product.templateId)
  const offerId = sanitizeOfferId(templateId)
  if (!templateId || !offerId) return { ok: false, offerId: offerId || null, templateId, reason: 'missing templateId' }
  if (offerId.length > 50) return { ok: false, offerId, templateId, reason: 'offerId longer than 50 characters' }

  const price = product.price
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return { ok: false, offerId, templateId, reason: `invalid price: ${JSON.stringify(price)}` }
  }

  const warnings = []
  let salePriceMicros = null
  let saleStart = null
  let saleEnd = null
  const sale = product.salePrice
  if (sale != null) {
    saleStart = parseIso(product.discountStart)
    saleEnd = parseIso(product.discountEnd)
    if (typeof sale !== 'number' || !Number.isFinite(sale) || sale < 0) {
      warnings.push(`ignored invalid salePrice ${JSON.stringify(sale)}`)
    } else if (sale >= price) {
      warnings.push('ignored salePrice not below price')
    } else if (saleEnd && Date.parse(saleEnd) <= now.getTime()) {
      warnings.push('ignored sale that has already ended')
    } else if (saleStart && saleEnd && Date.parse(saleEnd) <= Date.parse(saleStart)) {
      warnings.push('ignored sale whose end is not after its start')
    } else {
      salePriceMicros = toMicros(sale)
    }
    if (salePriceMicros == null) {
      saleStart = null
      saleEnd = null
    }
  }

  const discontinued = product.isDiscontinued === true
  const availability = discontinued || product.isInStock === false ? 'OUT_OF_STOCK' : 'IN_STOCK'

  const state = {
    currency,
    priceMicros: toMicros(price),
    salePriceMicros,
    saleStart,
    saleEnd,
    availability,
    discontinued
  }
  if (shipping) state.shipping = normalizeShipping(product.shipping, warnings)
  return { ok: true, offerId, templateId, warnings, state }
}

// Null shipping means "leave the offer's shipping as it is": carry forward
// what we last sent, so it neither counts as a change nor gets rewritten.
function applyShippingRule (state, record) {
  if (state.shipping === undefined) return { state, writeShipping: false }
  if (state.shipping === null) {
    const previous = record?.sent?.shipping
    return { state: previous !== undefined ? { ...state, shipping: previous } : state, writeShipping: false }
  }
  return { state, writeShipping: true }
}

function fingerprint (state) {
  const parts = [
    state.currency,
    state.priceMicros,
    state.salePriceMicros ?? '',
    state.saleStart ?? '',
    state.saleEnd ?? '',
    state.availability,
    state.discontinued ? 1 : 0
  ]
  if (state.shipping !== undefined) parts.push(JSON.stringify(state.shipping))
  return parts.join('|')
}

// Spreads the 30-day refresh across a window so offers written together
// (first run, campaign start) don't all come due on the same day.
function refreshAfterMs (offerId, { refreshAfterDays, refreshJitterDays }) {
  const jitterDays = Math.max(0, Math.floor(refreshJitterDays || 0))
  const hash = crypto.createHash('sha1').update(String(offerId)).digest().readUInt32BE(0)
  const offset = jitterDays > 0 ? hash % (jitterDays + 1) : 0
  return (refreshAfterDays + offset) * DAY_MS
}

/**
 * Returns 'new' | 'changed' | 'refresh' | 'unchanged'.
 */
function decideWrite (offerId, state, record, { now = new Date(), refreshAfterDays = 20, refreshJitterDays = 6 } = {}) {
  if (!record || !record.sent || !record.sentAt) return 'new'
  if (record.sent.fingerprint !== fingerprint(state)) return 'changed'
  const sentAtMs = new Date(record.sentAt).getTime()
  if (!Number.isFinite(sentAtMs)) return 'refresh'
  if (now.getTime() - sentAtMs >= refreshAfterMs(offerId, { refreshAfterDays, refreshJitterDays })) return 'refresh'
  return 'unchanged'
}

function productInputSegment (contentLanguage, feedLabel, offerId) {
  const plain = `${contentLanguage}~${feedLabel}~${offerId}`
  if (/[/%~]/.test(String(offerId)) || /[/%~]/.test(contentLanguage) || /[/%~]/.test(feedLabel)) {
    return Buffer.from(plain, 'utf8').toString('base64url')
  }
  return plain
}

function productInputName (accountId, contentLanguage, feedLabel, offerId) {
  return `accounts/${accountId}/productInputs/${productInputSegment(contentLanguage, feedLabel, offerId)}`
}

function toTimestamp (iso) {
  return { seconds: Math.floor(Date.parse(iso) / 1000) }
}

function buildPatchRequest (offerId, state, { accountId, dataSource, contentLanguage, feedLabel }, { writeShipping = false } = {}) {
  const productAttributes = {
    price: { amountMicros: state.priceMicros, currencyCode: state.currency },
    availability: state.availability
  }
  if (state.salePriceMicros != null) {
    productAttributes.salePrice = { amountMicros: state.salePriceMicros, currencyCode: state.currency }
    if (state.saleStart || state.saleEnd) {
      productAttributes.salePriceEffectiveDate = {}
      if (state.saleStart) productAttributes.salePriceEffectiveDate.startTime = toTimestamp(state.saleStart)
      if (state.saleEnd) productAttributes.salePriceEffectiveDate.endTime = toTimestamp(state.saleEnd)
    }
  }
  const paths = [...PRICE_UPDATE_MASK]
  if (writeShipping) {
    paths.push(SHIPPING_MASK_PATH)
    if (state.shipping.length) {
      productAttributes.shipping = state.shipping.map(m => ({
        price: { amountMicros: m.priceMicros, currencyCode: state.currency },
        country: m.country,
        service: m.service
      }))
    }
  }
  return {
    productInput: {
      name: productInputName(accountId, contentLanguage, feedLabel, offerId),
      productAttributes
    },
    updateMask: { paths },
    dataSource
  }
}

function buildDeleteRequest (offerId, { accountId, dataSource, contentLanguage, feedLabel }) {
  return { name: productInputName(accountId, contentLanguage, feedLabel, offerId), dataSource }
}

module.exports = {
  PRICE_UPDATE_MASK,
  SHIPPING_MASK_PATH,
  normalizeProduct,
  applyShippingRule,
  fingerprint,
  refreshAfterMs,
  decideWrite,
  productInputName,
  buildPatchRequest,
  buildDeleteRequest,
  DAY_MS
}
