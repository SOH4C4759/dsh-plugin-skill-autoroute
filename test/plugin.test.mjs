/**
 * Plugin wiring tests: a fake Host context drives the real `apply()` — one
 * routing pass per received instruction, correct mode behaviour, and no
 * failure path that can break a step.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, fallbackUserMessage } from '../index.js'

const SKILLS = [
  {
    name: 'premiere-sound-review-editor',
    description: 'Build long-form game-sound-review projects in Premiere Pro with captions and candidate markers.',
    path: 'F:/skills/premiere-sound-review-editor',
  },
  {
    name: 'skill-router',
    description: 'Route the current task to the most relevant installed skill.',
    path: 'F:/skills/skill-router',
  },
  {
    name: 'openai-whisper',
    description: 'Local speech-to-text transcription for long recordings.',
    path: 'F:/skills/openai-whisper',
  },
]

/** One user-role message in the shape the Host produces. */
function userMessage(id, text, kind = 'user') {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind } }
}

/** Minimal Host context double: records listeners, counts catalog reads. */
function createCtx({ skills = SKILLS, body, failList = false } = {}) {
  const listeners = new Map()
  const calls = { list: 0, get: 0 }
  const ctx = {
    skills: {
      async list() {
        calls.list += 1
        if (failList) throw new Error('catalog offline')
        return skills
      },
      async get(name) {
        calls.get += 1
        return body === undefined ? undefined : { name, content: body }
      },
    },
    logger: { info() {}, warn() {} },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => list.splice(list.indexOf(handler), 1)
    },
  }
  return { ctx, listeners, calls }
}

/** Drive the registered pre-step listener once. */
async function runStep(listeners, payload, decision) {
  const handlers = listeners.get('agent/pre-step') ?? []
  assert.equal(handlers.length > 0, true, 'pre-step listener must be registered')
  let result = decision
  for (const handler of handlers) {
    let consumed = false
    result = await handler(payload, async () => {
      if (consumed) throw new Error('next() called twice')
      consumed = true
      return result
    })
  }
  return result
}

/** Payload for one turn with one fresh instruction. */
function payload(turn, id, text, kind = 'user') {
  return {
    agent: { id: 'session-1', session: { header: { cwd: 'F:/workspace' } } },
    messages: [userMessage(id, text, kind)],
    turn,
    step: 1,
    signal: new AbortController().signal,
  }
}

test('one received instruction gets exactly one injected routing notice', async () => {
  const { ctx, listeners } = createCtx()
  apply(ctx)
  const notice = await runStep(listeners, payload(1, 'm1', '把评审工程的字幕和候选标记整理好'), {
    kind: 'enter',
    messages: [userMessage('m1', '把评审工程的字幕和候选标记整理好')],
  })
  assert.equal(notice.kind, 'enter')
  assert.equal(notice.messages.length, 2)
  const injected = notice.messages[1]
  assert.equal(injected.role, 'user')
  assert.equal(injected.source.kind, 'skill-autoroute')
  assert.equal(injected.source.form, 'notice')
  assert.match(String(injected.id), /^[0-9a-f-]{36}$/u)
  assert.equal(Object.isFrozen(injected), true)
  assert.equal(injected.content[0].text.includes('premiere-sound-review-editor'), true)
  assert.equal(injected.content[0].text.includes('skill(name="premiere-sound-review-editor")'), true)
})

test('the same instruction is never routed twice, a new one always is', async () => {
  const { ctx, listeners } = createCtx()
  apply(ctx)
  const first = payload(3, 'm1', '把评审工程的字幕和候选标记整理好')
  const decision = { kind: 'enter', messages: [userMessage('m1', first.messages[0].content[0].text)] }
  const routed = await runStep(listeners, first, decision)
  assert.equal(routed.messages.length, 2)
  // Same turn, same message ids: the step may repeat, the routing must not.
  const again = await runStep(listeners, { ...first, step: 2 }, decision)
  assert.equal(again.messages.length, 1)
  // A new instruction is a new batch.
  const next = payload(3, 'm2', '把评审工程的字幕和候选标记整理好')
  const routedAgain = await runStep(listeners, next, { kind: 'enter', messages: [userMessage('m2', '把评审工程的字幕和候选标记整理好')] })
  assert.equal(routedAgain.messages.length, 2)
})

