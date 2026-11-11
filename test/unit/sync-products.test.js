jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ debug: () => {}, info: () => {}, error: () => {} }) }
}))
const mockValidateToken = jest.fn(async token => ({ valid: token === 'stub' }))
const mockValidateTokenAllowList = jest.fn(async token => ({ valid: token === 'stub' }))
const mockGetTokenData = jest.fn(() => ({
  as: 'ims-na1',
  client_id: '<da.live client_id>',
  type: 'access_token'
}))
jest.mock('@adobe/aio-lib-ims', () => ({
  Ims: jest.fn(() => ({
    validateToken: mockValidateToken,
    validateTokenAllowList: mockValidateTokenAllowList
  })),
  getTokenData: mockGetTokenData
}))
jest.mock('../../actions/lib/gmcClients', () => ({
  makeClients: jest.fn((params) => {
    if (!params.GMC_SERVICE_ACCOUNT_JSON) {
      throw new Error('GMC credentials not configured')
    }
    return {
      productInputs: { insertProductInput: jest.fn(async () => [{ name: 'accounts/1/productInputs/en~US~x' }]) }
    }
  })
}))

jest.mock('../../actions/lib/priceStore', () => ({
  invalidatePriceRecords: jest.fn(async () => ({ ok: true }))
}))

const { makeClients } = require('../../actions/lib/gmcClients')
const { invalidatePriceRecords } = require('../../actions/lib/priceStore')
const action = require('../../actions/sync-products/index')

const validEnv = {
  GMC_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account',
    project_id: 'adbe-gcp1060',
    private_key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n',
    client_email: 'express-tools-gcp-account@adbe-gcp1060.iam.gserviceaccount.com'
  }),
  GMC_GCP_PROJECT_ID: 'adbe-gcp1060',
  GMC_ENV: 'test',
  GMC_MERCHANT_ACCOUNT_ID: '12345',
  GMC_DATASOURCE_ID: '9876',
  __ow_headers: { authorization: 'Bearer stub' }
}

const goodRow = {
  product_id: 'zaz-1',
  title: 'A thing',
  description: 'A perfectly nice thing.',
  link: 'https://www.adobe.com/express/print/mug/a-thing',
  initial_pretty_preferred_view_url: 'https://cdn.example.com/x.png',
  price: '9.99',
  google_product_category: '123'
}

describe('sync-products action', () => {
  beforeEach(() => {
    mockValidateToken.mockClear()
    mockValidateTokenAllowList.mockClear()
    mockGetTokenData.mockClear()
    makeClients.mockClear()
  })

  test('500 when GMC_ENV is missing or invalid (server misconfigured)', async () => {
    const noGmcEnv = { ...validEnv }
    delete noGmcEnv.GMC_ENV
    let res = await action.main({ ...noGmcEnv, products: [goodRow] })
    expect(res.error?.statusCode).toBe(500)
    res = await action.main({ ...validEnv, GMC_ENV: 'staging', products: [goodRow] })
    expect(res.error?.statusCode).toBe(500)
    expect(makeClients).not.toHaveBeenCalled()
  })

  test('400 when Authorization header missing', async () => {
    const noAuth = { ...validEnv }
    delete noAuth.__ow_headers
    const res = await action.main({ ...noAuth, products: [goodRow] })
    expect(res.error?.statusCode).toBe(400)
    expect(res.error.body.error).toMatch(/Authorization/i)
  })

  test('401 when the bearer token is not a valid IMS token', async () => {
    mockValidateTokenAllowList.mockResolvedValueOnce({ valid: false })
    const res = await action.main({ ...validEnv, products: [goodRow] })
    expect(res.error?.statusCode).toBe(401)
    expect(res.error.body.error).toBe('invalid IMS token')
    expect(mockValidateTokenAllowList).toHaveBeenCalledWith('stub', ['<da.live client_id>', 'projectx_webapp', 'darkalley'])
    expect(makeClients).not.toHaveBeenCalled()
  })

  test('503 when IMS token validation is unavailable', async () => {
    mockValidateTokenAllowList.mockRejectedValueOnce(new Error('IMS unavailable'))
    const res = await action.main({ ...validEnv, products: [goodRow] })
    expect(res.error?.statusCode).toBe(503)
    expect(res.error.body.error).toBe('unable to validate IMS token')
    expect(makeClients).not.toHaveBeenCalled()
  })

  test('400 when products missing or empty', async () => {
    let res = await action.main({ ...validEnv })
    expect(res.error?.statusCode).toBe(400)
    res = await action.main({ ...validEnv, products: [] })
    expect(res.error?.statusCode).toBe(400)
  })

  test('400 when chunk exceeds MAX_CHUNK (100)', async () => {
    const products = Array.from({ length: 101 }, (_, i) => ({ ...goodRow, product_id: `p-${i}` }))
    const res = await action.main({ ...validEnv, products })
    expect(res.error?.statusCode).toBe(400)
    expect(res.error.body.error).toMatch(/100/)
  })

  test('happy path returns the new response contract with pushedIds', async () => {
    const products = [goodRow, { ...goodRow, product_id: 'zaz-2' }]
    const res = await action.main({ ...validEnv, products })
    expect(res.statusCode).toBe(200)
    expect(res.body.env).toBe('test')
    expect(res.body.dataSource).toEqual(expect.any(String))
    expect(res.body.submitted).toBe(2)
    expect(res.body.succeeded).toBe(2)
    expect(res.body.failed).toBe(0)
    expect(res.body.pushedIds).toEqual(['zaz-1', 'zaz-2'])
    expect(res.body.failedItems).toEqual([])
  })

  test('drops price-sync records for re-inserted offers so the next price pass rewrites them', async () => {
    invalidatePriceRecords.mockClear()
    const products = [goodRow, { ...goodRow, product_id: '' }]
    await action.main({ ...validEnv, products })
    expect(invalidatePriceRecords).toHaveBeenCalledWith(expect.objectContaining({ GMC_ENV: 'test' }), ['zaz-1'], expect.anything())
  })

  test('validation failures appear in failedItems, do not abort the batch, and still return 200', async () => {
    const products = [goodRow, { ...goodRow, product_id: '' }]
    const res = await action.main({ ...validEnv, products })
    expect(res.statusCode).toBe(200)
    expect(res.body.submitted).toBe(2)
    expect(res.body.succeeded).toBe(1)
    expect(res.body.failed).toBe(1)
    expect(res.body.pushedIds).toEqual(['zaz-1'])
    expect(res.body.failedItems).toHaveLength(1)
    expect(res.body.failedItems[0]).toEqual(expect.objectContaining({
      reason: expect.stringMatching(/VALIDATION_ERROR/)
    }))
  })

  test('returns 200, not 500, even when every item fails', async () => {
    const badRow = { ...goodRow, product_id: '' }
    const products = [badRow, { ...badRow, title: '' }]
    const res = await action.main({ ...validEnv, products })
    expect(res.statusCode).toBe(200)
    expect(res.body.submitted).toBe(2)
    expect(res.body.succeeded).toBe(0)
    expect(res.body.failed).toBe(2)
    expect(res.body.pushedIds).toEqual([])
    expect(res.body.failedItems).toHaveLength(2)
  })

  test('500 when creds are missing (fails closed) — pre-flight failure, no items attempted', async () => {
    const noCredentials = { ...validEnv }
    delete noCredentials.GMC_SERVICE_ACCOUNT_JSON
    const res = await action.main({ ...noCredentials, products: [goodRow] })
    expect(res.error?.statusCode).toBe(500)
  })
})
