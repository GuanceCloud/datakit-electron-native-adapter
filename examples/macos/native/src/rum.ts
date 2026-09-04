import { datafluxRum } from '@cloudcare/browser-rum'

type RumConfiguration = Parameters<typeof datafluxRum.init>[0]
export type WebRumStatus = 'active' | 'error'

const bridgeOnlyConfiguration = {
  applicationId: value('VITE_GUANCE_APPLICATION_ID') || 'native-bridge',
  datakitOrigin: value('VITE_GUANCE_DATAKIT_ORIGIN') || 'http://127.0.0.1:9529',
} as const

let active = false

function value(name: string): string {
  return String(import.meta.env[name] || '').trim()
}

export function initializeWebRUM(info: NativeHostInfo): WebRumStatus {
  const allowedTracingURL = value('VITE_GUANCE_ALLOWED_TRACING_URL')
  if (typeof window.FTWebViewJavascriptBridge?.sendEvent !== 'function') {
    console.error('[Guance Web RUM] Native SDK bridge is unavailable')
    return 'error'
  }

  const traceMatcher = allowedTracingURL === '*'
    ? /.*/
    : allowedTracingURL
  const sessionReplay = info.capabilities?.replay === true &&
    value('VITE_GUANCE_SESSION_REPLAY') !== 'false'

  datafluxRum.init({
    ...bridgeOnlyConfiguration,
    service: value('VITE_GUANCE_SERVICE') || 'orbitdesk-native-electron',
    env: value('VITE_GUANCE_ENV') || 'development',
    version: '1.0.0',
    sessionSampleRate: 100,
    sessionReplaySampleRate: sessionReplay ? 100 : 0,
    trackUserInteractions: true,
    trackViewsManually: true,
    sessionPersistence: 'local-storage',
    ...(traceMatcher
      ? {
          allowedTracingUrls: [traceMatcher],
          traceType: 'ddtrace' as RumConfiguration['traceType'],
        }
      : {}),
    beforeSend: (event) => {
      if (import.meta.env.DEV) console.debug('[Guance Web RUM]', event.type)
      return true
    },
  })

  if (import.meta.env.DEV) {
    datafluxRum.stopSession()
    datafluxRum.startSession({ sessionSampleRate: 100 })
  }

  datafluxRum.setGlobalContext({
    hybrid_architecture: 'appkit-window-electron-surface',
    electron_surface: info.surface,
    electron_version: info.electronVersion,
    desktop_arch: info.arch,
  })
  datafluxRum.startView({ name: `Electron · ${surfaceTitle(info.surface)}` })
  if (sessionReplay) {
    datafluxRum.startSessionReplayRecording({ force: true })
    window.setTimeout(() => {
      window.nativeHost?.setReplayRecording(datafluxRum.isRecording())
    }, 1000)
  }
  active = true
  return 'active'
}

export function trackAction(name: string, context?: Record<string, unknown>): void {
  if (active) datafluxRum.addAction(name, context)
}

export function reportError(error: Error, context?: Record<string, unknown>): void {
  if (active) datafluxRum.addError(error, context)
}

function surfaceTitle(surface: string): string {
  return ({
    dashboard: 'Operations Dashboard',
    tasks: 'Task Center',
    requests: 'Request Lab',
    popup: 'Electron Popup',
  } as Record<string, string>)[surface] || surface
}
