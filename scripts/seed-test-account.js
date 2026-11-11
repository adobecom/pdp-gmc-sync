#!/usr/bin/env node
// Copies the production Merchant Center catalog into the test account's API
// data source, so price-sync can run against the full catalog there. Reads
// production only; writes only to the account in the --target-env file, which
// must have GMC_ENV=test. Dry run by default.
//
// Usage (env files use the .env.example shape):
//   node scripts/seed-test-account.js                          # dry run: counts per data source, nothing written
//   node scripts/seed-test-account.js --write --limit 100      # copy 100 products
//   node scripts/seed-test-account.js --write                  # copy the rest (offers already in the test account are skipped)
// Options:
//   --source-env <file>        production account env file (default .env.prod)
//   --target-env <file>        test account env file (default .env.stage)
//   --source-datasource <id>   only copy products whose primary data source is this id
//   --overwrite                re-insert offers that already exist in the test account
//   --concurrency <n>          parallel inserts (default 10)
//
// After seeding, run price-sync with `-p retryNotFound true` if it has already
// recorded these offers as missing from the test account.

const fs = require('fs')
const path = require('path')
const { resolveAccount, resolveDataSource } = require('../actions/lib/config')
const { runPool } = require('../actions/lib/concurrency')
const { callWithRetry } = require('../actions/lib/googleWrites')
const defaults = require('../config/defaults.json')

const BATCH_SIZE = 500
const FAILURE_SAMPLE_LIMIT = 20

// Accepts the .env forms dotenv does for single-line values: `export KEY=v`,
// values wrapped in matching quotes, and ` # comments` after unquoted values.
function parseEnvContent (content) {
  const env = {}
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim().replace(/^export\s+/, '')
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i === -1) continue
    let value = t.slice(i + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote))
    } else {
      value = value.replace(/\s+#.*$/, '')
    }
    env[t.slice(0, i).trim()] = value
  }
  return env
}

function parseEnvFile (file) {
  return parseEnvContent(fs.readFileSync(path.resolve(process.cwd(), file), 'utf-8'))
}

function parseArgs (argv) {
  const args = { sourceEnv: '.env.prod', targetEnv: '.env.stage', write: false, overwrite: false, concurrency: 10, limit: null, sourceDataSource: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') args.write = true
    else if (a === '--overwrite') args.overwrite = true
    else if (a === '--source-env') args.sourceEnv = argv[++i]
    else if (a === '--target-env') args.targetEnv = argv[++i]
    else if (a === '--source-datasource') args.sourceDataSource = String(argv[++i]).split('/').pop()
    else if (a === '--limit') args.limit = Number(argv[++i])
    else if (a === '--concurrency') args.concurrency = Number(argv[++i])
    else throw new Error(`unknown argument ${a}`)
  }
  if (args.limit != null && (!Number.isInteger(args.limit) || args.limit < 0)) throw new Error('--limit must be a non-negative integer')
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 50) throw new Error('--concurrency must be 1-50')
  return args
}

function resolveTargets (sourceEnv, targetEnv) {
  if (targetEnv.GMC_ENV !== 'test') throw new Error(`target env must have GMC_ENV=test (got ${JSON.stringify(targetEnv.GMC_ENV)})`)
  const source = { accountId: resolveAccount(sourceEnv), dataSourceId: sourceEnv.GMC_DATASOURCE_ID ? String(sourceEnv.GMC_DATASOURCE_ID).split('/').pop() : null }
  const targetAccount = resolveAccount(targetEnv)
  const target = { accountId: targetAccount, dataSource: resolveDataSource(targetEnv, targetAccount) }
  if (source.accountId === target.accountId) throw new Error('source and target are the same Merchant Center account')
  return { source, target }
}

function plain (message) {
  return message && typeof message.toJSON === 'function' ? message.toJSON() : message
}

function toProductInput (product) {
  return {
    offerId: product.offerId,
    contentLanguage: product.contentLanguage,
    feedLabel: product.feedLabel,
    productAttributes: plain(product.productAttributes) || {},
    customAttributes: (product.customAttributes || []).map(plain)
  }
}

const dataSourceId = name => String(name || '').split('/').pop() || '(none)'

async function listOfferIds (productsClient, accountId) {
  const ids = new Set()
  for await (const p of productsClient.listProductsAsync({ parent: `accounts/${accountId}`, pageSize: 1000 })) ids.add(p.offerId)
  return ids
}

/**
 * Streams the source catalog, tallying it by primary data source, and (with
 * write) inserts eligible en/US products into the target data source.
 */
