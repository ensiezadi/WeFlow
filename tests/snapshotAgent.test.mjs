import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const electron = resolve('node_modules/electron/dist/electron.exe')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function launch(file, args = []) {
  const child = spawn(electron, [file, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', code => resolve({ code, output }))
  })
  return { child, done, output: () => output }
}
async function waitFor(action, deadline = Date.now() + 15000) {
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result } catch {}
    await delay(100)
  }
  throw new Error('Timed out waiting for agent')
}

test('Windows event hook delivers notifications; resident agent acknowledges concurrent manual requests', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  await mkdir(resolve('logs'), { recursive: true })
  const scratch = await mkdtemp(resolve('logs/snapshot-agent-tests-'))
  const probeFile = join(scratch, 'probe.cjs')
  await build({
    stdin: { contents: `
      import { app } from 'electron'
      import * as koffi from 'koffi'
      import { watchForeground } from './scripts/snapshot-foreground'
      app.setPath('userData', ${JSON.stringify(join(scratch, 'probe-runtime'))})
      app.whenReady().then(() => {
        const timeout = setTimeout(() => { hook.close(); app.exit(1) }, 5000)
        const hook = watchForeground(() => { clearTimeout(timeout); hook.close(); console.log('hook-delivered'); app.exit(0) })
        const source = hook.context()
        if (!source?.app || typeof source.title !== 'string') throw new Error('Cannot read foreground app and title')
        const user32 = koffi.load('user32.dll')
        const getWindow = user32.func('void * __stdcall GetForegroundWindow()')
        const notify = user32.func('void __stdcall NotifyWinEvent(uint32_t event, void *window, int32_t object, int32_t child)')
        if (!hook.current()) throw new Error('Missing foreground window')
        notify(3, getWindow(), 0, 0)
      }).catch(error => { console.error(error); app.exit(1) })
    `, resolveDir: resolve('.') },
    outfile: probeFile, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'koffi']
  })
  const probe = launch(probeFile)
  const probeTimeout = setTimeout(() => probe.child.kill(), 12000)
  try {
    const result = await probe.done
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /hook-delivered/)
  } finally { clearTimeout(probeTimeout); if (probe.child.exitCode === null) probe.child.kill() }

  const root = join(scratch, 'archive')
  await mkdir(root)
  await writeFile(join(root, 'settings.json'), JSON.stringify({ schemaVersion: 1, enabled: false }))
  const agentFile = join(scratch, 'agent.cjs')
  await build({ entryPoints: [resolve('scripts/capture-diary-snapshot.ts')], outfile: agentFile, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'koffi'] })
  const agent = launch(agentFile, ['--root', root, '--watch'])
  const children = []
  try {
    const status = await waitFor(async () => JSON.parse(await readFile(join(root, 'agent-status.json'), 'utf8')))
    assert.equal(status.pid, agent.child.pid)
    const firstHeartbeat = status.heartbeatAt
    const manual = [0, 1].map(() => { const request = launch(agentFile, ['--root', root, '--manual']); children.push(request.child); return request })
    for (const result of await Promise.all(manual.map(request => request.done))) {
      assert.equal(result.code, 0, result.output)
      assert.match(result.output, /采样已暂停/)
    }
    const duplicate = launch(agentFile, ['--root', root, '--watch'])
    children.push(duplicate.child)
    assert.equal((await duplicate.done).code, 0)
    const next = await waitFor(async () => {
      const status = JSON.parse(await readFile(join(root, 'agent-status.json'), 'utf8'))
      return status.heartbeatAt !== firstHeartbeat ? status : null
    })
    assert.equal(next.pid, agent.child.pid)
    assert.equal(agent.child.exitCode, null, agent.output())
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    agent.child.kill()
    await agent.done
  }
})
