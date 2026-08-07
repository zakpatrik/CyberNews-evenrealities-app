/**
 * Full article text, for reading on the glasses instead of just the teaser.
 *
 * Three of the four sources give up their article body: Cybersecurity News
 * ships it in the feed's content:encoded, The Hacker News and BleepingComputer
 * hand over the page to an ordinary request. Dark Reading does not — its
 * article pages sit behind a Cloudflare JS challenge that answers 403 to every
 * header combination. Defeating that would mean driving a headless browser
 * specifically to get past a control the site put up deliberately, so DR keeps
 * its RSS summary and is marked as such.
 */

import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

const FETCH_TIMEOUT_MS = 25_000
/** Roughly 60 pages on the display. Past that it is a document, not a news story. */
const MAX_ARTICLE_CHARS = 20_000
/** Below this the extractor found navigation, not an article. */
const MIN_ARTICLE_CHARS = 400
/** Politeness, and it keeps memory flat — jsdom parses are not cheap. */
const CONCURRENCY = 4

/**
 * Tails that carry no story: newsletter pitches, share prompts, author bios.
 * Anchored to the end of the text and conservative on purpose — cutting a real
 * closing paragraph is worse than leaving a line of boilerplate on the last page.
 */
const TRAILING_NOISE = [
  /Found this (article|news) interesting\?[\s\S]*$/i,
  /Follow us on (Google News|Twitter|LinkedIn)[\s\S]*$/i,
  /Sign up (for|to) (our|the) (free )?newsletter[\s\S]*$/i,
  /Subscribe to our newsletter[\s\S]*$/i,
  /Get the whitepaper\s*$/i,
  /Share (this )?(article|post)( on)?[\s\S]{0,80}$/i,
]

export async function extractArticles(items, log = () => {}) {
  const out = {}
  const queue = [...items]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      out[item.id] = await extractOne(item, log)
    }
  })
  await Promise.all(workers)
  return out
}

async function extractOne(item, log) {
  // Already had it from the feed — no reason to ask the site again.
  if (item.full) {
    const text = finish(item.full)
    log(`  ${item.src.padEnd(4)} ${String(text.chars).padStart(6)} chars  from feed`)
    return { ...text, source: 'feed' }
  }

  try {
    const res = await fetch(item.url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      log(`  ${item.src.padEnd(4)} ${'—'.padStart(6)}        HTTP ${res.status}, summary only`)
      return { text: '', chars: 0, truncated: false, source: 'summary', error: `HTTP ${res.status}` }
    }

    const html = await res.text()
    const dom = new JSDOM(html, { url: item.url })
    const parsed = new Readability(dom.window.document, { charThreshold: 200 }).parse()
    dom.window.close()

    const raw = normalise(parsed?.textContent ?? '')
    if (raw.length < MIN_ARTICLE_CHARS) {
      log(`  ${item.src.padEnd(4)} ${String(raw.length).padStart(6)} chars  too short, summary only`)
      return { text: '', chars: 0, truncated: false, source: 'summary', error: 'extraction too short' }
    }

    const text = finish(raw)
    log(`  ${item.src.padEnd(4)} ${String(text.chars).padStart(6)} chars  from page${text.truncated ? ', truncated' : ''}`)
    return { ...text, source: 'page' }
  } catch (err) {
    log(`  ${item.src.padEnd(4)} ${'—'.padStart(6)}        ${err.message}, summary only`)
    return { text: '', chars: 0, truncated: false, source: 'summary', error: err.message }
  }
}

function finish(raw) {
  let text = normalise(raw)
  for (const pattern of TRAILING_NOISE) text = text.replace(pattern, '').trim()

  if (text.length <= MAX_ARTICLE_CHARS) return { text, chars: text.length, truncated: false }

  const cut = text.slice(0, MAX_ARTICLE_CHARS)
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  const trimmed = lastStop > MAX_ARTICLE_CHARS * 0.8 ? cut.slice(0, lastStop + 1) : cut
  return { text: `${trimmed.trim()} […]`, chars: trimmed.length, truncated: true }
}

function normalise(s) {
  return String(s ?? '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}
