/**
 * Combined entry point: both halves of the plugin in one Cordis row.
 *
 * This is the only module a DSH profile needs to name. It mounts, in order:
 *
 *   1. FIRST-PASS  - a `tools/post-execute` listener that truncates an
 *      over-budget tool result before the loop appends it to the session
 *      surface (see `./index.js`);
 *   2. GUARD       - a `toolResultPruner` provider that refuses to rewrite a
 *      tool result a provider request has already delivered (see
 *      `./guarded-pruner.js`).
 *
 * The two halves are deliberately one row because they must agree: the guard
 * can only stop rewriting delivered history if something else keeps oversized
 * results out of history in the first place.
 *
 * WHERE THE ROW GOES
 * ------------------
 * The `toolResultPruner` provider lives at the TOP LEVEL of the profile
 * composition, not only inside an agent preset: `dsh --dump-config` shows
 * `@deepseek-ai/dsh-base` contributing
 *
 *     - id: tool-result-pruner
 *       name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
 *       config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
 *
 * with no `isolate` wrapper, and `dsh-compaction-basic` resolves it with
 * `this.ctx.get("toolResultPruner")`. Being the last provider registered for
 * that name in the same scope is therefore enough.
 *
 * `tools/install-preset.mjs` performs the swap through the profile's own
 * `cordis.patch.yml` - the documented user layer - as the pair
 * `{ id: tool-result-pruner, disabled: true }` plus an inserted
 * `cache-safe-tool-result` row. An id-targeted patch cannot rename a row (its
 * `name` is a mismatch guard), which is why the swap is a disable plus an
 * insert rather than an override.
 *
 * The FIRST-PASS half needs no scope care at all: a listener registered by a
 * plain plugin is untagged, and `dsh-scope`'s dispatch filter admits untagged
 * listeners to every scope, so it observes the agent's `tools/post-execute`
 * events from wherever this row sits.
 *
 * @module dsh-cache-safe-tool-result/both
 */

import { apply as applyFirstPass, name as firstPassName } from './index.js'
import { apply as applyGuardedPruner, name as guardedPrunerName } from './guarded-pruner.js'

export { DEFAULTS, PRUNE_MARKER, measureContent, resolveBudgets, truncateContent } from './truncate.js'
export { hasProviderRequestAfter, createGuardedPruner } from './guarded-pruner.js'

/** Cordis plugin name for the combined row. */
export const name = 'cache-safe-tool-result'

/**
 * Nothing is injected: the guard half *provides* `toolResultPruner` rather than
 * consuming it, and the first-pass half only listens to an event.
 */
export const inject = []

/**
 * Mount both halves.
 *
 * A configuration key that either half owns is forwarded to both; each half
 * reads only the keys it documents, so the shared object is safe to pass
 * through unchanged.
 *
 * @param ctx - the owning Cordis context.
 * @param config - plugin configuration.
 * @param config.thresholdChars - prune when text exceeds this many code points (default 8192).
 * @param config.headChars - leading code points retained (default 4096).
 * @param config.tailChars - trailing code points retained (default 1024).
 * @param config.firstPass - mount the pre-admission truncation listener (default `true`).
 * @param config.guardedPruner - provide the delivery-guarded `toolResultPruner` (default `true`).
 * @param config.includeNested - first-pass: also truncate sub-dispatch results (default `true`).
 * @param config.verbose - log per-truncation and per-pass detail (default `false`).
 * @returns `{ firstPass, guardedPruner }`, each `null` when that half is off.
 * @throws when both halves are disabled, or when a half fails to mount - a row
 *   that silently mounts nothing would leave the preset's `ctx.get` resolving
 *   an unguarded pruner without saying so.
 */
export function apply(ctx, config = {}) {
  const mountFirstPass = config.firstPass ?? true
  const mountGuardedPruner = config.guardedPruner ?? true
  if (!mountFirstPass && !mountGuardedPruner) {
    throw new Error('dsh-cache-safe-tool-result: both halves are disabled; remove the row instead of mounting an inert one')
  }
  const firstPass = mountFirstPass ? applyFirstPass(ctx, config) : null
  const guardedPruner = mountGuardedPruner ? applyGuardedPruner(ctx, config) : null
  return { firstPass, guardedPruner }
}

export { firstPassName, guardedPrunerName }

export default { name, inject, apply }
