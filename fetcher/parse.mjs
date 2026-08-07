/**
 * Feed fetching and normalisation.
 *
 * This runs in GitHub Actions rather than in the Cloudflare Worker because two
 * of the four sites refuse requests originating from Cloudflare's network:
 * BleepingComputer answers error 1106 (Cloudflare will not proxy a Worker
 * subrequest to another Cloudflare-fronted zone) and CybersecurityNews serves a
 * captcha challenge. Both answer normally from an ordinary runner.
 *
 * Plain .mjs on purpose: CI runs it directly, with no build step to break.
 */

import { XMLParser } from 'fast-xml-parser'

export const SOURCES = [
  { id: 'THN', label: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews' },
  { id: 'BC', label: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/' },
  { id: 'CSN', label: 'Cybersecurity News', url: 'https://cybersecuritynews.com/feed/' },
  { id: 'DR', label: 'Dark Reading', url: 'https://www.darkreading.com/rss.xml' },
]

/** BleepingComputer rejects requests lacking both a browser UA and an XML Accept. */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
}

const MAX_SUMMARY = 700
const FETCH_TIMEOUT_MS = 25_000

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
})

/** Fetch one source. Never throws — a dead feed must not sink the other three. */
export async function loadSource(src, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(src.url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return { id: src.id, ok: false, items: [], error: `HTTP ${res.status}` }

    const xml = await res.text()
    const items = extractItems(xml, src)
    if (items.length === 0) {
      // A challenge page is a 200 with HTML in it, so "parsed nothing" is the
      // signal that matters, not the status code.
      const kind = /<html/i.test(xml.slice(0, 400)) ? 'challenge or HTML, not a feed' : 'no items parsed'
      return { id: src.id, ok: false, items: [], error: kind }
    }
    return { id: src.id, ok: true, items }
  } catch (err) {
    return { id: src.id, ok: false, items: [], error: err.message }
  }
}

export function extractItems(xml, src) {
  const doc = parser.parse(xml)

  const rssItems = toArray(doc?.rss?.channel?.item)
  const atomItems = toArray(doc?.feed?.entry)
  const raw = rssItems.length > 0 ? rssItems : atomItems
  const isAtom = rssItems.length === 0 && atomItems.length > 0

  const out = []
  for (const node of raw) {
    const title = toPlainText(pickText(node?.title))
    const link = isAtom ? atomLink(node) : toPlainText(pickText(node?.link))
    if (!title || !link) continue

    const dateRaw = isAtom
      ? pickText(node?.updated) || pickText(node?.published)
      : pickText(node?.pubDate)

    const summaryRaw = isAtom
      ? pickText(node?.summary) || pickText(node?.content)
      : pickText(node?.description) || pickText(node?.['content:encoded'])

    out.push({
      id: hash(link),
      title,
      src: src.id,
      srcLabel: src.label,
      ts: parseDate(dateRaw),
      url: link,
      summary: truncate(toPlainText(summaryRaw), MAX_SUMMARY),
    })
  }
  return out
}

/** fast-xml-parser yields a bare string, or an object with #text when attributes exist. */
function pickText(node) {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return pickText(node[0])
  if (typeof node === 'object') return pickText(node['#text'])
  return ''
}

function atomLink(node) {
  for (const l of toArray(node?.link)) {
    if (typeof l === 'string') return l
    const rel = l?.['@_rel']
    if (!rel || rel === 'alternate') return String(l?.['@_href'] ?? '')
  }
  return ''
}

/**
 * Descriptions arrive as HTML inside CDATA, so XML entity decoding never
 * touched them — tags and HTML entities both survive to here.
 */
export function toPlainText(input) {
  if (!input) return ''
  return decodeEntities(
    input
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
      .replace(/<\s*br\s*\/?\s*>/gi, ' ')
      .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', bull: '•', middot: '·', trade: '™',
  reg: '®', copy: '©', deg: '°', eacute: 'é',
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

function parseDate(raw) {
  if (!raw) return nowSec()
  const t = Date.parse(raw)
  return Number.isNaN(t) ? nowSec() : Math.floor(t / 1000)
}

function truncate(s, max) {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}

/** Same story syndicated twice should occupy one slot on a 20-row display. */
export function dedupe(items) {
  const seen = new Set()
  const out = []
  for (const it of items) {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

function toArray(v) {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

function hash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export function nowSec() {
  return Math.floor(Date.now() / 1000)
}
