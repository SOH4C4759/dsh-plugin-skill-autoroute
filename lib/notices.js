/**
 * Notice text for the three routing modes, per locale.
 *
 * The text is written to be self-describing and low-presence: it states what
 * happened, what was found, what to do with it, and that ignoring it is an
 * acceptable outcome. It never asks the model to narrate the routing itself.
 *
 * @module dsh-plugin-skill-autoroute/lib/notices
 */

import { truncate, describeHits } from './router.js'

/** Producer kind recorded on every message this plugin injects. */
export const SOURCE_KIND = 'skill-autoroute'

/** One-line account bound used by the harness for `form: 'notice'`. */
const SUMMARY_MAX = 120

/** Build the summary that the transcript shows without expanding the row. */
function summaryOf(text) {
  const single = String(text).replace(/\s+/gu, ' ').trim()
  return single.length <= SUMMARY_MAX ? single : `${single.slice(0, SUMMARY_MAX - 1)}…`
}

/** `1. name · 0.62 — description` plus its matched evidence. */
function candidateLine(item, index, locale) {
  const description = truncate(item.description.replace(/\s+/gu, ' ').trim(), 78)
  const hits = describeHits(item, locale)
  const head = `${index + 1}. ${item.name} · ${item.score.toFixed(2)}${description === '' ? '' : ` — ${description}`}`
  return hits.length === 0 ? head : `${head}\n   ${locale === 'en' ? 'matched' : '命中'}：${hits.join('、')}`
}

/**
 * Routing brief: the selected candidates plus the instruction to load the
 * winner through the model-facing `skill` tool when it really applies.
 * @param {{locale: string, ranked: object[], total: number, config: object}} input - render input.
 * @returns {{text: string, source: object}} injectable notice.
 */
export function renderBrief({ locale, ranked, total, config }) {
  const top = ranked[0]
  const lines = []
  if (locale === 'en') {
    lines.push(`[skill-autoroute] One automatic routing pass over the local skill catalog (${total} entries) produced:`)
    ranked.forEach((item, index) => lines.push(candidateLine(item, index, locale)))
    lines.push(`How to use: if 1. really matches the current task, call skill(name="${top.name}") first and follow it; otherwise ignore this note and continue as usual. Do not restate it.`)
  } else {
    lines.push(`[skill-autoroute] 已对本地技能目录（${total} 项）自动完成一次技能路由，候选如下：`)
    ranked.forEach((item, index) => lines.push(candidateLine(item, index, 'zh')))
    lines.push(`用法：若第 1 项确实匹配当前任务，先调用 skill(name="${top.name}") 读取完整说明再动手；不匹配则忽略本条、按常规执行。不要复述本条内容。`)
  }
  const text = lines.join('\n')
  return {
    text,
    source: { kind: SOURCE_KIND, form: 'notice', summary: summaryOf(`Skill routing: ${ranked.map((item) => item.name).join(', ')}`) },
  }
}

/**
 * Literal router mode: force exactly one consultation of the routing skill.
 * @param {{locale: string, routerSkill: string}} input - render input.
 * @returns {{text: string, source: object}} injectable notice.
 */
export function renderRouterDirective({ locale, routerSkill }) {
  const text = locale === 'en'
    ? `[skill-autoroute] Route this instruction before acting: call skill(name="${routerSkill}") exactly once, apply its own rules to decide whether to load any other installed skill, then continue. If that skill is unavailable, ignore this note.`
    : `[skill-autoroute] 动手前先做一次技能路由：请立刻调用 skill(name="${routerSkill}") 恰好一次，按其中规则判断是否需要加载其他已安装技能，然后再开始执行。若该技能不存在则忽略本条。`
  return {
    text,
    source: { kind: SOURCE_KIND, form: 'instructions', summary: summaryOf(`Router skill invoked: ${routerSkill}`) },
  }
}

/**
 * Load mode: the winning skill body travels with the instruction, so the skill
 * takes effect without a model round trip.
 * @param {{locale: string, item: object, body: string, maxBodyChars: number}} input - render input.
 * @returns {{text: string, source: object}} injectable notice.
 */
export function renderLoad({ locale, item, body, maxBodyChars }) {
  const trimmed = truncate(body.trim(), maxBodyChars)
  const head = locale === 'en'
    ? `[skill-autoroute] Selected and loaded skill "${item.name}" automatically (score ${item.score.toFixed(2)}). Follow the SKILL.md below; if it is clearly unrelated to the current task, ignore this note.\n--- SKILL.md: ${item.name} ---\n`
    : `[skill-autoroute] 已自动选中并加载技能「${item.name}」（匹配度 ${item.score.toFixed(2)}）。以下为 SKILL.md 正文，请按其中流程执行；若与当前任务明显无关则忽略本条。\n--- SKILL.md: ${item.name} ---\n`
  return {
    text: `${head}${trimmed}`,
    source: { kind: SOURCE_KIND, form: 'instructions', summary: summaryOf(`Skill auto-loaded: ${item.name}`) },
  }
}
