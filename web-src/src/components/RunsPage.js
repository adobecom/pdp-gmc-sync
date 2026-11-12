import React, { useCallback, useEffect, useState } from 'react'
import {
  View, Flex, Grid, Heading, Text, Well, StatusLight, ActionButton, Button, ProgressCircle, InlineAlert, Content,
  TableView, TableHeader, TableBody, Column, Row, Cell, DialogContainer, Divider, ContextualHelp
} from '@adobe/react-spectrum'
import Refresh from '@spectrum-icons/workflow/Refresh'
import Download from '@spectrum-icons/workflow/Download'
import RunDetail from './RunDetail'
import StatusChip from './StatusChip'
import { fetchAllOffers } from '../api'
import { when, ago, runDuration, num, whenPacific, TRIGGERS, csv, download } from '../format'

function Card ({ title, help, children }) {
  return (
    <Well UNSAFE_style={{ minHeight: 120 }}>
      <Flex alignItems='center' gap='size-50'>
        <Heading level={4} margin={0}>{title}</Heading>
        {help && <ContextualHelp variant='info'><Content>{help}</Content></ContextualHelp>}
      </Flex>
      <View marginTop='size-100'>{children}</View>
    </Well>
  )
}

const Big = ({ children, tone }) => (
  <Text UNSAFE_style={{ fontSize: 28, fontWeight: 700, color: tone === 'bad' ? 'var(--spectrum-global-color-red-600)' : undefined }}>{children}</Text>
)

const EXPORTS = {
  notInGmc: {
    label: 'Products missing from Merchant Center',
    file: 'products-not-in-gmc',
    columns: [{ key: 'offerId', label: 'Offer ID' }, { key: 'templateId', label: 'Template ID' }, { key: 'notInGmcSince', label: 'Missing since' }, { key: 'notFoundAt', label: 'Last checked' }]
  },
  failing: {
    label: 'Products that failed to update',
    file: 'products-failing',
    columns: [{ key: 'offerId', label: 'Offer ID' }, { key: 'templateId', label: 'Template ID' }, { key: 'failCount', label: 'Failed runs in a row' }, { key: 'lastError', label: 'Last error' }, { key: 'lastFailedAt', label: 'Last failed' }]
  },
  atRisk: {
    label: 'Products close to expiring',
    file: 'products-near-expiry',
    columns: [{ key: 'offerId', label: 'Offer ID' }, { key: 'templateId', label: 'Template ID' }, { key: 'sentAt', label: 'Last sent to Google' }]
  }
}

function ExportButton ({ call, view }) {
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const x = EXPORTS[view]
  const run = async () => {
    setError(null)
    setProgress('starting…')
    try {
      const offers = await fetchAllOffers(call, view, (n, total) => setProgress(`${num(n)} of ${num(total)}`))
      download(`${x.file}-${new Date().toISOString().slice(0, 10)}.csv`, csv(offers, x.columns))
      setProgress(null)
    } catch (e) {
      setProgress(null)
      setError(e.message)
    }
  }
  return (
    <Flex direction='column'>
      <ActionButton onPress={run} isDisabled={progress != null}>
        <Download />
        <Text>{progress ? `Downloading ${progress}` : x.label}</Text>
      </ActionButton>
      {error && <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-red-600)' }}>{error}</Text>}
    </Flex>
  )
}

