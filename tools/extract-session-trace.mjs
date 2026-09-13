/**
 * Extract a sanitized, committable regression trace from a real DSH session log.
 *
 * PRIVACY: the trace this writes contains NO message content. It keeps only
 * sequence numbers, event types, surface operations, tool names, content
 * lengths, content hashes, and provider token counts. Tool arguments, tool
 * output, prompts and reasoning are never copied.
 *
 * USAGE
 *   node tools/extract-session-trace.mjs <session.v3.jsonl.zstd> <out.json>
 *   node tools/extract-session-trace.mjs --from-home <session-id-prefix> <out.json>
 *
 * The DSH session format is a concatenation of zstd frames, one per flush; the
 * file must be inflated frame by frame.
 *
 * @module tools/extract-session-trace
 */

import { readFileSync, readdirSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Inflate a multi-frame zstd session log.
 * @param file - absolute path of the `.jsonl.zstd` file.
 * @returns the decoded newline-delimited JSON text.
 */
export function inflateSessionLog(file) {
  const buf = readFileSync(file)
  const offsets = []
  let index = 0
  while ((index = buf.indexOf(ZSTD_MAGIC, index)) !== -1) {
    offsets.push(index)
    index += 4
  }
  const parts = []
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    parts.push(zstdDecompressSync(buf.subarray(offsets[i], end)))
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Parse a session log into events.
 * @param file - absolute path of the `.jsonl.zstd` file.
 * @returns the parsed events, in log order.
 */
export function readSessionLog(file) {
  return inflateSessionLog(file).split(/\n/).filter(Boolean).map((line) => JSON.parse(line))
}

/**
 * Locate a session log under `$DSH_HOME/sessions` by directory-name prefix.
 * @param prefix - a unique prefix of the session directory name.
 * @returns the absolute log path.
 */
export function findSessionLog(prefix) {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  const root = join(home, 'sessions')
  const walk = (dir, depth) => {
    if (depth > 3) return null
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.includes(prefix) && statSync(path).isDirectory()) {
          const candidate = join(path, 'session.v3.jsonl.zstd')
          if (statSync(candidate, { throwIfNoEntry: false })) return candidate
        }
        const found = walk(path, depth + 1)
        if (found !== null) return found
      }
    }
    return null
  }
  const found = walk(root, 0)
  if (found === null) throw new Error(`no session log matching "${prefix}" under ${root}`)
  return found
}

const hashText = (value) => createHash('sha256').update(value ?? '').digest('hex').slice(0, 16)

/** Text length and hash of a tool-result event body, without copying the text. */
function toolResultShape(event) {
  const blocks = event.data?.message?.content ?? []
  let chars = 0
  for (const block of blocks) {
    if (block.type !== 'tool-result') continue
    for (const inner of block.content ?? []) if (inner.type === 'text') chars += inner.text.length
  }
  const payload = blocks.map((block) => (block.content ?? []).map((inner) => inner.text ?? '').join('')).join('')
  return { chars, hash: hashText(payload), truncated: payload.includes('[... tool result middle pruned ...]') }
}

/**
 * Build the sanitized trace for one session log.
 * @param file - session log path.
 * @returns the trace object written to the fixture.
 */
export function extractTrace(file) {
  const events = readSessionLog(file)
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const settlementSeqs = events
    .filter((event) => event.type === 'assistant/message' || event.type === 'assistant/attempt')
    .map((event) => event.seq)
  const delivered = (seq) => settlementSeqs.some((settled) => settled > seq)

  /* Fold surface operations exactly like dsh-session's SurfaceManager. */
  const surface = []
  const steps = []
  let lastUsage = null
  const notifications = []
  const toolCalls = new Map()

  for (const event of events) {
    /* Tool-call names are harness tool identifiers, not user data. */
    if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
      toolCalls.set(event.data.name, (toolCalls.get(event.data.name) ?? 0) + 1)
    }
    if (event.type === 'assistant/message' && event.data?.usage) {
      const usage = event.data.usage
      steps.push({
        seq: event.seq,
        uncachedInput: usage.inputTokens ?? 0,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        output: usage.outputTokens ?? 0,
        promptTokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        messages: surface.length
      })
      lastUsage = usage
    }
    const op = event.surfaceOp
    if (op === 'append') surface.push(event.seq)
    else if (op !== undefined && op.op === 'replace') {
      const at = surface.indexOf(op.startSeq)
      if (at >= 0) surface.splice(at, 1, event.seq)
      const target = bySeq.get(op.startSeq)
      if (target?.type === 'tool/result') {
        const before = steps.at(-1)
        notifications.push({
          kind: 'tool-result-replace',
          atSeq: event.seq,
          targetSeq: op.startSeq,
          targetDelivered: delivered(op.startSeq),
          targetChars: toolResultShape(target).chars,
          targetHash: toolResultShape(target).hash,
          lastRequestSeqBefore: before?.seq ?? null
        })
      }
    }
    if (event.type === 'compaction/prune') {
      notifications.push({
        kind: 'compaction-prune',
        atSeq: event.seq,
        targetSeq: event.data?.shadowedSeqs?.[0] ?? null,
        targetDelivered: delivered(event.data?.shadowedSeqs?.[0] ?? -1),
        shadowedTokenCount: event.data?.shadowedTokenCount ?? null,
        candidateDelivered: delivered(event.data?.shadowedSeqs?.[0] ?? -1)
      })
    }
  }

  return {
    schemaVersion: 1,
    source: {
      session: basename(file),
      /* Only the session id prefix is kept: no absolute path, no user name. */
      eventCount: events.length,
      extractedBy: 'tools/extract-session-trace.mjs'
    },
    note: 'Sanitized trace: sequence numbers, types, surface ops, lengths, hashes and token counts only. No message content.',
    events: events.map((event) => ({
      seq: event.seq,
      type: event.type,
      ...(typeof event.data?.name === 'string' ? { tool: event.data.name } : {}),
      ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp === 'append' ? 'append' : { op: event.surfaceOp.op, startSeq: event.surfaceOp.startSeq, endSeq: event.surfaceOp.endSeq } }),
      ...(event.type === 'tool/result' ? toolResultShape(event) : {}),
      ...(event.type === 'assistant/message' && event.data?.usage
        ? {
            usage: {
              uncachedInput: event.data.usage.inputTokens ?? 0,
              cacheRead: event.data.usage.cacheReadTokens ?? 0,
              cacheWrite: event.data.usage.cacheWriteTokens ?? 0,
              output: event.data.usage.outputTokens ?? 0
            }
          }
        : {})
    })),
    steps,
    notifications,
    toolCallNames: Object.fromEntries([...toolCalls].sort())
  }
}

/* CLI */
const args = process.argv.slice(2)
if (args.length > 0) {
  const fromHome = args[0] === '--from-home'
  const file = fromHome ? findSessionLog(args[1]) : args[0]
  const out = fromHome ? args[2] : args[1]
  if (!file || !out) {
    console.error('usage: node tools/extract-session-trace.mjs [--from-home <prefix>] <session.v3.jsonl.zstd> <out.json>')
    process.exit(2)
  }
  const trace = extractTrace(file)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(trace, null, 1)}\n`)
  console.log(`wrote ${out}: ${trace.events.length} events, ${trace.steps.length} requests, ${trace.notifications.length} surface notifications`)
}
