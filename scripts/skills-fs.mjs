/**
 * Offline skill-catalog reader for tooling and calibration.
 *
 * Reads `<root>/<dir>/SKILL.md` the same way the Host's filesystem skill
 * provider does, and projects the frontmatter into the `SkillSummary` shape the
 * router consumes (`name`, `description`, `whenToUse`, `source`, `path`).
 * Used only by `scripts/route.mjs` and the calibration test — never by the
 * runtime plugin, which always reads the live `skills` service.
 *
 * @module dsh-plugin-skill-autoroute/scripts/skills-fs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Strip one layer of matching quotes. */
function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Minimal YAML frontmatter reader for SKILL.md files: scalar keys, quoted
 * scalars, and `|`/`>` block scalars. Enough for `name`/`slug`/`description`/
 * `when_to_use`; anything more exotic is left to the Host provider.
 * @param {string} text - full SKILL.md content.
 * @returns {Record<string,string>} frontmatter keys.
 */
export function readFrontmatter(text) {
  const normalized = String(text ?? '').replace(/^\uFEFF/u, '')
  if (!normalized.startsWith('---')) return {}
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return {}
  const body = normalized.slice(normalized.indexOf('\n') + 1, end)
  const result = {}
  const lines = body.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(lines[index])
    if (match === null) continue
    const key = match[1]
    const inline = match[2]
    if (inline === '|' || inline === '>' || inline === '|-' || inline === '>-') {
      const collected = []
      while (index + 1 < lines.length && /^\s+\S/u.test(lines[index + 1])) {
        collected.push(lines[index + 1].trim())
        index += 1
      }
      result[key] = collected.join(inline.startsWith('>') ? ' ' : '\n').trim()
      continue
    }
    result[key] = unquote(inline)
  }
  return result
}

/**
 * Read every direct child skill directory of one root.
 * @param {string} root - skills root directory.
 * @returns {object[]} `SkillSummary`-shaped entries.
 */
export function readSkillRoot(root) {
  const entries = []
  let children
  try {
    children = readdirSync(root, { withFileTypes: true })
  } catch {
    return entries
  }
  for (const child of children) {
    if (!child.isDirectory()) continue
    const dir = join(root, child.name)
    let text
    try {
      if (!statSync(dir).isDirectory()) continue
      text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const front = readFrontmatter(text)
    const name = (front.name ?? front.slug ?? child.name).trim()
    if (name === '') continue
    entries.push({
      name,
      description: (front.description ?? '').trim(),
      whenToUse: (front.when_to_use ?? front.whenToUse ?? '').trim(),
      source: 'filesystem',
      provider: 'filesystem',
      path: dir,
      dir: child.name,
    })
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}
