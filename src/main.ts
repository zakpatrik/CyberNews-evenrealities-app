import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

import { fetchFeed, fetchArticles, countUnread, type NewsItem, type ArticleMap } from './feed'
import { listPage, detailPage, confirmPage, type PageContainers } from './views'
import { listRowLabel, paginateBytes, detailPageContent, byteLen, timeAgo } from './format'
import { isFreshEnough, nextRefreshDelay } from './schedule'
import {
  ID_DETAIL,
  MAX_LIST_ITEMS,
  DETAIL_CHROME_BYTES,
  MAX_REFRESH_MS,
  REFRESH_JITTER_MS,
  RETRY_BASE_MS,
  STORAGE_KEY_LAST_SEEN,
  CONFIRM_EXIT_QUESTION,
  CONFIRM_EXIT_OPTIONS,
  CONFIRM_INDEX_NO,
  CONFIRM_INDEX_YES,
} from './config'

const bridge = await waitForEvenAppBridge()

type View = 'list' | 'detail' | 'confirm'

const state = {
  view: 'list' as View,
  items: [] as NewsItem[],
  updated: 0,
  errors: [] as string[],
  /** Newest ts the user has already been shown; drives the "N new" badge. */
  lastSeenTs: 0,
  /** When we last successfully fetched — distinct from `updated`, the publish time. */
  lastFetchAt: 0,
  detailIndex: 0,
  detailPages: [] as string[],
  detailPage: 0,
  /** False when the open story fell back to its RSS summary. */
  detailFull: false,
  /** Full article bodies, keyed by item id. Downloaded with each refresh. */
  articles: {} as ArticleMap,
  loading: false,
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined
let retryDelay = RETRY_BASE_MS
let nextRefreshAt = 0

// ---------------------------------------------------------------- rendering

/** Push a fresh layout to the glasses. Container sets differ per view, so this is a rebuild. */
async function render(page: PageContainers): Promise<void> {
  await bridge.rebuildPageContainer(new RebuildPageContainer(page))
}

function headerText(): string {
  if (state.loading && state.items.length === 0) return 'CyberNews · loading…'
  if (state.items.length === 0) return 'CyberNews · no stories'

  const unread = countUnread(state.items, state.lastSeenTs)
  const right = unread > 0 ? `${unread} new` : timeAgo(state.updated)
  const degraded = state.errors.length > 0 ? ` · ${state.errors.length} src down` : ''

  // The firmware list caps at MAX_LIST_ITEMS rows, so say so rather than
  // quietly presenting a truncated list as the whole feed.
  const shown = Math.min(state.items.length, MAX_LIST_ITEMS)
  const count = shown < state.items.length ? `${shown} of ${state.items.length}` : `${shown}`
  return `CyberNews · ${count}${degraded} · ${right}`
}

async function renderList(): Promise<void> {
  state.view = 'list'
  const rows = state.items
    .slice(0, MAX_LIST_ITEMS)
    .map(it => listRowLabel(it.src, it.title))

  // The list widget needs at least one row to render a sane box.
  await render(listPage(headerText(), rows.length > 0 ? rows : ['No stories yet']))
  setCompanionStatus()
}

/**
 * Ask before leaving. The firmware exposes no long-press event, so double-tap
 * is the only gesture available to open this — which is exactly why it needs a
 * confirmation: double-tap is easy to trigger by accident while scrolling.
 */
async function renderConfirmExit(): Promise<void> {
  state.view = 'confirm'
  await render(confirmPage(CONFIRM_EXIT_QUESTION, [...CONFIRM_EXIT_OPTIONS]))
  setCompanionStatus()
}

function detailContent(): string {
  const item = state.items[state.detailIndex]
  if (!item) return 'Story unavailable.'

  return detailPageContent({
    title: item.title,
    // Say when you are reading the teaser rather than the story, so a short
    // read is not mistaken for a short article.
    srcLabel: state.detailFull ? item.srcLabel : `${item.srcLabel} · summary`,
    age: timeAgo(item.ts),
    pages: state.detailPages,
    index: state.detailPage,
  })
}

async function openDetail(index: number): Promise<void> {
  const item = state.items[index]
  if (!item) return

  state.detailIndex = index

  // Prefer the downloaded article; fall back to the RSS summary when extraction
  // failed for this source, which is what happens for Dark Reading.
  const article = state.articles[item.id]
  const body = article && article.chars > 0 ? article.text : item.summary
  state.detailFull = Boolean(article && article.chars > 0)
  state.detailPages = paginateBytes(body || '(no text available)', DETAIL_CHROME_BYTES)
  state.detailPage = 0
  state.view = 'detail'

  await render(detailPage(detailContent()))
  setCompanionStatus()

  // Opening a story counts as having seen everything above it in the list.
  await markSeen(state.items[0]?.ts ?? item.ts)
}

/** Page within the detail view without rebuilding the layout. */
async function showDetailPage(next: number): Promise<void> {
  const clamped = Math.min(Math.max(0, next), state.detailPages.length - 1)
  if (clamped === state.detailPage) return
  state.detailPage = clamped

  const content = detailContent()
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: ID_DETAIL,
      containerName: 'detail',
      contentOffset: 0,
      // Every other length in this API is a byte count, so this one is too.
      contentLength: byteLen(content),
      content,
    }),
  )
  setCompanionStatus()
}

