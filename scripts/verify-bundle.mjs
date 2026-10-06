#!/usr/bin/env node
/**
 * Bundle contract check for a DeepSeek Harness profile bundle.
 *
 * Why this exists: the expensive failure in this family is never a crash. It is
 * a package that installs cleanly, reports success, and then loads nothing —
 * `dsh.bundle.patch` pointing at a file that was renamed, an `exports` target
 * that no longer exists, a `files` entry that never made it into the tarball.
 * None of those are visible until somebody installs the release. This checker
 * turns them into a red build before the package is published.
 *
 * Usage:
 *   node scripts/verify-bundle.mjs [root]
 *
 * `root` defaults to the current directory, so the same file can be pointed at
 * an unpacked release asset to prove the artifact — not the checkout — is sound.
 *
 * Exit 0 when the manifest is internally consistent; exit 1 with one `FAIL` line
 * per hard violation. Warnings are advisory and never fail the run.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(process.argv[2] ?? process.cwd())
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const failures = []
const warnings = []
const fail = (message) => failures.push(message)
const warn = (message) => warnings.push(message)

const manifestPath = join(ROOT, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`verify-bundle: FAIL — no package.json under ${ROOT}`)
  process.exit(1)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  console.error(`verify-bundle: FAIL — package.json is not valid JSON: ${error.message}`)
  process.exit(1)
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Match one path segment that may contain `*` wildcards against a directory. */
function matchSegment(dir, segment, rest) {
  const matcher = new RegExp(`^${segment.split('*').map(escapeRe).join('[^/]*')}$`)
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!matcher.test(entry.name)) continue
    const absolute = join(dir, entry.name)
    if (rest.length === 0) {
      if (entry.isFile()) found.push(absolute)
    } else if (entry.isDirectory()) {
      found.push(...matchUnder(absolute, rest))
    }
  }
  return found
}

/** Resolve the remainder of a subpath pattern relative to an already-open directory. */
function matchUnder(dir, segments) {
  const [head, ...rest] = segments
  if (head === undefined || head === '') return []
  if (head.includes('*')) return matchSegment(dir, head, rest)
  const next = join(dir, head)
  if (!existsSync(next)) return []
  if (rest.length === 0) return statSync(next).isFile() ? [next] : []
  return statSync(next).isDirectory() ? matchUnder(next, rest) : []
}

/**
 * Expand one `exports` / `files` entry.
 *
 * Subpath patterns (`./locale/*.json`) are legitimate and common — the loader
 * addresses individual files through them — so a literal `existsSync` on the
 * pattern itself reports a false failure. Everything before the first wildcard
 * is a fixed prefix that must exist; the wildcards must then match real files.
 */
function expandEntry(relative) {
  const segments = relative.replace(/^\.\//, '').split('/')
  const fixed = []
  for (const segment of segments) {
    if (segment.includes('*')) break
    fixed.push(segment)
  }
  if (fixed.length === segments.length) return existsSync(join(ROOT, relative)) ? [join(ROOT, relative)] : []
  const base = join(ROOT, ...fixed)
  if (base === ROOT && fixed.length === 0) return []
  if (!existsSync(base) || !statSync(base).isDirectory()) return []
  return matchUnder(base, segments.slice(fixed.length))
}

/** Resolve one workspace-relative path and report it when it is not a real file. */
function requireFile(relative, source) {
  if (typeof relative !== 'string' || relative === '') {
    fail(`${source}: expected a path, got ${JSON.stringify(relative)}`)
    return null
  }
  const absolute = join(ROOT, relative)
  const matches = expandEntry(relative)
  if (matches.length === 0) {
    fail(
      relative.includes('*')
        ? `${source} pattern matches nothing: ${relative}`
        : `${source} points at a missing file: ${relative}`,
    )
    return null
  }
  const first = matches[0]
  if (!statSync(first).isFile()) {
    fail(`${source} points at a directory, not a file: ${relative}`)
    return null
  }
  void absolute
  return first
}

// 1. Identity. A release is addressed by these two strings, so neither may drift.
if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
  fail('package.json: `name` is missing')
}
if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
  fail(`package.json: \`version\` is missing or not semver: ${JSON.stringify(manifest.version)}`)
}

