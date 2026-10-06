/**
 * Host half of the `dsh-plugin-skill-autoroute` bundle.
 *
 * Why this exists: the local knowledge base ships 40+ skills, but `skill`
 * routing is opt-in — the model has to remember to consult them. This plugin
 * makes the routing pass automatic: at the first step of every received user
 * instruction it routes the instruction over the live skill catalog and injects
 * exactly one notice — a ranked brief, an auto-loaded SKILL.md body (`load`
 * mode), or a directive to consult the router skill (`router` mode).
 *
 * Seams used (all verified against this Host composition):
 *   - `agent/pre-step` (waterfall): append one synthetic user-role message.
 *     Same shape as `@nanmicoder/dsh-agent-teams` and `dsh-orb`.
 *   - `skills` service: `list()` for summaries, `get()` for a full body.
 *   - `skills/change` event: invalidate the catalog cache.
 *
 * The injected message is producer-tagged `{ kind: 'skill-autoroute' }` and is
 * durable request material, so it is never mistaken for a human instruction by
 * this plugin's own trigger filter.
 *
 * @module dsh-plugin-skill-autoroute
 */

import { randomUUID } from 'node:crypto'

import { resolveConfig } from './lib/config.js'
import { createAutoRouter } from './lib/autoroute.js'

/** Plugin name shown in loader logs. */
export const name = 'dsh-plugin-skill-autoroute'

/** The skill registry is the only required service. */
export const inject = ['skills']

/** Cached message constructor from the Host runtime. */
let createUserMessage

/**
 * Resolve the Host's canonical user-message constructor.
 *
 * The Host resolves `@deepseek-ai/*` for plugin modules; when it does not, the
 * structural equivalent is used instead (the canonical helper only stamps a
 * fresh uuid id, the `user` role, and a deep freeze — see `dsh-llm`
 * `createUserMessage`). Returning `undefined` disables injection rather than
 * risking a malformed message.
 * @returns {Promise<Function|undefined>} constructor, or undefined when neither path works.
 */
export async function resolveCreateUserMessage() {
  if (createUserMessage !== undefined) return createUserMessage ?? undefined
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    createUserMessage = typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : null
  } catch {
    createUserMessage = null
  }
  return createUserMessage ?? undefined
}

/** Deep-freeze a plain message graph, mirroring the Host's `deepFreeze`. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * Structural fallback for `createUserMessage`: identical field set, fresh uuid
 * identity, frozen before publication.
 * @param {{content: object[], source: object}} input - message input.
 * @returns {object} frozen user message.
 */
export function fallbackUserMessage(input) {
  return deepFreeze({ ...input, id: randomUUID(), role: 'user' })
}

/**
 * Mount the automatic routing pass.
 * @param {object} ctx - Host plugin context carrying `skills`.
 * @param {object} [rawConfig] - row config from the profile patch.
 * @returns {object} runtime handle (used by tests).
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx?.logger
  if (!config.enabled || config.mode === 'off') {
    logger?.info?.('[skill-autoroute] disabled (mode=%s, enabled=%s)', config.mode, String(config.enabled))
    return { config, route: async () => undefined, enabled: false }
  }

  const router = createAutoRouter({ skills: ctx.skills, config, logger })

  const disposeChange = ctx.on('skills/change', () => {
    router.invalidate()
  })

  const disposeStep = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages) || decision.messages.length === 0) {
      return decision
    }
    let notice
    try {
      notice = await router.route(payload, decision)
    } catch (error) {
      logger?.warn?.('[skill-autoroute] routing failed: %s', String(error?.message ?? error))
      return decision
    }
    if (notice === undefined) return decision

    const make = (await resolveCreateUserMessage()) ?? fallbackUserMessage
    try {
      payload?.signal?.throwIfAborted?.()
      const message = make({ content: [{ type: 'text', text: notice.text }], source: notice.source })
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      logger?.warn?.('[skill-autoroute] notice injection failed: %s', String(error?.message ?? error))
      return decision
    }
  })

  logger?.info?.(
    '[skill-autoroute] armed (mode=%s, topN=%s, minScore=%s, locale=%s)',
    config.mode,
    String(config.topN),
    String(config.minScore),
    config.locale,
  )

  return {
    config,
    enabled: true,
    stats: () => router.stats(),
    invalidate: () => router.invalidate(),
    dispose: () => {
      disposeStep?.()
      disposeChange?.()
    },
  }
}
