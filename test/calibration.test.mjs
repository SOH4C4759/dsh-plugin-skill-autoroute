/**
 * Catalog-level regression.
 *
 *   - The committed fixture pool (`test/fixtures/skills/`) always runs: it
 *     covers the filesystem reader and the frontmatter parser deterministically.
 *   - The two accuracy suites score a *real* skill pool, so they skip themselves
 *     when the pool is absent. Point `SKILL_AUTOROUTE_ROOT` at a pool that
 *     contains the skills the fixtures name to run them locally.
 *
 * The accuracy sets:
 *   - `calibration.txt` — used while tuning the lexicon and thresholds.
 *   - `holdout.txt`     — written after tuning; its first untouched run scored
 *                         top1 7/12, topN 8/12, and the thresholds below hold
 *                         the *current* numbers (see docs/verification.md).
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../lib/config.js'
import { buildCatalog, rankSkills } from '../lib/router.js'
import { readFrontmatter, readSkillRoot } from '../scripts/skills-fs.mjs'

/** Committed pool: always present, used by CI and by the reader tests. */
const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/skills', import.meta.url))
/** Real pool for the accuracy suites; absent on a fresh clone, hence the skips. */
const ROOT = process.env.SKILL_AUTOROUTE_ROOT ?? '.agents/skills'
const POOL_PRESENT = existsSync(ROOT)
const SKIP = POOL_PRESENT ? false : `no real skill pool at ${ROOT} (set SKILL_AUTOROUTE_ROOT to run the accuracy suites)`

/** Read one fixture into `{query, expected[]}` cases. */
function readFixture(name) {
  const url = new URL(`./fixtures/${name}`, import.meta.url)
  return readFileSync(url, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [query, expectedRaw] = line.split('|').map((value) => value.trim())
      return { query, expected: (expectedRaw ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '') }
    })
}

/** Score one fixture. */
function evaluate(cases, skills, catalog, config) {
  let scored = 0
  let top1 = 0
  let topN = 0
  let silenceExpected = 0
  let silenceHeld = 0
  const misses = []
  for (const item of cases) {
    const ranked = rankSkills(item.query, skills, config, catalog).map((entry) => entry.name)
    if (item.expected.length === 0) {
      silenceExpected += 1
      if (ranked.length === 0) silenceHeld += 1
      else misses.push(`silence: "${item.query}" -> ${ranked.join(', ')}`)
      continue
    }
    scored += 1
    if (item.expected.includes(ranked[0])) top1 += 1
    else misses.push(`top1: "${item.query}" -> ${ranked[0] ?? '(none)'} (want ${item.expected.join(' | ')})`)
    if (ranked.some((name) => item.expected.includes(name))) topN += 1
  }
  return { scored, top1, topN, silenceExpected, silenceHeld, misses }
}

test('the frontmatter reader handles scalars, quoting and block scalars', () => {
  const text = [
    '---',
    'name: demo-skill',
    'version: 1.0.0',
    'description: "A quoted one-liner."',
    'when_to_use: |',
    '  first line',
    '  second line',
    '---',
    '',
    '# Body',
  ].join('\n')
  assert.deepEqual(readFrontmatter(text), {
    name: 'demo-skill',
    version: '1.0.0',
    description: 'A quoted one-liner.',
    when_to_use: 'first line\nsecond line',
  })
  assert.deepEqual(readFrontmatter('# no frontmatter'), {})
})

test('the filesystem reader projects a directory into a skill summary', () => {
  const skills = readSkillRoot(FIXTURE_ROOT)
  assert.deepEqual(skills.map((skill) => skill.name), ['premiere-sound-review-editor', 'skill-router', 'weather'])
  const named = skills.find((skill) => skill.name === 'skill-router')
  assert.equal(named.description.startsWith('Route the current task'), true)
  assert.equal(named.whenToUse.length > 0, true)
  assert.equal(named.path.endsWith('skill-router'), true)
  // A missing root is a silent empty catalog, never a throw: the plugin must
  // survive a Host that has no skills at all.
  assert.deepEqual(readSkillRoot(`${FIXTURE_ROOT}/does-not-exist`), [])
})

test('the committed fixture pool routes through the production path', () => {
  const skills = readSkillRoot(FIXTURE_ROOT)
  const config = resolveConfig({})
  assert.equal(rankSkills('解析这份 PDF 的表单并合并', skills, config).length, 0, 'weak queries stay silent')
  assert.equal(rankSkills('把评审工程的字幕和候选标记整理好', skills, config)[0].name, 'premiere-sound-review-editor')
})

test('a real skill pool, when present, keeps the tuning set accurate', { skip: SKIP }, () => {
  const config = resolveConfig({})
  const skills = readSkillRoot(ROOT)
  const result = evaluate(readFixture('calibration.txt'), skills, buildCatalog(skills), config)
  assert.equal(result.top1 / result.scored >= 0.9, true, `top1 ${result.top1}/${result.scored}\n${result.misses.join('\n')}`)
  assert.equal(result.topN / result.scored >= 0.95, true, `topN ${result.topN}/${result.scored}\n${result.misses.join('\n')}`)
  assert.equal(result.silenceHeld, result.silenceExpected, result.misses.join('\n'))
})

test('a real skill pool, when present, keeps the held-out set accurate', { skip: SKIP }, () => {
  const config = resolveConfig({})
  const skills = readSkillRoot(ROOT)
  const result = evaluate(readFixture('holdout.txt'), skills, buildCatalog(skills), config)
  assert.equal(result.top1 / result.scored >= 0.75, true, `top1 ${result.top1}/${result.scored}\n${result.misses.join('\n')}`)
  assert.equal(result.topN / result.scored >= 0.9, true, `topN ${result.topN}/${result.scored}\n${result.misses.join('\n')}`)
  assert.equal(result.silenceHeld, result.silenceExpected, result.misses.join('\n'))
})
