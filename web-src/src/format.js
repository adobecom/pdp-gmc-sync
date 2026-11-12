const PACIFIC = 'America/Los_Angeles'

const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const pacificDateTime = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })

export function when (v) {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '—' : dateTime.format(d)
}

export function whenPacific (v) {
  return v ? pacificDateTime.format(new Date(v)) : '—'
}

export function ago (v, now = Date.now()) {
  if (!v) return ''
  const mins = Math.round((now - new Date(v).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

export function duration (start, end) {
  if (!start || !end) return '—'
  const mins = (new Date(end) - new Date(start)) / 60000
  if (mins < 1) return '< 1 min'
  if (mins < 90) return `${Math.round(mins)} min`
  return `${(mins / 60).toFixed(1)} h`
}

// Working time for a run: activeMs when recorded, else wall-clock time.
export function runDuration (run) {
  const label = run.activeMs != null
    ? duration(0, run.activeMs)
    : duration(run.startedAt, run.finishedAt || run.heartbeatAt)
  return run.resumeCount ? `${label} (resumed)` : label
}

export const num = n => (n == null ? '—' : Number(n).toLocaleString())

// "00:15" -> "12:15 AM"
export function timeLabel (hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

export const QUARTER_HOURS = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`)

export const STATUS = {
  complete: { variant: 'positive', label: 'Complete', help: 'The whole catalog was checked and every change was sent.' },
  incomplete: { variant: 'notice', label: 'Incomplete', help: 'Every page was read, but Zazzle’s counts didn’t add up, so nothing was deleted.' },
  running: { variant: 'info', label: 'Running', help: 'In progress.' },
  aborted: { variant: 'negative', label: 'Stopped by an error', help: 'Stopped early; it will resume automatically.' },
  stopped: { variant: 'neutral', label: 'Stopped (test limit)', help: 'Stopped on purpose after a set number of pages (a test run).' },
  interrupted: { variant: 'negative', label: 'Interrupted', help: 'The run ended without finishing (it crashed or was replaced by a newer run).' }
}

export const TRIGGERS = { schedule: 'Scheduled', manual: 'Run now', cli: 'Command line' }

export function csv (rows, columns) {
  const cell = v => {
    const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [columns.map(c => c.label).join(','), ...rows.map(r => columns.map(c => cell(r[c.key])).join(','))].join('\n')
}

export function download (filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
