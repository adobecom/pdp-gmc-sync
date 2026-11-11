const { validateRow, validateRows, validateLink, MAX_CHUNK } = require('../../actions/lib/validate')

const good = {
  product_id: 'urn:aaid:sc:VA6C2:abc',
  title: 'A thing',
  description: 'A perfectly nice thing.',
  link: 'https://www.adobe.com/express/print/mug/a-thing',
  initial_pretty_preferred_view_url: 'https://cdn.example.com/x.png',
  price: '9.99',
  google_product_category: '123'
}

describe('validateRow', () => {
  test('accepts a well-formed row', () => {
    expect(validateRow(good)).toBeNull()
  })
  test('rejects missing product_id', () => {
    expect(validateRow({ ...good, product_id: '' })).toMatch(/product_id/)
  })
  test('rejects missing title', () => {
    expect(validateRow({ ...good, title: '' })).toMatch(/title/)
  })
  test('rejects non-http image', () => {
    expect(validateRow({ ...good, initial_pretty_preferred_view_url: 'javascript:alert(1)' })).toMatch(/http/i)
  })
  test('accepts image_link fallback', () => {
    const { initial_pretty_preferred_view_url: _, ...rest } = good
    expect(validateRow({ ...rest, image_link: 'https://cdn.example.com/x.png' })).toBeNull()
  })
  test('rejects negative price', () => {
    expect(validateRow({ ...good, price: -1 })).toMatch(/price/i)
  })
  test('rejects non-string description', () => {
    expect(validateRow({ ...good, description: 42 })).toMatch(/description/)
  })
  test('rejects missing description', () => {
    const { description, ...rest } = good
    expect(validateRow(rest)).toMatch(/description/)
  })
  test('rejects empty description', () => {
    expect(validateRow({ ...good, description: '' })).toMatch(/description/)
    expect(validateRow({ ...good, description: '   ' })).toMatch(/description/)
  })
  test('rejects description over the max length', () => {
    expect(validateRow({ ...good, description: 'x'.repeat(5001) })).toMatch(/description/)
  })
  test('rejects non-object rows', () => {
    expect(validateRow(null)).toMatch(/object/)
    expect(validateRow('str')).toMatch(/object/)
  })
})

describe('google_product_category is mandatory', () => {
  test('rejects a row with neither product_type nor an explicit override', () => {
    const { google_product_category: _, ...rest } = good
    expect(validateRow(rest)).toMatch(/google_product_category missing/)
  })
  test('rejects a row whose product_type has no category-map entry', () => {
    const { google_product_category: _, ...rest } = good
    expect(validateRow({ ...rest, product_type: 'zazzle_totally_unmapped_type' }))
      .toMatch(/could not be resolved for product_type "zazzle_totally_unmapped_type"/)
  })
  test('accepts a row whose product_type resolves via config/category-map.json', () => {
    const { google_product_category: _, ...rest } = good
    expect(validateRow({ ...rest, product_type: 'zazzle_mug' })).toBeNull()
  })
  test('accepts an explicit google_product_category even with no product_type at all', () => {
    expect(validateRow(good)).toBeNull() // `good` already carries the explicit override, no product_type
  })
})

describe('link allowlist', () => {
  test('accepts adobe.com production host', () => {
    expect(validateLink('https://www.adobe.com/express/print/mug/x')).toBeNull()
  })
  test('accepts aem.live preview host', () => {
    expect(validateLink('https://main--da-express-milo--adobecom.aem.live/express/print/mug/x')).toBeNull()
  })
  test('rejects http (non-HTTPS)', () => {
    expect(validateLink('http://www.adobe.com/express/print/mug/x')).toMatch(/https/i)
  })
  test('rejects a non-allowlisted host', () => {
    expect(validateLink('https://evil.example.com/express/print/mug/x')).toMatch(/allowlist/i)
  })
  test('rejects a malformed URL', () => {
    expect(validateLink('not-a-url')).toMatch(/valid URL|https/i)
  })
  test('rejects missing link', () => {
    expect(validateLink('')).toMatch(/missing/)
    expect(validateLink(undefined)).toMatch(/missing/)
  })
  test('catches the userinfo trick (https://good.com@evil.com resolves to evil.com)', () => {
    // new URL('https://www.adobe.com@evil.com/').hostname === 'evil.com'
    expect(validateLink('https://www.adobe.com@evil.com/foo')).toMatch(/allowlist/i)
  })
  test('validateRow rejects rows with a bad link', () => {
    expect(validateRow({ ...good, link: 'http://www.adobe.com/express/print/mug/x' })).toMatch(/https/i)
    expect(validateRow({ ...good, link: 'https://evil.com/express/print/mug/x' })).toMatch(/allowlist/i)
    const { link: _, ...noLink } = good
    expect(validateRow(noLink)).toMatch(/link/i)
  })
})

describe('additional_images validation', () => {
  test('accepts a row with no additional_images field at all', () => {
    expect(validateRow(good)).toBeNull()
  })
  test('accepts a well-formed additional_images array', () => {
    const additional_images = ['https://cdn.example.com/x-2.png', 'https://cdn.example.com/x-3.png']
    expect(validateRow({ ...good, additional_images })).toBeNull()
  })
  test('accepts an empty additional_images array', () => {
    expect(validateRow({ ...good, additional_images: [] })).toBeNull()
  })
  test('rejects additional_images that is not an array', () => {
    expect(validateRow({ ...good, additional_images: 'https://cdn.example.com/x-2.png' }))
      .toMatch(/additional_images must be an array/)
  })
  test('rejects a non-string/empty entry', () => {
    expect(validateRow({ ...good, additional_images: [''] })).toMatch(/additional_images\[0\] missing or invalid/)
    expect(validateRow({ ...good, additional_images: [42] })).toMatch(/additional_images\[0\] missing or invalid/)
  })
  test('rejects a non-http(s) entry', () => {
    expect(validateRow({ ...good, additional_images: ['javascript:alert(1)'] }))
      .toMatch(/additional_images\[0\] must be an http\(s\) URL/)
  })
  test('rejects an overlong entry', () => {
    const tooLong = 'https://cdn.example.com/' + 'x'.repeat(2000) + '.png'
    expect(validateRow({ ...good, additional_images: [tooLong] })).toMatch(/additional_images\[0\] missing or invalid/)
  })
  test('one bad entry rejects the whole row, even alongside good entries', () => {
    const additional_images = ['https://cdn.example.com/x-2.png', 'not-a-url']
    expect(validateRow({ ...good, additional_images })).toMatch(/additional_images\[1\]/)
  })
})

describe('validateRows', () => {
  test('partitions valid vs invalid', () => {
    const rows = [good, { ...good, product_id: '' }, { ...good, product_id: 'z2' }]
    const { valid, invalid } = validateRows(rows)
    expect(valid.length).toBe(2)
    expect(invalid.length).toBe(1)
    expect(invalid[0].reason).toMatch(/product_id/)
  })
})

describe('MAX_CHUNK', () => {
  test('is 100, sized to stay well under the 60s blocking web-action timeout', () => {
    expect(MAX_CHUNK).toBe(100)
  })
})
