/**
 * Router unit tests on a synthetic catalog: scoring shape, policy rules,
 * determinism and config coercion. No filesystem, no Host.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import {
  aliasesOf,
  applyPolicy,
  buildCatalog,
  expandQueryTokens,
  mentionsAlias,
  metaIntentNames,
  rankSkills,
  stem,
  tokenize,
} from '../lib/router.js'
import { renderBrief, renderLoad, renderRouterDirective, SOURCE_KIND } from '../lib/notices.js'

const SKILLS = [
  {
    name: 'premiere-sound-review-editor',
    description: 'Build long-form Chinese game-sound-review projects in Adobe Premiere Pro with captions and candidate markers, non-destructive.',
    path: 'F:/skills/premiere-sound-review-editor',
  },
  {
    name: 'sound-review-video-pipeline',
    description: '端到端长录像抽取与成片流水线：离线转写、剪辑时间线、字幕对轴，输出 MP4 与可复查报告。',
    path: 'F:/skills/sound-review-video-pipeline',
  },
  {
    name: 'academic-figures',
    description: 'Create journal-quality colorblind-safe 600dpi figures from data, exporting TIFF/PNG/PDF.',
    path: 'F:/skills/academic-figures',
  },
  {
    name: 'pdf',
    description: 'Parse, fill, merge and split PDF files themselves.',
    path: 'F:/skills/pdf',
  },
  {
    name: 'Powerpoint / PPTX',
    description: 'Create and edit PowerPoint decks with templates, placeholders, notes and charts.',
    path: 'F:/skills/powerpoint-pptx',
  },
  {
    name: 'skill-router',
    description: 'Route the current task to the most relevant installed skill when choosing is the problem.',
    path: 'F:/skills/skill-router',
  },
  {
    name: 'openai-whisper',
    description: 'Local speech-to-text transcription with Whisper models for long recordings.',
    path: 'F:/skills/openai-whisper',
  },
  {
    name: 'weather',
    description: 'Look up the weather forecast for a place.',
    path: 'F:/skills/weather',
  },
]

const CONFIG = resolveConfig({})

/** Names of the ranked candidates, best first. */
function names(query, config = CONFIG) {
  return rankSkills(query, SKILLS, config).map((item) => item.name)
}

test('tokenize keeps latin compounds and CJK n-grams, drops stop words', () => {
  const tokens = tokenize('Please use the sound-review pipeline for 声音评审')
  assert.equal(tokens.has('the'), false)
  assert.equal(tokens.has('sound-review'), true)
  assert.equal(tokens.has('sound'), true)
  assert.equal(tokens.has('review'), true)
  assert.equal(tokens.has('声音'), true)
  assert.equal(tokens.has('评审'), true)
})

test('stem merges plurals but never merges distinct terms', () => {
  assert.equal(stem('captions'), 'caption')
  assert.equal(stem('frames'), 'frame')
  assert.equal(stem('stories'), 'story')
  assert.equal(stem('class'), 'class')
  assert.equal(stem('analysis'), 'analysis')
  assert.equal(stem('pdf'), 'pdf')
})

test('the lexicon bridges Chinese terms onto English evidence tokens', () => {
  const bridged = expandQueryTokens(tokenize('技能'))
  assert.equal(bridged.has('skill'), true)
  const custom = expandQueryTokens(tokenize('棱镜'), { 棱镜: ['prism'] })
  assert.equal(custom.has('prism'), true)
})

test('aliases cover the frontmatter name, its slash variants and the directory', () => {
  const aliases = aliasesOf(SKILLS[4])
  assert.deepEqual(aliases.sort(), ['powerpoint', 'powerpoint / pptx', 'powerpoint-pptx', 'pptx'].sort())
  assert.equal(mentionsAlias('use powerpoint for this', 'powerpoint'), true)
  assert.equal(mentionsAlias('powerpoints are fine', 'powerpoint'), false)
})

test('an explicitly named skill wins', () => {
  assert.equal(names('用 skill-router 帮我决定该用哪个技能')[0], 'skill-router')
  assert.equal(names('take the sound-review-video-pipeline route')[0], 'sound-review-video-pipeline')
})

test('a Chinese instruction reaches an English-description skill', () => {
  assert.equal(names('把评审工程的字幕和候选标记整理好')[0], 'premiere-sound-review-editor')
})

test('the local table seeds a capability that shares no token with the request', () => {
  assert.equal(names('帮我把录音里的对话转成中文字幕，并对好时间轴')[0], 'openai-whisper')
})

test('the meta family is down-ranked on real work and promoted on meta instructions', () => {
  const entry = { name: 'skill-router', aliases: ['skill-router'] }
  assert.deepEqual(applyPolicy(entry, '做一个 wwise 音频评审工程', CONFIG).notes, ['meta-downrank'])
  const promoted = applyPolicy(entry, '我装了一堆技能，到底该用哪个', CONFIG)
  assert.equal(promoted.notes.includes('meta-promote'), true)
  assert.equal(promoted.bonus > 0, true)
  const meta = rankSkills('我装了一堆技能，到底该用哪个', SKILLS, CONFIG)
  assert.equal(meta[0].name, 'skill-router')
})

