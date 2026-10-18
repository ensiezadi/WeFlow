import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

test('Windows OCR reads Chinese and code locally and removes its temporary image', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  await mkdir(resolve('logs'), { recursive: true })
  const scratch = await mkdtemp(resolve('logs/workflow-native-tests-'))
  const fixture = join(scratch, 'fixture.png')
  const script = join(scratch, 'draw.ps1')
  // Synthetic evidence, no live desktop data is read by this test.
  await writeFile(script, '\uFEFF' + `
    Add-Type -AssemblyName System.Drawing
    $image = New-Object System.Drawing.Bitmap(1400, 350)
    $graphics = [System.Drawing.Graphics]::FromImage($image)
    $graphics.Clear([System.Drawing.Color]::White)
    $font = New-Object System.Drawing.Font('Microsoft YaHei', 28)
    $graphics.DrawString('工作流记录 WeFlow snapshot test', $font, [System.Drawing.Brushes]::Black, 25, 25)
    $graphics.DrawString('const workflow = 12345;', $font, [System.Drawing.Brushes]::Black, 25, 110)
    $graphics.DrawString('All 8 tests passed', $font, [System.Drawing.Brushes]::Black, 25, 195)
    $image.Save('${fixture.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
    $font.Dispose(); $graphics.Dispose(); $image.Dispose()
  `)
  const ps = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: 'pipe' })
  let output = ''
  ps.stderr.on('data', chunk => { output += chunk })
  const code = await new Promise((resolve, reject) => { ps.on('error', reject); ps.on('exit', resolve) })
  assert.equal(code, 0, output)
  const compiled = join(scratch, 'ocr.mjs')
  await build({ entryPoints: [resolve('scripts/workflow-ocr.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'esm' })
  const { WorkflowOcr } = await import(pathToFileURL(compiled).href)
  const worker = new WorkflowOcr(resolve('scripts/Read-WorkflowOcr.ps1'), scratch)
  const { readFile } = await import('node:fs/promises')
  try {
    const recognized = await worker.recognize(await readFile(fixture))
    assert.match(recognized.text, /WeFlow/i)
    assert.match(recognized.text, /工\s*作/)
    assert.match(recognized.text, /12345/)
    assert.match(recognized.text, /tests passed/i)
    assert.equal(worker.languages.includes('zh-Hans-CN'), true)
    assert.equal((await readdir(scratch)).some(name => /^ocr-.*\.png$/.test(name)), false)
  } finally { worker.close() }
})
