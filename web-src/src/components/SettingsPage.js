import React, { useEffect, useMemo, useState } from 'react'
import {
  View, Flex, Heading, Text, Switch, Picker, Item, NumberField, ActionButton, Button, ButtonGroup, InlineAlert, Content,
  DialogContainer, AlertDialog, Divider, Well, TableView, TableHeader, TableBody, Column, Row, Cell, ProgressCircle, Form
} from '@adobe/react-spectrum'
import Add from '@spectrum-icons/workflow/Add'
import Remove from '@spectrum-icons/workflow/Remove'
import { validateSettings, nextRuns, DEFAULT_SETTINGS } from '../../../actions/lib/priceSyncSettings'
import { QUARTER_HOURS, timeLabel, when, whenPacific } from '../format'

const DEFAULT_CHOICE = '__default__'

const LABELS = {
  paused: 'Scheduled runs',
  scheduleTimes: 'Run times (Pacific)',
  deletes: 'Products Zazzle no longer returns',
  shipping: 'Shipping rates',
  refreshAfterDays: 'Resend unchanged products after (days)',
  refreshJitterDays: 'Spread resends over (days)',
  maxWritesPerRun: 'Most updates per run',
  notFoundRetryDays: 'Recheck missing products every (days)'
}

function describe (key, value, env) {
  if (key === 'paused') return value ? 'Paused' : 'On'
  if (key === 'scheduleTimes') return value.map(timeLabel).join(', ')
  if (key === 'deletes') return value == null ? `Deployment default (${env.deletesDefault === 'enabled' ? 'delete' : 'report only'})` : value === 'enabled' ? 'Delete from Merchant Center' : 'Report only'
  if (key === 'shipping') return value == null ? `Deployment default (${env.shippingDefault === 'send' ? 'send' : "don't send"})` : value === 'send' ? 'Send Zazzle’s shipping rates' : 'Don’t send'
  if (key === 'maxWritesPerRun') return value == null ? 'No limit' : value.toLocaleString()
  return String(value)
}

function changes (before, after) {
  return Object.keys(LABELS).filter(k => JSON.stringify(before ? before[k] : undefined) !== JSON.stringify(after ? after[k] : undefined))
}

