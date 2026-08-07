#!/usr/bin/env node
/**
 * Render the sideload QR to an image file.
 *
 * `evenhub qr` prints block characters to the terminal, which is fine when you
 * are sitting at it but does not survive into a document or a remote session.
 * This writes a real PNG that renders in the docs and scans off a screen.
 *
 *   node scripts/make-qr.mjs [url] [--out docs/qr-sideload.png]
 *
 * With no url it reads VITE_FEED_URL from .env and strips the /feed path, so
 * the QR always points at wherever the app is actually served from.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const qr = require('qr-image')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

const outFlag = args.indexOf('--out')
const outArg = outFlag >= 0 ? args[outFlag + 1] : 'docs/qr-sideload.png'
const out = isAbsolute(outArg) ? outArg : join(root, outArg)
// Guard on outFlag >= 0: without it, a missing --out makes outFlag + 1 === 0
// and silently eats the URL argument, falling back to .env instead of using it.
const positional = args.filter(
  (a, i) => !a.startsWith('--') && !(outFlag >= 0 && i === outFlag + 1),
)

const url = positional[0] ?? originFromEnv()
if (!url) {
  console.error('No URL given and none found in .env — pass one:')
  console.error('  node scripts/make-qr.mjs https://cybernews-feed.you.workers.dev')
  process.exit(1)
}

try {
  new URL(url)
} catch {
  console.error(`Not a usable URL: ${url}`)
  process.exit(1)
}

mkdirSync(dirname(out), { recursive: true })

// ec_level M keeps it readable off a slightly glary screen without bloating
// the module count; size 8 lands around 400px, big enough to scan from a laptop.
writeFileSync(out, qr.imageSync(url, { type: 'png', size: 8, margin: 2, ec_level: 'M' }))

console.log(`${out}`)
console.log(`  encodes: ${url}`)

function originFromEnv() {
  const envPath = join(root, '.env')
  if (!existsSync(envPath)) return null
  const match = /^VITE_FEED_URL=(.+)$/m.exec(readFileSync(envPath, 'utf8'))
  if (!match) return null
  try {
    // The app is served from the origin; /feed is just one route on it.
    return new URL(match[1].trim()).origin
  } catch {
    return null
  }
}
