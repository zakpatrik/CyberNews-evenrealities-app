/**
 * Tunables.
 *
 * Two different kinds of limit live here, and conflating them causes bugs:
 *
 *  - Hard firmware caps (20 list items, 63 bytes per item, 999 bytes per text
 *    container). Exceed one and the container fails to render outright.
 *  - Rendered-size budgets, measured in the simulator. These sit well below the
 *    firmware caps because text that is legal still wraps or clips once it
 *    exceeds 576x288, which quietly breaks the layout.
 *
 * Both are enforced byte-wise in format.ts, since feed headlines are full of
 * multi-byte punctuation and character counts would understate them.
 */

/** Feed aggregator endpoint. Override per-environment via VITE_FEED_URL (.env). */
// Optional chaining keeps this module importable outside Vite (e.g. the
// limit-verification script), where import.meta.env does not exist.
export const FEED_URL: string =
  import.meta.env?.VITE_FEED_URL ?? 'https://cybernews-feed.YOUR-SUBDOMAIN.workers.dev/feed'

/** Full article bodies, on the same origin. Derived so there is one URL to set. */
export const ARTICLES_URL: string = FEED_URL.replace(/\/feed(\?|$)/, '/articles$1')

/** Display geometry, in device pixels. */
export const SCREEN_W = 576
export const SCREEN_H = 288
export const HEADER_H = 34

/** Container IDs — stable per view so events can be attributed unambiguously. */
export const ID_HEADER = 1
export const ID_LIST = 2
export const ID_DETAIL = 3

/** How many stories to pull from the aggregator. */
export const FEED_LIMIT = 100

/** Firmware caps a list at 20 items; anything beyond this is simply not shown. */
export const MAX_LIST_ITEMS = 20

/**
 * Paging through the feed.
 *
 * The 20-row cap is the firmware's, not ours, so reaching story 21 means
 * repainting the list rather than growing it. When the feed does not fit one
 * page, the last row becomes navigation and the other 19 carry stories.
 *
 * Plain ASCII on purpose: the firmware substitutes a placeholder for glyphs
 * outside its font, and arrows are exactly the kind of character it lacks.
 */
export const LIST_STORIES_PER_PAGE = MAX_LIST_ITEMS - 1
export const LIST_NAV_MORE = '>> Older'
export const LIST_NAV_WRAP = '<< Back to newest'

/**
 * Rendered width, not the firmware cap.
 *
 * The firmware accepts 63 bytes per list item, but a 63-byte headline is wider
 * than 576px and wraps to a second line — which knocks the whole list out of
 * alignment and appends a second ellipsis. Measured in the simulator: 58 still
 * renders on one line, 63 wraps. 56 keeps a margin for headlines heavy in
 * capitals and acronyms, which are wider per character.
 */
export const LIST_ITEM_MAX_BYTES = 56

/**
 * Rendered height, not the firmware cap.
 *
 * The firmware accepts 999 bytes per text container, but only ~10 lines fit in
 * 288px and anything past that is silently clipped. Measured in the simulator:
 * a two-line headline plus source line leaves six body lines, so the body gets
 * DETAIL_MAX_BYTES - DETAIL_CHROME_BYTES = 340.
 */
export const DETAIL_MAX_BYTES = 500
/** Bytes reserved on every detail page for the headline and source line. */
export const DETAIL_CHROME_BYTES = 160
/** Keeps the detail headline to at most two rendered lines. */
export const DETAIL_TITLE_MAX_BYTES = 110

/**
 * Refresh pacing.
 *
 * The source data changes once an hour — that is how often the fetcher workflow
 * publishes — so a fixed short interval spends radio time re-reading a file that
 * cannot have changed. Instead the app aims to wake shortly after the next
 * publish, and skips the request entirely while what it holds is still fresh.
 */

/** How often .github/workflows/feed.yml publishes. Keep the two in step. */
export const PUBLISH_INTERVAL_MS = 60 * 60 * 1000
/** Floor on the gap between requests, whatever the arithmetic suggests. */
export const MIN_REFRESH_MS = 10 * 60 * 1000
/** Ceiling, so a clock skew cannot park the timer for half a day. */
export const MAX_REFRESH_MS = 60 * 60 * 1000
/** Spread wake-ups so every device does not hit the same second. */
export const REFRESH_JITTER_MS = 2 * 60 * 1000
/** First retry after a failed refresh; doubles up to MAX_REFRESH_MS. */
export const RETRY_BASE_MS = 2 * 60 * 1000
/**
 * Minimum gap between two actual requests. Reopening the app inside this window
 * reuses what is already loaded: opening the glasses ten times an hour should
 * cost one request, not ten.
 */
export const FRESH_ENOUGH_MS = 10 * 60 * 1000

/** Network timeout for a feed request. */
export const FETCH_TIMEOUT_MS = 15_000

/** Persisted key for the newest timestamp the user has already seen. */
export const STORAGE_KEY_LAST_SEEN = 'cybernews.lastSeenTs'
