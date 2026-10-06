/**
 * Offline router console: runs the exact production scoring path against a
 * filesystem skills root, so ranking can be inspected and calibrated without a
 * Host restart.
 *
 * Usage:
 *   node scripts/route.mjs "<instruction>" [--root <dir>] [--candidates 3] [--min 0.28]
 *                                          [--locale zh] [--json] [--notice]
 *   node scripts/route.mjs --batch <file> [--root <dir>] [--candidates 3]
 *
 * The skills root defaults to `.agents/skills` under the current directory, or
 * to `SKILL_AUTOROUTE_ROOT` when that variable is set.
 *
 * A batch file holds one case per line: `instruction | expected1,expected2`.
 */

import { readFileSync } from 'node:fs'

import { resolveConfig } from '../lib/config.js'
import { buildCatalog, rankSkills } from '../lib/router.js'
import { renderBrief, renderLoad } from '../lib/notices.js'
import { readSkillRoot } from './skills-fs.mjs'

const DEFAULT_ROOT = process.env.SKILL_AUTOROUTE_ROOT ?? '.agents/skills'

/** Parse `--flag value` pairs plus one positional query. */
function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, candidates: 3, min: undefined, locale: 'zh', json: false, notice: false, batch: undefined, query: undefined }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--root') options.root = argv[++index]
    else if (token === '--candidates' || token === '--top') options.candidates = Number(argv[++index])
    else if (token === '--min') options.min = Number(argv[++index])
    else if (token === '--locale') options.locale = argv[++index]
    else if (token === '--batch') options.batch = argv[++index]
    else if (token === '--json') options.json = true
    else if (token === '--notice') options.notice = true
    else rest.push(token)
  }
  options.query = rest.join(' ').trim()
  return options
}

/** Load the catalog once and return both the raw list and the built index. */
function loadCatalog(root) {
  const skills = readSkillRoot(root)
  return { skills, index: buildCatalog(skills) }
}

/** Score one query with the production path. */
function rank(query, catalog, config) {
  return rankSkills(query, catalog.skills, config, catalog.index)
}

/** Compact rendering of one candidate. */
function line(item, position) {
  const fields = (item.hits ?? []).map((hit) => `${hit.token}:${hit.field}`).join(' ')
  const notes = (item.notes ?? []).length > 0 ? ` [${item.notes.join(',')}]` : ''
  return `${String(position).padStart(2)}. ${item.score.toFixed(3)} ${item.name}${notes} ${fields}`
}

const options = parseArgs(process.argv.slice(2))
const config = resolveConfig({
  candidates: Number.isFinite(options.candidates) ? options.candidates : 3,
  locale: options.locale,
  ...(Number.isFinite(options.min) ? { minScore: options.min } : {}),
})
const catalog = loadCatalog(options.root)

if (options.batch !== undefined) {
  const lines = readFileSync(options.batch, 'utf8').split(/\r?\n/u).map((value) => value.trim()).filter((value) => value !== '' && !value.startsWith('#'))
  let top1 = 0
  let topN = 0
  let silence = 0
  const misses = []
  for (const entry of lines) {
    const [query, expectedRaw] = entry.split('|').map((value) => value.trim())
    const expected = (expectedRaw ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '')
    const ranked = rank(query, catalog, config)
    const names = ranked.map((item) => item.name)
    if (expected.length === 0) {
      if (names.length === 0) silence += 1
      else misses.push(`SILENCE  ${query}\n         got: ${names.join(', ')}`)
      continue
    }
    const first = names[0] !== undefined && expected.includes(names[0])
    const within = names.some((name) => expected.includes(name))
    if (first) top1 += 1
    else misses.push(`TOP1     ${query}\n         want: ${expected.join(' | ')}\n         got : ${names[0] ?? '(none)'}`)
    if (within) topN += 1
    else misses.push(`MISS     ${query}\n         want: ${expected.join(' | ')}\n         got : ${names.join(', ') || '(none)'}`)
  }
  const scored = lines.filter((entry) => !entry.endsWith('|')).length
  console.log(`catalog=${catalog.skills.length} scored=${scored} silence=${silence}`)
  console.log(`top1=${top1}/${scored} (${((top1 / Math.max(1, scored)) * 100).toFixed(1)}%) topN=${topN}/${scored} (${((topN / Math.max(1, scored)) * 100).toFixed(1)}%)`)
  for (const miss of misses) console.log(miss)
  process.exit(0)
}

if (options.query === '') {
  console.error('usage: node scripts/route.mjs "<instruction>" [--root <dir>] [--top 3] [--min 0.18] [--json] [--notice]')
  process.exit(2)
}

const ranked = rank(options.query, catalog, config)
if (options.json) {
  console.log(JSON.stringify({ catalog: catalog.skills.length, query: options.query, candidates: ranked }, null, 2))
} else {
  console.log(`catalog=${catalog.skills.length} minScore=${config.minScore} candidates=${config.candidates}`)
  console.log(`query=${options.query}`)
  ranked.forEach((item, index) => console.log(line(item, index + 1)))
  if (ranked.length === 0) console.log('(silent: no candidate reached minScore)')
  if (options.notice) {
    const top = ranked[0]
    const rendered = config.mode === 'load' && top !== undefined
      ? renderLoad({ locale: config.locale, item: top, body: readBody(top), maxBodyChars: 400 })
      : top === undefined
        ? undefined
        : renderBrief({ locale: config.locale, ranked, total: catalog.skills.length, config })
    console.log('---- notice ----')
    console.log(rendered?.text ?? '(nothing would be injected)')
  }
}

/** Best-effort body reader for `--notice`. */
function readBody(item) {
  try {
    return readFileSync(`${item.path}/SKILL.md`, 'utf8')
  } catch {
    return ''
  }
}
