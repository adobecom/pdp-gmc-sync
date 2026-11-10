#!/usr/bin/env node
// Read-only rehearsal of the daily price sync against the LIVE Zazzle
// getbulkpricing endpoint. Nothing is written anywhere: no Google calls, and
// an in-memory store (so every product counts as "new"). Use it to sanity
// check Zazzle's data and the mapping before a live run.
//
// Usage:
//   node scripts/price-sync-dry-run.js            # first 5 pages (500 products)
//   node scripts/price-sync-dry-run.js --pages 20
//   node scripts/price-sync-dry-run.js --all      # full pass, ~520 calls
//
// Zazzle allows 4,999 calls per IP in any rolling 24 hours, refused calls
// included, so avoid repeated --all runs.

const { runPriceSync, formatPriceSyncDigest } = require('../actions/lib/priceSync')
const { MemoryPriceStore } = require('../actions/lib/priceStore')
const { fetchBulkPricingPage } = require('../actions/lib/zazzleBulkPricing')
const { normalizeProduct, buildPatchRequest } = require('../actions/lib/priceMapping')

function parseArgs (argv) {
  const args = { pages: 5 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') args.pages = undefined
    else if (argv[i] === '--pages') args.pages = Number(argv[++i])
  }
  if (args.pages !== undefined && (!Number.isInteger(args.pages) || args.pages < 1)) throw new Error('--pages must be a positive integer')
  return args
}

async function main () {
  const { pages } = parseArgs(process.argv.slice(2))
  const logger = { info: console.log, warn: console.warn, error: console.error, debug () {} }
  let firstProduct = null
  const fetchPage = async after => {
    const page = await fetchBulkPricingPage(after, { query: { zcur: 'USD', lang: 'en', region: 'us' }, logger })
    if (!firstProduct && page.products.length) firstProduct = page.products.find(p => p.salePrice != null) || page.products[0]
    process.stdout.write(`page after=${after}: ${page.products.length} products\n`)
    return page
  }
  const summary = await runPriceSync({ store: new MemoryPriceStore(), fetchPage, logger }, {
    mode: 'dry-run',
    accountId: 'DRY_RUN',
    dataSource: 'accounts/DRY_RUN/dataSources/DRY_RUN',
    contentLanguage: 'en',
    feedLabel: 'US',
    expectedCurrency: 'USD',
    shipping: 'send',
    maxPages: pages
  })
  console.log(`\n${formatPriceSyncDigest(summary, { env: 'dry-run' })}`)
  if (summary.samples.invalid.length) console.log('\nInvalid samples:', JSON.stringify(summary.samples.invalid, null, 2))
  if (summary.samples.warnings.length) console.log('\nWarning samples:', JSON.stringify(summary.samples.warnings, null, 2))
  if (firstProduct) {
    const n = normalizeProduct(firstProduct, { currency: 'USD', now: new Date(), shipping: true })
    console.log('\nExample: Zazzle product', JSON.stringify(firstProduct, null, 2))
    if (n.ok) {
      console.log('-> patch request', JSON.stringify(buildPatchRequest(n.offerId, n.state, {
        accountId: 'DRY_RUN', dataSource: 'accounts/DRY_RUN/dataSources/DRY_RUN', contentLanguage: 'en', feedLabel: 'US'
      }, { writeShipping: Array.isArray(n.state.shipping) }), null, 2))
    }
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
