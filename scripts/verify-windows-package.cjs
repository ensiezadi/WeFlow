const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')

async function main() {
  const asar = await import('@electron/asar')
  const root = path.resolve(__dirname, '..')
  const output = path.join(root, 'release-local', 'win-unpacked')
  const archive = path.join(output, 'resources', 'app.asar')
  const packageInfo = JSON.parse(asar.extractFile(archive, 'package.json').toString())
  assert.equal(packageInfo.main, 'dist-electron/bootstrap.cjs')
  assert.ok(packageInfo.localBuild)
  for (const file of ['dist/index.html', 'dist-electron/bootstrap.cjs', 'dist-electron/main.js', 'dist-electron/preload.js', 'dist-electron/diary-agent.cjs']) assert.ok(asar.extractFile(archive, file).length > 0, file)
  const packagedPaths = asar.listPackage(archive)
  assert.equal(packagedPaths.some(file => /^[/\\](local-diary-archive|cache|logs|\.env)([/\\]|$)/.test(file)), false, 'Private runtime data must not be packaged')
  await fs.access(path.join(output, 'resources', 'diary', 'Read-WorkflowOcr.ps1'))
  await fs.mkdir(path.join(root, 'logs'), { recursive: true })
  const scratch = await fs.mkdtemp(path.join(root, 'logs', 'packaged-smoke-'))
  await fs.writeFile(path.join(scratch, 'settings.json'), JSON.stringify({ schemaVersion: 1, enabled: false }))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(path.join(output, 'WeFlow.exe'), ['--diary-agent', '--root', scratch, '--manual'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  child.stdout.on('data', chunk => { text += chunk })
  child.stderr.on('data', chunk => { text += chunk })
  const timeout = setTimeout(() => child.kill(), 20000)
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    assert.equal(code, 0, text)
    assert.match(text, /采样已暂停/)
    const files = await fs.readdir(scratch)
    assert.equal(files.some(file => file.endsWith('.jpg') || file === 'context'), false)
  } finally { clearTimeout(timeout) }
  console.log('Packaged app contains frontend, native agent and OCR helper; paused agent launch passed without capturing the desktop.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
