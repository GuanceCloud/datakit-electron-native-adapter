import { datafluxRum } from '@cloudcare/browser-rum'

type RumConfiguration = Parameters<typeof datafluxRum.init>[0]

export interface RumRuntimeState {
  configured: boolean
  status: 'active' | 'not-configured' | 'error'
  message: string
  intakeMode: 'Native SDK Bridge'
  service: string
  environment: string
  applicationId: string
  sessionReplay: boolean
}

const service = import.meta.env.VITE_GUANCE_SERVICE || 'orbitdesk-electron'
const environment = import.meta.env.VITE_GUANCE_ENV || (import.meta.env.DEV ? 'development' : 'production')
const bridgeOnlyConfiguration = {
  applicationId: import.meta.env.VITE_GUANCE_APPLICATION_ID?.trim() || 'native-bridge',
  datakitOrigin: import.meta.env.VITE_GUANCE_DATAKIT_ORIGIN?.trim() || 'http://127.0.0.1:9529',
} as const

let rumActive = false

let runtimeState: RumRuntimeState = {
  configured: false,
  status: 'not-configured',
  message: 'Waiting for the Native SDK bridge',
  intakeMode: 'Native SDK Bridge',
  service,
  environment,
  applicationId: 'Owned by Native SDK',
  sessionReplay: false,
}

function getDeviceId(): string {
  const storageKey = 'orbitdesk.rum-device-id'
  const stored = window.localStorage.getItem(storageKey)
  if (stored) return stored

  const id = `desktop-${crypto.randomUUID()}`
  window.localStorage.setItem(storageKey, id)
  return id
}

export function initializeRum(appInfo: AppInfo): RumRuntimeState {
  const tracingUrl = import.meta.env.VITE_GUANCE_ALLOWED_TRACING_URL?.trim() || ''
  const sessionReplay = appInfo.capabilities?.replay === true &&
    import.meta.env.VITE_GUANCE_SESSION_REPLAY !== 'false'

  if (typeof window.FTWebViewJavascriptBridge?.sendEvent !== 'function') {
    runtimeState = {
      ...runtimeState,
      status: 'error',
      message: 'The Native SDK bridge is unavailable',
      sessionReplay,
    }
    return runtimeState
  }

  try {
    datafluxRum.init({
      ...bridgeOnlyConfiguration,
      service,
      env: environment,
      version: appInfo.version,
      sessionSampleRate: 100,
      sessionReplaySampleRate: sessionReplay ? 100 : 0,
      trackUserInteractions: true,
      trackViewsManually: true,
      actionNameAttribute: 'data-guance-action-name',
      sessionPersistence: 'local-storage',
      ...(tracingUrl
        ? {
            allowedTracingUrls: [tracingUrl],
            traceType: 'ddtrace' as RumConfiguration['traceType'],
          }
        : {}),
      beforeSend: (event) => {
        if (import.meta.env.DEV) {
          console.debug('[Guance RUM]', event.type)
        }
        return true
      },
    })

    if (import.meta.env.DEV) {
      // local-storage intentionally persists sessions across restarts. A fresh
      // session per dev launch makes RUM and Replay debugging deterministic.
      datafluxRum.stopSession()
      datafluxRum.startSession({ sessionSampleRate: 100 })
      window.setTimeout(() => {
        console.debug(
          `[Guance RUM] development_session ${datafluxRum.getInternalContext()?.session.id ?? 'unknown'}`,
        )
      }, 250)
    }

    datafluxRum.setUser({ id: getDeviceId() })
    datafluxRum.setGlobalContext({
      desktop_platform: appInfo.platform,
      desktop_arch: appInfo.arch,
      electron_version: appInfo.electronVersion,
    })

    if (sessionReplay) {
      // Force upgrades a session that may have been persisted before Replay was
      // enabled. This is important for Electron file:// pages using localStorage.
      datafluxRum.startSessionReplayRecording({ force: true })

      if (import.meta.env.DEV) {
        for (const delay of [1000, 3000, 5000]) {
          window.setTimeout(() => {
            const recording = datafluxRum.isRecording()
            console.debug(
              `[Guance RUM] session_replay ${delay}ms`,
              recording ? 'recording' : 'not_recording',
            )
          }, delay)
        }
      }
    }

    datafluxRum.startView({ name: 'Dashboard' })
    rumActive = true
    runtimeState = {
      configured: true,
      status: 'active',
      message: 'Web RUM is collecting through the Native SDK bridge',
      intakeMode: 'Native SDK Bridge',
      service,
      environment,
      applicationId: 'Owned by Native SDK',
      sessionReplay,
    }
  } catch (error) {
    console.error('Guance RUM initialization failed', error)
    runtimeState = {
      configured: false,
      status: 'error',
      message: error instanceof Error ? error.message : 'SDK initialization failed',
      intakeMode: 'Native SDK Bridge',
      service,
      environment,
      applicationId: 'Owned by Native SDK',
      sessionReplay,
    }
  }

  return runtimeState
}

export function getRumRuntimeState(): RumRuntimeState {
  return runtimeState
}

export function isSessionReplayRecording(): boolean {
  return rumActive && datafluxRum.isRecording()
}

export function startRumView(name: string): void {
  if (rumActive) {
    datafluxRum.startView({ name })
  }
}

export function trackAction(name: string, context?: Record<string, unknown>): void {
  if (rumActive) {
    datafluxRum.addAction(name, context)
  }
}

export function reportError(error: Error, context?: Record<string, unknown>): void {
  if (rumActive) {
    datafluxRum.addError(error, context)
  }
}