// 2. The bundle patch is the whole reason a profile composes this package.
const patchRelative = manifest.dsh?.bundle?.patch
if (typeof patchRelative !== 'string' || patchRelative === '') {
  fail('package.json: `dsh.bundle.patch` is missing — without it the profile never composes this package')
} else {
  const patchPath = requireFile(patchRelative, 'dsh.bundle.patch')
  if (patchPath !== null) {
    const text = readFileSync(patchPath, 'utf8')
    if (text.trim() === '') {
      fail(`the bundle patch is empty: ${patchRelative}`)
    } else if (typeof manifest.name === 'string' && !text.includes(manifest.name)) {
      warn(`the bundle patch never names "${manifest.name}"; confirm the row it inserts is the one the profile loads`)
    }
  }
}

// 3. Every published entry point must exist. `exports` is what the loader reads.
const exportsField = manifest.exports
const exportEntries = []
if (exportsField === undefined) {
  warn('package.json: no `exports` map; the loader reaches the browser half through its `./client` subpath')
} else if (typeof exportsField === 'string') {
  exportEntries.push(['exports', exportsField])
} else if (exportsField !== null && typeof exportsField === 'object') {
  for (const [key, value] of Object.entries(exportsField)) {
    if (typeof value === 'string') exportEntries.push([`exports["${key}"]`, value])
  }
} else {
  fail('package.json: `exports` is neither a string nor a map')
}

const resolvedExports = new Map()
for (const [source, value] of exportEntries) {
  if (!value.startsWith('./')) continue
  const absolute = requireFile(value, source)
  if (absolute !== null) resolvedExports.set(source, { relative: value, absolute })
}

// 4. `files` is the publish allow-list: an entry that does not exist is a typo,
//    and a real file missing from it is content the release will not carry.
//
//    That second half is the one that bites. A new local module imported by an
//    entry point is invisible until somebody installs the tarball, at which point
//    the import fails and the plugin never loads — the checkout works, so nothing
//    local contradicts it. So the entry points' relative imports are walked and
//    every one of them must be covered by the allow-list.
if (manifest.files !== undefined) {
  if (!Array.isArray(manifest.files)) {
    fail('package.json: `files` must be an array')
  } else {
    for (const entry of manifest.files) {
      if (typeof entry !== 'string' || entry === '') {
        fail(`package.json: invalid \`files\` entry: ${JSON.stringify(entry)}`)
        continue
      }
      if (expandEntry(entry).length === 0) fail(`\`files\` entry resolves to nothing: ${entry}`)
    }
  }
} else {
  warn('package.json: no `files` allow-list; the published package carries every tracked file')
}

/**
 * Walk the relative imports of one file, transitively.
 *
 * Only static `from '...'` forms are matched: those are what an entry point uses
 * to reach its own modules, and a dynamic import would be a finding of its own.
 */
function relativeImports(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return seen
  seen.add(file)
  const text = readFileSync(file, 'utf8')
  // Match the specifier, not the statement. A multi-line `import { … } from '…'`
  // is common, and an expression trying to span the whole statement also spans
  // unrelated code between two of them — which produced a false report about a
  // file nobody imports.
  const pattern = /\bfrom\s*['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]/g
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1] ?? match[2]
    if (specifier === undefined) continue
    const resolved = resolve(dirname(file), specifier)
    for (const candidate of [resolved, `${resolved}.mjs`, `${resolved}.js`, join(resolved, 'index.mjs')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        relativeImports(candidate, seen)
        break
      }
    }
  }
  return seen
}

/** Whether a workspace-relative path is carried by the `files` allow-list. */
function isCarried(relativePath, allowList) {
  if (allowList === null) return true
  for (const entry of allowList) {
    const normalized = entry.replace(/\/+$/, '')
    if (relativePath === normalized || relativePath.startsWith(`${normalized}/`)) return true
  }
  return false
}

