/**
 * The routing runtime: one automatic routing pass per received user
 * instruction, expressed as an injectable notice.
 *
 * Everything the plugin does at runtime lives here, behind injected
 * collaborators (`skills`, `logger`, `now`), so the behaviour is testable
 * without a Host process.
 *
 * @module dsh-plugin-skill-autoroute/lib/autoroute
 */

import { aliasesOf, buildCatalog, isSlashCommand, rankSkills } from './router.js'
import { renderBrief, renderLoad, renderRouterDirective, SOURCE_KIND } from './notices.js'

/** Distinct sessions remembered for duplicate-suppression. */
const MAX_SESSIONS = 64
/** Distinct instruction batches remembered per session. */
const MAX_KEYS_PER_SESSION = 64

/**
 * The messages that represent a freshly received instruction.
 * @param {readonly object[]} messages - messages offered to this step.
 * @param {readonly string[]} triggerSources - accepted `source.kind` values.
 * @returns {object[]} matching messages, in order.
 */
export function humanMessages(messages, triggerSources = ['user']) {
  const sources = Array.isArray(triggerSources) && triggerSources.length > 0 ? triggerSources : ['user']
  return (messages ?? []).filter(
    (message) => message && typeof message === 'object' && message.source && sources.includes(message.source.kind),
  )
}

/**
 * Concatenate the text blocks of the given messages.
 * @param {readonly object[]} messages - messages to read.
 * @returns {string} trimmed text.
 */
