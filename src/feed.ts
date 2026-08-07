import { FEED_URL, FEED_LIMIT, FETCH_TIMEOUT_MS } from './config'

export interface NewsItem {
  id: string
  title: string
  src: string
  srcLabel: string
  ts: number
  url: string
  summary: string
}

export interface FeedResult {
  updated: number
  count: number
  items: NewsItem[]
  errors: string[]
}

/**
 * Fetch the aggregated feed from the Worker.
 *
 * The four upstream sites cannot be called from here directly: none send CORS
 * headers, and BleepingComputer 403s any client that lacks a browser
 * User-Agent — which a WebView cannot override. Everything goes via the Worker.
 */
export async function fetchFeed(): Promise<FeedResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const url = `${FEED_URL}${FEED_URL.includes('?') ? '&' : '?'}limit=${FEED_LIMIT}`
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const data = (await res.json()) as Partial<FeedResult>
    const items = Array.isArray(data.items) ? data.items.filter(isNewsItem) : []

    return {
      updated: typeof data.updated === 'number' ? data.updated : Math.floor(Date.now() / 1000),
      count: items.length,
      items,
      errors: Array.isArray(data.errors) ? data.errors : [],
    }
  } finally {
    clearTimeout(timer)
  }
}

/** The payload crosses a network boundary, so shape is checked rather than assumed. */
function isNewsItem(v: unknown): v is NewsItem {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    o.title.trim().length > 0 &&
    typeof o.src === 'string' &&
    typeof o.ts === 'number'
  )
}

/** Count of stories newer than the last one the user looked at. */
export function countUnread(items: NewsItem[], lastSeenTs: number): number {
  if (!lastSeenTs) return 0
  return items.reduce((n, it) => (it.ts > lastSeenTs ? n + 1 : n), 0)
}
