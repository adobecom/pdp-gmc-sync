const { DbPriceStore, invalidatePriceRecords, OFFERS, RUNS, LOCKS } = require('../../actions/lib/priceStore')

function fakeClient () {
  const collections = {}
  const make = () => ({
    find: jest.fn(() => ({ toArray: async () => [] })),
    bulkWrite: jest.fn(async () => ({})),
    deleteMany: jest.fn(async () => ({})),
    countDocuments: jest.fn(async () => 0),
    insertOne: jest.fn(async () => ({})),
    updateOne: jest.fn(async () => ({})),
    deleteOne: jest.fn(async () => ({})),
    findOne: jest.fn(async () => { throw new Error('findOne must not be used: the service throws "Document not found" instead of returning null') })
  })
  return {
    collections,
    collection: jest.fn(name => (collections[name] ||= make())),
    close: jest.fn(async () => {})
  }
}

const NOW = new Date('2026-11-10T08:15:00Z')

describe('DbPriceStore', () => {
  test('applyResults sends one unordered bulkWrite per page, upserting only what it should', async () => {
    const client = fakeClient()
    const store = new DbPriceStore(client)
    const state = { currency: 'USD', priceMicros: '1', salePriceMicros: null, saleStart: null, saleEnd: null, availability: 'IN_STOCK', discontinued: false }
    await store.applyResults('run-1', NOW, [
      { offerId: 'a', templateId: 'ta', outcome: 'written', state, fingerprint: 'fp' },
      { offerId: 'b', outcome: 'unchanged' },
      { offerId: 'c', templateId: 'tc', outcome: 'failed', error: 'INTERNAL: boom' },
      { offerId: 'd', templateId: 'td', outcome: 'notFound', firstNotFound: true },
      { offerId: 'e', outcome: 'deleted' }
    ])
    const offers = client.collections[OFFERS]
    const [[ops, opts]] = offers.bulkWrite.mock.calls
    expect(opts).toEqual({ ordered: false })
    const byId = Object.fromEntries(ops.map(o => [o.updateOne.filter._id, o.updateOne]))
    expect(byId.a).toMatchObject({ upsert: true, update: { $set: { sent: { ...state, fingerprint: 'fp' }, sentAt: NOW, lastSeenRunId: 'run-1', failCount: 0 } } })
    expect(byId.b).toEqual({ filter: { _id: 'b' }, update: { $set: { lastSeenRunId: 'run-1', lastSeenAt: NOW } }, upsert: false })
    expect(byId.c).toMatchObject({ upsert: true, update: { $inc: { failCount: 1 }, $set: { lastError: 'INTERNAL: boom' } } })
    expect(byId.d).toMatchObject({ upsert: true, update: { $set: { notInGmc: true, notInGmcSince: NOW }, $unset: { sent: '', sentAt: '' } } })
    expect(byId.e).toBeUndefined()
    expect(offers.deleteMany).toHaveBeenCalledWith({ _id: { $in: ['e'] } })
  })

  test('delete candidates are offers we have sent that this run has not seen', async () => {
    const client = fakeClient()
    const store = new DbPriceStore(client)
    const offers = client.collection(OFFERS)
    offers.countDocuments.mockResolvedValue(2)
    offers.find.mockReturnValue({ toArray: async () => [{ _id: 'x' }, { _id: 'y' }] })
    expect(await store.findUnseenManaged('run-9', 100)).toEqual({ total: 2, offerIds: ['x', 'y'] })
    expect(offers.find).toHaveBeenCalledWith({ sentAt: { $ne: null }, lastSeenRunId: { $ne: 'run-9' } }, { projection: { _id: 1 }, limit: 100 })
  })

  describe('lock (decided from write results, never by reading the lock back)', () => {
    const duplicate = () => Object.assign(new Error('Request x to v1/collection/price_sync_locks/insertOne failed with code 409: E11000 duplicate key error'), { httpStatusCode: 409 })

    test('a successful insert holds the lock', async () => {
      const client = fakeClient()
      const locks = client.collection(LOCKS)
      expect(await new DbPriceStore(client).acquireLock('me', NOW, 1000)).toEqual({ acquired: true })
      expect(locks.insertOne).toHaveBeenCalledWith({ _id: 'price-sync', holder: 'me', heldUntil: new Date(NOW.getTime() + 1000) })
      expect(locks.updateOne).not.toHaveBeenCalled()
    })

    test('an existing but expired lock is taken over atomically', async () => {
      const client = fakeClient()
      const locks = client.collection(LOCKS)
      locks.insertOne.mockRejectedValueOnce(duplicate())
      locks.updateOne.mockResolvedValueOnce({ acknowledged: true, matchedCount: 1, modifiedCount: 1 })
      expect(await new DbPriceStore(client).acquireLock('me', NOW, 1000)).toEqual({ acquired: true, tookOver: true })
      expect(locks.updateOne).toHaveBeenCalledWith({ _id: 'price-sync', heldUntil: { $lt: NOW } }, { $set: { holder: 'me', heldUntil: new Date(NOW.getTime() + 1000) } })
    })

    test('a live lock is refused and reports its holder', async () => {
      const client = fakeClient()
      const locks = client.collection(LOCKS)
      locks.insertOne.mockRejectedValueOnce(duplicate())
      locks.updateOne.mockResolvedValueOnce({ acknowledged: true, matchedCount: 0, modifiedCount: 0 })
      const heldUntil = new Date(NOW.getTime() + 60000)
      locks.find.mockReturnValueOnce({ toArray: async () => [{ _id: 'price-sync', holder: 'other', heldUntil }] })
      expect(await new DbPriceStore(client).acquireLock('me', NOW, 1000)).toEqual({ acquired: false, holder: 'other', heldUntil })
    })

    test('any other insert failure is an error, not "locked"', async () => {
      const client = fakeClient()
      const locks = client.collection(LOCKS)
      locks.insertOne.mockRejectedValueOnce(Object.assign(new Error('failed with code 503'), { httpStatusCode: 503 }))
      await expect(new DbPriceStore(client).acquireLock('me', NOW, 1000)).rejects.toThrow('503')
      expect(locks.updateOne).not.toHaveBeenCalled()
    })
  })

  test('latest run lookups sort by startedAt', async () => {
    const client = fakeClient()
    const store = new DbPriceStore(client)
    const runs = client.collection(RUNS)
    runs.find.mockReturnValue({ toArray: async () => [{ _id: 'r1', status: 'complete' }] })
    expect(await store.getLastCompleteRun()).toEqual({ _id: 'r1', status: 'complete' })
    expect(runs.find).toHaveBeenCalledWith({ status: 'complete' }, { sort: { startedAt: -1 }, limit: 1 })
  })
})

