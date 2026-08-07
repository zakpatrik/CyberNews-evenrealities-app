/**
 * Verifies the firmware byte budgets against real feed data.
 *
 * The G2 does not degrade gracefully when a container exceeds its limits — it
 * fails to render — and the offending strings come from four third-party feeds
 * we do not control. So the check runs against live output, not fixtures.
 *
 *   npm run verify        (needs the Worker running: npm run worker:dev)
 */

import {
  listRowLabel,
  paginateBytes,
  detailPageContent,
  truncateBytes,
  byteLen,
  timeAgo,
} from '../src/format'
import { isFreshEnough, nextRefreshDelay } from '../src/schedule'
import {
  MAX_LIST_ITEMS,
  LIST_ITEM_MAX_BYTES,
  DETAIL_MAX_BYTES,
  DETAIL_CHROME_BYTES,
} from '../src/config'

const FEED = 'http://localhost:8787/feed?limit=100'
const ARTICLES = 'http://localhost:8787/articles'

/** Hard firmware caps, quoted from the simulator changelog (v0.7.1, v0.7.3). */
const FIRMWARE_LIST_ITEM_BYTES = 63
const FIRMWARE_LIST_ITEMS = 20
const FIRMWARE_TEXT_BYTES = 999

let failures = 0
let checks = 0

