/**
 * Read one DSH session log and report the facts this plugin's guard depends on.
 *
 * The v3 log is multi-frame zstd: each frame is an independently compressed
 * chunk of JSONL, so the whole file cannot be inflated in one call.
 *
 * Usage:
 *   node tools/session-report.mjs <session.v3.jsonl.zstd>
 *   node tools/session-report.mjs --home <DSH_HOME>          # newest session
 *
 * Reports only counts, types and sizes - never message content beyond the prune
 * marker, which it looks for because that marker is the subject of the report.
 *
 * @module dsh-cache-safe-tool-result/tools/session-report
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { PRUNE_MARKER } from '../src/truncate.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Inflate every zstd frame in the file, concatenated.
 * @param file - path to the `.zstd` session log.
 * @returns the decoded JSONL text.
 */
export function inflateFrames(file) {
  const buffer = readFileSync(file)
  const parts = []
  let cursor = 0
  while (true) {
    const at = buffer.indexOf(MAGIC, cursor)
    if (at < 0) break
    let end = buffer.indexOf(MAGIC, at + MAGIC.length)
    if (end < 0) end = buffer.length
    parts.push(zstdDecompressSync(buffer.subarray(at, end)))
    cursor = end
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Every event in a session log, in file order. */
export function readEvents(file) {
  const events = []
  for (const line of inflateFrames(file).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch { /* a torn tail line: ignore it, the rest of the log is intact */ }
  }
  return events
}

/** The newest session log under `<home>/sessions`. */
export function newestSessionLog(home) {
  const root = join(home, 'sessions')
  let newest
  for (const workspace of readdirSync(root)) {
    const dir = join(root, workspace)
    for (const session of readdirSync(dir)) {
      const file = join(dir, session, 'session.v3.jsonl.zstd')
      try {
        const stat = statSync(file)
        if (newest === undefined || stat.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: stat.mtimeMs }
      } catch { /* not a session directory */ }
    }
  }
  return newest?.file
}

/** Structural summary of one session log. */
export function summarise(events) {
  const types = new Map()
  const rewrites = []
  let firstPassAppends = 0
  let markerInAppend = 0
  let pruneEvents = 0
  let toolResults = 0

  for (const event of events) {
    const type = event.type ?? '(header)'
    types.set(type, (types.get(type) ?? 0) + 1)
    if (type === 'compaction/prune') pruneEvents += 1
    if (type !== 'tool/result') continue
    toolResults += 1
    const op = event.surfaceOp
    const text = JSON.stringify(event.data?.message?.content ?? '')
    if (op === 'append' || op === undefined) {
      firstPassAppends += 1
      if (text.includes(PRUNE_MARKER)) markerInAppend += 1
    } else if (typeof op === 'object' && op.op === 'replace') {
      rewrites.push({ atSeq: event.seq, targetSeq: op.startSeq, truncated: text.includes(PRUNE_MARKER) })
    }
  }
  return { total: events.length, types, toolResults, firstPassAppends, markerInAppend, pruneEvents, rewrites }
}

function main(argv) {
  let file
  if (argv[0] === '--home') file = newestSessionLog(argv[1] ?? process.env.DSH_HOME ?? '')
  else file = argv[0] ?? newestSessionLog(process.env.DSH_HOME ?? '')
  if (file === undefined) {
    console.error('session-report: no session log found (pass a path or --home <DSH_HOME>)')
    return 2
  }
  const summary = summarise(readEvents(file))
  console.log(`log: ${file}`)
  console.log(`events: ${summary.total}`)
  console.log(`tool/result events: ${summary.toolResults}`)
  console.log(`  appended (first admission): ${summary.firstPassAppends}`)
  console.log(`    of those, carrying the prune marker: ${summary.markerInAppend}`)
  console.log(`  replacements (surfaceOp replace): ${summary.rewrites.length}`)
  for (const rewrite of summary.rewrites) console.log(`    at ${rewrite.atSeq} -> target ${rewrite.targetSeq} (truncated: ${rewrite.truncated})`)
  console.log(`compaction/prune events: ${summary.pruneEvents}`)
  console.log('event types:')
  for (const [type, count] of [...summary.types].sort((a, b) => b[1] - a[1])) console.log(`  ${count}\t${type}`)
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('session-report.mjs')
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