describe('invalidatePriceRecords', () => {
  const params = { __ims_oauth_s2s: { client_id: 'x' } }

  test('skipped without include-ims-credentials or offers', async () => {
    const open = jest.fn()
    expect(await invalidatePriceRecords({}, ['a'], null, { open })).toEqual({ skipped: true })
    expect(await invalidatePriceRecords(params, [], null, { open })).toEqual({ skipped: true })
    expect(open).not.toHaveBeenCalled()
  })

  test('drops the records and closes the connection', async () => {
    const store = { invalidateOffers: jest.fn(async () => {}), close: jest.fn(async () => {}) }
    expect(await invalidatePriceRecords(params, ['a', 'b'], null, { open: async () => store })).toEqual({ ok: true })
    expect(store.invalidateOffers).toHaveBeenCalledWith(['a', 'b'])
    expect(store.close).toHaveBeenCalled()
  })

  test('never throws: failures and timeouts are logged and reported', async () => {
    const logger = { error: jest.fn() }
    const failing = await invalidatePriceRecords(params, ['a'], logger, { open: async () => { throw new Error('no db') } })
    expect(failing).toEqual({ ok: false, error: 'no db' })
    const slow = await invalidatePriceRecords(params, ['a'], logger, { timeoutMs: 10, open: () => new Promise(() => {}) })
    expect(slow).toEqual({ ok: false, error: 'timed out after 10ms' })
    expect(logger.error).toHaveBeenCalledTimes(2)
  })
})
