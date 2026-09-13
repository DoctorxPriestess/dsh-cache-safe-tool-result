/**
 * Test doubles for the harness contracts this plugin interacts with.
 *
 * The surface/session double mirrors the semantics of `dsh-session`'s
 * `SurfaceManager`: append-only nodes in model-visible order, and a
 * `surfaceOp: { op: 'replace' }` that swaps one node for a later event. The
 * waterfall double mirrors `cordis`'s `EventsService.waterfall`: listeners run
 * outermost-first around a final `next`.
 */

/* ------------------------------------------------------------------ *
 * Session / surface
 * ------------------------------------------------------------------ */

const textBlock = (text) => ({ type: 'text', text })

/**
 * The message payload of one `tool/result` event, shaped exactly like the
 * runtime's: `{ role:'user', content:[{ type:'tool-result', content:[…] }] }`.
 * The pruner reads `data.message.content[0].content`, so the double keeps that
 * nesting rather than flattening it.
 * @param callId - tool call id the result answers.
 * @param text - single text body of the result.
 * @returns a message object suitable for `session.append`.
 */
function toolResultMessage(callId, text) {
  return toolResultMessageWith(callId, [textBlock(text)])
}

/** Build a `tool/result` message whose result content is the given text blocks. */
export function toolResultMessageWith(callId, blocks) {
  return {
    role: 'user',
    id: `m-${callId}`,
    source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: blocks }]
  }
}

/** A whole `tool/result` event (only needed by tests that append by hand). */
export function toolResultEvent(callId, text) {
  return { message: toolResultMessage(callId, text) }
}

/**
 * An in-memory Session with an ordered surface.
 * @param options - `baseSeq` shifts the sequence numbering (forked/seeded logs).
 * @returns a session double plus inspection helpers.
 */
export function makeSession(options = {}) {
  const baseSeq = options.baseSeq ?? 0
  const log = []
  const nodes = []
  let replaceGeneration = 0

  const session = {
    get log() { return log },
    get seq() { return log.length + baseSeq },
    surface: {
      get nodes() { return nodes },
      get replaceGeneration() { return replaceGeneration }
    },
    eventAt: (seq) => log[seq - baseSeq],
    snapshotEvents: (from = baseSeq, to = log.length + baseSeq) =>
      Object.freeze(log.slice(Math.max(0, from - baseSeq), Math.max(0, to - baseSeq))),
    append(type, data, opts) {
      const seq = log.length + baseSeq
      const event = { type, seq, data }
      if (opts !== undefined) event.surfaceOp = opts.surfaceOp ?? opts
      log.push(event)
      if (event.surfaceOp === 'append') nodes.push(seq)
      else if (event.surfaceOp && event.surfaceOp.op === 'replace') {
        const at = nodes.indexOf(event.surfaceOp.startSeq)
        if (at < 0) throw new Error(`replace target not on surface: ${event.surfaceOp.startSeq}`)
        nodes.splice(at, 1, seq)
        replaceGeneration += 1
      }
      return { seq }
    },
    /** Append an already-built event verbatim (used by trace replay). */
    appendEvent(event) {
      log.push(event)
      const op = event.surfaceOp
      if (op === 'append') nodes.push(event.seq)
      else if (op !== undefined && op.op === 'replace') {
        const at = nodes.indexOf(op.startSeq)
        if (at >= 0) nodes.splice(at, 1, event.seq)
        else throw new Error(`replace target not on surface: ${op.startSeq}`)
        replaceGeneration += 1
      }
      return { seq: event.seq }
    }
  }
  return { session, log, nodes }
}

/**
 * Rebuild a session double from a sanitized trace, in log order.
 *
 * Unlike the read-only fold in the regression test this one is appendable, so a
 * pruning pass can actually land, and it applies the fixture's surface ops the
 * same way `dsh-session` does. Sequence 0 is reserved for the file header the
 * fixtures start with, so the trace is renumbered contiguously from 0 - the
 * guard only ever reasons about order, never about absolute seq values.
 * @param trace - a trace produced by `tools/extract-session-trace.mjs`.
 * @returns `{ session, ofTrace }` where `ofTrace(seq)` maps a trace seq to the
 *   seq it now occupies in the double.
 */
export function makeSessionFromTrace(trace) {
  const { session, log, nodes } = makeSession()
  const seqMap = new Map()
  for (const event of trace.events) {
    if (!Number.isInteger(event.seq)) continue
    const next = log.length
    seqMap.set(event.seq, next)
    const op = event.surfaceOp
    const surfaceOp =
      op === 'append' ? 'append'
        : op !== undefined && op.op === 'replace'
          ? { op: 'replace', startSeq: seqMap.get(op.startSeq) ?? op.startSeq, endSeq: seqMap.get(op.endSeq) ?? op.endSeq }
          : undefined
    session.appendEvent({ type: event.type, seq: next, data: event.data ?? {}, ...(surfaceOp !== undefined ? { surfaceOp } : {}) })
  }
  const ofTrace = (seq) => seqMap.get(seq)
  return { session, log, nodes, ofTrace }
}

/** A settled request marker: the only delivery evidence the log carries. */
export const settledRequest = (type = 'assistant/message') => ({ type, data: {} })

/** Append a tool result and return its seq. */
export function appendToolResult(session, callId, text) {
  return session.append('tool/result', { message: toolResultMessage(callId, text) }, { surfaceOp: 'append', sourceEventSeqs: [] }).seq
}

/** Append a tool result whose content is the given blocks; returns its seq. */
export function appendToolResultBlocks(session, callId, blocks) {
  return session.append('tool/result', { message: toolResultMessageWith(callId, blocks) }, { surfaceOp: 'append', sourceEventSeqs: [] }).seq
}

/** Append a settled request marker. */
export function appendSettledRequest(session, type = 'assistant/message') {
  return session.append(type, {}, { surfaceOp: 'append' }).seq
}

/** Text of a tool result node at `seq`, or `undefined`. */
export function toolResultText(session, seq) {
  const event = session.eventAt(seq)
  const block = event?.data?.message?.content?.[0]
  if (block?.type !== 'tool-result') return undefined
  return (block.content ?? []).map((inner) => inner.text ?? '').join('')
}

/* ------------------------------------------------------------------ *
 * `tools/post-execute` waterfall
 * ------------------------------------------------------------------ */

/**
 * A context double that records `on()` registrations and drives them the way
 * the tool runtime does.
 * @returns `{ ctx, invoke, registered, stats }`.
 */
export function makeToolContext() {
  const registered = new Map()
  const ctx = {
    on(event, listener) {
      const list = registered.get(event) ?? []
      list.push(listener)
      registered.set(event, list)
      return () => {}
    },
    effect() { return () => {} },
    logger: { info() {}, warn() {}, debug() {} }
  }
  /**
   * Run every `tools/post-execute` listener as a waterfall.
   * @param exec - the tool execution descriptor.
   * @param result - the tool result under consideration.
   * @param inner - the built-in behavior, defaulting to `{kind:'accept'}`.
   * @returns the outermost listener's decision.
   */
  async function invoke(exec, result, inner = async () => ({ kind: 'accept' })) {
    const listeners = [...(registered.get('tools/post-execute') ?? [])]
    const next = () => (listeners.shift() ?? inner)(exec, result, next)
    return next()
  }
  return { ctx, invoke, registered }
}