function check(ok: boolean, label: string, detail = ''): void {
  checks++
  if (!ok) {
    failures++
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

interface Item {
  id: string
  title: string
  src: string
  srcLabel: string
  ts: number
  summary: string
}

async function main(): Promise<void> {
  console.log('--- synthetic edge cases ---')

  check(byteLen('abc') === 3, 'byteLen ascii')
  check(byteLen('…') === 3, 'byteLen multi-byte')
  check(byteLen('🔒') === 4, 'byteLen astral plane')

  // Truncation must never split a multi-byte character.
  for (const sample of ['🔒'.repeat(40), '’'.repeat(80), 'a'.repeat(200), 'Ω✓—…'.repeat(30)]) {
    for (const limit of [5, 8, 16, 63, 140]) {
      const out = truncateBytes(sample, limit)
      check(byteLen(out) <= limit, 'truncateBytes respects limit', `${limit} -> ${byteLen(out)}`)
      check(!out.includes('�'), 'truncateBytes produced no replacement char')
      check([...out].every(c => c.codePointAt(0) !== undefined), 'truncateBytes output is valid')
    }
  }

  check(paginateBytes('').length === 1, 'paginateBytes always returns a page')
  check(paginateBytes('   ')[0] === '', 'paginateBytes handles whitespace-only')

  // A single unbroken token longer than a page must still be split, not dropped.
  const monster = 'x'.repeat(5000)
  const monsterPages = paginateBytes(monster, DETAIL_CHROME_BYTES)
  check(monsterPages.length > 1, 'paginateBytes splits an oversized token')
  check(
    monsterPages.join('').length === monster.length,
    'paginateBytes loses no characters from an oversized token',
    `${monsterPages.join('').length} vs ${monster.length}`,
  )
  for (const p of monsterPages) {
    check(byteLen(p) <= DETAIL_MAX_BYTES - DETAIL_CHROME_BYTES, 'oversized-token page fits budget')
  }

  console.log('--- refresh pacing ---')

  const MIN = 10 * 60_000
  const MAX = 60 * 60_000
  const HOUR = 60 * 60_000
  const now = 1_800_000_000_000
  const secAgo = (ms: number) => Math.floor((now - ms) / 1000)

  // isFreshEnough takes the last *fetch* time in ms, not the publish stamp.
  check(!isFreshEnough(0, 0, now), 'nothing fetched yet is never fresh')
  check(!isFreshEnough(now, 0, now), 'zero items is never fresh, however recent the fetch')
  check(isFreshEnough(now - 60_000, 60, now), 'fetched a minute ago is fresh')
  check(isFreshEnough(now - 9 * 60_000, 60, now), 'fetched 9 minutes ago is still fresh')
  check(!isFreshEnough(now - 11 * 60_000, 60, now), 'fetched 11 minutes ago is not')
  // The bug this replaced: an old publish stamp made every reopen refetch.
  check(isFreshEnough(now - 60_000, 60, now), 'a stale publish does not force a refetch if we just asked')

  // Aim past the next publish, not at a fixed cadence.
  check(nextRefreshDelay(secAgo(10 * 60_000), now) === 50 * 60_000, '10 min old -> wait 50 min')
  check(nextRefreshDelay(secAgo(30 * 60_000), now) === 30 * 60_000, '30 min old -> wait 30 min')
  check(nextRefreshDelay(secAgo(55 * 60_000), now) === MIN, '55 min old -> floored at 10 min')
  check(nextRefreshDelay(secAgo(3 * HOUR), now) === MIN, 'long overdue -> floored, not negative')
  check(nextRefreshDelay(0, now) === MIN, 'no timestamp -> floored, not a huge wait')
  // A clock skewing the feed into the future must not park the timer for a day.
  check(nextRefreshDelay(secAgo(-5 * HOUR), now) === MAX, 'future timestamp -> capped at 60 min')

  for (const ageMin of [0, 5, 17, 42, 59, 90]) {
    for (const jitter of [0, 60_000, 119_999]) {
      const d = nextRefreshDelay(secAgo(ageMin * 60_000), now, jitter)
      check(d >= MIN && d <= MAX, 'delay always inside its bounds', `age=${ageMin}m jitter=${jitter} -> ${d}`)
    }
  }

  // One request per publish cycle, versus 12 for the old fixed 5-minute timer.
  const cycle: number[] = []
  let clock = now
  for (let i = 0; i < 5; i++) {
    // Each iteration models waking exactly when a fresh publish is available,
    // so the stamp has to advance with the clock — not stay pinned to `now`.
    const d = nextRefreshDelay(Math.floor(clock / 1000), clock)
    cycle.push(d)
    clock += d
  }
  check(cycle.every(d => d === MAX), 'a feed caught at publish settles to hourly polling', cycle.join(','))

  console.log(`  ${checks} synthetic checks, ${failures} failures`)

  console.log('--- live feed data ---')
  let items: Item[]
  try {
    const res = await fetch(FEED)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    items = (await res.json()).items as Item[]
  } catch (err) {
    console.error(`\nCould not reach ${FEED} (${(err as Error).message}).`)
    console.error('Start the Worker first:  npm run worker:dev\n')
    exit(1)
    return
  }

  console.log(`  ${items.length} live stories`)

  const before = failures
  let worstRow = 0
  let worstPage = 0
  let totalPages = 0

  const rows = items.slice(0, MAX_LIST_ITEMS).map(i => listRowLabel(i.src, i.title))
  check(rows.length <= FIRMWARE_LIST_ITEMS, 'list length within firmware cap', `${rows.length}`)
  check(MAX_LIST_ITEMS <= FIRMWARE_LIST_ITEMS, 'configured cap within firmware cap')
  check(LIST_ITEM_MAX_BYTES <= FIRMWARE_LIST_ITEM_BYTES, 'configured item cap within firmware cap')
  check(DETAIL_MAX_BYTES <= FIRMWARE_TEXT_BYTES, 'configured text cap within firmware cap')

  for (const row of rows) {
    worstRow = Math.max(worstRow, byteLen(row))
    check(byteLen(row) <= FIRMWARE_LIST_ITEM_BYTES, 'list row within 63 bytes', `"${row}" = ${byteLen(row)}B`)
    check(!row.includes('\n'), 'list row is single-line')
  }

  for (const item of items) {
    const pages = paginateBytes(item.summary || '(no summary in feed)', DETAIL_CHROME_BYTES)
    totalPages += pages.length
    for (let i = 0; i < pages.length; i++) {
      const content = detailPageContent({
        title: item.title,
        srcLabel: item.srcLabel,
        age: timeAgo(item.ts),
        pages,
        index: i,
      })
      worstPage = Math.max(worstPage, byteLen(content))
      check(
        byteLen(content) <= FIRMWARE_TEXT_BYTES,
        'detail page within 999 bytes',
        `${item.src} p${i + 1}/${pages.length} = ${byteLen(content)}B`,
      )
      check(content.includes(truncateBytes(item.title, 140).slice(0, 20)), 'detail page keeps the headline')
    }
  }

  // Full articles are the real stress test: a 15k-character story becomes
  // dozens of pages, and every one of them has to clear the firmware cap.
  console.log('--- full article pagination ---')
  let articles: Record<string, { text: string; chars: number; source: string }> = {}
  try {
    const res = await fetch(ARTICLES)
    if (res.ok) articles = ((await res.json()) as { items: typeof articles }).items ?? {}
  } catch {
    console.log('  (articles endpoint unreachable, skipping)')
  }

  const byId = new Map(items.map(i => [i.id, i]))
  let widestArticlePage = 0
  let mostPages = 0
  let articlePages = 0
  let withBody = 0

  for (const [id, article] of Object.entries(articles)) {
    if (!article.chars) continue
    withBody++
    const item = byId.get(id)
    const pages = paginateBytes(article.text, DETAIL_CHROME_BYTES)
    articlePages += pages.length
    mostPages = Math.max(mostPages, pages.length)

    check(pages.length > 0, 'a full article always paginates to at least one page')
    check(
      pages.join(' ').replace(/\s+/g, '').length >= article.text.replace(/\s+/g, '').length - 2,
      'pagination drops no article text',
      `${id}`,
    )

    for (let i = 0; i < pages.length; i++) {
      const content = detailPageContent({
        title: item?.title ?? 'Untitled',
        srcLabel: item?.srcLabel ?? 'Source',
        age: '1h',
        pages,
        index: i,
      })
      widestArticlePage = Math.max(widestArticlePage, byteLen(content))
      check(
        byteLen(content) <= FIRMWARE_TEXT_BYTES,
        'full-article page within 999 bytes',
        `${id} p${i + 1}/${pages.length} = ${byteLen(content)}B`,
      )
    }
  }

  console.log(`  articles with a body : ${withBody}`)
  console.log(`  widest article page  : ${widestArticlePage}B / ${FIRMWARE_TEXT_BYTES}B`)
  console.log(`  longest article      : ${mostPages} pages`)
  console.log(`  total article pages  : ${articlePages}`)

  console.log('--- list and summary ---')
  console.log(`  widest list row : ${worstRow}B / ${FIRMWARE_LIST_ITEM_BYTES}B`)
  console.log(`  widest detail   : ${worstPage}B / ${FIRMWARE_TEXT_BYTES}B`)
  console.log(`  detail pages    : ${totalPages} across ${items.length} stories`)
  console.log(`  ${failures - before} failures on live data`)

  console.log(`\n${checks} checks, ${failures} failures`)
  exit(failures === 0 ? 0 : 1)
}

function exit(code: number): void {
  const proc = (globalThis as { process?: { exit(c: number): void } }).process
  if (proc) proc.exit(code)
}

void main()