test('non-instruction steps, slash commands and tiny inputs inject nothing', async () => {
  const { ctx, listeners } = createCtx()
  apply(ctx)
  const team = await runStep(listeners, payload(1, 'm1', '把评审工程整理好', 'agent-teams'), {
    kind: 'enter',
    messages: [userMessage('m1', '把评审工程整理好', 'agent-teams')],
  })
  assert.equal(team.messages.length, 1)
  const slash = await runStep(listeners, payload(1, 'm2', '/agent-teams 做评审工程'), {
    kind: 'enter',
    messages: [userMessage('m2', '/agent-teams 做评审工程')],
  })
  assert.equal(slash.messages.length, 1)
  const tiny = await runStep(listeners, payload(1, 'm3', '好'), { kind: 'enter', messages: [userMessage('m3', '好')] })
  assert.equal(tiny.messages.length, 1)
  const rejected = await runStep(listeners, payload(1, 'm4', '把评审工程整理好'), { kind: 'reject' })
  assert.deepEqual(rejected, { kind: 'reject' })
})

test('load mode injects the winning skill body; a missing body falls back to a brief', async () => {
  const withBody = createCtx({ body: 'BODY-MARKER: follow these steps.' })
  apply(withBody.ctx, { mode: 'load', loadMinScore: 0 })
  const loaded = await runStep(withBody.listeners, payload(1, 'm1', '把评审工程的字幕和候选标记整理好'), {
    kind: 'enter',
    messages: [userMessage('m1', '把评审工程的字幕和候选标记整理好')],
  })
  assert.equal(loaded.messages.length, 2)
  assert.equal(loaded.messages[1].source.form, 'instructions')
  assert.equal(loaded.messages[1].content[0].text.includes('BODY-MARKER'), true)
  assert.equal(withBody.calls.get, 1)

  const withoutBody = createCtx()
  apply(withoutBody.ctx, { mode: 'load', loadMinScore: 0 })
  const brief = await runStep(withoutBody.listeners, payload(1, 'm1', '把评审工程的字幕和候选标记整理好'), {
    kind: 'enter',
    messages: [userMessage('m1', '把评审工程的字幕和候选标记整理好')],
  })
  assert.equal(brief.messages[1].source.form, 'notice')
})

test('router mode forces exactly one router-skill call and falls back when it is absent', async () => {
  const present = createCtx()
  apply(present.ctx, { mode: 'router' })
  const directive = await runStep(present.listeners, payload(1, 'm1', '把评审工程的字幕和候选标记整理好'), {
    kind: 'enter',
    messages: [userMessage('m1', '把评审工程的字幕和候选标记整理好')],
  })
  assert.equal(directive.messages.length, 2)
  assert.equal(directive.messages[1].content[0].text.includes('skill(name="skill-router")'), true)
  assert.equal(present.calls.list, 1)

  const absent = createCtx({ skills: SKILLS.filter((skill) => skill.name !== 'skill-router') })
  apply(absent.ctx, { mode: 'router' })
  const fallback = await runStep(absent.listeners, payload(1, 'm1', '把评审工程的字幕和候选标记整理好'), {
    kind: 'enter',
    messages: [userMessage('m1', '把评审工程的字幕和候选标记整理好')],
  })
  assert.equal(fallback.messages.length, 2)
  assert.equal(fallback.messages[1].content[0].text.includes('skill(name="skill-router")'), false)
  assert.equal(fallback.messages[1].source.form, 'notice')
})