export default function SettingsPage ({ call, overview, refreshOverview }) {
  const env = overview.env
  const canEdit = overview.user.role === 'editor'
  const [draft, setDraft] = useState(overview.settings)
  const [version, setVersion] = useState(overview.settingsMeta.version)
  const [serverErrors, setServerErrors] = useState({})
  const [dialog, setDialog] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [history, setHistory] = useState(null)

  useEffect(() => {
    setDraft(overview.settings)
    setVersion(overview.settingsMeta.version)
  }, [overview])

  const loadHistory = () => call('settingsHistory', { limit: 20 }).then(r => setHistory(r.history), () => setHistory([]))
  useEffect(() => { loadHistory() }, [call])

  const local = useMemo(() => validateSettings(draft), [draft])
  const errors = { ...(local.ok ? {} : local.errors), ...serverErrors }
  const changed = changes(overview.settings, draft)
  const preview = local.ok && env.mode !== 'off' ? nextRuns(new Date(), local.value, 3) : []
  const set = (key, value) => {
    setServerErrors({})
    setMessage(null)
    setDraft(d => ({ ...d, [key]: value }))
  }

  const save = async () => {
    setBusy(true)
    try {
      const res = await call('saveSettings', { settings: local.value, expectedVersion: version })
      setVersion(res.version)
      setMessage({ variant: 'positive', text: 'Settings saved. They apply from the next run.' })
      refreshOverview()
      loadHistory()
    } catch (e) {
      if (e.details) setServerErrors(e.details)
      setMessage({ variant: 'negative', text: e.message })
    } finally {
      setBusy(false)
      setDialog(null)
    }
  }

  const runNow = async () => {
    setBusy(true)
    try {
      await call('runNow')
      setMessage({ variant: 'positive', text: 'Run started. It shows on the Runs tab within a minute; a full pass takes about 45 minutes.' })
      setTimeout(refreshOverview, 15000)
    } catch (e) {
      setMessage({ variant: 'negative', text: e.message })
    } finally {
      setBusy(false)
      setDialog(null)
    }
  }

  const times = draft.scheduleTimes || []
  const deadline = draft.refreshAfterDays + draft.refreshJitterDays

  return (
    <View marginTop='size-200' maxWidth='900px'>
      {!canEdit && (
        <InlineAlert variant='info' marginBottom='size-200'>
          <Heading>View only</Heading>
          <Content>Ask an admin to add your email to PRICE_SYNC_EDITORS (a GitHub environment variable) if you need to change these.</Content>
        </InlineAlert>
      )}
      {message && (
        <InlineAlert variant={message.variant} marginBottom='size-200'>
          <Heading>{message.variant === 'positive' ? 'Done' : 'That didn’t work'}</Heading>
          <Content>{message.text}</Content>
        </InlineAlert>
      )}

      <Well marginBottom='size-300'>
        <Flex alignItems='center' gap='size-200' wrap>
          <View flexGrow={1}>
            <Heading level={3} margin={0}>Run the sync now</Heading>
            <Text>Starts a full pass right away, outside the schedule. Changed prices are sent to Merchant Center ({env.gmcEnv === 'prod' ? 'production' : 'test account'}).</Text>
          </View>
          <Button variant='primary' onPress={() => setDialog('run')} isDisabled={!canEdit || busy || overview.lock.held || env.mode === 'off'}>
            {overview.lock.held ? 'A run is in progress' : 'Run now'}
          </Button>
        </Flex>
      </Well>

      <Form isReadOnly={!canEdit} maxWidth='100%' validationBehavior='aria'>
        <Heading level={3}>Schedule</Heading>
        <Switch isSelected={!draft.paused} onChange={v => set('paused', !v)} isReadOnly={!canEdit}>
          {draft.paused ? 'Scheduled runs are paused' : 'Scheduled runs are on'}
        </Switch>
        {draft.paused && <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-orange-700)' }}>While paused, nothing is sent. Google removes products that go 30 days without an update, so don’t leave it paused for weeks.</Text>}
        <Text>Run times, in Pacific time (1 to 4 a day, at least 2 hours apart). Zazzle recommends shortly after midnight Pacific, when promotions change over.</Text>
        <Flex direction='column' gap='size-100'>
          {times.map((t, i) => (
            <Flex key={i} gap='size-100' alignItems='end'>
              <Picker
                label={`Run ${i + 1}`}
                selectedKey={t}
                onSelectionChange={k => set('scheduleTimes', times.map((x, j) => (j === i ? k : x)))}
                isDisabled={!canEdit}
                items={QUARTER_HOURS.map(id => ({ id, name: timeLabel(id) }))}
                maxHeight='size-3600'
              >
                {item => <Item key={item.id}>{item.name}</Item>}
              </Picker>
              {canEdit && times.length > 1 && (
                <ActionButton aria-label={`Remove run ${i + 1}`} onPress={() => set('scheduleTimes', times.filter((_, j) => j !== i))}><Remove /></ActionButton>
              )}
            </Flex>
          ))}
          {canEdit && times.length < 4 && (
            <View><ActionButton onPress={() => set('scheduleTimes', [...times, '12:00'])}><Add /><Text>Add a run time</Text></ActionButton></View>
          )}
          {errors.scheduleTimes && <Text UNSAFE_style={{ color: 'var(--spectrum-global-color-red-600)' }}>{errors.scheduleTimes}</Text>}
          {preview.length > 0 && <Text UNSAFE_style={{ fontSize: 12 }}>Next runs: {preview.map(whenPacific).join(' · ')}</Text>}
        </Flex>

        <Divider size='S' marginY='size-200' />
        <Heading level={3}>What gets sent</Heading>
        <Picker
          label={LABELS.deletes}
          selectedKey={draft.deletes == null ? DEFAULT_CHOICE : draft.deletes}
          onSelectionChange={k => set('deletes', k === DEFAULT_CHOICE ? null : k)}
          isDisabled={!canEdit}
          width='size-6000'
          description='After a complete pass, products Zazzle stopped returning can be listed or deleted. Deletes are always skipped if Zazzle’s catalog shrank more than 5% or the list is over 5% of it.'
        >
          <Item key={DEFAULT_CHOICE}>{describe('deletes', null, env)}</Item>
          <Item key='report'>Report only</Item>
          <Item key='enabled'>Delete from Merchant Center</Item>
        </Picker>
        <Picker
          label={LABELS.shipping}
          selectedKey={draft.shipping == null ? DEFAULT_CHOICE : draft.shipping}
          onSelectionChange={k => set('shipping', k === DEFAULT_CHOICE ? null : k)}
          isDisabled={!canEdit}
          width='size-6000'
          description='Whether each product’s shipping cost from Zazzle is sent with its price.'
        >
          <Item key={DEFAULT_CHOICE}>{describe('shipping', null, env)}</Item>
          <Item key='send'>Send Zazzle’s shipping rates</Item>
          <Item key='ignore'>Don’t send</Item>
        </Picker>

        <Divider size='S' marginY='size-200' />
        <Heading level={3}>Advanced</Heading>
        <Flex gap='size-300' wrap>
          <NumberField
            label={LABELS.refreshAfterDays}
            width='size-3600'
            value={draft.refreshAfterDays}
            onChange={v => set('refreshAfterDays', v)}
            minValue={1}
            maxValue={26}
            step={1}
            isInvalid={!!errors.refreshAfterDays}
            errorMessage={errors.refreshAfterDays}
            isReadOnly={!canEdit}
          />
          <NumberField
            label={LABELS.refreshJitterDays}
            width='size-3600'
            value={draft.refreshJitterDays}
            onChange={v => set('refreshJitterDays', v)}
            minValue={0}
            maxValue={26}
            step={1}
            isInvalid={!!errors.refreshJitterDays}
            errorMessage={errors.refreshJitterDays}
            isReadOnly={!canEdit}
          />
        </Flex>
        <Text UNSAFE_style={{ fontSize: 12 }}>
          Google removes a product after 30 days without an update, so unchanged products are resent between day {draft.refreshAfterDays} and day {Number.isFinite(deadline) ? deadline : '?'} after they were last sent, spread out so they don’t all go on the same day.
        </Text>
        <Flex gap='size-300' wrap>
          <NumberField
            label={LABELS.maxWritesPerRun}
            width='size-3600'
            value={draft.maxWritesPerRun == null ? NaN : draft.maxWritesPerRun}
            onChange={v => set('maxWritesPerRun', Number.isNaN(v) ? null : v)}
            minValue={0}
            step={1}
            description='Leave empty for no limit. Products over the limit are sent on the next run.'
            isInvalid={!!errors.maxWritesPerRun}
            errorMessage={errors.maxWritesPerRun}
            isReadOnly={!canEdit}
          />
          <NumberField
            label={LABELS.notFoundRetryDays}
            width='size-3600'
            value={draft.notFoundRetryDays}
            onChange={v => set('notFoundRetryDays', v)}
            minValue={1}
            maxValue={30}
            step={1}
            description='Products missing from Merchant Center are checked again this often.'
            isInvalid={!!errors.notFoundRetryDays}
            errorMessage={errors.notFoundRetryDays}
            isReadOnly={!canEdit}
          />
        </Flex>

        <Divider size='S' marginY='size-200' />
        <Heading level={3}>Set when deployed (read only)</Heading>
        <Text>
          Mode: <b>{env.mode === 'live' ? 'Live — changes are sent to Merchant Center' : env.mode === 'dry-run' ? 'Dry run — nothing is sent' : 'Off — nothing runs'}</b>.
          Changing this needs a code change and deploy (PRICE_SYNC_MODE).
        </Text>
      </Form>

      {canEdit && (
        <ButtonGroup marginTop='size-300'>
          <Button variant='accent' onPress={() => setDialog('save')} isDisabled={!changed.length || !local.ok || busy}>Save changes</Button>
          <Button variant='secondary' onPress={() => { setDraft(overview.settings); setServerErrors({}) }} isDisabled={!changed.length || busy}>Discard</Button>
        </ButtonGroup>
      )}
      {overview.settingsMeta.updatedAt && (
        <View marginTop='size-150'><Text UNSAFE_style={{ fontSize: 12 }}>Last changed {when(overview.settingsMeta.updatedAt)} by {overview.settingsMeta.updatedBy}</Text></View>
      )}

      <Divider size='S' marginY='size-300' />
      <Heading level={3}>Change history</Heading>
      {history == null
        ? <ProgressCircle aria-label='Loading history' isIndeterminate size='S' />
        : history.length === 0
          ? <Text>No changes yet — the defaults are in use.</Text>
          : (
            <TableView aria-label='Settings change history' density='compact' overflowMode='wrap' maxHeight='size-4600'>
              <TableHeader>
                <Column key='at' width='1fr'>When</Column>
                <Column key='by' width='1fr'>Who</Column>
                <Column key='what' width='3fr'>What changed</Column>
              </TableHeader>
              <TableBody items={history.map(h => ({ ...h, id: h._id }))}>
                {h => (
                  <Row key={h.id}>
                    <Cell>{when(h.at)}</Cell>
                    <Cell>{h.by}</Cell>
                    <Cell>{changes(h.before || DEFAULT_SETTINGS, h.after).map(k => `${LABELS[k]}: ${describe(k, h.after[k], env)}`).join('; ') || 'No change'}</Cell>
                  </Row>
                )}
              </TableBody>
            </TableView>
            )}

      <DialogContainer onDismiss={() => setDialog(null)}>
        {dialog === 'save' && (
          <AlertDialog title='Save these changes?' variant='confirmation' primaryActionLabel='Save' cancelLabel='Cancel' onPrimaryAction={save}>
            <ul style={{ paddingLeft: 18 }}>
              {changed.map(k => <li key={k}><b>{LABELS[k]}</b>: {describe(k, overview.settings[k], env)} → {describe(k, draft[k], env)}</li>)}
            </ul>
            They apply from the next run.
          </AlertDialog>
        )}
        {dialog === 'run' && (
          <AlertDialog title='Start a run now?' variant='confirmation' primaryActionLabel='Run now' cancelLabel='Cancel' onPrimaryAction={runNow}>
            This checks every product with Zazzle and sends changes to Merchant Center ({env.gmcEnv === 'prod' ? 'production' : 'test account'}). It takes about 45 minutes and can’t be stopped from here.
          </AlertDialog>
        )}
      </DialogContainer>
    </View>
  )
}
