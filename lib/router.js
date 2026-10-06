/**
 * Deterministic skill router.
 *
 * Pure functions only — no I/O, no framework imports, no LLM calls. The router
 * answers one question: *given this instruction, which installed skills explain
 * it best?* It is deliberately explainable: every score is a ratio of matched
 * evidence, and every adjustment carries a machine-readable note that the
 * notice renderer turns into human language.
 *
 * Scoring model (documented so the numbers can be argued with, not guessed at):
 *
 *   fieldWeight(token) = 4 in name/alias, 2 in whenToUse, 1 in description
 *   idfFactor(token)   = 0.6 + 0.4 * idf(token) / maxIdf   (rare matches count more)
 *   evidence(token)    = queryWeight(token) * fieldWeight * idfFactor
 *   strength           = max(explicit floor 8, evidence * policy multiplier, priority floor 3.2)
 *                        + intent bonus 4.5
 *   rank               = strength (descending)
 *   reported score     = 1 - exp(-strength / 3.2)
 *
 * Ranking happens in evidence space and only the *reported* number is
 * saturated, so two strong candidates stay distinguishable instead of both
 * reading 0.95. A format word that only describes a delivery format (`导出 PDF`)
 * removes its same-named skill from the shortlist entirely (local overrides F1/F2).
 *
 * `queryWeight` for a Chinese token comes either from the CJK n-gram itself or
 * from the Chinese→English bridge in `lexicon.js`, which is what lets a Chinese
 * instruction hit an English skill name at all.
 *
 * The policy layer mirrors `.agents/skills/skill-router/references/local-overrides.md`:
 * the meta-skill family is down-ranked on real work, and format words (`PDF`,
 * `PPTX`) never promote their same-named skill when they only describe a
 * delivery format.
 *
 * @module dsh-plugin-skill-autoroute/lib/router
 */

import { BRIDGE_WEIGHT, LEXICON } from './lexicon.js'
import { localPriorityBoost, localPriorityMatches } from './local-policy.js'

/** How many evidence tokens contribute to one score. */
const TOP_EVIDENCE = 8

/** Evidence scale of the reported score: 1 - exp(-strength / SATURATION). */
const SATURATION = 3.2

/** Evidence floor granted to an explicit name/alias mention. */
const EXPLICIT_EVIDENCE = 8

/** Evidence floor (and seed value) for a capability named by the local priority table. */
const PRIORITY_EVIDENCE = 3.2

/** Latin tokens that carry no routing signal. */
const LATIN_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'with', 'on', 'in', 'is', 'are', 'be', 'by',
  'from', 'that', 'this', 'it', 'as', 'at', 'use', 'using', 'used', 'please', 'can', 'could',
  'you', 'your', 'we', 'our', 'my', 'me', 'do', 'does', 'did', 'how', 'what', 'when', 'which',
  'should', 'would', 'will', 'shall', 'if', 'then', 'than', 'into', 'about', 'up', 'out', 'no',
  'not', 'all', 'any', 'some', 'one', 'two', 'also', 'but', 'so', 'get', 'got', 'make', 'made',
  'new', 'need', 'want', 'let', 'just', 'only', 'very', 'more', 'most', 'such', 'per', 'via',
  'have', 'has', 'was', 'were', 'there', 'here', 'help', 'give', 'take', 'put', 'see', 'look',
])

/** CJK characters that carry no routing signal on their own. */
const CJK_STOP = new Set(
  '的了是和与或在有请帮我把它这那哪什么怎么如何一个一下而且然后就都也很更最可以要把被给对从到为以及其之此些吗呢吧啊哦嗯你好再再次就是还能用'.split(''),
)

/** Meta-skill family: skills *about* skills/agents rather than about the work. */
export const META_FAMILY = Object.freeze([
  'skill-router',
  'skill-selector',
  'mimo-skill-selector',
  'skill-finder-cn',
  'skill-finder',
  'luban-skill',
  'luban-skill-pro',
  'tiangong-skill',
  'book-to-skill',
  'zy930511',
  'self-improving-agent',
  'xiucheng-self-improving-agent',
  'dsh-skill-catalog',
  'skills-hub',
])

