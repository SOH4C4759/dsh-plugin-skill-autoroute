/**
 * Workspace-local priority table.
 *
 * A deterministic router cannot infer that 「做成可继续修改的评审工程」 means the
 * Premiere long-recording review project rather than the review *pipeline*, and
 * the vocabulary overlap between those two skills is almost total. This table
 * encodes the same same-domain tie-breaks the local Skill Router documents in
 * `.agents/skills/skill-router/references/local-overrides.md` §3.1/§3.2 — a
 * small, auditable boost applied only *inside* one capability.
 *
 * It never invents a skill: a name listed here must also be an installed skill
 * or the entry simply never matches. Disable the whole layer with
 * `rulesEnabled: false`.
 *
 * @module dsh-plugin-skill-autoroute/lib/local-policy
 */

/** Boost applied when an entry's `when` matches and its `unless` does not. */
export const PRIORITY_MULTIPLIER = 1.5

/** @type {ReadonlyArray<{names: readonly string[], when: RegExp, unless?: RegExp, note: string}>} */
export const DOMAIN_PRIORITIES = Object.freeze([
  {
    names: ['premiere-sound-review-editor'],
    when: /评审工程|工程可继续改|保留完整讨论|候选标记|非破坏|无损|加字幕/u,
    unless: /碎片|源出入点|术语表|字幕对轴/u,
    note: 'priority-review-project',
  },
  {
    names: ['premiere-stt-revision'],
    when: /剪好|碎片|源出入点|术语表|按源/u,
    unless: /评审工程|时间线/u,
    note: 'priority-stt-revision',
  },
  {
    names: ['sound-review-video-pipeline'],
    when: /时间线|字幕对轴|端到端|出 ?mp4|录屏|可复查报告/u,
    unless: /评审工程|碎片/u,
    note: 'priority-review-pipeline',
  },
  {
    names: ['narrated-game-audio-video'],
    when: /旁白|科普|讲解|解说/u,
    unless: /评审工程|碎片/u,
    note: 'priority-narrated',
  },
  {
    names: ['automotive-turn-indicator-chime'],
    when: /车型|汽车|转向|提示音/u,
    unless: /原理动画|现有 ?ae|共享配置/u,
    note: 'priority-automotive-research',
  },
  {
    names: ['ae-audio-principle-animation'],
    when: /原理动画|现有 ?ae|共享配置|5\.1/u,
    unless: /调研|设计方案/u,
    note: 'priority-ae-principle',
  },
  {
    names: ['openai-whisper'],
    when: /转写|转文字|转录|听写|录音.{0,8}(转|字幕)|语音.{0,6}(转|识别)/u,
    note: 'priority-transcription',
  },
  {
    names: ['plugin-inventory'],
    when: /哪些|盘点|清单|装了|已装|装了哪些|目录/u,
    unless: /保持|迁移|修复/u,
    note: 'priority-plugin-inventory',
  },
])

/**
 * Score multiplier and note codes for one candidate under the local table.
 * @param {readonly string[]} keys - lowercased name/alias keys of the candidate.
 * @param {string} text - normalized instruction.
 * @returns {{multiplier: number, notes: string[]}} boost, if any.
 */
export function localPriorityBoost(keys, text) {
  for (const entry of DOMAIN_PRIORITIES) {
    if (!entry.names.some((name) => keys.includes(name))) continue
    if (!entry.when.test(text)) continue
    if (entry.unless !== undefined && entry.unless.test(text)) continue
    return { multiplier: PRIORITY_MULTIPLIER, notes: [entry.note] }
  }
  return { multiplier: 1, notes: [] }
}

/**
 * Entries the instruction clearly asks for, whether or not lexical overlap can
 * reach them. A Chinese request for transcription shares no token with the name
 * `openai-whisper`, so the table also *seeds* such candidates.
 * @param {string} text - normalized instruction.
 * @returns {Array<{names: readonly string[], note: string}>} matched entries.
 */
export function localPriorityMatches(text) {
  const value = String(text ?? '')
  return DOMAIN_PRIORITIES.filter(
    (entry) => entry.when.test(value) && (entry.unless === undefined || !entry.unless.test(value)),
  ).map((entry) => ({ names: entry.names, note: entry.note }))
}