test('router mode uses the first configured router skill that is installed', async () => {
  const skills = [
    ...SKILLS,
    { name: 'skill-selector', description: '选技能、给候选人列表。', path: 'F:/skills/mimo-skill-selector' },
  ]
  const ctxWithBoth = createCtx({ skills })
  apply(ctxWithBoth.ctx, { mode: 'router', routerSkills: ['skill-selector', 'skill-router'] })
  const preferred = await runStep(ctxWithBoth.listeners, payload(1, 'm1', '把评审工程的字幕和候选标记整理好'), {
    kind: 'enter',
    messages: [userMessage('m1', '把评审工程的字幕和候选标记整理好')],
  })
  assert.equal(preferred.messages[1].content[0].text.includes('skill(name="skill-selector")'), true)

  // `routerSkill` (singular) stays accepted, and the whole list may be missing.
  const onlyRouter = createCtx()
  apply(onlyRouter.ctx, { mode: 'router', routerSkill: 'skill-selector' })
  const second = await runStep(onlyRouter.listeners, payload(1, 'm1', '把评审工程的字幕和候选标记整理好'), {
    kind: 'enter',
    messages: [userMessage('m1', '把评审工程的字幕和候选标记整理好')],
  })
  assert.equal(second.messages[1].source.form, 'notice', 'a missing router skill falls back to the brief')

  const empty = createCtx({ skills: [] })
  apply(empty.ctx, { mode: 'router' })
  const third = await runStep(empty.listeners, payload(1, 'm1', '把评审工程的字幕和候选标记整理好'), {
    kind: 'enter',
    messages: [userMessage('m1', '把评审工程的字幕和候选标记整理好')],
  })
  assert.equal(third.messages.length, 1, 'an empty catalog must inject nothing')
})

test('a failing catalog is reported but never breaks the step', async () => {
  const { ctx, listeners } = createCtx({ failList: true })
  apply(ctx)
  const decision = { kind: 'enter', messages: [userMessage('m1', '把评审工程的字幕和候选标记整理好')] }
  const out = await runStep(listeners, payload(1, 'm1', '把评审工程的字幕和候选标记整理好'), decision)
  assert.equal(out.messages.length, 1)
})

test('the skills/change event invalidates the cached catalog', async () => {
  const { ctx, listeners, calls } = createCtx()
  apply(ctx, { catalogCacheMs: 600000 })
  await runStep(listeners, payload(1, 'm1', '把评审工程的字幕和候选标记整理好'), {
    kind: 'enter',
    messages: [userMessage('m1', '把评审工程的字幕和候选标记整理好')],
  })
  assert.equal(calls.list, 1)
  await runStep(listeners, payload(2, 'm2', '把评审工程的字幕和候选标记整理好'), {
    kind: 'enter',
    messages: [userMessage('m2', '把评审工程的字幕和候选标记整理好')],
  })
  assert.equal(calls.list, 1, 'a warm cache must not re-read the catalog')
  for (const handler of listeners.get('skills/change') ?? []) handler()
  await runStep(listeners, payload(3, 'm3', '把评审工程的字幕和候选标记整理好'), {
    kind: 'enter',
    messages: [userMessage('m3', '把评审工程的字幕和候选标记整理好')],
  })
  assert.equal(calls.list, 2)
})

test('disabled rows mount nothing at all', async () => {
  const off = createCtx()
  const handle = apply(off.ctx, { mode: 'off' })
  assert.equal(handle.enabled, false)
  assert.equal(off.listeners.size, 0)
  const disabled = createCtx()
  apply(disabled.ctx, { enabled: false })
  assert.equal(disabled.listeners.size, 0)
})

test('the structural message fallback matches the canonical helper contract', () => {
  const message = fallbackUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'skill-autoroute' } })
  assert.equal(message.role, 'user')
  assert.match(String(message.id), /^[0-9a-f-]{36}$/u)
  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.content), true)
  assert.equal(message.content[0].text, 'x')
})
