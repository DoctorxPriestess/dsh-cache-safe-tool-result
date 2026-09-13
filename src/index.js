/**
 * FIRST-PASS: truncate an over-budget tool result before the loop appends it to
 * the session surface.
 *
 * The hook is DSH's sanctioned pre-admission seam:
 *
 *   dsh-agent-loop  runGroup.commitReady()
 *     -> ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(exec, result)
 *          -> dsh-tools postExecute()
 *               -> ctx.waterfall(<agent scope>, "tools/post-execute", exec, result, next)
 *     -> appendToolResult(session, …)            // only now does it become history
 *
 * A `{ kind: 'accept', content }` decision replaces the content that gets
 * appended, so the truncated text is what the provider sees on the very first
 * request. Delivered history therefore never has to be rewritten to reclaim
 * those characters.
 *
 * The decision protocol is respected rather than bypassed:
 *   - `next()` runs first, so earlier listeners and the built-in behavior win;
 *   - a `block` decision, or an `accept` decision that replaced `value`, is
 *     handed back untouched (the `value` arm is for successful results only and
 *     must never be used for a failed one);
 *   - any error in this row returns the untouched decision, so tool execution is
 *     never affected.
 *
 * @module dsh-cache-safe-tool-result
 */

import { DEFAULTS, PRUNE_MARKER, measureContent, resolveBudgets, truncateContent } from './truncate.js'

export { DEFAULTS, PRUNE_MARKER, measureContent, resolveBudgets, truncateContent }

/** Cordis plugin name. */
export const name = 'cache-safe-tool-result'

/**
 * `tools` owns the `tools/post-execute` waterfall.
 * `optional: true` keeps the row mountable in compositions where the tool
 * registry is absent; the row then simply does nothing.
 */
export const inject = { optional: ['tools'] }

/**
 * Mount the first-pass truncation row.
 * @param ctx - the owning Cordis context.
 * @param config - plugin configuration.
 * @param config.thresholdChars - prune when text exceeds this many code points (default 8192).
 * @param config.headChars - leading code points retained (default 4096).
 * @param config.tailChars - trailing code points retained (default 1024).
 * @param config.includeNested - also truncate sub-dispatch results (default `true`).
 * @param config.verbose - log per-truncation detail (default `false`).
 */
export function apply(ctx, config = {}) {
  const budgets = resolveBudgets(config)
  const includeNested = config.includeNested ?? true
  const verbose = config.verbose === true
  /** Counters for tests and for the optional dashboard hook. */
  const stats = { inspected: 0, truncated: 0, charsBefore: 0, charsAfter: 0, bypassed: 0, failed: 0 }

  const off = ctx.on('tools/post-execute', async (exec, result, next) => {
    /* `next()` runs first and its decision is what gets returned, so the
     * waterfall order is preserved and the built-in behavior always wins. */
    let decision
    try {
      decision = await next()
      if (decision === null || typeof decision !== 'object') return decision
      if (decision.kind !== 'accept') {
        stats.bypassed += 1
        return decision
      }
      if (Object.prototype.hasOwnProperty.call(decision, 'value')) {
        /* Another listener produced a validated value through the tool's own
         * output schema; rewriting content here would desynchronise the pair. */
        stats.bypassed += 1
        return decision
      }
      if (!includeNested && exec?.parent !== undefined) {
        stats.bypassed += 1
        return decision
      }
      const content = decision.content !== undefined ? decision.content : result?.content
      if (!Array.isArray(content)) {
        stats.bypassed += 1
        return decision
      }
      stats.inspected += 1
      const before = measureContent(content)
      const truncated = truncateContent(content, budgets)
      if (truncated === null) return decision
      stats.truncated += 1
      stats.charsBefore += before
      stats.charsAfter += measureContent(truncated)
      if (verbose) {
        console.info(`dsh-cache-safe-tool-result: truncated ${exec?.name ?? 'tool'} result ${before} -> ${measureContent(truncated)} code points before admission`)
      }
      return { kind: 'accept', content: truncated }
    } catch (error) {
      /* FAIL OPEN for the tool call itself: an unexpected API change must not
       * turn a successful tool result into an error. The guard half stays
       * fail-closed, so history is still protected.
       * `postExecute` dereferences the decision unconditionally, so the only
       * safe fallback is the decision the inner behavior already produced -
       * never `undefined`. */
      stats.failed += 1
      console.warn(`dsh-cache-safe-tool-result: first-pass skipped after error: ${error?.message}`)
      return decision ?? { kind: 'accept' }
    }
  })
  /* Removing the row must remove the listener too, so a live patch reload or a
   * re-mount cannot leave two truncating listeners stacked on one waterfall. */
  ctx.effect?.(() => off, 'dsh-cache-safe-tool-result: first-pass listener')

  ctx.logger?.info?.(
    `dsh-cache-safe-tool-result: first-pass active ` +
    `(thresholdChars=${budgets.thresholdChars} headChars=${budgets.headChars} tailChars=${budgets.tailChars} includeNested=${includeNested})`
  )

  /* Read-only counters for tests and for the optional dashboard hook. */
  return stats
}

export default { name, inject, apply, DEFAULTS, PRUNE_MARKER, measureContent, resolveBudgets, truncateContent }
