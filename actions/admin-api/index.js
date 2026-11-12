// Backend for the admin app in web-src (runs dashboard and settings). A web
// action: callers authenticate with their Experience Cloud IMS token (see
// lib/adminAuth). Request: POST JSON { op, ...args }; ops in lib/adminApi.

const { Core } = require('@adobe/aio-sdk')
const { authenticate } = require('../lib/adminAuth')
const { handleAdmin, AdminError } = require('../lib/adminApi')
const { openPriceStore } = require('../lib/priceStore')
const { invokeAsync } = require('../lib/runtimeInvoke')

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body
})

async function main (params, { open = openPriceStore, invoke = invokeAsync, auth = authenticate } = {}) {
  const logger = Core.Logger('admin-api', { level: params.LOG_LEVEL || 'info' })
  let user
  try {
    const result = await auth(params)
    if (!result.user) return json(result.status, { error: result.error })
    user = result.user
  } catch (e) {
    logger.error(`admin-api: auth failed: ${e.message}`)
    return json(502, { error: 'could not check your sign-in with Adobe IMS; try again' })
  }

  const op = params.op
  let store
  try {
    store = await open(params)
    const body = await handleAdmin(op, { store, params, args: params, user, now: new Date(), invoke })
    if (op === 'saveSettings' || op === 'runNow') logger.info(`admin-api: ${op} by ${user.email}: ${JSON.stringify(body)}`)
    return json(200, body)
  } catch (e) {
    if (e instanceof AdminError) return json(e.status, { error: e.message, ...(e.details ? { details: e.details } : {}) })
    logger.error(`admin-api: ${op} failed: ${e.stack || e.message}`)
    return json(500, { error: 'something went wrong; see the admin-api activation logs' })
  } finally {
    if (store) await store.close().catch(() => {})
  }
}

module.exports = { main }
