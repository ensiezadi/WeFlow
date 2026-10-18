import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

await mkdir(resolve('logs'), { recursive: true })
const scratch = await mkdtemp(resolve('logs/package-tests-'))
const launchModule = join(scratch, 'launch.mjs')
await build({ entryPoints: [resolve('electron/services/snapshotLaunch.ts')], outfile: launchModule, bundle: true, platform: 'node', format: 'esm' })
const { snapshotLaunchArguments } = await import(pathToFileURL(launchModule).href)

test('packaged and source agents use distinct entry points and explicit owner lifetime', () => {
  assert.deepEqual(snapshotLaunchArguments(true, 'unused', 'C:\\Archive Folder', 'watch', 123), ['--diary-agent', '--root', 'C:\\Archive Folder', '--watch', '--owner-pid', '123'])
  assert.deepEqual(snapshotLaunchArguments(false, 'C:\\app\\agent.cjs', 'C:\\archive', 'manual'), ['C:\\app\\agent.cjs', '--root', 'C:\\archive', '--manual'])
  assert.equal(snapshotLaunchArguments(true, 'unused', 'C:\\archive', 'manual').includes('--owner-pid'), false)
})

test('bootstrap dispatches agent before normal app initialization and disables updates for local builds', async () => {
  const bootstrap = await readFile(resolve('electron/bootstrap.cjs'), 'utf8')
  const loaded = []
  const process = { argv: ['WeFlow.exe', '--diary-agent'], env: {} }
  runInNewContext(bootstrap, { process, require: name => name.endsWith('package.json') ? { localBuild: true } : loaded.push(name) })
  assert.deepEqual(loaded, ['./diary-agent.cjs'])
  assert.equal(process.env.AUTO_UPDATE_ENABLED, 'false')
  loaded.length = 0
  runInNewContext(bootstrap, { process: { argv: ['WeFlow.exe'], env: {} }, require: name => name.endsWith('package.json') ? {} : loaded.push(name) })
  assert.deepEqual(loaded, ['./main.js'])
})

test('app startup and shutdown are paused and preserve exclusions without launching a worker', async () => {
  const root = join(scratch, 'archive')
  await mkdir(root)
  await writeFile(join(root, 'settings.json'), JSON.stringify({ enabled: true, deniedApps: ['game.exe'] }))
  const compiled = join(scratch, 'service.mjs')
  await build({
    entryPoints: [resolve('electron/services/snapshotService.ts')], outfile: compiled, platform: 'node', format: 'esm', bundle: true,
    plugins: [{ name: 'electron-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app = { isPackaged: true, getPath: () => ${JSON.stringify(scratch)}, getAppPath: () => ${JSON.stringify(scratch)} }` }))
    } }]
  })
  const previousArgs = process.argv
  process.argv = [...previousArgs, '--snapshot-root', root]
  try {
    const service = await import(pathToFileURL(compiled).href)
    await service.initializeSnapshots()
    assert.equal(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).enabled, false)
    await service.saveWorkflowSettings({ contextEnabled: true, deniedApps: ['game.exe'], deniedTitles: [] })
    service.shutdownSnapshots()
    const settings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
    assert.equal(settings.enabled, false)
    assert.deepEqual(settings.deniedApps, ['game.exe'])
    await assert.rejects(service.enableSnapshots(true), /正在退出/)
  } finally { process.argv = previousArgs }
})