async function seed ({ productsClient, sourceProductsClient = productsClient, productInputs, source, target, options, log = () => {}, retry }) {
  const contentLanguage = defaults.contentLanguage || 'en'
  const feedLabel = defaults.feedLabel || 'US'
  const existing = options.overwrite ? new Set() : await listOfferIds(productsClient, target.accountId)
  const stats = {
    listed: 0,
    byDataSource: {},
    otherLocale: 0,
    otherDataSource: 0,
    alreadyInTarget: 0,
    overLimit: 0,
    eligible: 0,
    inserted: 0,
    failed: 0,
    failures: []
  }

  let batch = []
  const flush = async () => {
    const current = batch
    batch = []
    if (!options.write || !current.length) return
    const results = await runPool(current, p => callWithRetry(() => productInputs.insertProductInput({
      parent: `accounts/${target.accountId}`,
      dataSource: target.dataSource,
      productInput: toProductInput(p)
    }), retry), options.concurrency)
    results.forEach((r, i) => {
      if (r.ok) stats.inserted++
      else {
        stats.failed++
        if (stats.failures.length < FAILURE_SAMPLE_LIMIT) stats.failures.push({ offerId: current[i].offerId, status: r.error.status, message: r.error.message })
      }
    })
    log(`inserted ${stats.inserted}, failed ${stats.failed}`)
  }

  for await (const product of sourceProductsClient.listProductsAsync({ parent: `accounts/${source.accountId}`, pageSize: 1000 })) {
    stats.listed++
    const ds = dataSourceId(product.dataSource)
    stats.byDataSource[ds] = (stats.byDataSource[ds] || 0) + 1
    if (product.contentLanguage !== contentLanguage || product.feedLabel !== feedLabel) {
      stats.otherLocale++
      continue
    }
    if (options.sourceDataSource && ds !== options.sourceDataSource) {
      stats.otherDataSource++
      continue
    }
    if (existing.has(product.offerId)) {
      stats.alreadyInTarget++
      continue
    }
    if (options.limit != null && stats.eligible >= options.limit) {
      stats.overLimit++
      continue
    }
    stats.eligible++
    batch.push(product)
    if (batch.length >= BATCH_SIZE) await flush()
  }
  await flush()
  return stats
}

function report (stats, { source, target, options }) {
  const lines = [`Source accounts/${source.accountId}: ${stats.listed} products by primary data source:`]
  for (const [ds, n] of Object.entries(stats.byDataSource).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${ds}: ${n}${ds === source.dataSourceId ? '   <- our API data source (GMC_DATASOURCE_ID)' : ''}`)
  }
  if (source.dataSourceId && !stats.byDataSource[source.dataSourceId]) lines.push(`  (none in our API data source ${source.dataSourceId})`)
  lines.push(
    `Skipped: ${stats.otherLocale} not en/US, ${stats.otherDataSource} other data source, ${stats.alreadyInTarget} already in the test account, ${stats.overLimit} over --limit`,
    options.write
      ? `Inserted into ${target.dataSource}: ${stats.inserted} of ${stats.eligible} (${stats.failed} failed)`
      : `Dry run: would insert ${stats.eligible} into ${target.dataSource}. Re-run with --write to copy.`
  )
  if (stats.failures.length) lines.push(`Failure samples: ${JSON.stringify(stats.failures, null, 2)}`)
  return lines.join('\n')
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  const sourceEnv = parseEnvFile(options.sourceEnv)
  const targetEnv = parseEnvFile(options.targetEnv)
  const { source, target } = resolveTargets(sourceEnv, targetEnv)

  const { ProductsServiceClient, ProductInputsServiceClient } = require('@google-shopping/products').v1
  const { getAuthClient } = require('../actions/lib/auth')
  const sourceAuth = getAuthClient(sourceEnv)
  const targetAuth = getAuthClient(targetEnv)

  console.log(`${options.write ? 'WRITE' : 'DRY RUN'}: accounts/${source.accountId} (read only) -> ${target.dataSource}`)
  const stats = await seed({
    productsClient: new ProductsServiceClient({ auth: targetAuth }),
    sourceProductsClient: new ProductsServiceClient({ auth: sourceAuth }),
    productInputs: new ProductInputsServiceClient({ auth: targetAuth }),
    source,
    target,
    options,
    log: msg => console.log(msg)
  })
  console.log(`\n${report(stats, { source, target, options })}`)
}

if (require.main === module) {
  main().catch(e => {
    console.error(e.message || e)
    process.exit(1)
  })
}

module.exports = { parseArgs, parseEnvContent, resolveTargets, toProductInput, seed, report }
