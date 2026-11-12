// Settings editable from the admin app (stored in price_sync_settings), and
// the schedule maths shared by the scheduler, the admin API and the UI.
// Deploy-time inputs stay the ceiling: PRICE_SYNC_MODE=off or dry-run can't be
// raised from here, and deletes/shipping fall back to PRICE_SYNC_DELETES /
// PRICE_SYNC_SHIPPING until someone saves a choice.

const TIME_ZONE = 'America/Los_Angeles'
const TIME_RE = /^([01]\d|2[0-3]):(00|15|30|45)$/
const MIN_GAP_MINUTES = 120
const MAX_TIMES = 4
// Refreshes must land before Google's 30-day expiry, with margin for a missed day.
const MAX_REFRESH_DAYS = 26

const DEFAULT_SETTINGS = Object.freeze({
  paused: false,
  // Zazzle: "run one daily, shortly after 07:00 UTC, when promos usually
  // change over" (midnight Pacific).
  scheduleTimes: Object.freeze(['00:15']),
  deletes: null,
  shipping: null,
  refreshAfterDays: 20,
  refreshJitterDays: 6,
  maxWritesPerRun: null,
  notFoundRetryDays: 7
})

const FIELDS = Object.keys(DEFAULT_SETTINGS)

function isInt (v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max
}

function minutesOf (hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// Returns { ok, value, errors } where errors maps field -> message. Unknown
// fields are rejected so a typo can't silently do nothing.
function validateSettings (input) {
  const errors = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: { _: 'settings must be an object' } }
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) errors[k] = 'unknown setting'
  const v = { ...DEFAULT_SETTINGS, ...input }

  if (typeof v.paused !== 'boolean') errors.paused = 'must be true or false'

  if (!Array.isArray(v.scheduleTimes) || v.scheduleTimes.length < 1 || v.scheduleTimes.length > MAX_TIMES) {
    errors.scheduleTimes = `choose 1 to ${MAX_TIMES} times`
  } else if (!v.scheduleTimes.every(t => typeof t === 'string' && TIME_RE.test(t))) {
    errors.scheduleTimes = 'times must be HH:MM on the quarter hour (e.g. 00:15)'
  } else {
    const mins = [...new Set(v.scheduleTimes)].map(minutesOf).sort((a, b) => a - b)
    if (mins.length !== v.scheduleTimes.length) errors.scheduleTimes = 'times must be different'
    else if (mins.some((m, i) => (i ? m - mins[i - 1] : m + 1440 - mins[mins.length - 1]) < MIN_GAP_MINUTES)) {
      errors.scheduleTimes = `times must be at least ${MIN_GAP_MINUTES / 60} hours apart`
    }
  }

  if (v.deletes !== null && !['report', 'enabled'].includes(v.deletes)) errors.deletes = 'must be report or enabled'
  if (v.shipping !== null && !['send', 'ignore'].includes(v.shipping)) errors.shipping = 'must be send or ignore'
  if (!isInt(v.refreshAfterDays, 1, MAX_REFRESH_DAYS)) errors.refreshAfterDays = `must be a whole number from 1 to ${MAX_REFRESH_DAYS}`
  if (!isInt(v.refreshJitterDays, 0, MAX_REFRESH_DAYS)) errors.refreshJitterDays = `must be a whole number from 0 to ${MAX_REFRESH_DAYS}`
  if (!errors.refreshAfterDays && !errors.refreshJitterDays && v.refreshAfterDays + v.refreshJitterDays > MAX_REFRESH_DAYS) {
    errors.refreshJitterDays = `refresh days plus spread must be ${MAX_REFRESH_DAYS} or less, so offers are rewritten before Google's 30-day expiry`
  }
  if (v.maxWritesPerRun !== null && !isInt(v.maxWritesPerRun, 0, 1000000)) errors.maxWritesPerRun = 'must be empty or a whole number from 0 to 1,000,000'
  if (!isInt(v.notFoundRetryDays, 1, 30)) errors.notFoundRetryDays = 'must be a whole number from 1 to 30'

  if (Object.keys(errors).length) return { ok: false, errors }
  const value = Object.fromEntries(FIELDS.map(k => [k, v[k]]))
  value.scheduleTimes = [...v.scheduleTimes].sort((a, b) => minutesOf(a) - minutesOf(b))
  return { ok: true, value }
}

