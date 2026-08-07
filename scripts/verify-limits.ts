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
import {
  MAX_LIST_ITEMS,
  LIST_ITEM_MAX_BYTES,
  DETAIL_MAX_BYTES,
  DETAIL_CHROME_BYTES,
} from '../src/config'

const FEED = 'http://localhost:8787/feed?limit=60'

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
