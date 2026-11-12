// Non-blocking invocation of another action in this namespace through the
// I/O Runtime REST API, using the credentials Runtime gives every action
// (__OW_API_HOST / __OW_API_KEY / __OW_NAMESPACE). Returns the activation id.

async function invokeAsync (actionName, params, { env = process.env, fetchImpl = fetch } = {}) {
  const host = env.__OW_API_HOST
  const key = env.__OW_API_KEY
  const namespace = env.__OW_NAMESPACE
  if (!host || !key || !namespace) throw new Error('Runtime API credentials are not available to this action')
  const path = actionName.split('/').map(encodeURIComponent).join('/')
  const res = await fetchImpl(`${host}/api/v1/namespaces/${encodeURIComponent(namespace)}/actions/${path}?blocking=false`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(key).toString('base64')}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(params || {})
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`invoking ${actionName} failed: HTTP ${res.status} ${text.slice(0, 200)}`)
  try {
    return JSON.parse(text).activationId || null
  } catch {
    return null
  }
}

module.exports = { invokeAsync }
