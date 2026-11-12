const { MemoryPriceStore } = require('../../actions/lib/priceStore')
const { schedulerTick, PRICE_SYNC_ACTION } = require('../../actions/lib/priceSyncScheduler')
const { DEFAULT_SETTINGS } = require('../../actions/lib/priceSyncSettings')

const at = iso => new Date(iso)

function setup () {
  const store = new MemoryPriceStore()
  const invoke = jest.fn(async () => 'act-1')
  const tick = (iso, mode = 'live') => schedulerTick({ store, now: at(iso), invoke, mode })
  return { store, invoke, tick }
}

describe('schedulerTick', () => {
  test('starts each scheduled slot exactly once', async () => {
    const { store, invoke, tick } = setup()
    expect(await tick('2026-11-12T08:00:00Z')).toMatchObject({ action: 'none', reason: 'nothing due' })
    expect(await tick('2026-11-12T08:15:02Z')).toMatchObject({ action: 'started', slot: '2026-11-12T08:15:00.000Z' })
    await store.createRun({ _id: 'r1', slot: '2026-11-12T08:15:00.000Z', status: 'complete', startedAt: at('2026-11-12T08:15:05Z') })
    expect(await tick('2026-11-12T08:30:00Z')).toMatchObject({ action: 'none' })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(PRICE_SYNC_ACTION, { slot: '2026-11-12T08:15:00.000Z', trigger: 'schedule' })
  })

  test('does nothing while paused, a run holds the lock, or the mode is off', async () => {
    const { store, invoke, tick } = setup()
    expect(await tick('2026-11-12T08:15:00Z', 'off')).toMatchObject({ action: 'none' })
    await store.acquireLock('other', at('2026-11-12T08:00:00Z'), 30 * 60 * 1000)
    expect(await tick('2026-11-12T08:15:00Z')).toMatchObject({ reason: 'a run is in progress' })
    await store.releaseLock('other')
    await store.saveSettings({ ...DEFAULT_SETTINGS, paused: true }, { by: 'a@adobe.com', at: at('2026-11-01T00:00:00Z'), expectedVersion: 0 })
    expect(await tick('2026-11-12T08:15:00Z')).toMatchObject({ reason: 'paused' })
    expect(invoke).not.toHaveBeenCalled()
  })

  test('a failed invoke releases the slot so the next tick retries it', async () => {
    const { invoke, tick } = setup()
    invoke.mockRejectedValueOnce(new Error('HTTP 502'))
    await expect(tick('2026-11-12T08:15:00Z')).rejects.toThrow('HTTP 502')
    expect(await tick('2026-11-12T08:30:00Z')).toMatchObject({ action: 'started', slot: '2026-11-12T08:15:00.000Z' })
  })

  test('a claimed slot whose run never started is retried every 10 minutes, at most 3 attempts in all', async () => {
    const { invoke, tick } = setup()
    expect(await tick('2026-11-12T08:15:00Z')).toMatchObject({ action: 'started' })
    expect(await tick('2026-11-12T08:20:00Z')).toMatchObject({ action: 'none' })
    expect(await tick('2026-11-12T08:30:00Z')).toMatchObject({ action: 'retried', attempt: 2 })
    expect(await tick('2026-11-12T08:45:00Z')).toMatchObject({ action: 'retried', attempt: 3 })
    expect(await tick('2026-11-12T09:00:00Z')).toMatchObject({ action: 'none' })
    expect(invoke).toHaveBeenCalledTimes(3)

    const s = setup()
    await s.tick('2026-11-12T08:15:00Z')
    await s.store.createRun({ _id: 'r1', slot: '2026-11-12T08:15:00.000Z', status: 'complete', startedAt: at('2026-11-12T08:15:05Z') })
    expect(await s.tick('2026-11-12T08:30:00Z')).toMatchObject({ action: 'none' })
  })

  test('resumes a pass cut short once it has been quiet for a while, at most hourly', async () => {
    const { store, invoke, tick } = setup()
    await store.claimSlot('2026-11-12T08:15:00.000Z', {})
    await store.createRun({ _id: 'r1', slot: '2026-11-12T08:15:00.000Z', trigger: 'schedule', status: 'aborted', startedAt: at('2026-11-12T08:15:00Z'), heartbeatAt: at('2026-11-12T09:00:00Z'), resumeCount: 0 })
    expect(await tick('2026-11-12T09:15:00Z')).toMatchObject({ action: 'none' })
    expect(await tick('2026-11-12T09:45:00Z')).toMatchObject({ action: 'resumed', run: 'r1' })
    expect(await tick('2026-11-12T10:00:00Z')).toMatchObject({ action: 'none' })
    expect(invoke).toHaveBeenCalledWith(PRICE_SYNC_ACTION, { slot: '2026-11-12T08:15:00.000Z', trigger: 'schedule' })
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
