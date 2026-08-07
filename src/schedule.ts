import {
  PUBLISH_INTERVAL_MS,
  MIN_REFRESH_MS,
  MAX_REFRESH_MS,
  FRESH_ENOUGH_MS,
} from './config'

/**
 * Refresh pacing, kept pure so it can be tested without a network or a clock.
 *
 * The premise: the feed changes once an hour, when the fetcher workflow
 * publishes. Requests made in between cannot return anything new, so they are
 * pure radio time — which on glasses is battery.
 */

/**
 * Is a fetch pointless right now?
 *
 * Keyed on when we last *fetched*, not on when the feed was last *published* —
 * those differ, and using the publish time gets it wrong: an 18-minute-old feed
 * looks stale, so every reopen refetches, even though nothing new exists until
 * the next hourly publish. What matters is how long ago we asked.
 */
export function isFreshEnough(lastFetchAtMs: number, itemCount: number, nowMs: number): boolean {
  if (itemCount === 0 || !lastFetchAtMs) return false
  return nowMs - lastFetchAtMs < FRESH_ENOUGH_MS
}

/**
 * How long to wait before looking again, aiming just past the next publish.
 *
 * `jitterMs` is added by the caller so wake-ups spread out across devices
 * instead of stacking on the same second; pass 0 for a deterministic result.
 */
export function nextRefreshDelay(updatedSec: number, nowMs: number, jitterMs = 0): number {
  // No timestamp yet means nothing has loaded — treat it as a full cycle behind
  // so the floor applies rather than a wildly negative age.
  const age = updatedSec ? nowMs - updatedSec * 1000 : PUBLISH_INTERVAL_MS
  const untilNextPublish = PUBLISH_INTERVAL_MS - age + jitterMs
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, untilNextPublish))
}