// The stored doc, or defaults if there is none or it no longer validates
// (e.g. after a schema change). `problem` explains a fallback.
function effectiveSettings (doc) {
  if (!doc) return { settings: { ...DEFAULT_SETTINGS, scheduleTimes: [...DEFAULT_SETTINGS.scheduleTimes] }, version: 0, updatedAt: null, updatedBy: null, problem: null }
  const stored = Object.fromEntries(FIELDS.filter(k => k in doc).map(k => [k, doc[k]]))
  const { ok, value, errors } = validateSettings(stored)
  const meta = { version: doc.version || 0, updatedAt: doc.updatedAt || null, updatedBy: doc.updatedBy || null }
  if (ok) return { settings: value, ...meta, problem: null }
  return {
    settings: { ...DEFAULT_SETTINGS, scheduleTimes: [...DEFAULT_SETTINGS.scheduleTimes] },
    ...meta,
    problem: `saved settings are invalid (${Object.entries(errors).map(([k, m]) => `${k}: ${m}`).join('; ')}); using defaults`
  }
}

const MODES = ['off', 'dry-run', 'live']

// PRICE_SYNC_MODE as deployed: off (default) | dry-run | live.
function deployMode (params) {
  const mode = String(params.PRICE_SYNC_MODE || 'off').trim().toLowerCase()
  if (!MODES.includes(mode)) throw new Error(`PRICE_SYNC_MODE must be off, dry-run or live, got ${JSON.stringify(params.PRICE_SYNC_MODE)}`)
  return mode
}

function resolveDeletes (settings, params) {
  return (settings.deletes || params.PRICE_SYNC_DELETES) === 'enabled' ? 'enabled' : 'report'
}

function resolveShipping (settings, params) {
  return (settings.shipping || params.PRICE_SYNC_SHIPPING) === 'send' ? 'send' : 'ignore'
}

// --- time zone maths (no dependencies; Node ships full ICU) ---

const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

function zonedParts (date) {
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second }
}

function offsetMs (date) {
  const p = zonedParts(date)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000
}

// Local wall-clock time in TIME_ZONE -> instant.
function zonedToUtc (y, m, d, h, mi) {
  const guess = Date.UTC(y, m - 1, d, h, mi)
  let t = guess - offsetMs(new Date(guess))
  t = guess - offsetMs(new Date(t))
  return new Date(t)
}

function slotsAround (now, times, dayOffsets) {
  const today = zonedParts(now)
  const out = []
  for (const off of dayOffsets) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + off))
    for (const t of times) {
      const [h, mi] = t.split(':').map(Number)
      out.push(zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi))
    }
  }
  return out.sort((a, b) => a - b)
}

// The latest scheduled time that is due at `now` (alarms can fire a little
// early, hence the tolerance) and not older than the grace window or the last
// settings change (so moving a time earlier doesn't trigger a catch-up run).
function dueSlot (now, settings, { graceMs = 2 * 3600 * 1000, toleranceMs = 60 * 1000, notBefore = null } = {}) {
  const floor = Math.max(now.getTime() - graceMs, notBefore ? new Date(notBefore).getTime() : -Infinity)
  const due = slotsAround(now, settings.scheduleTimes, [-1, 0])
    .filter(s => s.getTime() <= now.getTime() + toleranceMs && s.getTime() > floor)
  return due.length ? due[due.length - 1] : null
}

function nextRuns (now, settings, count = 3) {
  if (settings.paused) return []
  return slotsAround(now, settings.scheduleTimes, [0, 1, 2, 3])
    .filter(s => s.getTime() > now.getTime())
    .slice(0, count)
}

module.exports = {
  DEFAULT_SETTINGS,
  TIME_ZONE,
  MAX_REFRESH_DAYS,
  validateSettings,
  effectiveSettings,
  deployMode,
  resolveDeletes,
  resolveShipping,
  zonedToUtc,
  dueSlot,
  nextRuns
}
