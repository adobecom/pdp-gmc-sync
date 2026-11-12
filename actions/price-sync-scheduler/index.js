// Fired every 15 minutes by the price-sync-tick trigger. Starts price-sync at
// the times set in the admin app (Pacific time) and resumes passes that were
// cut short. Quiet unless it does something.

const { Core } = require('@adobe/aio-sdk')
const { openPriceStore } = require('../lib/priceStore')
const { schedulerTick } = require('../lib/priceSyncScheduler')
const { invokeAsync } = require('../lib/runtimeInvoke')
const { deployMode } = require('../lib/priceSyncSettings')

async function main (params) {
  const logger = Core.Logger('price-sync-scheduler', { level: params.LOG_LEVEL || 'info' })
  let mode
  try {
    mode = deployMode(params)
  } catch (e) {
    logger.error(`PRICE_SYNC_ALERT env=${params.GMC_ENV} run=none :: price-sync-scheduler: ${e.message}`)
    return { statusCode: 500, body: { error: e.message } }
  }
  if (mode === 'off') return { statusCode: 200, body: { action: 'none', reason: 'PRICE_SYNC_MODE=off' } }

  let store
  try {
    store = await openPriceStore(params)
    const result = await schedulerTick({ store, now: new Date(), mode, invoke: (name, p) => invokeAsync(name, p) })
    if (result.problem) logger.warn(`price-sync-scheduler: ${result.problem}`)
    if (result.action !== 'none') {
      logger.info(`PRICE_SYNC_SCHEDULER env=${params.GMC_ENV} action=${result.action} slot=${result.slot} activation=${result.activationId}${result.run ? ` run=${result.run}` : ''}`)
    }
    return { statusCode: 200, body: result }
  } catch (e) {
    logger.error(`PRICE_SYNC_ALERT env=${params.GMC_ENV} run=none :: price-sync-scheduler failed: ${e.message}`)
    return { statusCode: 500, body: { error: e.message } }
  } finally {
    if (store) await store.close().catch(() => {})
  }
}

module.exports = { main }
