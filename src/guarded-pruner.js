/**
 * Cache-safe replacement for the built-in `toolResultPruner` service.
 *
 * WHY A REPLACEMENT INSTEAD OF A WRAPPER
 * --------------------------------------
 * The built-in pruner is a Cordis service registered as `toolResultPruner`
 * inside the agent preset's **isolated scope**
 * (`dsh-agent-presets/presets/*\/agent.cordis.yml` mounts it under
 * `isolate: { toolResultPruner: true }`). Cordis resolution is scoped:
 *
 *   ctx.isolate(name, label)      -> a child scope with its own label for `name`
 *   ctx.reflect.get(name)         -> resolves the label of the *calling* scope
 *   ctx.reflect.provide(name, …)  -> throws if that label already has an impl
 *
 * `@deepseek-ai/dsh-compaction-basic` reads it with
 * `this.ctx.get("toolResultPruner")` from inside that same isolated group.
 * Consequences, all verified against the installed runtime:
 *
 * - A host-plane or profile-root plugin **cannot reach** the preset's instance:
 *   its own scope label has no implementation, so `ctx.get()` returns
 *   `undefined`. There is no interception, wrapping, or shadowing API.
 * - `ctx.provide("toolResultPruner", instance)` from outside that scope
 *   registers into a different label and is never seen by the preset; from
 *   inside a scope that already has one it throws.
 *
 * Therefore the only way to install a guarded pruner without patching DSH is to
 * **be** the provider: the preset swaps its `tool-result-pruner` row for this
 * plugin's row, inside the same isolate group. `dsh-compaction-basic` treats
 * the service as optional (`const prune = this.ctx.get("toolResultPruner")`),
 * so the swap needs no other change.
 *
 * The pruner algorithm itself is the upstream-mirrored port in `./truncate.js`;
 * this module adds only the delivery guard around it.
 *
 * @module dsh-cache-safe-tool-result/guarded-pruner
 */

import { DEFAULTS, PRUNE_MARKER, codePointLength, measureContent, resolveBudgets, truncateContent } from './truncate.js'

export { PRUNE_MARKER }

/** Event types that prove a provider request was admitted at a later seq. */
const REQUEST_SETTLEMENT_EVENTS = Object.freeze(['assistant/message', 'assistant/attempt'])

/**
 * Whether a provider request was admitted after `seq`.
 *
 * `assistant/message` settles a request the provider answered;
 * `assistant/attempt` settles one that streamed and then failed. Both are
 * appended only after the loop derived the surface and dispatched it, so a
 * later one of either proves `seq` was inside an admitted request. An attempt
 * cannot show whether the provider received the payload, so it counts as
 * delivered: the guard errs toward keeping history byte-stable.
 *
 * The predicate is monotone in the log - it can only turn true as a session
 * grows - so a delivered node stays delivered across retries, resumes, and
 * repeated pruning passes.
 * @param session - session owning the surface node.
 * @param seq - sequence number of a current surface node.
 * @returns `true` when delivered, `false` when provably undelivered.
 * @throws when the session does not expose the log-range API, so the caller can
 *   fail closed instead of assuming.
 */
export function hasProviderRequestAfter(session, seq) {
  if (typeof session?.snapshotEvents !== 'function') {
    throw new TypeError('session.snapshotEvents is unavailable; cannot prove delivery state')
  }
  for (const event of session.snapshotEvents(seq + 1)) {
    if (event !== null && typeof event === 'object' && REQUEST_SETTLEMENT_EVENTS.includes(event.type)) return true
  }
  return false
}

/**
 * Build a `toolResultPruner` service implementation.
 *
 * Exposes the exact surface the built-in service exposes and that its single
 * consumer uses:
 *   - `pruneContent(blocks)` - `ContentBlock[] | null`
 *   - `pruneSession(session)` - `{ pruned, charsRemoved }`
 *
 * Every failure path is closed: a node whose delivery state cannot be proven is
 * skipped, and a node whose rewrite throws is skipped. The pass never rewrites
 * a delivered node, and never rolls back a rewrite the built-in pruner already
 * performed.
 *
 * @param options - optional configuration.
 * @param options.thresholdChars - prune when text exceeds this many code points.
 * @param options.headChars - leading code points retained.
 * @param options.tailChars - trailing code points retained.
 * @param options.verbose - when `true`, log a per-pass summary (default `false`).
 * @returns the service instance plus diagnostic counters.
 */
