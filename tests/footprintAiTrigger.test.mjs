import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function loadTriggerModule() {
  const scratch = await mkdtemp(join(tmpdir(), 'weflow-footprint-trigger-'))
  const outfile = join(scratch, 'footprintAiTrigger.mjs')

  await build({
    entryPoints: [resolve(projectRoot, 'src/utils/footprintAiTrigger.ts')],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'esm'
  })

  return import(pathToFileURL(outfile).href)
}

test('settings shortcut creates an explicit one-shot AI summary route', async () => {
  const { buildFootprintAiTriggerPath } = await loadTriggerModule()
  assert.equal(buildFootprintAiTriggerPath(), '/footprint?generateAi=1')
})

test('AI summary auto-trigger only accepts the explicit query value', async () => {
  const { shouldAutoGenerateFootprintAi } = await loadTriggerModule()
  assert.equal(shouldAutoGenerateFootprintAi('?generateAi=1'), true)
  assert.equal(shouldAutoGenerateFootprintAi('?generateAi=0'), false)
  assert.equal(shouldAutoGenerateFootprintAi(''), false)
})
