/**
 * Row-config resolution for `dsh-plugin-skill-autoroute`.
 *
 * A hand-written profile patch must never be able to break Host startup, so
 * every value is coerced and clamped instead of rejected. Invalid enums fall
 * back to the documented default.
 *
 * @module dsh-plugin-skill-autoroute/lib/config
 */

/** Routing modes, in increasing aggressiveness. */
export const MODES = ['off', 'brief', 'load', 'router']

/** Locales with shipped notice templates. */
export const LOCALES = ['zh', 'en']

/** Message-source kinds that count as "a user instruction" by default. */
export const DEFAULT_TRIGGER_SOURCES = ['user']

/** @type {Readonly<Record<string, unknown>>} */
export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch; `enabled: false` unloads the behaviour but keeps the row. */
  enabled: true,
  /** `off` | `brief` (route + brief) | `load` (route + inject body) | `router` (force one router-skill call). */
  mode: 'brief',
  /**
   * Skills `router` mode may force, most preferred first. The first one that is
   * actually installed wins, so `['skill-selector', 'skill-router']` works
   * whichever of the two this machine has.
   */
  routerSkills: ['skill-router'],
  /** Candidate rows the notice lists (`topN` is accepted as a legacy alias). */
  candidates: 3,
  /** Include the matched-token evidence line under each candidate (costs tokens). */
  explain: true,
  /** Minimum normalized score for a skill to be worth mentioning at all. */
  minScore: 0.28,
  /** Minimum score for `load` mode to inject the winning skill body. */
  loadMinScore: 0.55,
  /** Upper bound on injected SKILL.md body characters. */
  maxBodyChars: 6000,
  /** Instructions shorter than this are not routed (e.g. "继续", "ok"). */
  minChars: 4,
  /** How many skills one routing pass may scan (`maxCandidates` is accepted as a legacy alias). */
  catalogLimit: 400,
  /** Catalog cache lifetime in ms; also invalidated by the `skills/change` event. */
  catalogCacheMs: 30000,
  /** Slash commands select their own behaviour; they are not routed by default. */
  skipSlashCommands: true,
  /** Message-source kinds that trigger one routing pass. */
  triggerSources: DEFAULT_TRIGGER_SOURCES,
  /** Notice language. */
  locale: 'zh',
  /** Multiplier applied to the meta-skill family on non-meta instructions. */
  metaDownRank: 0.45,
  /** Apply the local-overrides format-word / meta-family policy rules. */
  rulesEnabled: true,
  /** Use the built-in Chinese→English bridge (plus `lexicon`). */
  lexiconEnabled: true,
  /** Extra or overriding bridge entries: `{ '术语': ['glossary'] }`. */
  lexicon: {},
  /** Prefer these skill names when they reach `pinMinScore` (never invented: the name must exist). */
  pins: [],
  /** Minimum score before a configured pin is forced to the front. */
  pinMinScore: 0.1,
  /** Verbose Host logging for every routing decision. */
  debug: false,
})

/** Clamp a finite number into `[min, max]`, else return `fallback`. */
function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Coerce one enum value, else return `fallback`. */
function enumValue(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** Coerce a list of non-empty strings. */
function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback.slice()
  const items = value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return items.length > 0 ? items : fallback.slice()
}

/** Coerce a single name or a list of names into a list (`routerSkill` alias is accepted). */
function nameList(value, fallback) {
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
  const fromAlias = value === undefined ? undefined : value
  return stringList(fromAlias, fallback)
}

/**
 * Coerce a bridge-lexicon override into `{ term: [english, ...] }`.
 * @param {unknown} value - raw config value.
 * @returns {Record<string, string[]>} normalized entries.
 */
function lexiconMap(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== 'string' || key.trim() === '') continue
    const list = (Array.isArray(entry) ? entry : [entry])
      .filter((item) => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim().toLowerCase())
    if (list.length > 0) result[key.trim().toLowerCase()] = list
  }
  return result
}

/** First value that is not `undefined` (legacy config aliases). */
function firstDefined(...values) {
  return values.find((value) => value !== undefined)
}

/**
 * Resolve the row config into the plugin's working shape.
 * @param {object|undefined} raw - row config from the profile patch.
 * @returns {object} resolved, frozen config.
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return Object.freeze({
    enabled: source.enabled !== false,
    mode: enumValue(source.mode, MODES, DEFAULT_CONFIG.mode),
    routerSkills: nameList(source.routerSkills ?? source.routerSkill, DEFAULT_CONFIG.routerSkills),
    candidates: clampNumber(firstDefined(source.candidates, source.topN), 1, 25, DEFAULT_CONFIG.candidates),
    explain: source.explain !== false,
    minScore: clampNumber(source.minScore, 0, 1, DEFAULT_CONFIG.minScore),
    loadMinScore: clampNumber(source.loadMinScore, 0, 1, DEFAULT_CONFIG.loadMinScore),
    maxBodyChars: clampNumber(source.maxBodyChars, 200, 200000, DEFAULT_CONFIG.maxBodyChars),
    minChars: clampNumber(source.minChars, 1, 200, DEFAULT_CONFIG.minChars),
    catalogLimit: clampNumber(firstDefined(source.catalogLimit, source.maxCandidates), 1, 20000, DEFAULT_CONFIG.catalogLimit),
    catalogCacheMs: clampNumber(source.catalogCacheMs, 0, 3600000, DEFAULT_CONFIG.catalogCacheMs),
    skipSlashCommands: source.skipSlashCommands !== false,
    triggerSources: stringList(source.triggerSources, DEFAULT_TRIGGER_SOURCES),
    locale: enumValue(source.locale, LOCALES, DEFAULT_CONFIG.locale),
    metaDownRank: clampNumber(source.metaDownRank, 0, 1, DEFAULT_CONFIG.metaDownRank),
    rulesEnabled: source.rulesEnabled !== false,
    lexiconEnabled: source.lexiconEnabled !== false,
    lexicon: lexiconMap(source.lexicon),
    pins: stringList(source.pins, []),
    pinMinScore: clampNumber(source.pinMinScore, 0, 1, DEFAULT_CONFIG.pinMinScore),
    debug: source.debug === true,
  })
}
