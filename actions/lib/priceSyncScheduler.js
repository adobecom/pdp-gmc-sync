// One scheduler tick (every 15 minutes): start the pass for a due schedule
// slot, or resume a pass that was cut short. price-sync itself is invoked
// non-blocking so it gets its own 3-hour activation.

const { effectiveSettings, dueSlot } = require('./priceSyncSettings')
const { DEFAULTS, RESUMABLE } = require('./priceSync')

const PRICE_SYNC_ACTION = 'gmc-feed-sync/price-sync'
// An unfinished pass is resumed once it has been quiet this long (longer than
// the lock TTL, so a live invocation is never doubled up), at most hourly.
const RESUME_AFTER_MS = 35 * 60 * 1000
const RESUME_EVERY_MS = 60 * 60 * 1000
// A claimed slot whose price-sync never created a run (it failed before
// starting, e.g. the database or Google config was unavailable) is invoked
// again, up to this many times in all, while the slot is still due.
const SLOT_RETRY_AFTER_MS = 10 * 60 * 1000
const MAX_SLOT_ATTEMPTS = 3

function lockHeld (lock, now) {
  return !!lock && new Date(lock.heldUntil) > now
}

function resumable (run, now) {
  if (!run?.slot || !RESUMABLE.includes(run.status) || run.status === 'stopped') return false
  if ((run.resumeCount || 0) >= DEFAULTS.maxResumes) return false
  if (now - new Date(run.startedAt) > DEFAULTS.runWindowHours * 3600 * 1000) return false
  if (now - new Date(run.heartbeatAt || run.startedAt) < RESUME_AFTER_MS) return false
  return !run.resumeRequestedAt || now - new Date(run.resumeRequestedAt) >= RESUME_EVERY_MS
}

async function schedulerTick ({ store, now, invoke, mode }) {
  if (mode === 'off') return { action: 'none', reason: 'PRICE_SYNC_MODE=off' }
  const eff = effectiveSettings(await store.getSettingsDoc())
  if (lockHeld(await store.getLock(), now)) return { action: 'none', reason: 'a run is in progress', problem: eff.problem }

  if (!eff.settings.paused) {
    const slot = dueSlot(now, eff.settings, { notBefore: eff.updatedAt })
    if (slot) {
      const slotId = slot.toISOString()
      if (await store.claimSlot(slotId, { kind: 'schedule', claimedAt: now, lastInvokedAt: now, attempts: 1 })) {
        try {
          const activationId = await invoke(PRICE_SYNC_ACTION, { slot: slotId, trigger: 'schedule' })
          return { action: 'started', slot: slotId, activationId, problem: eff.problem }
        } catch (e) {
          await store.releaseSlot(slotId).catch(() => {})
          throw e
        }
      }
      // Dry runs never create run docs, so there is nothing to check.
      if (mode === 'live') {
        const claim = await store.getSlot(slotId)
        const attempts = claim?.attempts || 1
        if (claim && attempts < MAX_SLOT_ATTEMPTS &&
            now - new Date(claim.lastInvokedAt || claim.claimedAt) >= SLOT_RETRY_AFTER_MS &&
            !(await store.hasRunForSlot(slotId)) &&
            await store.retrySlot(slotId, claim.attempts ?? attempts, now)) {
          const activationId = await invoke(PRICE_SYNC_ACTION, { slot: slotId, trigger: 'schedule' })
          return { action: 'retried', slot: slotId, attempt: attempts + 1, activationId, problem: eff.problem }
        }
      }
    }
  }

  const latest = await store.getLatestRun()
  if (resumable(latest, now) && !(eff.settings.paused && latest.trigger === 'schedule')) {
    await store.updateRun(latest._id, { resumeRequestedAt: now })
    const activationId = await invoke(PRICE_SYNC_ACTION, {
      slot: latest.slot,
      trigger: latest.trigger || 'schedule',
      ...(latest.requestedBy ? { requestedBy: latest.requestedBy } : {})
    })
    return { action: 'resumed', run: latest._id, slot: latest.slot, activationId, problem: eff.problem }
  }
  return { action: 'none', reason: eff.settings.paused ? 'paused' : 'nothing due', problem: eff.problem }
}

module.exports = { schedulerTick, PRICE_SYNC_ACTION, RESUME_AFTER_MS }
