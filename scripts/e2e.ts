/**
 * Headless end-to-end check of the app's interaction model, driven against the
 * live Worker with a faked SDK bridge.
 *
 * This exists because the simulator needs a desktop (WebKitGTK) and cannot run
 * in CI. It does not verify pixels — it verifies that the right containers get
 * built, that taps move between views, and that firmware byte caps hold on real
 * headlines.
 *
 *   npm run e2e        (needs the Worker running: npm run worker:dev)
 */

import { calls, fire, lastCall, readStorage, network, uncountedFetch } from './mock-sdk'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { byteLen } from '../src/format'
import { ID_LIST, ID_DETAIL, ID_CONFIRM, MAX_LIST_ITEMS, FEED_URL } from '../src/config'

// Importing main.ts boots the app: it awaits the bridge, creates the start-up
// page and performs the first refresh before this module body runs.
import '../src/main'

const FIRMWARE_LIST_ITEM_BYTES = 63
const FIRMWARE_TEXT_BYTES = 999

let failures = 0
let checks = 0

function check(ok: boolean, label: string, detail = ''): void {
  checks++
  if (ok) {
    console.log(`  ok    ${label}`)
  } else {
    failures++
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const settle = () => new Promise(r => setTimeout(r, 120))

interface AnyContainer {
  containerTotalNum?: number
  textObject?: Array<{ containerID?: number; content?: string }>
  listObject?: Array<{
    containerID?: number
    itemContainer?: { itemCount?: number; itemName?: string[] }
  }>
}

function asPage(v: unknown): AnyContainer {
  return v as AnyContainer
}

function currentRows(): string[] {
  const rebuilds = calls.filter(c => c.name === 'rebuild')
  for (let i = rebuilds.length - 1; i >= 0; i--) {
    const page = asPage(rebuilds[i].arg)
    const list = page.listObject?.find(l => l.containerID === ID_LIST)
    if (list?.itemContainer?.itemName) return list.itemContainer.itemName
  }
  return []
}

let feedUpdated = 0
function feedUpdatedAt(): number {
  return feedUpdated
}

/** The published payloads, read off-counter so the harness can assert against them. */
let liveItems: Array<{ id: string; src: string; summary: string }> = []
let liveArticles: Record<string, { text: string; chars: number; source: string }> = {}

async function loadPublished(): Promise<void> {
  try {
    const feed = (await (await uncountedFetch(FEED_URL)).json()) as {
      updated: number
      items: typeof liveItems
    }
    feedUpdated = feed.updated
    liveItems = feed.items
  } catch {
    feedUpdated = 0
  }
  try {
    const url = FEED_URL.replace(/\/feed(\?|$)/, '/articles$1')
    liveArticles = ((await (await uncountedFetch(url)).json()) as { items: typeof liveArticles }).items ?? {}
  } catch {
    liveArticles = {}
  }
}

function currentConfirm(): string[] {
  const last = lastCall('rebuild')
  if (!last) return []
  const list = asPage(last.arg).listObject?.find(l => l.containerID === ID_CONFIRM)
  return list?.itemContainer?.itemName ?? []
}

function currentDetail(): string | undefined {
  const last = lastCall()
  if (!last) return undefined
  if (last.name === 'upgrade') return (last.arg as { content?: string }).content
  if (last.name === 'rebuild') {
    const page = asPage(last.arg)
    return page.textObject?.find(t => t.containerID === ID_DETAIL)?.content
  }
  return undefined
}

async function main(): Promise<void> {
  await loadPublished()

  console.log('--- bootstrap ---')

  const created = calls.find(c => c.name === 'create')
  check(created !== undefined, 'created a start-up page')
  check(asPage(created?.arg).containerTotalNum === 2, 'start-up page has header + list')

  const rows = currentRows()
  check(rows.length > 0, 'list populated from the live feed', `${rows.length} rows`)
  check(rows.length <= MAX_LIST_ITEMS, 'list respects the 20-item cap', `${rows.length}`)
  check(
    rows.every(r => byteLen(r) <= FIRMWARE_LIST_ITEM_BYTES),
    'every rendered row is within 63 bytes',
    `max ${Math.max(...rows.map(byteLen))}B`,
  )
  check(
    rows.every(r => /^(THN|BC|CSN|DR) /.test(r)),
    'every row carries a source tag',
  )

  const header = asPage(lastCall('rebuild')?.arg).textObject?.[0]?.content ?? ''
  check(header.startsWith('CyberNews'), 'header rendered', header)
  console.log(`        header: "${header}"`)
  console.log(`        row[0]: "${rows[0]}"`)

  console.log('--- open a story ---')
  const rebuildsBefore = calls.filter(c => c.name === 'rebuild').length
  fire({ listEvent: { containerID: ID_LIST, containerName: 'stories', currentSelectItemIndex: 2 } })
  await settle()

  check(
    calls.filter(c => c.name === 'rebuild').length > rebuildsBefore,
    'tapping a row rebuilt the page',
  )
  const detail = currentDetail()
  check(detail !== undefined && detail.length > 0, 'detail view has content')
  check(asPage(lastCall('rebuild')?.arg).containerTotalNum === 1, 'detail view is a single container')
  check(byteLen(detail ?? '') <= FIRMWARE_TEXT_BYTES, 'detail within 999 bytes', `${byteLen(detail ?? '')}B`)
  check((detail ?? '').split('\n').length >= 3, 'detail has headline + source line + body')
  console.log(`        detail: "${(detail ?? '').slice(0, 60).replace(/\n/g, ' | ')}…"`)

  check(readStorage('cybernews.lastSeenTs') !== undefined, 'last-seen timestamp persisted')

  console.log('--- full article text ---')
  check(network.articleRequests === 1, 'the article bundle was fetched once, with the feed', `${network.articleRequests}`)

  // Which story is open, and does the published bundle carry its body?
  const opened = liveItems[2]
  const body = liveArticles[opened?.id ?? '']
  const hasBody = Boolean(body && body.chars > 0)
  const marked = / · summary\b/.test(detail ?? '')

  check(hasBody !== marked, 'the summary marker matches whether a body exists', `body=${hasBody} marked=${marked}`)

  if (hasBody) {
    const pager = / · (\d+)\/(\d+)/.exec(detail ?? '')
    const pageCount = pager ? Number(pager[2]) : 1
    const summaryPages = Math.max(1, Math.ceil(byteLen(opened.summary) / 340))
    check(pageCount > summaryPages, 'the article runs longer than its teaser would', `${pageCount} vs ~${summaryPages}`)
    check(
      (detail ?? '').includes(body.text.slice(0, 40)),
      'page one starts at the beginning of the article',
    )
    console.log(`        ${opened.src} · ${body.chars} chars · ${pageCount} pages · from ${body.source}`)
  } else {
    console.log(`        ${opened?.src} has no extracted body; showing the summary`)
  }

  console.log('--- paging ---')
  // The pager rides on the source line, so it must survive an in-place update.
  const pagerOf = (s: string | undefined) => / · (\d+)\/(\d+)/.exec(s ?? '')

  const firstPager = pagerOf(currentDetail())
  const beforePaging = calls.length
  fire({ textEvent: { containerID: ID_DETAIL, eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
  await settle()

  // A story short enough to fit one page has no pager, and scrolling is a no-op.
  const paged = calls.length > beforePaging
  if (paged) {
    const nextPager = pagerOf(currentDetail())
    check(firstPager !== null, 'multi-page story shows a pager', currentDetail()?.slice(0, 90))
    check(nextPager !== null, 'pager survives the in-place update')
    check(
      nextPager !== null && firstPager !== null && Number(nextPager[1]) === Number(firstPager[1]) + 1,
      'pager advanced by one page',
      `${firstPager?.[0]} -> ${nextPager?.[0]}`,
    )
    check(lastCall()?.name === 'upgrade', 'paging used textContainerUpgrade, not a rebuild')
    console.log(`        paged ${firstPager?.[0].trim()} -> ${nextPager?.[0].trim()}`)
  } else {
    check(firstPager === null, 'single-page story shows no pager')
    console.log('        single-page story, scroll was a no-op')
  }

  console.log('--- back out of detail ---')
  fire({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
  await settle()
  const backRows = currentRows()
  check(backRows.length > 0, 'double-tap returned to the list')
  check(
    asPage(lastCall('rebuild')?.arg).containerTotalNum === 2,
    'list layout restored after going back',
  )

  console.log('--- exit confirmation ---')
  const shutdowns = () => calls.filter(c => c.name === 'shutdown').length

  // Double-tap must never exit directly: it is the only exit gesture available
  // and is easy to hit by accident while scrolling.
  let before = shutdowns()
  fire({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
  await settle()

  const options = currentConfirm()
  check(options.length === 2, 'double-tap in the list opens a confirmation', `${options.length} options`)
  check(shutdowns() === before, 'confirmation did not exit on its own')
  check(/^no\b/i.test(options[0] ?? ''), '"No" is first, so it is the default selection', options[0])
  check(/yes/i.test(options[1] ?? ''), '"Yes" is second', options[1])
  console.log(`        options: ${JSON.stringify(options)}`)

  // Cancelling by double-tap.
  fire({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
  await settle()
  check(currentRows().length > 0, 'double-tap in the confirmation cancels back to the list')
  check(shutdowns() === before, 'cancelling by double-tap did not exit')

  // A click whose index is omitted on the wire must read as "No", not "Yes".
  fire({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
  await settle()
  fire({ listEvent: { containerID: ID_CONFIRM, containerName: 'confirm' } })
  await settle()
  check(currentRows().length > 0, 'confirmation click with no index cancels')
  check(shutdowns() === before, 'absent index is treated as "No", never as exit')

  // Explicitly choosing "No".
  fire({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
  await settle()
  fire({ listEvent: { containerID: ID_CONFIRM, containerName: 'confirm', currentSelectItemIndex: 0 } })
  await settle()
  check(shutdowns() === before, 'choosing "No" does not exit')
  check(currentRows().length > 0, 'choosing "No" returns to the list')

  // Explicitly choosing "Yes".
  before = shutdowns()
  fire({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
  await settle()
  fire({ listEvent: { containerID: ID_CONFIRM, containerName: 'confirm', currentSelectItemIndex: 1 } })
  await settle()
  check(shutdowns() === before + 1, 'choosing "Yes" shuts the app down')
  check(
    lastCall('shutdown')?.arg === 0,
    'exits immediately, without the second native prompt',
    `exitMode=${lastCall('shutdown')?.arg}`,
  )

  console.log('--- refresh pacing ---')
  const feedAgeMin = feedUpdatedAt() ? Math.round((Date.now() / 1000 - feedUpdatedAt()) / 60) : -1

  const afterBootstrap = network.feedRequests
  check(afterBootstrap === 1, 'bootstrap made exactly one feed request', `${afterBootstrap}`)

  // Reopening must not refetch, regardless of how old the published feed is.
  // Gating on publish age instead of last-fetch time made this depend on when
  // the cron last ran, and refetched on every reopen for most of the hour.
  fire({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } })
  await settle()
  fire({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } })
  await settle()
  fire({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } })
  await settle()

  const extra = network.feedRequests - afterBootstrap
  check(extra === 0, 'three reopens just after a fetch cost no requests', `${extra}`)
  console.log(`        published feed was ${feedAgeMin} min old; ${extra} extra request(s)`)

  console.log('--- lifecycle ---')
  fire({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } })
  await settle()
  const afterBackground = network.feedRequests
  await new Promise(r => setTimeout(r, 300))
  check(network.feedRequests === afterBackground, 'backgrounded app makes no requests')

  fire({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } })
  await settle()
  check(true, 'lifecycle events handled without throwing')

  console.log(`\n${checks} checks, ${failures} failures`)
  const proc = (globalThis as { process?: { exit(c: number): void } }).process
  proc?.exit(failures === 0 ? 0 : 1)
}

void main()