// ------------------------------------------------------------------- data

async function refresh({ force = false } = {}): Promise<void> {
  if (state.loading) return

  if (!force && isFreshEnough(state.lastFetchAt, state.items.length, Date.now())) {
    scheduleNextRefresh()
    return
  }

  state.loading = true
  setCompanionStatus()

  let ok = false
  try {
    // Both in one go: the article bundle is what makes reading work without a
    // signal, so a refresh that skipped it would leave stories unreadable later.
    const [result, articles] = await Promise.all([
      fetchFeed(),
      fetchArticles().catch(err => {
        // Losing the bodies is a degradation, not a failure — summaries still show.
        console.warn('Article bodies unavailable:', err)
        return {} as ArticleMap
      }),
    ])
    state.items = result.items
    state.updated = result.updated
    state.errors = result.errors
    state.lastFetchAt = Date.now()
    if (Object.keys(articles).length > 0) state.articles = articles
    ok = true
    if (result.errors.length > 0) console.warn('Feed sources degraded:', result.errors)
  } catch (err) {
    // Keep whatever is already on screen; a failed refresh must not blank the display.
    state.errors = [(err as Error).message]
    console.error('Feed refresh failed:', err)
  } finally {
    state.loading = false
  }

  if (ok) scheduleNextRefresh()
  else scheduleRetry()

  if (state.view === 'list') await renderList()
  else setCompanionStatus()
}

async function markSeen(ts: number): Promise<void> {
  if (!ts || ts <= state.lastSeenTs) return
  state.lastSeenTs = ts
  try {
    await bridge.setLocalStorage(STORAGE_KEY_LAST_SEEN, String(ts))
  } catch (err) {
    console.warn('Could not persist last-seen timestamp:', err)
  }
}

async function loadLastSeen(): Promise<void> {
  try {
    const raw = await bridge.getLocalStorage(STORAGE_KEY_LAST_SEEN)
    const parsed = parseInt(raw ?? '', 10)
    if (Number.isFinite(parsed) && parsed > 0) state.lastSeenTs = parsed
  } catch {
    // First run, or storage unavailable — an unread count of zero is a fine default.
  }
}

/**
 * Wake shortly after the next expected publish rather than on a fixed cadence.
 * If the data we hold is 10 minutes old, the next one is ~50 minutes out, so
 * that is when to look — anything sooner is radio time spent on an unchanged file.
 */
function scheduleNextRefresh(): void {
  stopAutoRefresh()
  retryDelay = RETRY_BASE_MS

  const jitter = Math.floor(Math.random() * REFRESH_JITTER_MS)
  const delay = nextRefreshDelay(state.updated, Date.now(), jitter)

  nextRefreshAt = Date.now() + delay
  refreshTimer = setTimeout(() => void refresh({ force: true }), delay)
}

