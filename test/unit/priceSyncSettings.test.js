const { validateSettings, effectiveSettings, dueSlot, nextRuns, zonedToUtc, DEFAULT_SETTINGS } = require('../../actions/lib/priceSyncSettings')

const settings = over => ({ ...DEFAULT_SETTINGS, ...over })

describe('validateSettings', () => {
  test('accepts defaults and sorts schedule times', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, scheduleTimes: ['14:00', '00:15'] })).toMatchObject({ ok: true, value: { scheduleTimes: ['00:15', '14:00'] } })
  })

  test.each([
    [{ scheduleTimes: [] }, 'scheduleTimes'],
    [{ scheduleTimes: ['00:10'] }, 'scheduleTimes'],
    [{ scheduleTimes: ['00:15', '01:15'] }, 'scheduleTimes'],
    [{ scheduleTimes: ['23:30', '00:15'] }, 'scheduleTimes'],
    [{ refreshAfterDays: 20, refreshJitterDays: 7 }, 'refreshJitterDays'],
    [{ maxWritesPerRun: -1 }, 'maxWritesPerRun'],
    [{ deletes: 'yes' }, 'deletes'],
    [{ paused: 'no' }, 'paused'],
    [{ surprise: 1 }, 'surprise']
  ])('rejects %j', (input, field) => {
    const r = validateSettings({ ...DEFAULT_SETTINGS, ...input })
    expect(r.ok).toBe(false)
    expect(r.errors).toHaveProperty(field)
  })

  test('an invalid stored doc falls back to defaults and says why', () => {
    const eff = effectiveSettings({ _id: 'current', ...DEFAULT_SETTINGS, refreshAfterDays: 40, version: 3 })
    expect(eff.settings).toEqual(DEFAULT_SETTINGS)
    expect(eff.version).toBe(3)
    expect(eff.problem).toMatch(/refreshAfterDays/)
  })
})

describe('schedule (Pacific time)', () => {
  test('wall-clock times convert across daylight saving', () => {
    expect(zonedToUtc(2026, 7, 1, 0, 15).toISOString()).toBe('2026-07-01T07:15:00.000Z')
    expect(zonedToUtc(2026, 11, 12, 0, 15).toISOString()).toBe('2026-11-12T08:15:00.000Z')
  })

  test('dueSlot: the latest time already reached, within the grace window', () => {
    const s = settings({ scheduleTimes: ['00:15', '12:00'] })
    expect(dueSlot(new Date('2026-11-12T08:14:30Z'), s)?.toISOString()).toBe('2026-11-12T08:15:00.000Z')
    expect(dueSlot(new Date('2026-11-12T09:30:00Z'), s)?.toISOString()).toBe('2026-11-12T08:15:00.000Z')
    expect(dueSlot(new Date('2026-11-12T11:00:00Z'), s)).toBeNull()
    expect(dueSlot(new Date('2026-11-12T20:05:00Z'), s)?.toISOString()).toBe('2026-11-12T20:00:00.000Z')
  })

  test('dueSlot ignores times that had already passed when settings were saved', () => {
    const s = settings({ scheduleTimes: ['00:15'] })
    expect(dueSlot(new Date('2026-11-12T08:30:00Z'), s, { notBefore: new Date('2026-11-12T08:20:00Z') })).toBeNull()
  })

  test('nextRuns lists upcoming times, none when paused', () => {
    const s = settings({ scheduleTimes: ['00:15', '12:00'] })
    expect(nextRuns(new Date('2026-11-12T09:00:00Z'), s, 2).map(d => d.toISOString())).toEqual(['2026-11-12T20:00:00.000Z', '2026-11-13T08:15:00.000Z'])
    expect(nextRuns(new Date(), { ...s, paused: true })).toEqual([])
  })
})
