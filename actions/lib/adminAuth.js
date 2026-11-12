// Who is calling the admin API. The browser sends the Experience Cloud
// user's IMS access token; asking IMS for that user's profile both validates
// the token and gives us the email to check against:
//   PRICE_SYNC_EDITORS  comma-separated emails that may change settings and
//                       start runs (a deploy-time input, so callers can't set it)
// Anyone with an @adobe.com email may view. Access rules must never be read
// from request params that aren't deploy-time inputs: web actions merge the
// request body and query into params.

const crypto = require('crypto')
const { getBearerToken } = require('../utils')

const IMS_HOST = 'https://ims-na1.adobelogin.com'
const PROFILE_PATHS = ['/ims/profile/v1', '/ims/userinfo/v2']
const VIEWER_DOMAINS = ['adobe.com']
const CACHE_MS = 5 * 60 * 1000
const cache = new Map()

const list = v => String(v || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)

function roleFor (email, params) {
  if (!email) return null
  if (list(params.PRICE_SYNC_EDITORS).includes(email)) return 'editor'
  return VIEWER_DOMAINS.some(d => email.endsWith(`@${d}`)) ? 'viewer' : null
}

async function fetchEmail (token, fetchImpl) {
  let lastStatus = null
  for (const path of PROFILE_PATHS) {
    const res = await fetchImpl(`${IMS_HOST}${path}`, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 401 || res.status === 403) return { invalid: true }
    if (res.ok) {
      const profile = await res.json()
      const email = String(profile.email || '').trim().toLowerCase()
      if (email) return { email, name: profile.displayName || profile.name || null }
    }
    lastStatus = res.status
  }
  throw new Error(`IMS profile lookup failed (HTTP ${lastStatus})`)
}

// Returns { user: { email, name, role } } or { status, error }.
async function authenticate (params, { fetchImpl = fetch, now = Date.now() } = {}) {
  const token = getBearerToken(params)
  if (!token) return { status: 401, error: 'sign-in required' }
  const key = crypto.createHash('sha256').update(token).digest('hex')
  let entry = cache.get(key)
  if (!entry || entry.expires < now) {
    const found = await fetchEmail(token, fetchImpl)
    if (found.invalid) return { status: 401, error: 'your session has expired; reload the page' }
    entry = { email: found.email, name: found.name, expires: now + CACHE_MS }
    if (cache.size > 500) cache.clear()
    cache.set(key, entry)
  }
  const role = roleFor(entry.email, params)
  if (!role) return { status: 403, error: `${entry.email} is not allowed to use this app` }
  return { user: { email: entry.email, name: entry.name, role } }
}

module.exports = { authenticate, roleFor, _cache: cache }
