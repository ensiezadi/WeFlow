const { spawnSync, execFileSync } = require('node:child_process')
const { readFileSync, writeFileSync, createReadStream, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createHash } = require('node:crypto')
const root = resolve(__dirname, '..')
if (process.platform !== 'win32') throw new Error('Run the Windows local packaging command on Windows')
const original = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '')
const version = original.version.split('-')[0] + '-local.' + stamp
const repair = spawnSync(process.execPath, [join(root, 'scripts/repair-windows-wcdb-expiry.cjs'), '--source-only'], { cwd: root, stdio: 'inherit', windowsHide: true })
if (repair.error) throw repair.error
if (repair.status !== 0) process.exit(repair.status || 1)
const builderArgs = [join(root, 'node_modules/electron-builder/cli.js'), '--win', ...(process.argv.includes('--dir') ? ['--dir'] : ['nsis']), '--x64', '--publish', 'never',
  '--config.electronDist=node_modules/electron/dist', '--config.directories.output=release-local',
  `--config.extraMetadata.version=${version}`, '--config.extraMetadata.localBuild=true', '--config.artifactName=${productName}-${version}-x64-Setup.${ext}']
const result = spawnSync(process.execPath, builderArgs, { cwd: root, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
async function main() {
  let commit = null
  try { commit = execFileSync(process.env.GIT_EXECUTABLE || 'git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim() } catch {}
  const files = []
  for (const name of readdirSync(join(root, 'release-local')).filter(name => /\.(exe|zip)$/.test(name))) {
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of createReadStream(join(root, 'release-local', name))) { hash.update(chunk); bytes += chunk.length }
    files.push({ name, bytes, sha256: hash.digest('hex') })
  }
  writeFileSync(join(root, 'release-local/build-info.json'), JSON.stringify({ version, builtAt: new Date().toISOString(), sourceCommit: commit, platform: process.platform, arch: process.arch, captureDefault: 'off', scheduledTaskInstalled: false, artifacts: files }, null, 2) + '\n')
  console.log(`Windows local build ready: release-local/win-unpacked/WeFlow.exe (${version})`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
