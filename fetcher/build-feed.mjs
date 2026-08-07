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

const args = process.argv.slice(2)
const out = valueOf('--out') ?? 'feed.json'
const limit = Number(valueOf('--limit') ?? 60)

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

if (merged.length === 0) {
  console.error('Every source failed and there was nothing to carry over.')
  for (const s of sources) console.error(`  ${s.id}: ${s.error}`)
  process.exit(1)
}

const payload = {
  updated: nowSec(),
  count: merged.length,
  items: merged,
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

// Surface a partial outage in the Actions UI without failing the run.
if (live < SOURCES.length && process.env.GITHUB_STEP_SUMMARY) {
  const lines = sources
    .filter(s => !s.ok)
    .map(s => `- **${s.id}** failed: ${s.error}${s.stale ? ' (served stale)' : ''}`)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### Feed sources down\n${lines.join('\n')}\n`, { flag: 'a' })
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
