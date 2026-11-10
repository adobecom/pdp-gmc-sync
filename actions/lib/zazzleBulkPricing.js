// Client for Zazzle's getbulkpricing partner endpoint. One call returns 100
// products plus a `nextAfter` cursor; a full pass is ~520 calls. Zazzle's
// contract (integration guide + `?doc=1`): errors usually arrive as HTTP 200
// with `success: false`; treat a non-200, a non-JSON body, or success:false as
// an error, wait, then retry the SAME `after`. Refused calls count against the
// 4,999-calls-per-IP rolling-24h limit, so a rate-limit response aborts the
// pass instead of burning more calls.

const DEFAULT_URL = 'https://www.zazzle.com/svc/partner/adobeexpress/v1/getbulkpricing'
const DEFAULT_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000]
const DEFAULT_TIMEOUT_MS = 30000

class ZazzleError extends Error {
  constructor (message, { rateLimited = false, retriable = true, status } = {}) {
    super(message)
    this.name = 'ZazzleError'
    this.rateLimited = rateLimited
    this.retriable = retriable && !rateLimited
    this.status = status
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function buildUrl (baseUrl, after, query) {
  const url = new URL(baseUrl || DEFAULT_URL)
  url.searchParams.set('after', String(after ?? '0'))
  for (const [k, v] of Object.entries(query || {})) {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  }
  return url.toString()
}

function validatePage (body) {
  if (!body || typeof body !== 'object') throw new ZazzleError('response is not a JSON object')
  if (body.success !== true) {
    const err = body.error
    // Zazzle returns `error` as an object only when the call was rate-limited.
    const rateLimited = err != null && typeof err === 'object'
    const message = typeof err === 'string' ? err : JSON.stringify(err ?? 'success:false')
    throw new ZazzleError(`zazzle error: ${message.slice(0, 500)}`, { rateLimited })
  }
  const data = body.data
  if (!data || typeof data !== 'object') throw new ZazzleError('response has no data object')
  if (!Array.isArray(data.products)) throw new ZazzleError('response data.products is not an array')
  if (typeof data.currency !== 'string' || !data.currency) throw new ZazzleError('response data.currency missing')
  if (!Number.isFinite(data.totalCount)) throw new ZazzleError('response data.totalCount missing')
  if (data.nextAfter != null && typeof data.nextAfter !== 'string' && typeof data.nextAfter !== 'number') {
    throw new ZazzleError('response data.nextAfter has an unexpected type')
  }
  return {
    currency: data.currency,
    totalCount: data.totalCount,
    nextAfter: data.nextAfter == null ? null : String(data.nextAfter),
    excludedCount: Number(data.excludedCount) || 0,
    skippedCount: Number(data.skippedCount) || 0,
    promo: data.promo || null,
    products: data.products
  }
}

async function fetchPageOnce ({ fetchImpl, url, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller.signal })
  } catch (e) {
    throw new ZazzleError(`request failed: ${e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message}`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 429) throw new ZazzleError('HTTP 429', { rateLimited: true, status: 429 })
  if (res.status !== 200) throw new ZazzleError(`HTTP ${res.status}`, { status: res.status })
  let body
  try {
    body = JSON.parse(await res.text())
  } catch {
    throw new ZazzleError('response body is not JSON', { status: res.status })
  }
  return validatePage(body)
}

/**
 * Fetches one page, retrying the same `after` with backoff. Throws the last
 * ZazzleError once retries are exhausted, or immediately when rate-limited.
 */
async function fetchBulkPricingPage (after, {
  fetchImpl = global.fetch,
  baseUrl = DEFAULT_URL,
  query,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger
} = {}) {
  const url = buildUrl(baseUrl, after, query)
  for (let attempt = 0; ; attempt++) {
    try {
      const page = await fetchPageOnce({ fetchImpl, url, timeoutMs })
      return { ...page, attempts: attempt + 1 }
    } catch (e) {
      const err = e instanceof ZazzleError ? e : new ZazzleError(e.message)
      if (!err.retriable || attempt >= retryDelaysMs.length) {
        err.attempts = attempt + 1
        throw err
      }
      if (logger?.warn) logger.warn(`zazzle after=${after} attempt=${attempt + 1} failed: ${err.message}; retrying`)
      await sleep(retryDelaysMs[attempt])
    }
  }
}

module.exports = { fetchBulkPricingPage, validatePage, buildUrl, ZazzleError, DEFAULT_URL }