/** Back off after a failure so a flat network does not become a polling loop. */
function scheduleRetry(): void {
  stopAutoRefresh()
  const delay = retryDelay
  retryDelay = Math.min(MAX_REFRESH_MS, retryDelay * 2)

  nextRefreshAt = Date.now() + delay
  refreshTimer = setTimeout(() => void refresh({ force: true }), delay)
}

function stopAutoRefresh(): void {
  if (refreshTimer === undefined) return
  clearTimeout(refreshTimer)
  refreshTimer = undefined
  nextRefreshAt = 0
}

// ----------------------------------------------------------------- events

/**
 * Protobuf omits zero-valued fields on the wire, so CLICK_EVENT (0) arrives with
 * `eventType` absent. A present envelope with no eventType therefore means CLICK —
 * coalescing to null instead would silently swallow every tap.
 */
function eventTypeOf(envelope: { eventType?: OsEventTypeList } | undefined): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = eventTypeOf(event.sysEvent)
  const listType = eventTypeOf(event.listEvent)
  const textType = eventTypeOf(event.textEvent)

  // Double-tap is the universal "back" and must work from any envelope. It never
  // exits directly: from the list it opens the confirmation, and from the
  // confirmation it cancels, so no single gesture can drop you out of the app.
  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    if (state.view === 'detail') void renderList()
    else if (state.view === 'confirm') void renderList()
    else void renderConfirmExit()
    return
  }

  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    // Not forced: reopening the app a minute later should cost nothing.
    void refresh()
    return
  }

  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    stopAutoRefresh()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    stopAutoRefresh()
    unsubscribe()
    return
  }

  if (state.view === 'confirm') {
    if (listType === OsEventTypeList.CLICK_EVENT) {
      // Index is omitted on the wire when it is zero, and zero is "No" — so an
      // absent index must fall back to cancelling, never to exiting.
      const choice = event.listEvent?.currentSelectItemIndex ?? CONFIRM_INDEX_NO
      if (choice === CONFIRM_INDEX_YES) void bridge.shutDownPageContainer(0)
      else void renderList()
    }
    return
  }

  if (state.view === 'list') {
    // Scroll events only move the widget's own selection; act on the click.
    if (listType === OsEventTypeList.CLICK_EVENT) {
      void openDetail(event.listEvent?.currentSelectItemIndex ?? 0)
    }
    return
  }

  // Detail view: scroll pages, click advances, and a click past the end returns.
  const detailType = textType ?? sysType
  if (detailType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    void showDetailPage(state.detailPage + 1)
  } else if (detailType === OsEventTypeList.SCROLL_TOP_EVENT) {
    void showDetailPage(state.detailPage - 1)
  } else if (detailType === OsEventTypeList.CLICK_EVENT) {
    if (state.detailPage >= state.detailPages.length - 1) void renderList()
    else void showDetailPage(state.detailPage + 1)
  }
})

// ------------------------------------------------- companion (phone) screen

function setCompanionStatus(): void {
  const el = document.getElementById('app')
  if (!el) return

  const nextIn = nextRefreshAt ? Math.max(0, Math.round((nextRefreshAt - Date.now()) / 60000)) : null

  const lines = [
    `<strong>CyberNews</strong>`,
    state.loading ? 'Refreshing…' : `${state.items.length} stories · updated ${timeAgo(state.updated)}`,
    `View: ${state.view}`,
    state.errors.length > 0 ? `<span class="warn">${state.errors.join(' · ')}</span>` : 'All sources OK',
    nextIn === null ? '<span class="hint">Refresh paused</span>' : `<span class="hint">Next refresh in ~${nextIn} min</span>`,
    `<span class="hint">Check the glasses display.</span>`,
  ]
  el.innerHTML = lines.join('<br>')
}

// -------------------------------------------------------------- bootstrap

await loadLastSeen()

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer(listPage('CyberNews · loading…', ['Loading…'])),
)
// A non-zero result is not fatal: the first refresh rebuilds the page anyway.
// It shows up during dev when hot reload re-runs this against a live container.
console.log('Page created:', created === 0 ? 'success' : `failed (${created})`)

await refresh()
