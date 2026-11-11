const { parseArgs, parseEnvContent, resolveTargets, toProductInput, seed, report } = require('../../scripts/seed-test-account')

const prodEnv = { GMC_ENV: 'prod', GMC_MERCHANT_ACCOUNT_ID: '111', GMC_DATASOURCE_ID: '900' }
const testEnv = { GMC_ENV: 'test', GMC_MERCHANT_ACCOUNT_ID: '222', GMC_DATASOURCE_ID: '800' }

const product = (offerId, over = {}) => ({
  offerId,
  contentLanguage: 'en',
  feedLabel: 'US',
  dataSource: 'accounts/111/dataSources/900',
  productAttributes: { title: `Product ${offerId}`, link: `https://www.adobe.com/express/print/x/${offerId}` },
  customAttributes: [],
  ...over
})

function lister (byAccount) {
  return {
    listProductsAsync: jest.fn(async function * ({ parent }) {
      for (const p of byAccount[parent.split('/')[1]] || []) yield p
    })
  }
}

describe('seed-test-account', () => {
  test('defaults to a dry run from .env.prod into .env.stage', () => {
    expect(parseArgs([])).toMatchObject({ sourceEnv: '.env.prod', targetEnv: '.env.stage', write: false, concurrency: 10, limit: null })
    expect(parseArgs(['--write', '--limit', '5', '--source-datasource', 'accounts/1/dataSources/9'])).toMatchObject({ write: true, limit: 5, sourceDataSource: '9' })
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/)
  })

  test('reads .env files the way dotenv does: quotes, inline comments, export', () => {
    const json = '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nAB#C\\n-----END PRIVATE KEY-----\\n"}'
    const env = parseEnvContent([
      '# comment',
      'GMC_ENV=prod                    # test in .env.stage',
      `GMC_SERVICE_ACCOUNT_JSON='${json}'`,
      'export GMC_MERCHANT_ACCOUNT_ID="111"',
      `RAW=${json}`,
      'GMC_DATASOURCE_ID=900\r'
    ].join('\n'))
    expect(env).toEqual({ GMC_ENV: 'prod', GMC_SERVICE_ACCOUNT_JSON: json, GMC_MERCHANT_ACCOUNT_ID: '111', RAW: json, GMC_DATASOURCE_ID: '900' })
    expect(JSON.parse(env.GMC_SERVICE_ACCOUNT_JSON).type).toBe('service_account')
  })

  test('only ever writes to a GMC_ENV=test account that differs from the source', () => {
    expect(resolveTargets(prodEnv, testEnv)).toEqual({
      source: { accountId: '111', dataSourceId: '900' },
      target: { accountId: '222', dataSource: 'accounts/222/dataSources/800' }
    })
    expect(() => resolveTargets(testEnv, prodEnv)).toThrow(/GMC_ENV=test/)
    expect(() => resolveTargets(prodEnv, { ...testEnv, GMC_MERCHANT_ACCOUNT_ID: '111' })).toThrow(/same Merchant Center account/)
  })

  test('dry run tallies the source by data source and writes nothing', async () => {
    const productsClient = lister({
      111: [product('a'), product('b'), product('c', { dataSource: 'accounts/111/dataSources/555' }), product('d', { feedLabel: 'CA' })],
      222: [product('b')]
    })
    const productInputs = { insertProductInput: jest.fn() }
    const { source, target } = resolveTargets(prodEnv, testEnv)
    const stats = await seed({ productsClient, productInputs, source, target, options: { write: false, concurrency: 2 } })
    expect(stats).toMatchObject({ listed: 4, byDataSource: { 900: 3, 555: 1 }, otherLocale: 1, alreadyInTarget: 1, eligible: 2, inserted: 0 })
    expect(productInputs.insertProductInput).not.toHaveBeenCalled()
    expect(report(stats, { source, target, options: { write: false } })).toContain('900: 3   <- our API data source')
  })

  test('write inserts eligible products into the target data source, honoring --limit and --source-datasource', async () => {
    const productsClient = lister({ 111: [product('a'), product('b'), product('c', { dataSource: 'accounts/111/dataSources/555' }), product('e')], 222: [] })
    const productInputs = {
      insertProductInput: jest.fn(async req => {
        if (req.productInput.offerId === 'b') throw Object.assign(new Error('bad link'), { code: 3 })
        return [{}]
      })
    }
    const { source, target } = resolveTargets(prodEnv, testEnv)
    const stats = await seed({
      productsClient, productInputs, source, target, retry: { retryDelaysMs: [] },
      options: { write: true, concurrency: 2, limit: 2, sourceDataSource: '900' }
    })
    expect(stats).toMatchObject({ eligible: 2, inserted: 1, failed: 1, otherDataSource: 1, overLimit: 1 })
    expect(stats.failures).toEqual([{ offerId: 'b', status: 'INVALID_ARGUMENT', message: 'bad link' }])
    expect(productInputs.insertProductInput).toHaveBeenCalledWith({
      parent: 'accounts/222',
      dataSource: 'accounts/222/dataSources/800',
      productInput: toProductInput(product('a'))
    })
  })

  test('a processed Product converts into an insertable ProductInput without losing attributes', () => {
    const { protos } = require('@google-shopping/products')
    const v1 = protos.google.shopping.merchant.products.v1
    const processed = v1.Product.fromObject({
      name: 'accounts/111/products/en~US~a',
      offerId: 'a',
      contentLanguage: 'en',
      feedLabel: 'US',
      dataSource: 'accounts/111/dataSources/900',
      productAttributes: {
        title: 'Business card',
        link: 'https://www.adobe.com/express/print/business-card/a',
        price: { amountMicros: 15000000, currencyCode: 'USD' },
        availability: 'IN_STOCK',
        identifierExists: false
      },
      customAttributes: [{ name: 'minimum_order_quantity', value: '1' }]
    })
    const input = v1.ProductInput.toObject(v1.ProductInput.fromObject(toProductInput(processed)), { enums: String, longs: String })
    expect(input).toEqual({
      offerId: 'a',
      contentLanguage: 'en',
      feedLabel: 'US',
      productAttributes: {
        title: 'Business card',
        link: 'https://www.adobe.com/express/print/business-card/a',
        price: { amountMicros: '15000000', currencyCode: 'USD' },
        availability: 'IN_STOCK',
        identifierExists: false
      },
      customAttributes: [{ name: 'minimum_order_quantity', value: '1' }]
    })
  })
})