if (Array.isArray(manifest.files)) {
  const allowList = manifest.files.filter((entry) => typeof entry === 'string')
  const carried = new Set()
  for (const [source, value] of exportEntries) {
    if (typeof value !== 'string' || !value.startsWith('./')) continue
    // Only JavaScript entry points import anything. `exports["./package.json"]` is
    // an export target too, but it is data — and npm always ships it, listed or not.
    if (!/\.(mjs|js)$/.test(value)) continue
    const absolute = join(ROOT, value)
    if (!existsSync(absolute)) continue
    for (const file of relativeImports(absolute)) {
      // `rel`, not `relative`: the latter is the imported path helper.
      const rel = relative(ROOT, file).split(sep).join('/')
      if (!isCarried(rel, allowList)) carried.add(rel)
    }
  }
  if (carried.size > 0) {
    fail(`these files are imported by an entry point but are not in \`files\`, so the published package would fail to load: ${[...carried].join(', ')}`)
  }
}

// 5. The browser half is declared in `dsh.client` and delivered by `./client`.
const clientField = manifest.dsh?.client
if (clientField !== undefined) {
  const target = exportEntries.find(([source]) => source === 'exports["./client"]')
  if (target === undefined) {
    fail('`dsh.client` is declared but package.json has no `./client` export')
  } else if (!resolvedExports.has('exports["./client"]')) {
    // requireFile already recorded the precise reason.
  } else if (clientField?.platform !== 'web') {
    warn(`dsh.client.platform is ${JSON.stringify(clientField?.platform)}; the loader expects "web"`)
  }
}

// 6. Parse every entry point. `--check` parses without executing, which is what
//    this needs: the browser half references `window` and the host half imports
//    the harness, so neither can be imported here.
const syntaxTargets = new Map()
for (const [source, value] of exportEntries) {
  if (typeof value === 'string' && value.endsWith('.js') && !value.includes('*')) syntaxTargets.set(value, source)
}
if (typeof manifest.main === 'string' && manifest.main.endsWith('.js')) {
  syntaxTargets.set(manifest.main, 'main')
}
for (const relative of ['index.js', 'client.js']) {
  if (existsSync(join(ROOT, relative))) syntaxTargets.set(`./${relative}`, 'top-level entry')
}

let parsed = 0
for (const [relative, source] of syntaxTargets) {
  const absolute = join(ROOT, relative)
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    fail(`${source} points at a missing entry file: ${relative}`)
    continue
  }
  try {
    execFileSync(process.execPath, ['--check', absolute], { stdio: ['ignore', 'ignore', 'pipe'] })
    parsed += 1
  } catch (error) {
    const detail = (error.stderr ?? '').toString().trim().split('\n').slice(0, 6).join('\n')
    fail(`entry file does not parse: ${relative}${detail === '' ? '' : `\n${detail}`}`)
  }
}

// 7. Advisory presentation. DSH renders these on the plugin page; a missing one
//    is a worse first impression, not a broken install.
if (typeof manifest.meta?.title !== 'string' || manifest.meta.title === '') {
  warn('package.json: `meta.title` is missing — the plugin list falls back to the package name')
}
if (typeof manifest.meta?.description !== 'string' || manifest.meta.description === '') {
  warn('package.json: `meta.description` is missing — the plugin page shows no summary')
}
if (typeof manifest.icon === 'string' && manifest.icon !== '' && !existsSync(join(ROOT, manifest.icon))) {
  warn(`package.json: \`icon\` points at a missing file: ${manifest.icon}`)
}
if (typeof manifest.engines?.node !== 'string') {
  warn('package.json: `engines.node` is missing; the supported runtime is undocumented')
}

const identity = `${manifest.name ?? '<unnamed>'}@${manifest.version ?? '<unversioned>'}`
console.log(`verify-bundle: ${identity} (${ROOT})`)
for (const warning of warnings) console.log(`  warn  ${warning}`)
for (const failure of failures) console.log(`  FAIL  ${failure}`)
if (failures.length > 0) {
  console.error(`verify-bundle: ${failures.length} contract violation(s) in ${identity}`)
  process.exit(1)
}
console.log(`verify-bundle: OK — ${resolvedExports.size} export target(s) resolved, ${parsed} entry file(s) parsed`)
