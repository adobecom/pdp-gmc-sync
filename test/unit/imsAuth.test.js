const mockValidateToken = jest.fn()
const mockValidateTokenAllowList = jest.fn()
const mockDecodeImsToken = jest.fn()

jest.mock('@adobe/aio-lib-ims', () => ({
  Ims: jest.fn(() => ({
    validateToken: mockValidateToken,
    validateTokenAllowList: mockValidateTokenAllowList
  })),
  getTokenData: mockDecodeImsToken
}))

const { isValidImsToken } = require('../../actions/lib/imsAuth')

describe('IMS authentication diagnostics', () => {
  beforeEach(() => {
    mockValidateToken.mockReset().mockResolvedValue({ valid: true })
    mockValidateTokenAllowList.mockReset().mockResolvedValue({ valid: true })
    mockDecodeImsToken.mockReset().mockReturnValue({
      as: 'ims-na1',
      client_id: 'da-live-client',
      type: 'access_token'
    })
  })

  test('logs selected claims and validation results without logging the bearer token', async () => {
    const token = 'raw-secret-token'
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})

    const valid = await isValidImsToken({
      __ow_headers: { authorization: `Bearer ${token}` }
    })

    expect(valid).toBe(true)
    expect(mockDecodeImsToken).toHaveBeenCalledWith(token)
    expect(mockValidateToken).toHaveBeenCalledWith(token)
    expect(mockValidateTokenAllowList).toHaveBeenCalledWith(token, ['<da.live client_id>', 'projectx_webapp', 'darkalley'])

    const output = log.mock.calls.flat().join(' ')
    expect(output).toContain('"as":"ims-na1"')
    expect(output).toContain('"client_id":"da-live-client"')
    expect(output).toContain('allowList=true')
    expect(output).not.toContain(token)

    log.mockRestore()
  })

  test('rejects a token that fails the client allow-list', async () => {
    mockValidateTokenAllowList.mockResolvedValue({ valid: false, reason: 'client not allowed' })
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})

    const valid = await isValidImsToken({
      __ow_headers: { authorization: 'Bearer signed-token' }
    })

    expect(valid).toBe(false)
    log.mockRestore()
  })
})