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

const mockClients = { reports: {}, products: {} }
const mockMakeClients = jest.fn(() => mockClients)
jest.mock('../../actions/lib/gmcClients', () => ({ makeClients: mockMakeClients }))
jest.mock('../../actions/lib/config', () => ({
  ENVS: new Set(['test', 'prod']),
  resolveAccount: jest.fn(() => '12345'),
  resolveDataSource: jest.fn(() => 'accounts/12345/dataSources/67890')
}))

const productDiagnostics = [{
  id: 'en~US~offer-1',
  offerId: 'offer-1',
  aggregatedReportingContextStatus: 'ELIGIBLE',
  statusPerReportingContext: [],
  itemIssues: []
}]
const mockSearchProductDiagnostics = jest.fn(async () => productDiagnostics)
const mockSummarizeProductDiagnostics = jest.fn(() => ({
  counts: { active: 1, limited: 0, pending: 0, disapproved: 0, unknown: 0, error: 0 },
  itemIssueTop: []
}))
jest.mock('../../actions/lib/diagnostics', () => ({
  searchProductDiagnostics: mockSearchProductDiagnostics,
  summarizeProductDiagnostics: mockSummarizeProductDiagnostics
}))
const mockState = { delete: jest.fn() }
const mockInitState = jest.fn(async () => mockState)
const mockClearPushes = jest.fn(async () => {})
jest.mock('../../actions/lib/syncState', () => ({
  initState: mockInitState,
  clearPushes: mockClearPushes
}))
jest.mock('../../actions/lib/slack', () => ({
  postSlack: jest.fn(async () => {}),
  formatDigest: jest.fn(() => 'digest')
}))
jest.mock('../../actions/lib/redact', () => ({ redact: jest.fn(() => '{}') }))

const action = require('../../actions/diagnostics/index')

const validParams = {
  GMC_ENV: 'test',
  __ow_headers: { authorization: 'Bearer stub' }
}

describe('diagnostics action IMS authorization', () => {
  beforeEach(() => {
    mockValidateToken.mockClear()
    mockValidateTokenAllowList.mockClear()
    mockGetTokenData.mockClear()
    mockMakeClients.mockClear()
    mockSearchProductDiagnostics.mockClear()
    mockSummarizeProductDiagnostics.mockClear()
    mockInitState.mockClear()
    mockClearPushes.mockClear()
  })

  test('validates the bearer token before reading Merchant Center', async () => {
    const res = await action.main(validParams)
    expect(res.statusCode).toBe(200)
    expect(mockValidateTokenAllowList).toHaveBeenCalledWith('stub', expect.arrayContaining(['<da.live client_id>']))
    expect(mockMakeClients).toHaveBeenCalledTimes(1)
    expect(mockSearchProductDiagnostics).toHaveBeenCalledWith(
      mockClients.reports,
      mockClients.products,
      '12345',
      'accounts/12345/dataSources/67890',
      null
    )
    expect(res.body).toEqual(expect.objectContaining({
      accountId: '12345',
      dataSource: 'accounts/12345/dataSources/67890',
      offerCount: 1,
      results: productDiagnostics
    }))
    expect(mockClearPushes).toHaveBeenCalledWith(
      mockState,
      'test',
      '12345',
      ['offer-1'],
      expect.anything()
    )
  })

  test('deduplicates requested offers and reports source-scoped offers not yet available', async () => {
    const res = await action.main({ ...validParams, offerIds: ['offer-1', 'missing', 'offer-1'] })
    expect(mockSearchProductDiagnostics).toHaveBeenCalledWith(
      mockClients.reports,
      mockClients.products,
      '12345',
      'accounts/12345/dataSources/67890',
      ['offer-1', 'missing']
    )
    expect(res.body.requestedOfferCount).toBe(2)
    expect(res.body.missingOfferIds).toEqual(['missing'])
    expect(mockClearPushes).toHaveBeenCalledWith(
      mockState,
      'test',
      '12345',
      ['offer-1'],
      expect.anything()
    )
  })

  test('unpacks comma-separated pushedIds before querying Google', async () => {
    mockSearchProductDiagnostics.mockResolvedValueOnce([])
    mockSummarizeProductDiagnostics.mockReturnValueOnce({
      counts: { active: 0, limited: 0, pending: 0, disapproved: 0, unknown: 0, error: 0 },
      itemIssueTop: []
    })
    const offerIds = ['first', 'second', 'third']
    const res = await action.main({ ...validParams, offerIds: [offerIds.join(',')] })

    expect(mockSearchProductDiagnostics).toHaveBeenCalledWith(
      mockClients.reports,
      mockClients.products,
      '12345',
      'accounts/12345/dataSources/67890',
      offerIds
    )
    expect(res.body).toEqual(expect.objectContaining({
      requestedOfferCount: 3,
      offerCount: 0,
      missingOfferIds: offerIds
    }))
  })

  test('passes through exactly 50 offerIds in one Google query', async () => {
    const offerIds = Array.from({ length: 50 }, (_, index) => `offer-${index}`)
    const res = await action.main({ ...validParams, offerIds })

    expect(mockSearchProductDiagnostics).toHaveBeenCalledWith(
      mockClients.reports,
      mockClients.products,
      '12345',
      'accounts/12345/dataSources/67890',
      offerIds
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.requestedOfferCount).toBe(50)
  })

  test('rejects more than 100 offerIds without querying Google', async () => {
    const offerIds = Array.from({ length: 101 }, (_, index) => `offer-${index}`)
    const res = await action.main({ ...validParams, offerIds })

    expect(res.error?.statusCode).toBe(400)
    expect(res.error.body.error).toContain('keep <= 100')
    expect(mockSearchProductDiagnostics).not.toHaveBeenCalled()
  })

  test('rejects an oversized serialized response before clearing State', async () => {
    const oversized = { ...productDiagnostics[0], title: 'x'.repeat(1024 * 1024) }
    mockSearchProductDiagnostics.mockResolvedValueOnce([oversized])
    const res = await action.main({ ...validParams, offerIds: ['offer-1'] })

    expect(res.error?.statusCode).toBe(413)
    expect(res.error.body.error).toContain('retry with fewer offerIds')
    expect(mockClearPushes).not.toHaveBeenCalled()
  })

  test('returns 401 without creating GMC clients for an invalid token', async () => {
    mockValidateTokenAllowList.mockResolvedValueOnce({ valid: false })
    const res = await action.main(validParams)
    expect(res.error?.statusCode).toBe(401)
    expect(res.error.body.error).toBe('invalid IMS token')
    expect(mockMakeClients).not.toHaveBeenCalled()
  })

  test('returns 503 without creating GMC clients when IMS is unavailable', async () => {
    mockValidateTokenAllowList.mockRejectedValueOnce(new Error('IMS unavailable'))
    const res = await action.main(validParams)
    expect(res.error?.statusCode).toBe(503)
    expect(res.error.body.error).toBe('unable to validate IMS token')
    expect(mockMakeClients).not.toHaveBeenCalled()
  })
})