/** Instructions that are themselves about choosing/installing skills. */
const META_QUERY = /技能|skill|智能体|子代理|该用哪|用哪个|选哪|选择哪|装一个|安装一个|找一个能|有没有.*(能用|可用)/iu

/** Per-member meta intents (M2 of the local overrides): intent decides which family member leads. */
const META_INTENTS = [
  { names: ['book-to-skill', 'zy930511'], pattern: /(书|图书|论文|文献).{0,8}(skill|技能)|(skill|技能).{0,8}(书|图书)/iu },
  { names: ['skill-finder-cn'], pattern: /找|搜|安装|装一个|有没有.{0,6}(能用|可用)|哪里|find|search|install/iu },
  { names: ['tiangong-skill'], pattern: /智能体|人物设定|人格|角色.{0,4}(设计|创建)|agent.{0,8}(design|create)/iu },
  { names: ['luban-skill', 'luban-skill-pro'], pattern: /(优化|评分|打分|改进).{0,6}(skill|技能)|(skill|技能).{0,6}(优化|评分|打分)/iu },
  { names: ['self-improving-agent', 'xiucheng-self-improving-agent'], pattern: /自我改进|改进你|回答策略/iu },
  { names: ['skill-selector', 'mimo-skill-selector', 'skill-router'], pattern: /该用哪|用哪个|选哪|选择哪|哪一个|哪几个|哪个技能|which skill/iu },
]

/** Export/delivery verbs that turn a format word into a format-only mention. */
const EXPORT_VERB = /导出|输出|交付|生成|发布|出一份|出一版|做成|转换为|转成/iu
/** Work that genuinely operates on the PDF file itself. */
const PDF_WORK = /解析|抽取|提取|合并|拆分|填表|表单|编辑|批注|读取|加密|解密|扫描版/iu
/** Work that genuinely builds a deck. */
const PPTX_WORK = /母版|占位符|备注|图表|课件|演示稿|幻灯片|版面|版式|deck|slide/iu

/** Normalize any user text into the router's comparison space. */
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** True when the text is a slash command rather than a free instruction. */
export function isSlashCommand(text) {
  return /^\s*\//u.test(String(text ?? ''))
}

