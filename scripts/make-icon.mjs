#!/usr/bin/env node
/**
 * Even Hub app icon: 24x24, 1-bit artwork, white on dark.
 *
 * Drawn in code rather than exported from an editor because at 24 pixels every
 * one is a decision, and the constraints are checkable: Even Hub wants
 * monochrome only, ink coverage roughly 12-55%, no isolated pixels, and a
 * 2-pixel margin so nothing touches the edge. All four are asserted below, so a
 * tweak that breaks one fails here rather than in review.
 *
 *   node scripts/make-icon.mjs [--out docs/app-icon-24.png]
 *
 * The mark is a shield holding three lines of text — the last one short, which
 * is what reads as a paragraph rather than as an "=" symbol. A security reader,
 * in the two shapes that survive this size.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const SIZE = 24
const MARGIN = 2
const INK_MIN = 12
const INK_MAX = 55
/** Emitted alongside the real icon so the artwork can be eyeballed. */
const PREVIEW_SCALE = 10

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outFlag = args.indexOf('--out')
const outArg = outFlag >= 0 ? args[outFlag + 1] : 'docs/app-icon-24.png'
const out = isAbsolute(outArg) ? outArg : join(root, outArg)

// ------------------------------------------------------------------ drawing

const grid = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0))

/**
 * Shield silhouette: straight sides to the shoulder, then a curved taper.
 * A linear taper leaves visible stair-steps at this size; the exponent softens
 * the shoulder of the curve without needing anti-aliasing we cannot have.
 */
function shieldMask(top, bottom, x0, x1, shoulderFrac = 0.5, power = 1.8) {
  const mask = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0))
  const shoulder = top + Math.round((bottom - top) * shoulderFrac)
  const half = (x1 - x0) / 2

  for (let y = top; y <= bottom; y++) {
    let a = x0
    let b = x1
    if (y > shoulder) {
      const t = (y - shoulder) / Math.max(1, bottom - shoulder)
      const inset = Math.round(half * t ** power)
      a = x0 + inset
      b = x1 - inset
    }
    for (let x = a; x <= b; x++) mask[y][x] = 1
  }
  return mask
}

/** Shrink by one pixel on every side; subtracting the result leaves an outline. */
function erode(mask) {
  const out = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0))
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      if (mask[y][x] && mask[y - 1][x] && mask[y + 1][x] && mask[y][x - 1] && mask[y][x + 1]) {
        out[y][x] = 1
      }
    }
  }
  return out
}

function bar(y, x0, x1) {
  for (let x = x0; x <= x1; x++) grid[y][x] = 1
}

const shield = shieldMask(MARGIN, SIZE - MARGIN - 1, 2, 21)
const inner = erode(erode(shield))
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) grid[y][x] = shield[y][x] && !inner[y][x] ? 1 : 0
}

// Three lines of "text". The short last one is the whole trick — equal lines
// read as a symbol, ragged ones read as a paragraph.
bar(8, 7, 16)
bar(11, 7, 16)
bar(14, 7, 13)

// -------------------------------------------------------------- constraints

const lit = grid.flat().reduce((n, v) => n + v, 0)
const coverage = (lit / (SIZE * SIZE)) * 100

const strays = []
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!grid[y][x]) continue
    let neighbours = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dy && !dx) continue
        const ny = y + dy
        const nx = x + dx
        if (ny >= 0 && ny < SIZE && nx >= 0 && nx < SIZE) neighbours += grid[ny][nx]
      }
    }
    if (neighbours === 0) strays.push(`${x},${y}`)
  }
}

const bleeding = []
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const outside = y < MARGIN || y >= SIZE - MARGIN || x < MARGIN || x >= SIZE - MARGIN
    if (grid[y][x] && outside) bleeding.push(`${x},${y}`)
  }
}

const problems = []
if (coverage < INK_MIN || coverage > INK_MAX) problems.push(`ink coverage ${coverage.toFixed(1)}% outside ${INK_MIN}-${INK_MAX}%`)
if (strays.length) problems.push(`${strays.length} isolated pixel(s): ${strays.slice(0, 5).join(' ')}`)
if (bleeding.length) problems.push(`${bleeding.length} pixel(s) inside the ${MARGIN}px margin: ${bleeding.slice(0, 5).join(' ')}`)

if (problems.length) {
  console.error('Icon violates the Even Hub constraints:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

// ------------------------------------------------------------------ encoding

/**
 * RGBA with R=G=B, which is what g2-icon-studio exports and therefore the shape
 * the portal is known to accept. A greyscale-typed PNG would be smaller but is
 * a less-trodden path through whatever validates the upload.
 */
function encodePng(pixels, width, height) {
  const raw = Buffer.alloc(height * (1 + width * 4))
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const v = pixels[y][x] ? 255 : 0
      raw[p++] = v
      raw[p++] = v
      raw[p++] = v
      raw[p++] = 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function scale(pixels, factor) {
  return Array.from({ length: pixels.length * factor }, (_, y) =>
    Array.from({ length: pixels[0].length * factor }, (_, x) =>
      pixels[Math.floor(y / factor)][Math.floor(x / factor)],
    ),
  )
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, encodePng(grid, SIZE, SIZE))

const previewPath = out.replace(/\.png$/, `-preview.png`)
const big = scale(grid, PREVIEW_SCALE)
writeFileSync(previewPath, encodePng(big, big[0].length, big.length))

console.log(`${out}`)
console.log(`  ${SIZE}x${SIZE}, white on dark, ink ${coverage.toFixed(1)}% (limit ${INK_MIN}-${INK_MAX}%)`)
console.log(`  no isolated pixels, ${MARGIN}px margin clear`)
console.log(`${previewPath}`)
console.log(`  ${PREVIEW_SCALE}x, for looking at`)
console.log('')
for (const row of grid) console.log('  ' + row.map(v => (v ? '##' : '..')).join(''))