export function createGuardedPruner(options = {}) {
  const budgets = resolveBudgets(options)
  const verbose = options.verbose === true
  /** Aggregate counters, read by tests and by verbose logging only. */
  const stats = {
    passes: 0,
    candidates: 0,
    pruned: 0,
    skippedDelivered: 0,
    skippedUnprovable: 0,
    charsRemoved: 0
  }

  /** Measure text content in Unicode code points; non-text blocks cost zero. */
  function measure(blocks) {
    return measureContent(blocks)
  }

  /**
   * Replace an over-budget text middle; kept for parity with the built-in
   * service, which exposes it on the instance.
   */
  function pruneContent(blocks) {
    return truncateContent(blocks, budgets)
  }

  /**
   * Prune every over-budget tool result that is provably undelivered.
   *
   * Delivered nodes are skipped in place: their events, content, and order stay
   * byte-identical, no `compaction/prune` shadow-price event is emitted for
   * them, and no `tool/result` replacement is appended.
   * @param session - session whose current surface is considered.
   * @returns `{ pruned, charsRemoved }`, matching the built-in service shape.
   */
  function pruneSession(session) {
    const result = { pruned: [], charsRemoved: 0 }
    const surface = session?.surface
    if (surface === null || typeof surface !== 'object' || !Array.isArray(surface.nodes)) {
      if (verbose) console.warn('dsh-cache-safe-tool-result: session surface unavailable; skipping pruning pass')
      return result
    }
    const nodes = [...surface.nodes]
    stats.passes += 1

    const candidates = []
    for (const seq of nodes) {
      const event = session.eventAt(seq)
      if (event?.type !== 'tool/result') continue
      let delivered
      try {
        delivered = hasProviderRequestAfter(session, seq)
      } catch (error) {
        /* FAIL CLOSED: an unprovable delivery state counts as delivered. */
        stats.skippedUnprovable += 1
        if (verbose) console.warn(`dsh-cache-safe-tool-result: delivery state unprovable at seq ${seq} (${error?.message}); skipping`)
        continue
      }
      if (delivered) {
        stats.skippedDelivered += 1
        continue
      }
      candidates.push({ seq, event })
    }
    stats.candidates += candidates.length

    for (const { seq, event } of candidates) {
      const block = event.data?.message?.content?.[0]
      if (block === undefined) continue
      let content
      try {
        content = pruneContent(block.content)
      } catch (error) {
        if (verbose) console.warn(`dsh-cache-safe-tool-result: refusing to prune seq ${seq}: ${error?.message}`)
        continue
      }
      if (content === null) continue
      const charsBefore = measure(block.content)
      const charsAfter = measure(content)
      try {
        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: estimateShadowedTokens(event.data?.message)
        })
        const replacement = session.append(
          'tool/result',
          { ...event.data, message: freezeMessage({ ...event.data.message, content: [{ ...block, content }] }) },
          { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }
        )
        result.pruned.push({
          originalSeq: seq,
          replacementSeq: replacement?.seq,
          callId: event.data?.message?.source?.callId,
          charsBefore,
          charsAfter
        })
        result.charsRemoved += charsBefore - charsAfter
        stats.pruned += 1
        stats.charsRemoved += charsBefore - charsAfter
      } catch (error) {
        /* A rejected rewrite leaves the delivered surface untouched; nothing to undo. */
        if (verbose) console.warn(`dsh-cache-safe-tool-result: rewrite rejected at seq ${seq}: ${error?.message}`)
      }
    }

    if (verbose && (stats.pruned > 0 || stats.skippedDelivered > 0)) {
      console.info(
        `dsh-cache-safe-tool-result: pass ${stats.passes} - candidates=${candidates.length} ` +
        `pruned=${stats.pruned} skippedDelivered=${stats.skippedDelivered} charsRemoved=${stats.charsRemoved}`
      )
    }
    return result
  }

  return { config: budgets, measureContent: measure, pruneContent, pruneSession, stats, DEFAULTS }
}

/**
 * Price a shadowed message the way the token meter does.
 *
 * The built-in pruner asks the injected `tokenMeter` for this number. A
 * substitute cannot assume that service is reachable from its own scope, so it
 * reproduces the same fixed-density heuristic (4 characters per token plus
 * role framing) that the meter uses, and never throws.
 * @param message - the message being shadowed.
 * @returns an estimated token count.
 */
function estimateShadowedTokens(message) {
  try {
    let chars = 0
    for (const block of message?.content ?? []) {
      if (block.type === 'text') chars += block.text.length
      else if (Array.isArray(block.content)) for (const inner of block.content) if (inner.type === 'text') chars += inner.text.length
    }
    return Math.ceil(chars / 4) + 4
  } catch {
    return 0
  }
}

/**
 * Freeze a message the way `@deepseek-ai/dsh-llm`'s `freezeMessage` does.
 *
 * The local copy keeps the plugin free of a runtime dependency on the harness
 * package while preserving the invariant that a surface message is deeply
 * immutable once appended.
 * @param message - message to freeze.
 * @returns the frozen message.
 */
function freezeMessage(message) {
  if (typeof message?.content?.forEach === 'function') {
    for (const block of message.content) {
      if (Array.isArray(block.content)) Object.freeze(block.content)
      Object.freeze(block)
    }
    Object.freeze(message.content)
  }
  return Object.freeze(message)
}

/**
 * Cordis plugin entry: register this implementation as `toolResultPruner`.
 *
 * Mount this row **inside** the preset's compaction isolate group, replacing
 * the built-in `tool-result-pruner` row. If something already provides the
 * service in this scope, Cordis rejects the duplicate registration and the
 * plugin fails loud rather than silently running alongside an unguarded pruner.
 * @param ctx - the owning Cordis context.
 * @param config - plugin configuration.
 */
export function apply(ctx, config = {}) {
  const service = createGuardedPruner(config)
  const disposer = ctx.provide('toolResultPruner', service)
  ctx.effect?.(() => disposer, 'dsh-cache-safe-tool-result: guarded pruner')
  ctx.logger?.info?.(
    `dsh-cache-safe-tool-result: guarded pruner installed ` +
    `(thresholdChars=${service.config.thresholdChars} headChars=${service.config.headChars} tailChars=${service.config.tailChars})`
  )
}

/** Cordis plugin name. */
export const name = 'cache-safe-tool-result-pruner'

/** No injected service is consumed; `ctx.provide` needs nothing resolved. */
export const inject = []

export default { name, inject, apply, createGuardedPruner, hasProviderRequestAfter, PRUNE_MARKER, DEFAULTS, resolveBudgets, measureContent, codePointLength }
