/* global fetch */
import actions from './config.json'

const ADMIN_ACTION = 'gmc-feed-sync/admin-api'

export class ApiError extends Error {
  constructor (status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

export function makeApi (ims) {
  const url = actions[ADMIN_ACTION]
  return async function call (op, args = {}) {
    if (!url) throw new ApiError(0, 'admin-api is not deployed in this workspace')
    const headers = { 'content-type': 'application/json' }
    if (ims.token) headers.authorization = `Bearer ${ims.token}`
    if (ims.org) headers['x-gw-ims-org-id'] = ims.org
    let res
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...args, op }) })
    } catch (e) {
      throw new ApiError(0, 'could not reach the server; check your connection and try again')
    }
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch (e) {}
    if (!res.ok) throw new ApiError(res.status, body?.error || `request failed (HTTP ${res.status})`, body?.details)
    return body
  }
}

// Pages through an offer list (up to 2000 per request) for CSV export.
export async function fetchAllOffers (call, view, onProgress) {
  const offers = []
  let after = null
  let total = null
  do {
    const page = await call('listOffers', { view, after, limit: 2000 })
    if (total == null) total = page.total
    offers.push(...page.offers)
    after = page.next
    if (onProgress) onProgress(offers.length, total)
  } while (after)
  return offers
}
