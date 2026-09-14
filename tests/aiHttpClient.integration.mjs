import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { build } from 'esbuild'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function runElectron(entry) {
  return new Promise((resolveRun, rejectRun) => {
    const electronBinary = resolve(projectRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    const child = spawn(electronBinary, [entry], {
      cwd: projectRoot,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', rejectRun)
    child.on('exit', (code) => {
      if (code !== 0) {
        rejectRun(new Error(`Electron exited ${code}: ${stderr || stdout}`))
        return
      }
      resolveRun(stdout)
    })
  })
}

test('AI HTTP client uses Electron system proxy for HTTPS requests', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'weflow-ai-http-'))
  const bundledClient = join(scratch, 'aiHttpClient.cjs')
  const runner = join(scratch, 'runner.cjs')

  await build({
    entryPoints: [resolve(projectRoot, 'electron/services/aiHttpClient.ts')],
    outfile: bundledClient,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })

  await writeFile(runner, `
const { app } = require('electron')
const { requestText } = require(${JSON.stringify(bundledClient)})

app.whenReady().then(async () => {
  try {
    const response = await requestText(
      'https://provider.ensiezadi.lol/v1/models',
      { method: 'GET' },
      20000
    )
    process.stdout.write(JSON.stringify({ statusCode: response.statusCode }))
    app.quit()
  } catch (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error))
    app.exit(1)
  }
})
`, 'utf8')

  const stdout = await runElectron(runner)
  assert.equal(JSON.parse(stdout).statusCode, 401)
})

test('AI HTTP client drops manual content length for a JSON POST', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'weflow-ai-http-post-'))
  const bundledClient = join(scratch, 'aiHttpClient.cjs')
  const runner = join(scratch, 'runner.cjs')

  await build({
    entryPoints: [resolve(projectRoot, 'electron/services/aiHttpClient.ts')],
    outfile: bundledClient,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })

  await writeFile(runner, `
const { app } = require('electron')
const { requestText } = require(${JSON.stringify(bundledClient)})

app.whenReady().then(async () => {
  try {
    const body = JSON.stringify({ model: 'MiniMax-M3', messages: [] })
    const response = await requestText(
      'https://provider.ensiezadi.lol/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body))
        },
        body
      },
      20000
    )
    process.stdout.write(JSON.stringify({ statusCode: response.statusCode }))
    app.quit()
  } catch (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error))
    app.exit(1)
  }
})
`, 'utf8')

  const stdout = await runElectron(runner)
  assert.equal(JSON.parse(stdout).statusCode, 401)
})
