#!/usr/bin/env node
/**
 * Point the app at a feed aggregator.
 *
 * The URL has to be in two places or the app breaks in a confusing way: .env
 * (baked in at build time by Vite) and the app.json network whitelist (enforced
 * at runtime by the host, not at build time). Setting only one leaves you with a
 * build that looks fine and silently fails to fetch on the glasses.
 *
 *   node scripts/set-feed-url.mjs https://cybernews-feed.you.workers.dev
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV = join(root, '.env')
const MANIFEST = join(root, 'app.json')

const raw = process.argv[2]
if (!raw) {
  console.error('Usage: node scripts/set-feed-url.mjs <worker-url>')
  console.error('   e.g. node scripts/set-feed-url.mjs https://cybernews-feed.you.workers.dev')
  process.exit(1)
}

let origin
try {
  const parsed = new URL(raw)
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('must be http or https')
  origin = parsed.origin
} catch (err) {
  console.error(`Not a usable URL: ${raw} (${err.message})`)
  process.exit(1)
}

if (origin.startsWith('http://') && !/^http:\/\/(localhost|127\.|192\.168\.|10\.|172\.)/.test(origin)) {
  console.error(`Refusing plain http for a non-local host: ${origin}`)
  process.exit(1)
}

const feedUrl = `${origin}/feed`

// .env — Vite inlines this at build time.
const envLine = `VITE_FEED_URL=${feedUrl}`
let env = existsSync(ENV) ? readFileSync(ENV, 'utf8') : ''
env = /^VITE_FEED_URL=.*$/m.test(env)
  ? env.replace(/^VITE_FEED_URL=.*$/m, envLine)
  : `${env.trimEnd()}\n${envLine}\n`.trimStart()
writeFileSync(ENV, env.endsWith('\n') ? env : `${env}\n`)

// app.json — the host blocks any origin missing from this list, at runtime.
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const network = (manifest.permissions ?? []).find(p => p.name === 'network')
if (!network) {
  console.error('app.json has no "network" permission to whitelist against.')
  process.exit(1)
}
network.whitelist = [origin]
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`.env      VITE_FEED_URL = ${feedUrl}`)
console.log(`app.json  whitelist     = ["${origin}"]`)

// A reachable /health now saves a confusing round of "why is the list empty".
try {
  const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000) })
  const body = await res.text()
  console.log(res.ok ? `health    ${body.slice(0, 80)}` : `health    HTTP ${res.status} — check the deploy`)
} catch (err) {
  console.log(`health    unreachable (${err.message}) — fine if you have not deployed yet`)
}

console.log('\nNext:  npm run build && npm run pack')