/** Truncate with an ellipsis, never exceeding `max` characters. */
export function truncate(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

/** Split a latin word into searchable parts (kebab/snake/dotted compounds). */
function latinParts(word) {
  const parts = word.split(/[-_./+#]+/u).filter((part) => part.length >= 2 && !LATIN_STOP.has(part) && !/^\d+$/u.test(part))
  if (word.length >= 2 && !LATIN_STOP.has(word) && !/^\d+$/u.test(word)) parts.unshift(word)
  return parts
}

/**
 * Light suffix normalization, so `captions` meets `caption` and `frames` meets
 * `frame`. Plural-only on purpose: it must never merge two real terms.
 * @param {string} token - latin token.
 * @returns {string} normalized token.
 */
export function stem(token) {
  const value = String(token)
  if (value.length < 4) return value
  if (/ies$/u.test(value)) return `${value.slice(0, -3)}y`
  if (/(ss|us|is|os|xs)$/u.test(value)) return value
  if (/s$/u.test(value)) return value.slice(0, -1)
  return value
}

/** Weight one CJK n-gram, discounting grams that lean on stop characters. */
function cjkWeight(gram, base) {
  let stops = 0
  for (const char of gram) if (CJK_STOP.has(char)) stops += 1
  if (stops === gram.length) return 0
  return stops === 0 ? base : base * 0.5
}

/**
 * Tokenize text into a weighted token map. Latin words contribute the word plus
 * their compounds; CJK runs contribute bigrams, trigrams and (for short runs)
 * the whole run, so both 「声音评审」 and 「评审工程」 can hit a description.
 * @param {string} text - raw text.
 * @returns {Map<string, number>} token -> maximum weight seen.
 */
export function tokenize(text) {
  /** @type {Map<string, number>} */
  const tokens = new Map()
  const add = (token, weight) => {
    if (!token || weight <= 0) return
    if (!tokens.has(token) || (tokens.get(token) ?? 0) < weight) tokens.set(token, weight)
  }
  const normalized = normalizeText(text)
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9+#._-]*/gu)) {
    for (const part of latinParts(match[0])) {
      add(part, 1)
      add(stem(part), 1)
    }
  }
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const run = match[0]
    if (run.length === 1) {
      add(run, 0.6)
      continue
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      add(run.slice(index, index + 2), cjkWeight(run.slice(index, index + 2), 1))
    }
    for (let index = 0; index < run.length - 2; index += 1) {
      add(run.slice(index, index + 3), cjkWeight(run.slice(index, index + 3), 1.25))
    }
    if (run.length <= 6) add(run, cjkWeight(run, 1.5))
  }
  return tokens
}

/**
 * Expand a query's CJK tokens through the Chinese→English bridge. Document
 * tokens are never expanded: the bridge is a query-side affordance only.
 * @param {Map<string, number>} tokens - raw query tokens.
 * @param {Record<string, readonly string[]>} [extra] - additional lexicon entries.
 * @returns {Map<string, number>} tokens plus bridged tokens.
 */
export function expandQueryTokens(tokens, extra) {
  const expanded = new Map(tokens)
  const lookup = (key) => {
    const added = extra?.[key]
    if (Array.isArray(added)) return added
    return LEXICON[key]
  }
  for (const [token, weight] of tokens) {
    const mapped = lookup(token)
    if (!Array.isArray(mapped)) continue
    const bridged = weight * BRIDGE_WEIGHT
    for (const latin of mapped) {
      const key = String(latin).toLowerCase()
      if (key === '') continue
      if (!expanded.has(key) || (expanded.get(key) ?? 0) < bridged) expanded.set(key, bridged)
    }
  }
  return expanded
}

/**
 * Tokenize a user instruction and bridge its Chinese terms to English ones.
 * @param {string} text - instruction text.
 * @param {Record<string, readonly string[]>} [extra] - additional lexicon entries.
 * @returns {Map<string, number>} query token weights.
 */
export function queryTokens(text, extra) {
  return expandQueryTokens(tokenize(text), extra)
}

/** Directory-name alias of a skill path, ignoring a trailing file name. */
function dirAlias(path) {
  const clean = String(path ?? '').replace(/[\\/]+$/u, '')
  if (clean === '') return ''
  const parts = clean.split(/[\\/]/u)
  let base = parts.pop() ?? ''
  if (/\.[a-z0-9]{1,6}$/iu.test(base)) base = parts.pop() ?? ''
  if (base === '' || base === '.' || base === '..') return ''
  return base
}

/**
 * Every name a user could type for one skill: the frontmatter name, its slash
 * variants (`Powerpoint / PPTX`), and the containing directory name.
 * @param {object} summary - `SkillSummary` from the host skills service.
 * @returns {string[]} lowercased aliases.
 */
export function aliasesOf(summary) {
  const aliases = new Set()
  const name = typeof summary?.name === 'string' ? summary.name.trim() : ''
  if (name !== '') {
    aliases.add(name)
    for (const part of name.split(/[/|,]+/u)) {
      const trimmed = part.trim()
      if (trimmed.length >= 3) aliases.add(trimmed)
    }
  }
  const alias = dirAlias(summary?.path)
  if (alias !== '') aliases.add(alias)
  return [...aliases].map((value) => value.toLowerCase()).filter((value) => value !== '')
}

/** Build the searchable profile of one skill. */
export function buildProfile(summary) {
  const aliases = aliasesOf(summary)
  const nameTokens = tokenize(aliases.join(' '))
  const whenTokens = tokenize(summary?.whenToUse ?? '')
  const descTokens = tokenize(summary?.description ?? '')
  return {
    name: String(summary?.name ?? ''),
    description: String(summary?.description ?? ''),
    path: typeof summary?.path === 'string' ? summary.path : '',
    source: typeof summary?.source === 'string' ? summary.source : '',
    provider: typeof summary?.provider === 'string' ? summary.provider : '',
    aliases,
    nameTokens,
    whenTokens,
    descTokens,
  }
}

/**
 * Build the catalog index: per-skill profiles plus document frequency, which is
 * what makes a rare match (`wwise`) outweigh a common one (`音频`).
 * @param {readonly object[]} skills - `SkillSummary[]`.
 * @returns {{size: number, profiles: object[], df: Map<string, number>}}
 */
export function buildCatalog(skills) {
  const profiles = []
  const df = new Map()
  for (const summary of skills ?? []) {
    if (!summary || typeof summary.name !== 'string' || summary.name.trim() === '') continue
    const profile = buildProfile(summary)
    profiles.push(profile)
    const seen = new Set([...profile.nameTokens.keys(), ...profile.whenTokens.keys(), ...profile.descTokens.keys()])
    for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1)
  }
  return { size: profiles.length, profiles, df }
}

