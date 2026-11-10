// Server-side Lana logging, matching the query-string contract of Milo's
// libs/utils/lana.js (GET {endpoint}?m=&c=&s=&t=&r=&tags=). Best-effort:
// never throws, so logging can't break a run.

const MSG_LIMIT = 2000
const ENDPOINTS = {
  prod: 'https://www.adobe.com/lana/ll',
  stage: 'https://www.stage.adobe.com/lana/ll'
}

async function lanaLog (message, { clientId, env = 'stage', severity = 'e', tags = '', fetchImpl = global.fetch, logger } = {}) {
  if (!clientId) return { skipped: true }
  let msg = String(message ?? '')
  if (msg.length > MSG_LIMIT) msg = `${msg.slice(0, MSG_LIMIT)}<trunc>`
  const query = [
    `m=${encodeURIComponent(msg)}`,
    `c=${encodeURIComponent(clientId)}`,
    's=100',
    't=e',
    `r=${encodeURIComponent(severity)}`
  ]
  if (tags) query.push(`tags=${encodeURIComponent(tags)}`)
  const url = `${env === 'prod' ? ENDPOINTS.prod : ENDPOINTS.stage}?${query.join('&')}`
  try {
    const res = await fetchImpl(url, { method: 'GET' })
    return { ok: res.ok, status: res.status }
  } catch (e) {
    if (logger?.warn) logger.warn(`lana log failed: ${e.message}`)
    return { ok: false, error: e.message }
  }
}

module.exports = { lanaLog, ENDPOINTS }
