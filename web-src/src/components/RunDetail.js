import React, { useEffect, useState } from 'react'
import { useDialogContainer, Dialog, Heading, Divider, Content, ButtonGroup, Button, ProgressCircle, Flex, View, Text, InlineAlert, Grid, LabeledValue, ActionButton } from '@adobe/react-spectrum'
import Download from '@spectrum-icons/workflow/Download'
import StatusChip from './StatusChip'
import { when, duration, runDuration, num, TRIGGERS, STATUS, csv, download } from '../format'

function problemsOf (run) {
  const out = []
  const c = run.counters || {}
  if (run.abortReason) out.push(`Stopped: ${run.abortReason}`)
  if (run.status === 'incomplete' && run.completeness) out.push(`Zazzle’s counts didn’t add up: ${(run.completeness.reasons || []).join('; ')}`)
  if (c.failed || c.deleteFailed) out.push(`${num(c.failed)} update(s) and ${num(c.deleteFailed || 0)} delete(s) failed`)
  const h = run.health
  if (h && h.atRisk) out.push(`${num(h.atRisk)} product(s) not sent to Google for ${h.expiryRiskDays}+ days`)
  if (h && h.repeatFailureCount) out.push(`${num(h.repeatFailureCount)} product(s) failed on ${h.repeatFailureThreshold}+ runs in a row`)
  return out
}

const Stat = ({ label, value }) => <LabeledValue label={label} value={value == null ? '—' : typeof value === 'number' ? num(value) : value} />

export default function RunDetail ({ call, runId }) {
  const [run, setRun] = useState(null)
  const [error, setError] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const dialog = useDialogContainer()

  useEffect(() => {
    call('getRun', { id: runId }).then(r => setRun(r.run), e => setError(e.message))
  }, [call, runId])

  const downloadDeletes = async () => {
    setDownloading(true)
    try {
      const { offerIds } = await call('deleteCandidates', { id: runId })
      download(`delete-candidates-${runId.slice(0, 10)}.csv`, csv(offerIds.map(offerId => ({ offerId })), [{ key: 'offerId', label: 'Offer ID' }]))
    } catch (e) {
      setError(e.message)
    } finally {
      setDownloading(false)
    }
  }

  const c = (run && run.counters) || {}
  const due = c.due || {}
  const problems = run ? problemsOf(run) : []
  const samples = (run && run.samples) || {}

  return (
    <Dialog size='L'>
      <Heading>Run details</Heading>
      <Divider />
      <Content>
        {error && <InlineAlert variant='negative'><Heading>Couldn’t load this run</Heading><Content>{error}</Content></InlineAlert>}
        {!run && !error && <ProgressCircle aria-label='Loading' isIndeterminate />}
        {run && (
          <Flex direction='column' gap='size-250'>
            <Flex alignItems='center' gap='size-200' wrap>
              <StatusChip status={run.displayStatus} />
              <Text>{(STATUS[run.displayStatus] || {}).help}</Text>
            </Flex>
            {problems.length > 0 && (
              <InlineAlert variant='notice'>
                <Heading>Needs a look</Heading>
                <Content><ul style={{ margin: 0, paddingLeft: 18 }}>{problems.map(p => <li key={p}>{p}</li>)}</ul></Content>
              </InlineAlert>
            )}
            <Grid columns='repeat(auto-fit, minmax(180px, 1fr))' gap='size-200'>
              <Stat label='Started' value={when(run.startedAt)} />
              <Stat label='Finished' value={run.finishedAt ? when(run.finishedAt) : '—'} />
              <Stat label='Working time' value={runDuration(run)} />
              {run.resumeCount > 0 && <Stat label='Start to finish' value={duration(run.startedAt, run.finishedAt || run.heartbeatAt)} />}
              <Stat label='Started by' value={run.requestedBy || TRIGGERS[run.trigger] || 'Scheduled'} />
              <Stat label='Resumed' value={run.resumeCount ? `${run.resumeCount} time(s)` : 'No'} />
            </Grid>
            <View>
              <Heading level={4}>Zazzle</Heading>
              <Grid columns='repeat(auto-fit, minmax(180px, 1fr))' gap='size-200'>
                <Stat label='Products in the feed' value={run.firstTotalCount} />
                <Stat label='Products checked' value={c.returned} />
                <Stat label='No longer exist (excluded)' value={c.excluded} />
                <Stat label='Couldn’t be priced (skipped)' value={c.skippedByZazzle} />
                <Stat label='Invalid data' value={c.invalid} />
              </Grid>
            </View>
            <View>
              <Heading level={4}>Merchant Center</Heading>
              <Grid columns='repeat(auto-fit, minmax(180px, 1fr))' gap='size-200'>
                <Stat label='Updated' value={c.written} />
                <Stat label='… new to this job' value={due.new} />
                <Stat label='… price or availability changed' value={due.changed} />
                <Stat label='… routine refresh (before 30-day expiry)' value={due.refresh} />
                <Stat label='Unchanged (not sent)' value={c.unchanged} />
                <Stat label='Missing from Merchant Center' value={(c.notFound || 0) + (c.notInGmcSkipped || 0)} />
                <Stat label='Failed' value={c.failed} />
                <Stat label='Deleted' value={c.deleted} />
              </Grid>
            </View>
            {run.deletes && (
              <View>
                <Heading level={4}>Products Zazzle no longer returns</Heading>
                <Text>
                  {num(run.deletes.candidates)} found
                  {run.deletes.mode === 'enabled' ? '' : ' (reported only, not deleted)'}
                  {run.deletes.blockedReason ? ` — ${run.deletes.blockedReason}` : ''}
                </Text>
                {run.deletes.candidates > 0 && (
                  <View marginTop='size-100'>
                    <ActionButton onPress={downloadDeletes} isDisabled={downloading}><Download /><Text>Download list</Text></ActionButton>
                  </View>
                )}
              </View>
            )}
            {(samples.failed || []).length > 0 && (
              <View>
                <Heading level={4}>Example failures</Heading>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {samples.failed.map((f, i) => <li key={i}><code>{f.offerId}</code> — {f.op} {f.status}: {f.message}</li>)}
                </ul>
              </View>
            )}
            <Text UNSAFE_style={{ fontSize: 11, color: 'var(--spectrum-global-color-gray-600)' }}>Run ID {run.id}{run.slot ? ` · slot ${run.slot}` : ''}</Text>
          </Flex>
        )}
      </Content>
      <ButtonGroup>
        <Button variant='secondary' onPress={dialog.dismiss}>Close</Button>
      </ButtonGroup>
    </Dialog>
  )
}
