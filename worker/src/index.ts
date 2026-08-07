/**
 * CyberNews — Cloudflare Worker.
 *
 * Serves two things: the built glasses app (via [assets]) and the aggregated
 * feed. It deliberately does NOT fetch the source feeds itself.
 *
 * Two of the four sites refuse requests originating from Cloudflare's network —
 * BleepingComputer answers error 1106, CybersecurityNews serves a captcha
 * challenge — and every workaround probed (FeedBurner mirrors, public CORS
 * proxies, Google News) was either wrong content, down, or rate-limited. So the
 * fetching moved to a GitHub Actions cron, which publishes feed.json, and this
 * Worker reads that.
 *
 *   GET /feed?limit=60&src=THN,BC
 *   GET /health
 *   GET /diag
 */

export interface Env {
  /** Raw URL of the feed.json published by the fetcher workflow. */
  FEED_SOURCE_URL?: string
}

const DEFAULT_FEED_SOURCE =
  'https://raw.githubusercontent.com/zakpatrik/CyberNews-evenrealities-app/main/feed.json'

/** The fetcher publishes hourly, so caching below that just re-reads unchanged JSON. */
const EDGE_TTL = 900 // seconds
const DEFAULT_LIMIT = 60
/** Three missed hourly runs — by then the workflow has stopped, not hiccuped. */
const STALE_AFTER = 3 * 3600

interface NewsItem {
  id: string
  title: string
  src: string
  srcLabel: string
  ts: number
  url: string
  summary: string
}

interface FeedFile {
  updated: number
  count: number
  items: NewsItem[]
  errors: string[]
  sources: Array<{ id: string; ok: boolean; items: number; error?: string; stale?: boolean }>
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    if (url.pathname === '/health') {
      return json({ ok: true, source: sourceUrl(env) })
    }

    if (url.pathname === '/diag') {
      return json(await diagnose(env))
    }

    // "/" and /assets/* are static files — see [assets] in wrangler.toml.
    if (url.pathname !== '/feed') {
      return json({ error: 'not found' }, 404)
    }

    const cache = caches.default
    const cacheKey = new Request(url.toString(), { method: 'GET' })
    const hit = await cache.match(cacheKey)
    if (hit) return hit

    let feed: FeedFile
    try {
      feed = await loadFeed(env)
    } catch (err) {
      return json({ error: `feed unavailable: ${(err as Error).message}` }, 502)
    }

    const limit = clamp(parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT, 1, 200)
    const wanted = parseSourceFilter(url.searchParams.get('src'), feed)

    const items = feed.items
      .filter(i => wanted.has(i.src))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)

    const age = nowSec() - feed.updated
    const errors = [...(feed.errors ?? [])]
    if (age > STALE_AFTER) {
      errors.push(`feed is ${Math.round(age / 3600)}h old — check the fetcher workflow`)
    }

    const response = json(
      { updated: feed.updated, count: items.length, items, errors },
      200,
      { 'Cache-Control': `public, max-age=${EDGE_TTL}, stale-while-revalidate=600` },
    )
    ctx.waitUntil(cache.put(cacheKey, response.clone()))
    return response
  },
}

async function loadFeed(env: Env): Promise<FeedFile> {
  const res = await fetch(sourceUrl(env), {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: EDGE_TTL, cacheEverything: true },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from the feed source`)

  const data = (await res.json()) as Partial<FeedFile>
  if (!Array.isArray(data.items)) throw new Error('feed source has no items array')

  return {
    updated: typeof data.updated === 'number' ? data.updated : 0,
    count: data.items.length,
    items: data.items,
    errors: Array.isArray(data.errors) ? data.errors : [],
    sources: Array.isArray(data.sources) ? data.sources : [],
  }
}

/** Reports whether the published feed is reachable and fresh, and which sources fed it. */
async function diagnose(env: Env): Promise<Record<string, unknown>> {
  const src = sourceUrl(env)
  if (src.includes('YOUR-USER')) {
    return { error: 'FEED_SOURCE_URL is still the placeholder — set it in wrangler.toml', source: src }
  }

  try {
    const feed = await loadFeed(env)
    const age = nowSec() - feed.updated
    return {
      source: src,
      updated: feed.updated,
      ageSeconds: age,
      stale: age > STALE_AFTER,
      count: feed.count,
      sources: feed.sources,
      errors: feed.errors,
    }
  } catch (err) {
    return { source: src, error: (err as Error).message }
  }
}

function sourceUrl(env: Env): string {
  return env.FEED_SOURCE_URL || DEFAULT_FEED_SOURCE
}

function parseSourceFilter(raw: string | null, feed: FeedFile): Set<string> {
  const all = new Set(feed.items.map(i => i.src))
  if (!raw) return all
  const requested = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  const filtered = new Set(requested.filter(id => all.has(id)))
  return filtered.size > 0 ? filtered : all
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...extra,
    },
  })
}
