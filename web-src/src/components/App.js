import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Provider, defaultTheme, View, Flex, Heading, Text, Tabs, TabList, TabPanels, Item, ProgressCircle, InlineAlert, Content, Badge, ActionButton } from '@adobe/react-spectrum'
import ErrorBoundary from 'react-error-boundary'
import { makeApi } from '../api'
import RunsPage from './RunsPage'
import SettingsPage from './SettingsPage'

const EXC_URL = `https://experience.adobe.com/?devMode=true#/custom-apps/?localDevUrl=${typeof window !== 'undefined' ? window.location.origin + window.location.pathname : ''}`

function App ({ runtime, ims }) {
  const [token, setToken] = useState(ims.token)
  useEffect(() => {
    runtime.on('configuration', ({ imsToken }) => { if (imsToken) setToken(imsToken) })
  }, [runtime])
  const call = useMemo(() => makeApi({ ...ims, token }), [ims, token])
  const [overview, setOverview] = useState(null)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      setOverview(await call('overview'))
      setError(null)
    } catch (e) {
      setError(e)
    }
  }, [call])

  useEffect(() => { refresh() }, [refresh])

  const outsideShell = !token && window.location.hostname !== 'localhost'

  return (
    <ErrorBoundary FallbackComponent={Fallback}>
      <Provider theme={defaultTheme} colorScheme='light'>
        <View padding='size-300' maxWidth='1400px' marginX='auto'>
          <Flex alignItems='center' gap='size-150' marginBottom='size-200' wrap>
            <Heading level={1} margin={0}>GMC price sync</Heading>
            {overview && <Badge variant={overview.env.gmcEnv === 'prod' ? 'negative' : 'info'}>{overview.env.gmcEnv === 'prod' ? 'Production' : `Environment: ${overview.env.gmcEnv || 'unknown'}`}</Badge>}
            {overview && overview.env.mode !== 'live' && <Badge variant='yellow'>{overview.env.mode === 'off' ? 'Turned off' : 'Dry run only'}</Badge>}
            {overview && overview.settings.paused && <Badge variant='yellow'>Schedule paused</Badge>}
            <View flexGrow={1} />
            {overview && <Text>{overview.user.email} · {overview.user.role === 'editor' ? 'Editor' : 'View only'}</Text>}
          </Flex>
          {outsideShell
            ? (
              <InlineAlert variant='info'>
                <Heading>Open this app through Experience Cloud</Heading>
                <Content>It needs your Adobe sign-in. <a href={EXC_URL}>Open it in Experience Cloud</a>.</Content>
              </InlineAlert>
              )
            : error && !overview
              ? (
                <InlineAlert variant='negative'>
                  <Heading>Couldn’t load the app</Heading>
                  <Content>
                    {error.message}
                    <View marginTop='size-100'><ActionButton onPress={refresh}>Try again</ActionButton></View>
                  </Content>
                </InlineAlert>
                )
              : !overview
                  ? <Flex justifyContent='center' marginTop='size-600'><ProgressCircle aria-label='Loading' isIndeterminate size='L' /></Flex>
                  : (
                    <Tabs aria-label='Sections'>
                      <TabList>
                        <Item key='runs'>Runs</Item>
                        <Item key='settings'>Settings</Item>
                      </TabList>
                      <TabPanels>
                        <Item key='runs'><RunsPage call={call} overview={overview} refreshOverview={refresh} /></Item>
                        <Item key='settings'><SettingsPage call={call} overview={overview} refreshOverview={refresh} /></Item>
                      </TabPanels>
                    </Tabs>
                    )}
        </View>
      </Provider>
    </ErrorBoundary>
  )
}

function Fallback ({ error }) {
  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Something went wrong</h1>
      <p>Reload the page to try again.</p>
      <pre>{error && error.message}</pre>
    </div>
  )
}

export default App
