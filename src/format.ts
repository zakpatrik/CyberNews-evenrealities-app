import { LIST_ITEM_MAX_BYTES, DETAIL_MAX_BYTES, DETAIL_TITLE_MAX_BYTES } from './config'

const encoder = new TextEncoder()

/**
 * Firmware limits are expressed in bytes, not characters, and feed titles are
 * full of multi-byte punctuation (’ — …). Everything below budgets in bytes and
 * iterates by code point so a character is never split down the middle.
 */
export function byteLen(s: string): number {
  return encoder.encode(s).length
}

export function truncateBytes(s: string, maxBytes: number, ellipsis = '…'): string {
  if (byteLen(s) <= maxBytes) return s

  const budget = Math.max(0, maxBytes - byteLen(ellipsis))
  let out = ''
  let used = 0
  for (const ch of s) {
    const b = byteLen(ch)
    if (used + b > budget) break
    out += ch
    used += b
  }

  // Prefer a word boundary, but only when it does not cost most of the line.
  const lastSpace = out.lastIndexOf(' ')
  if (lastSpace > out.length * 0.6) out = out.slice(0, lastSpace)
  return out.trimEnd() + ellipsis
}

/** Compact relative age: 12m, 3h, 2d. Anything older than a week gets a date. */
export function timeAgo(tsSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
  if (!tsSec) return '—'
  const diff = Math.max(0, nowSec - tsSec)
  if (diff < 60) return 'now'
  const mins = Math.floor(diff / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const d = new Date(tsSec * 1000)
  return `${d.getDate()}/${d.getMonth() + 1}`
}

/**
 * One list row: source tag, then as much headline as the 63-byte item limit allows.
 * Age is omitted here — it would cost several bytes of headline and is shown in
 * the detail view anyway.
 */
export function listRowLabel(srcTag: string, title: string): string {
  return truncateBytes(`${srcTag} ${title}`, LIST_ITEM_MAX_BYTES)
}

/**
 * Split body text into pages that fit the text container's byte limit, breaking
 * on whitespace so words never straddle a page boundary. Always returns at least
 * one page.
 *
 * `reserveBytes` accounts for the title/meta/pager chrome that gets prepended to
 * every page, so the assembled content stays under the firmware cap.
 */
export function paginateBytes(text: string, reserveBytes = 0, maxBytes = DETAIL_MAX_BYTES): string[] {
  const body = text.trim()
  if (!body) return ['']

  const budget = Math.max(40, maxBytes - reserveBytes)
  if (byteLen(body) <= budget) return [body]

  const pages: string[] = []
  let current = ''
  let used = 0

  for (const word of body.split(/\s+/)) {
    const piece = current === '' ? word : ` ${word}`
    const pieceBytes = byteLen(piece)

    if (used + pieceBytes <= budget) {
      current += piece
      used += pieceBytes
      continue
    }

    if (current !== '') {
      pages.push(current)
      current = ''
      used = 0
    }

    // A single word longer than a whole page still has to go somewhere.
    if (byteLen(word) > budget) {
      let rest = word
      while (byteLen(rest) > budget) {
        const head = truncateBytes(rest, budget, '')
        pages.push(head)
        rest = rest.slice(head.length)
      }
      current = rest
      used = byteLen(rest)
    } else {
      current = word
      used = byteLen(word)
    }
  }

  if (current !== '') pages.push(current)
  return pages.length > 0 ? pages : ['']
}

/**
 * Assemble one detail-view screen: headline, source line, body page, pager.
 *
 * Kept pure and separate from the SDK plumbing so the firmware byte budget can
 * be verified directly against real feed data.
 */
export function detailPageContent(opts: {
  title: string
  srcLabel: string
  age: string
  pages: string[]
  index: number
}): string {
  const { title, srcLabel, age, pages, index } = opts
  const total = pages.length
  const body = pages[index] ?? ''

  // The pager rides on the source line rather than sitting under the body: a
  // trailing pager costs two lines, which pushed it off the bottom of the 288px
  // canvas on multi-page stories.
  const pager = total > 1 ? ` · ${index + 1}/${total}` : ''
  const head = `${truncateBytes(title, DETAIL_TITLE_MAX_BYTES)}\n${srcLabel} · ${age}${pager}\n\n`

  // paginateBytes already reserved DETAIL_CHROME_BYTES for this chrome, so the
  // guard below should never bite; it exists so an unusually long source label
  // cannot push the container past the firmware cap and blank the screen.
  return truncateBytes(head + body, DETAIL_MAX_BYTES, '')
}