/** Inverse document frequency of one token. */
function idf(token, df, size) {
  if (size <= 0) return 0
  return Math.log(1 + size / (1 + (df.get(token) ?? 0)))
}

/** Field label for a field weight. */
function fieldOf(weight) {
  if (weight >= 4) return 'name'
  if (weight >= 2) return 'when'
  return 'description'
}

/** True when the instruction is itself about skills/agents. */
export function isMetaQuery(text) {
  return META_QUERY.test(String(text ?? ''))
}

/**
 * Meta-family members the instruction is actually asking for.
 * @param {string} text - normalized instruction.
 * @returns {Set<string>} promoted names.
 */
export function metaIntentNames(text) {
  const value = String(text ?? '')
  const names = new Set()
  for (const intent of META_INTENTS) {
    if (intent.pattern.test(value)) for (const name of intent.names) names.add(name)
  }
  return names
}

/** True when a skill belongs to the meta family. */
export function isMetaSkill(entry) {
  const keys = [entry.name, ...(entry.aliases ?? [])].map((value) => String(value ?? '').toLowerCase())
  return keys.some((key) => META_FAMILY.includes(key))
}

/** Word-boundary (latin) or substring (CJK) alias mention test. */
export function mentionsAlias(text, alias) {
  const value = String(alias ?? '').toLowerCase()
  if (value.length < 3) return false
  if (/^[a-z0-9][a-z0-9 .+#_-]*$/u.test(value)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'u').test(text)
  }
  return text.includes(value)
}

/**
 * Apply the policy rules to one candidate.
 *
 * Rules work on *evidence*, not on the reported score: two strong candidates
 * would otherwise both read ~0.95 and their order would be noise.
 * @param {{name: string, aliases: string[]}} entry - candidate identity.
 * @param {string} text - normalized instruction.
 * @param {object} config - resolved config.
 * @returns {{multiplier: number, bonus: number, floor: number, exclude: boolean, notes: string[]}} policy effect.
 */
export function applyPolicy(entry, text, config) {
  const notes = []
  let multiplier = 1
  let bonus = 0
  let floor = 0
  let exclude = false
  const keys = [entry.name, ...(entry.aliases ?? [])].map((value) => String(value ?? '').toLowerCase())
  if (!config || config.rulesEnabled !== false) {
    const metaDownRank = typeof config?.metaDownRank === 'number' ? config.metaDownRank : 0.45
    const metaQuery = isMetaQuery(text)
    if (isMetaSkill(entry) && !metaQuery) {
      multiplier *= metaDownRank
      notes.push('meta-downrank')
    }
    if (isMetaSkill(entry) && metaQuery) {
      // M2 of the local overrides: on a meta instruction the family is the
      // primary choice, and which member leads depends on the stated intent.
      // The intent is categorical, so it adds evidence instead of scaling it.
      const intent = metaIntentNames(text)
      if (keys.some((key) => intent.has(key))) {
        bonus += 4.5
        notes.push('meta-promote')
      }
    }
    const priority = localPriorityBoost(keys, text)
    if (priority.multiplier !== 1) {
      multiplier *= priority.multiplier
      floor = Math.max(floor, PRIORITY_EVIDENCE)
      notes.push(...priority.notes)
    }
    const isPdf = keys.includes('pdf')
    const isPptx = keys.some((key) => key === 'powerpoint-pptx' || key === 'powerpoint / pptx' || key === 'pptx')
    // F1/F2 of the local overrides: a format word that only describes the
    // delivery format must not promote — or even keep — its same-named skill.
    if (isPdf && /pdf/u.test(text) && EXPORT_VERB.test(text) && !PDF_WORK.test(text)) {
      exclude = true
      notes.push('format-only-pdf')
    }
    if (isPptx && /pptx?|幻灯片|演示文稿|演示稿/iu.test(text) && !PPTX_WORK.test(text)) {
      exclude = true
      notes.push('format-only-pptx')
    }
  }
  return { multiplier, bonus, floor, exclude, notes }
}

/** Comparator shared by the pre-seed and post-seed ordering. */
function compareRanked(left, right) {
  if (right.strength !== left.strength) return right.strength - left.strength
  if (left.explicit !== right.explicit) return left.explicit ? -1 : 1
  if (right.nameHits !== left.nameHits) return right.nameHits - left.nameHits
  return left.name.localeCompare(right.name)
}

/**
 * Add capabilities the local table names outright. A Chinese request for
 * transcription shares no token with `openai-whisper`, so lexical overlap alone
 * can never surface it; the table is allowed to *seed* the candidate, never to
 * invent one — the name must resolve to an installed skill.
 */
function seedLocalPriorities(ranked, built, text, config) {
  if (config?.rulesEnabled === false) return
  const matches = localPriorityMatches(text)
  if (matches.length === 0) return
  const byKey = new Map()
  for (const profile of built.profiles) {
    for (const key of [profile.name, ...profile.aliases]) byKey.set(String(key).toLowerCase(), profile)
  }
  const present = new Set(ranked.map((item) => item.name))
  for (const match of matches) {
    for (const name of match.names) {
      const profile = byKey.get(String(name).toLowerCase())
      if (profile === undefined || present.has(profile.name)) continue
      present.add(profile.name)
      ranked.push({
        name: profile.name,
        description: profile.description,
        path: profile.path,
        source: profile.source,
        provider: profile.provider,
        aliases: profile.aliases,
        strength: PRIORITY_EVIDENCE,
        score: Math.round((1 - Math.exp(-PRIORITY_EVIDENCE / SATURATION)) * 1000) / 1000,
        explicit: false,
        meta: isMetaSkill(profile),
        seeded: true,
        fields: [],
        hits: [],
        notes: [match.note, 'policy-seed'],
        nameHits: 0,
      })
    }
  }
  ranked.sort(compareRanked)
}

/**
 * Rank installed skills against one instruction.
 * @param {string} query - the user instruction.
 * @param {readonly object[]} skills - `SkillSummary[]` from the skills service.
 * @param {object} config - resolved config.
 * @param {{size: number, profiles: object[], df: Map<string, number>}} [catalog] - prebuilt index.
 * @returns {object[]} ranked candidates, best first, already filtered and sliced.
 */
export function rankSkills(query, skills, config, catalog) {
  const text = normalizeText(query)
  const tokens = queryTokens(text, config?.lexiconEnabled === false ? undefined : config?.lexicon)
  if (tokens.size === 0) return []
  const built = catalog ?? buildCatalog(skills)
  if (built.size === 0) return []

  const tokenInfo = []
  let idfMax = 0
  for (const [token, queryWeight] of tokens) {
    const value = idf(token, built.df, built.size)
    if (value > idfMax) idfMax = value
    tokenInfo.push({ token, queryWeight, idf: value })
  }

  const metaQuery = isMetaQuery(text)
  const ranked = []
  for (const profile of built.profiles) {
    const hits = []
    for (const info of tokenInfo) {
      const fieldWeight = profile.nameTokens.has(info.token)
        ? 4
        : profile.whenTokens.has(info.token)
          ? 2
          : profile.descTokens.has(info.token)
            ? 1
            : 0
      if (fieldWeight === 0) continue
      const idfFactor = idfMax > 0 ? 0.6 + 0.4 * (info.idf / idfMax) : 1
      hits.push({ token: info.token, field: fieldOf(fieldWeight), weight: info.queryWeight * fieldWeight * idfFactor })
    }
    if (hits.length === 0) continue
    hits.sort((left, right) => right.weight - left.weight)
    const evidence = hits.slice(0, TOP_EVIDENCE).reduce((sum, hit) => sum + hit.weight, 0)
    const explicit = profile.aliases.some((alias) => mentionsAlias(text, alias))
    const policy = applyPolicy({ name: profile.name, aliases: profile.aliases }, text, config)
    if (policy.exclude) continue
    // Ranking happens in evidence space; `score` is only the reported, monotone view.
    const strength = Math.max(
      explicit ? EXPLICIT_EVIDENCE : 0,
      evidence * policy.multiplier,
      policy.floor,
    ) + policy.bonus
    const fields = [...new Set(hits.map((hit) => hit.field))]
    ranked.push({
      name: profile.name,
      description: profile.description,
      path: profile.path,
      source: profile.source,
      provider: profile.provider,
      aliases: profile.aliases,
      strength: Math.round(strength * 1000) / 1000,
      score: Math.round((1 - Math.exp(-strength / SATURATION)) * 1000) / 1000,
      explicit,
      meta: isMetaSkill(profile),
      fields,
      hits: hits.slice(0, 5).map((hit) => ({ token: hit.token, field: hit.field })),
      notes: policy.notes,
      nameHits: hits.filter((hit) => hit.field === 'name').length,
    })
  }

  ranked.sort(compareRanked)

  // The local table may also seed a capability that no shared token can reach.
  seedLocalPriorities(ranked, built, text, config)

  const pinned = []
  for (const pin of config?.pins ?? []) {
    const index = ranked.findIndex((item) => item.name === pin)
    if (index > 0 && ranked[index].score >= (config?.pinMinScore ?? 0)) pinned.push(...ranked.splice(index, 1))
  }
  const ordered = [...pinned, ...ranked]

  const minScore = typeof config?.minScore === 'number' ? config.minScore : 0.18
  const topN = typeof config?.topN === 'number' ? config.topN : 3
  return ordered.filter((item) => item.score >= minScore).slice(0, Math.max(1, topN))
}

/**
 * Render one candidate's matched evidence as short human-readable fragments.
 * @param {object} item - ranked candidate.
 * @param {'zh'|'en'} locale - notice language.
 * @returns {string[]} fragments such as `wwise (名称)`.
 */
export function describeHits(item, locale) {
  const labels = locale === 'en'
    ? { name: 'name', when: 'when-to-use', description: 'description' }
    : { name: '名称', when: '适用时机', description: '描述' }
  const fragments = []
  for (const hit of item.hits ?? []) {
    if (hit.field === 'description' && fragments.length >= 2) continue
    fragments.push(`${hit.token} (${labels[hit.field] ?? hit.field})`)
    if (fragments.length >= 3) break
  }
  return fragments
}