export default function RunsPage ({ call, overview, refreshOverview }) {
  const [runs, setRuns] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)

  const load = useCallback(async (before) => {
    setLoading(true)
    try {
      const page = await call('listRuns', { limit: 25, before })
      setRuns(prev => (before ? [...(prev || []), ...page.runs] : page.runs))
      setHasMore(page.hasMore)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [call])

  useEffect(() => { load() }, [load])

  const refresh = () => {
    refreshOverview()
    load()
  }

  const latest = overview.latestRun
  const last = overview.lastComplete
  const health = (latest && latest.health) || (last && last.health) || null

  return (
    <View marginTop='size-200'>
      {overview.env.mode !== 'live' && (
        <InlineAlert variant='notice' marginBottom='size-200'>
          <Heading>{overview.env.mode === 'off' ? 'Price sync is turned off in this environment' : 'Price sync is in dry-run mode in this environment'}</Heading>
          <Content>Nothing is sent to Merchant Center here. This is set when the app is deployed (PRICE_SYNC_MODE), not in Settings.</Content>
        </InlineAlert>
      )}
      {overview.settingsMeta.problem && (
        <InlineAlert variant='negative' marginBottom='size-200'>
          <Heading>Saved settings couldn’t be used</Heading>
          <Content>{overview.settingsMeta.problem}</Content>
        </InlineAlert>
      )}

      <Grid columns='repeat(3, minmax(0, 1fr))' gap='size-200'>
        <Card title='Latest run'>
          {latest
            ? (
              <>
                <StatusChip status={latest.displayStatus} />
                <Text>{when(latest.startedAt)} · {ago(latest.startedAt)}</Text>
                {latest.abortReason && <View><Text UNSAFE_style={{ fontSize: 12 }}>{latest.abortReason}</Text></View>}
              </>
              )
            : <Text>No runs yet</Text>}
        </Card>
        <Card title='Last full catalog check' help='The last run that checked every product and sent every change.'>
          {last
            ? (
              <Flex direction='column'>
                <Big>{num(last.counters && last.counters.written)}</Big>
                <Text>products updated · {when(last.finishedAt || last.startedAt)}</Text>
              </Flex>
              )
            : <Text>None yet</Text>}
        </Card>
        <Card title='Next scheduled run' help='Times are set on the Settings tab, in Pacific time.'>
          {overview.nextRuns.length
            ? <Flex direction='column'><Text UNSAFE_style={{ fontWeight: 700 }}>{whenPacific(overview.nextRuns[0])}</Text><Text>{when(overview.nextRuns[0])}</Text></Flex>
            : <Text>{overview.settings.paused ? 'Paused' : 'Not scheduled'}</Text>}
          {overview.lock.held && <View marginTop='size-100'><StatusLight variant='info'>A run is in progress</StatusLight></View>}
        </Card>
        <Card title='Close to expiring' help={`Products Google hasn't received for ${overview.limits.expiryRiskDays}+ days. Google removes a product after 30 days without an update, so this should be 0.`}>
          <Big tone={health && health.atRisk ? 'bad' : null}>{health ? num(health.atRisk) : '—'}</Big>
        </Card>
        <Card title='Failing repeatedly' help={`Products whose update failed on ${overview.limits.repeatFailureThreshold}+ runs in a row.`}>
          <Big tone={health && health.repeatFailureCount ? 'bad' : null}>{health ? num(health.repeatFailureCount) : '—'}</Big>
        </Card>
        <Card title='Missing from Merchant Center' help='Zazzle has a price for these, but they are not in our Merchant Center data source (they were never added through the PDP tool). They are rechecked weekly and are not created by this job.'>
          <Big>{health ? num(health.notInGmc) : '—'}</Big>
        </Card>
      </Grid>

      <Flex gap='size-150' marginTop='size-200' wrap>
        <ExportButton call={call} view='notInGmc' />
        <ExportButton call={call} view='failing' />
        <ExportButton call={call} view='atRisk' />
      </Flex>

      <Divider size='S' marginY='size-300' />

      <Flex alignItems='center' marginBottom='size-150'>
        <Heading level={2} margin={0}>Run history</Heading>
        <View flexGrow={1} />
        <ActionButton onPress={refresh} isDisabled={loading}><Refresh /><Text>Refresh</Text></ActionButton>
      </Flex>
      {error && <InlineAlert variant='negative' marginBottom='size-150'><Heading>Couldn’t load runs</Heading><Content>{error}</Content></InlineAlert>}
      {runs == null
        ? <ProgressCircle aria-label='Loading runs' isIndeterminate />
        : (
          <>
            <TableView aria-label='Run history' selectionMode='none' onAction={key => setSelected(key)} density='compact' overflowMode='wrap'>
              <TableHeader>
                <Column key='startedAt' width='1.4fr'>Started</Column>
                <Column key='trigger'>Started by</Column>
                <Column key='status' width='1.3fr'>Result</Column>
                <Column key='duration'>Took</Column>
                <Column key='returned' align='end'>Checked</Column>
                <Column key='written' align='end'>Updated</Column>
                <Column key='notFound' align='end'>Not in GMC</Column>
                <Column key='failed' align='end'>Failed</Column>
              </TableHeader>
              <TableBody items={runs}>
                {r => {
                  const c = r.counters || {}
                  return (
                    <Row key={r.id}>
                      <Cell>{when(r.startedAt)}</Cell>
                      <Cell>{r.trigger === 'manual' && r.requestedBy ? r.requestedBy : (TRIGGERS[r.trigger] || 'Scheduled')}</Cell>
                      <Cell><StatusChip status={r.displayStatus} /></Cell>
                      <Cell>{runDuration(r)}</Cell>
                      <Cell>{num(c.returned)}</Cell>
                      <Cell>{num(c.written)}</Cell>
                      <Cell>{num((c.notFound || 0) + (c.notInGmcSkipped || 0))}</Cell>
                      <Cell>{num((c.failed || 0) + (c.deleteFailed || 0))}</Cell>
                    </Row>
                  )
                }}
              </TableBody>
            </TableView>
            <Flex marginTop='size-150' gap='size-150' alignItems='center'>
              <Text UNSAFE_style={{ fontSize: 12 }}>Select a run to see its details. Checked: products Zazzle returned. Updated: sent to Merchant Center. Not in GMC: products with no Merchant Center listing to update.</Text>
              {hasMore && <Button variant='secondary' onPress={() => load(runs[runs.length - 1].startedAt)} isDisabled={loading}>Load older runs</Button>}
            </Flex>
          </>
          )}

      <DialogContainer onDismiss={() => setSelected(null)}>
        {selected && <RunDetail call={call} runId={selected} />}
      </DialogContainer>
    </View>
  )
}