test('a format word used only as a delivery format never promotes its skill', () => {
  const exportOnly = rankSkills('把结论导出成 PDF 交付', SKILLS, CONFIG).map((item) => item.name)
  assert.equal(exportOnly.includes('pdf'), false)
  assert.equal(names('解析这份扫描件 PDF 的表单并合并')[0], 'pdf')
  assert.equal(rankSkills('导出 PPTX 文件', SKILLS, CONFIG).some((item) => item.name === 'Powerpoint / PPTX'), false)
  const deckWork = rankSkills('套本机母版和占位符做一份 PPTX 课件，备注也要对齐', SKILLS, CONFIG)
  assert.equal(deckWork[0].name, 'Powerpoint / PPTX')
  assert.equal(deckWork[0].notes.includes('format-only-pptx'), false)
})

test('an unrelated instruction stays silent instead of naming a weak candidate', () => {
  assert.deepEqual(names('帮我约个附近能开会的地方'), [])
})

test('ranking is deterministic and honours topN', () => {
  const first = names('把长录像做成成片并出报告')
  const second = names('把长录像做成成片并出报告')
  assert.deepEqual(first, second)
  assert.equal(rankSkills('把长录像做成成片并出报告', SKILLS, resolveConfig({ topN: 1 })).length, 1)
})

test('configured pins move an existing candidate to the front', () => {
  const config = resolveConfig({ pins: ['weather'], pinMinScore: 0 })
  assert.equal(rankSkills('今天天气如何，顺便看下评审工程', SKILLS, config)[0].name, 'weather')
})

test('meta intents resolve per family member', () => {
  assert.deepEqual([...metaIntentNames('帮我找一个能批量处理音频的技能')], ['skill-finder-cn'])
  assert.deepEqual([...metaIntentNames('把这本书蒸馏成一个 skill')].sort(), ['book-to-skill', 'zy930511'])
})

test('notices carry producer tags, a bounded summary and the winning name', () => {
  const ranked = rankSkills('用 skill-router 选择技能', SKILLS, CONFIG)
  const brief = renderBrief({ locale: 'zh', ranked, total: SKILLS.length, config: CONFIG })
  assert.equal(brief.source.kind, SOURCE_KIND)
  assert.equal(brief.source.form, 'notice')
  assert.equal(brief.source.summary.length <= 120, true)
  assert.equal(brief.text.includes('skill(name="skill-router")'), true)

  const router = renderRouterDirective({ locale: 'zh', routerSkill: 'skill-router' })
  assert.equal(router.source.form, 'instructions')
  assert.equal(router.text.includes('skill(name="skill-router")'), true)

  const loaded = renderLoad({ locale: 'zh', item: ranked[0], body: 'BODY', maxBodyChars: 100 })
  assert.equal(loaded.text.includes('BODY'), true)
  assert.equal(loaded.source.form, 'instructions')
})

test('config coercion never throws and always yields a usable shape', () => {
  const config = resolveConfig({
    mode: 'nonsense',
    topN: 999,
    minScore: 'x',
    loadMinScore: -3,
    locale: 'fr',
    triggerSources: [],
    pins: 'weather',
    lexicon: { '棱镜': 'prism' },
    maxBodyChars: 10,
  })
  assert.equal(config.mode, 'brief')
  assert.equal(config.topN, 10)
  assert.equal(config.minScore, resolveConfig({}).minScore)
  assert.equal(config.loadMinScore, 0)
  assert.equal(config.locale, 'zh')
  assert.deepEqual(config.triggerSources, ['user'])
  assert.deepEqual(config.pins, [])
  assert.deepEqual(config.lexicon, { 棱镜: ['prism'] })
  assert.equal(config.maxBodyChars, 200)
  assert.deepEqual(resolveConfig({ routerSkill: 'skill-selector' }).routerSkills, ['skill-selector'])
  assert.deepEqual(resolveConfig({ routerSkills: ['skill-selector', 'skill-router'] }).routerSkills, ['skill-selector', 'skill-router'])
  assert.deepEqual(resolveConfig({ routerSkills: [] }).routerSkills, ['skill-router'])
  assert.equal(resolveConfig(undefined).enabled, true)
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.equal(Object.isFrozen(config), true)
})

test('catalog building ignores nameless entries and is reusable', () => {
  const catalog = buildCatalog([...SKILLS, { description: 'no name' }, null])
  assert.equal(catalog.size, SKILLS.length)
  const reused = rankSkills('解析 PDF 表单', SKILLS, CONFIG, catalog)
  assert.equal(reused[0].name, 'pdf')
})