export function messagesText(messages) {
  const parts = []
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Identity of one instruction batch: the turn plus the exact message ids, so a
 * steering message mid-turn is a new batch and a repeated step is not.
 * @param {number} turn - agent turn number.
 * @param {readonly object[]} human - the batch's messages.
 * @returns {string} stable key.
 */
export function batchKey(turn, human) {
  return `${Number.isFinite(turn) ? turn : 0}:${human.map((message) => String(message?.id ?? '?')).join(',')}`
}

/** Bounded, insertion-ordered memory of already-routed instruction batches. */
function createSeenStore() {
  /** @type {Map<string, {keys: Set<string>, order: string[]}>} */
  const sessions = new Map()
  return {
    has(sessionId, key) {
      return sessions.get(sessionId)?.keys.has(key) === true
    },
    add(sessionId, key) {
      let entry = sessions.get(sessionId)
      if (entry === undefined) {
        entry = { keys: new Set(), order: [] }
      } else {
        sessions.delete(sessionId)
      }
      sessions.set(sessionId, entry)
      if (!entry.keys.has(key)) {
        entry.keys.add(key)
        entry.order.push(key)
      }
      while (entry.order.length > MAX_KEYS_PER_SESSION) {
        const oldest = entry.order.shift()
        if (oldest !== undefined) entry.keys.delete(oldest)
      }
      while (sessions.size > MAX_SESSIONS) {
        const oldest = sessions.keys().next().value
        if (oldest === undefined) break
        sessions.delete(oldest)
      }
    },
    clear() {
      sessions.clear()
    },
    size() {
      return sessions.size
    },
  }
}

/**
 * Catalog reader over the Host `skills` service, with a short-lived cache that
 * the `skills/change` event invalidates.
 * @param {{skills: object, config: object, now?: () => number}} input - collaborators.
 * @returns {{list: Function, body: Function, invalidate: Function}}
 */
export function createCatalogReader({ skills, config, now = Date.now }) {
  let cached
  return {
    invalidate() {
      cached = undefined
    },
    /**
     * @param {{cwd?: string, signal?: AbortSignal}} options - view options.
     * @returns {Promise<{summaries: object[], index: object, total: number}>} cached listing.
     */
    async list({ cwd, signal } = {}) {
      const key = String(cwd ?? '')
      if (
        cached !== undefined
        && cached.key === key
        && config.catalogCacheMs > 0
        && now() - cached.at < config.catalogCacheMs
      ) {
        return cached
      }
      const listed = await skills.list({ cwd, signal })
      const summaries = (Array.isArray(listed) ? listed : []).slice(0, config.maxCandidates)
      cached = { key, at: now(), summaries, index: buildCatalog(summaries), total: summaries.length }
      return cached
    },
    /**
     * Load one skill body.
     * @param {string} name - skill name.
     * @param {{cwd?: string, signal?: AbortSignal}} options - view options.
     * @returns {Promise<string|undefined>} SKILL.md content.
     */
    async body(name, { cwd, signal } = {}) {
      if (typeof skills.get !== 'function') return undefined
      const definition = await skills.get(name, { cwd, signal })
      const content = definition?.content
      return typeof content === 'string' && content.trim() !== '' ? content : undefined
    },
  }
}

/** Safe logger call: a broken logger must never break a step. */
function log(logger, level, message, meta) {
  try {
    const target = logger?.[level]
    if (typeof target === 'function') target.call(logger, message, meta)
  } catch {
    /* logging never breaks routing */
  }
}

/**
 * Build the routing runtime.
 * @param {{skills: object, config: object, logger?: object, now?: () => number, catalogReader?: object}} input - collaborators.
 * @returns {{route: Function, invalidate: Function, stats: Function}} runtime.
 */
export function createAutoRouter({ skills, config, logger, now = Date.now, catalogReader }) {
  const reader = catalogReader ?? createCatalogReader({ skills, config, now })
  const seen = createSeenStore()
  const counters = { passes: 0, injected: 0, skipped: 0, errors: 0, lastMode: config.mode, lastNames: [] }

  const remember = (sessionId, key, notice, detail) => {
    seen.add(sessionId, key)
    if (notice === undefined) counters.skipped += 1
    else counters.injected += 1
    counters.lastNames = detail
    if (config.debug) log(logger, 'info', '[skill-autoroute] %s', { detail: detail.join(',') || '(none)', injected: notice !== undefined })
    return notice
  }

  /**
   * Run one routing pass for a pre-step decision.
   * @param {object} payload - `agent/pre-step` payload.
   * @param {{kind: string, messages: object[]}} decision - downstream decision.
   * @returns {Promise<{text: string, source: object}|undefined>} notice to inject.
   */
  async function route(payload, decision) {
    counters.passes += 1
    counters.lastMode = config.mode
    if (!config.enabled || config.mode === 'off') return undefined
    const human = humanMessages(decision?.messages, config.triggerSources)
    if (human.length === 0) return undefined
    const sessionId = String(payload?.agent?.id ?? 'unknown')
    const turn = Number(payload?.turn)
    const key = batchKey(Number.isFinite(turn) ? turn : 0, human)
    if (seen.has(sessionId, key)) return undefined

    const text = messagesText(human)
    if (text === '' || text.length < config.minChars) return remember(sessionId, key, undefined, ['too-short'])
    if (config.skipSlashCommands && isSlashCommand(text)) return remember(sessionId, key, undefined, ['slash-command'])

    const signal = payload?.signal
    const cwd = payload?.agent?.session?.header?.cwd
    let listing
    try {
      listing = await reader.list({ cwd, signal })
    } catch (error) {
      counters.errors += 1
      log(logger, 'warn', '[skill-autoroute] skill catalog unavailable: %s', String(error?.message ?? error))
      if (config.mode === 'router') {
        const fallbackSkill = config.routerSkills[0]
        return remember(sessionId, key, renderRouterDirective({ locale: config.locale, routerSkill: fallbackSkill }), [
          `router-skill(unverified):${fallbackSkill}`,
        ])
      }
      return remember(sessionId, key, undefined, ['catalog-error'])
    }

    if (config.mode === 'router') {
      // An empty catalog proves nothing is installed, so forcing a skill call
      // would only waste a turn.
      if (listing.total === 0) return remember(sessionId, key, undefined, ['catalog-empty'])
      const picked = config.routerSkills.find((name) => {
        const wanted = name.toLowerCase()
        return listing.summaries.some(
          (summary) => String(summary?.name ?? '').toLowerCase() === wanted
            || aliasesOf(summary).includes(wanted),
        )
      })
      if (picked !== undefined) {
        return remember(sessionId, key, renderRouterDirective({ locale: config.locale, routerSkill: picked }), [
          `router-skill:${picked}`,
        ])
      }
      log(
        logger,
        'warn',
        '[skill-autoroute] none of the configured router skills (%s) are installed; falling back to the brief mode',
        config.routerSkills.join(', '),
      )
    }

    let ranked
    try {
      ranked = rankSkills(text, listing.summaries, config, listing.index)
    } catch (error) {
      counters.errors += 1
      log(logger, 'warn', '[skill-autoroute] ranking failed: %s', String(error?.message ?? error))
      return remember(sessionId, key, undefined, ['rank-error'])
    }
    if (ranked.length === 0) return remember(sessionId, key, undefined, ['no-match'])

    const names = ranked.map((item) => item.name)
    if (config.mode === 'load' && ranked[0].score >= config.loadMinScore) {
      try {
        const body = await reader.body(ranked[0].name, { cwd, signal })
        if (body !== undefined) {
          return remember(sessionId, key, renderLoad({
            locale: config.locale,
            item: ranked[0],
            body,
            maxBodyChars: config.maxBodyChars,
          }), [`loaded:${ranked[0].name}`, ...names.slice(1)])
        }
      } catch (error) {
        counters.errors += 1
        log(logger, 'warn', '[skill-autoroute] skill body load failed for "%s": %s', ranked[0].name, String(error?.message ?? error))
      }
    }

    return remember(sessionId, key, renderBrief({ locale: config.locale, ranked, total: listing.total, config }), names)
  }

  return {
    route,
    invalidate() {
      reader.invalidate()
    },
    stats() {
      return { ...counters, sessions: seen.size() }
    },
    /** Exposed for tests only. */
    __internals: { reader, seen, SOURCE_KIND },
  }
}
