#!/usr/bin/env node
/**
 * Build feed.json. Run by GitHub Actions on a schedule; runs anywhere Node does.
 *
 *   node fetcher/build-feed.mjs [--out feed.json] [--limit 60]
 *
 * Exits non-zero only when every source fails, so one blocked site still
 * publishes the others rather than leaving the glasses with stale data.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { SOURCES, loadSource, dedupe, nowSec } from './parse.mjs'
import { extractArticles } from './extract.mjs'

const args = process.argv.slice(2)
const out = valueOf('--out') ?? 'feed.json'
const articlesOut = valueOf('--articles') ?? out.replace(/feed\.json$/, 'articles.json')
const limit = Number(valueOf('--limit') ?? 60)
/** Matches MAX_LIST_ITEMS in the app — the firmware shows no more than this. */
const articleCount = Number(valueOf('--articles-limit') ?? 20)

function valueOf(flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const previous = readPrevious(out)
const results = await Promise.all(SOURCES.map(s => loadSource(s)))

const items = []
const sources = []
const errors = []

for (const r of results) {
  if (r.ok) {
    items.push(...r.items)
    sources.push({ id: r.id, ok: true, items: r.items.length })
    continue
  }

  // A source that fails this run keeps whatever it published last run. These
  // sites challenge intermittently, and dropping a quarter of the feed over one
  // bad request is worse than showing stories that are an hour old.
  const carried = previous.items.filter(i => i.src === r.id)
  items.push(...carried)
  sources.push({ id: r.id, ok: false, items: carried.length, error: r.error, stale: carried.length > 0 })
  errors.push(`${r.id}: ${r.error}${carried.length ? ` (kept ${carried.length} from last run)` : ''}`)
}

const merged = dedupe(items).sort((a, b) => b.ts - a.ts).slice(0, limit)

// Full text is pulled only for the rows the glasses can actually reach — the
// firmware caps a list at 20 — so the app downloads one bundle it can read
// offline rather than paying for 40 stories nobody can select.
const readable = merged.slice(0, articleCount)

if (merged.length === 0) {
  console.error('Every source failed and there was nothing to carry over.')
  for (const s of sources) console.error(`  ${s.id}: ${s.error}`)
  process.exit(1)
}

console.log(`Extracting full text for the ${readable.length} reachable stories…`)
const previousArticles = readPreviousArticles(articlesOut)
const extracted = await extractArticles(readable, previousArticles, msg => console.log(msg))

const articles = {
  updated: nowSec(),
  count: Object.values(extracted).filter(a => a.chars > 0).length,
  items: extracted,
}
writeFileSync(articlesOut, `${JSON.stringify(articles, null, 0)}\n`)

const payload = {
  updated: nowSec(),
  count: merged.length,
  // `full` is working state from the parser, not something the list needs; it
  // would multiply feed.json's size for data the app reads from articles.json.
  items: merged.map(({ full, ...item }) => ({
    ...item,
    hasFull: extracted[item.id]?.chars > 0,
  })),
  errors,
  sources,
}

writeFileSync(out, `${JSON.stringify(payload, null, 0)}\n`)

const live = sources.filter(s => s.ok).length
console.log(`Wrote ${out}: ${merged.length} items, ${live}/${SOURCES.length} sources live`)
for (const s of sources) {
  const state = s.ok ? 'ok' : s.stale ? 'FAILED, carried over' : 'FAILED, no data'
  console.log(`  ${s.id.padEnd(4)} ${String(s.items).padStart(3)} items  ${state}${s.error ? ` — ${s.error}` : ''}`)
}

const bytes = Math.round(JSON.stringify(articles).length / 1024)
console.log(`Wrote ${articlesOut}: ${articles.count}/${readable.length} with full text, ${bytes} kB`)

// Surface a partial outage in the Actions UI without failing the run.
if (live < SOURCES.length && process.env.GITHUB_STEP_SUMMARY) {
  const lines = sources
    .filter(s => !s.ok)
    .map(s => `- **${s.id}** failed: ${s.error}${s.stale ? ' (served stale)' : ''}`)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### Feed sources down\n${lines.join('\n')}\n`, { flag: 'a' })
}

function readPreviousArticles(path) {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed.items === 'object' && parsed.items !== null ? parsed.items : {}
  } catch {
    return {}
  }
}

function readPrevious(path) {
  if (!existsSync(path)) return { items: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed.items) ? parsed : { items: [] }
  } catch {
    return { items: [] }
  }
}
