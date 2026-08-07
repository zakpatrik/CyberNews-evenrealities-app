/**
 * Stand-in for @evenrealities/even_hub_sdk, used by the e2e harness.
 *
 * The real SDK talks to a Flutter host that only exists inside the Even app or
 * the simulator. Everything except the bridge factory is re-exported unchanged,
 * so container classes, enums and their validation behave exactly as in
 * production — only the transport is faked.
 *
 * Explicit exports take precedence over `export *`, so the real
 * waitForEvenAppBridge is shadowed by the one below.
 */

// Deliberately a file path, not the package name: the e2e build aliases the
// package specifier to this module, so importing it by name would self-resolve.
export * from '../node_modules/@evenrealities/even_hub_sdk/dist/index.js'

export interface Call {
  name: 'create' | 'rebuild' | 'upgrade' | 'shutdown'
  arg: unknown
}

export const calls: Call[] = []

let handler: ((event: unknown) => void) | null = null
const storage = new Map<string, string>()

// main.ts writes a status line to the phone WebView during bootstrap. This
// module is imported before main.ts runs, so the stub has to be installed here.
const g = globalThis as Record<string, unknown>
if (!g.document) {
  g.document = { getElementById: () => null }
}

/**
 * Count feed requests, so the e2e can assert the app is not re-fetching a file
 * that cannot have changed — the whole point of the refresh pacing.
 */
export const network = { feedRequests: 0 }

const realFetch = g.fetch as typeof fetch
g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (target.includes('/feed')) network.feedRequests++
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

/** Fetch without touching the counter, for the harness's own bookkeeping. */
export const uncountedFetch: typeof fetch = (input, init) => realFetch(input as RequestInfo, init)

export async function waitForEvenAppBridge(): Promise<Record<string, unknown>> {
  return {
    createStartUpPageContainer: async (c: unknown) => {
      calls.push({ name: 'create', arg: c })
      return 0
    },
    rebuildPageContainer: async (c: unknown) => {
      calls.push({ name: 'rebuild', arg: c })
      return true
    },
    textContainerUpgrade: async (c: unknown) => {
      calls.push({ name: 'upgrade', arg: c })
      return true
    },
    shutDownPageContainer: async (mode: number) => {
      calls.push({ name: 'shutdown', arg: mode })
      return true
    },
    setLocalStorage: async (k: string, v: string) => {
      storage.set(k, v)
      return true
    },
    getLocalStorage: async (k: string) => storage.get(k) ?? '',
    onEvenHubEvent: (cb: (event: unknown) => void) => {
      handler = cb
      return () => {
        handler = null
      }
    },
  }
}

/** Deliver a synthetic host event to the app's subscriber. */
export function fire(event: unknown): void {
  if (!handler) throw new Error('no event handler registered')
  handler(event)
}

export function lastCall(name?: Call['name']): Call | undefined {
  const pool = name ? calls.filter(c => c.name === name) : calls
  return pool[pool.length - 1]
}

export function readStorage(k: string): string | undefined {
  return storage.get(k)
}
