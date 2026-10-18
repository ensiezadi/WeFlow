import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

await mkdir(resolve('logs'), { recursive: true })
const scratch = await mkdtemp(resolve('logs/game-guard-tests-'))
const compiled = join(scratch, 'guard.mjs')
await build({ entryPoints: [resolve('electron/services/workflowGameGuard.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'esm' })
const { isGameExecutable, workflowGameBlockReason } = await import(pathToFileURL(compiled).href)
const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }]
const window = { app: 'code.exe', bounds: { left: 0, top: 0, right: 1920, bottom: 1040 }, windowStyle: 0x00c00000 }

test('Dark Souls III and Steam game binaries are excluded in fullscreen and windowed mode', () => {
  assert.equal(isGameExecutable('D:\\SteamLibrary\\steamapps\\common\\DARK SOULS III\\Game\\DarkSoulsIII.exe'), true)
  assert.equal(isGameExecutable('D:\\Games\\DarkSoulsIII.exe'), true)
  assert.equal(isGameExecutable('C:\\Program Files\\Microsoft VS Code\\Code.exe'), false)
  assert.ok(workflowGameBlockReason({ ...window, gameProcess: true }, displays))
  assert.ok(workflowGameBlockReason({ ...window, app: 'DARKSOULSIII.EXE' }, displays))
})

test('D3D fullscreen, presentation mode and borderless fullscreen stop capture before screenshots', () => {
  assert.ok(workflowGameBlockReason({ ...window, notificationState: 3 }, displays))
  assert.ok(workflowGameBlockReason({ ...window, notificationState: 4 }, displays))
  assert.ok(workflowGameBlockReason({ ...window, windowStyle: 0, bounds: { left: 0, top: 0, right: 1920, bottom: 1080 } }, displays))
  assert.equal(workflowGameBlockReason({ ...window, notificationState: 5 }, displays), undefined)
  assert.equal(workflowGameBlockReason({ ...window, bounds: { left: -8, top: -8, right: 1928, bottom: 1088 } }, displays), undefined)
})

test('borderless secondary-monitor fullscreen is blocked without blocking ordinary work windows', () => {
  const secondary = [{ x: -2560, y: 0, width: 2560, height: 1440 }]
  assert.ok(workflowGameBlockReason({ ...window, windowStyle: 0, bounds: { left: -2560, top: 0, right: 0, bottom: 1440 } }, secondary))
  assert.equal(workflowGameBlockReason({ ...window, windowStyle: 0 }, displays), undefined)
})
