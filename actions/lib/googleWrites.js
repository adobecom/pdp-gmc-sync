// Merchant API writes for the daily price sync: productInputs.patch for price
// fields and productInputs.delete for removals. Retriable errors (429/5xx)
// back off and retry; Google's per-minute quotas reset each minute, so the
// last delay is about a minute.

const { parseGoogleError } = require('./googleError')

const DEFAULT_RETRY_DELAYS_MS = [2000, 8000, 30000, 60000]
const FATAL_STATUSES = new Set(['UNAUTHENTICATED', 'PERMISSION_DENIED'])

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function isNotFound (p) {
  return p.status === 'NOT_FOUND' || p.code === 404 || p.code === 5
}

async function callWithRetry (fn, { retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, sleepFn = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await fn()
      return { ok: true, value, attempts: attempt + 1 }
    } catch (err) {
      const p = parseGoogleError(err)
      if (!p.retriable || attempt >= retryDelaysMs.length) return { ok: false, error: p, attempts: attempt + 1 }
      await sleepFn(retryDelaysMs[attempt] + Math.floor(Math.random() * 500))
    }
  }
}

function failure (offerId, p, attempts) {
  return {
    offerId,
    ok: false,
    notFound: isNotFound(p),
    fatal: FATAL_STATUSES.has(p.status) || p.code === 401 || p.code === 403,
    code: p.code,
    status: p.status,
    message: String(p.message || '').slice(0, 500),
    attempts
  }
}

async function patchPrices (productInputs, request, offerId, options) {
  const r = await callWithRetry(() => productInputs.updateProductInput(request), options)
  if (r.ok) return { offerId, ok: true, attempts: r.attempts }
  return failure(offerId, r.error, r.attempts)
}

// A NOT_FOUND on delete means the offer is already gone, which is the goal.
async function deleteOffer (productInputs, request, offerId, options) {
  const r = await callWithRetry(() => productInputs.deleteProductInput(request), options)
  if (r.ok) return { offerId, ok: true, attempts: r.attempts }
  const f = failure(offerId, r.error, r.attempts)
  if (f.notFound) return { offerId, ok: true, alreadyGone: true, attempts: r.attempts }
  return f
}

module.exports = { patchPrices, deleteOffer, callWithRetry, isNotFound, DEFAULT_RETRY_DELAYS_MS }
