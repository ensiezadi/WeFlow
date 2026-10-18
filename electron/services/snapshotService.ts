import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { join, isAbsolute, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { snapshotStatus, snapshotEnabled, setSnapshotEnabled, snapshotImage, noteSnapshot } from './snapshotArchive'
import { readWorkflow, editWorkflow, updateWorkflowSettings } from './workflowArchive'
import { snapshotLaunchArguments } from './snapshotLaunch'
import { importDeviceArchive } from './deviceArchiveMigration'
import type { WorkflowEdit, WorkflowSettings } from '../../src/types/workflow'

let watcher: ChildProcess | undefined
let closing = false
let migrationWarning = ''
export function snapshotRoot() {
  const rootIndex = process.argv.indexOf('--snapshot-root')
  if (rootIndex >= 0) {
    const root = process.argv[rootIndex + 1]
    if (!root || !isAbsolute(root)) throw new Error('归档目录必须为绝对路径')
    return root
  }
  return join(app.getPath('userData'), 'device-diary-archive', 'snapshots')
}
export const getSnapshots = async (day?: string) => {
  let status = await snapshotStatus(snapshotRoot(), day)
  if (!day && !status.days.includes(status.day) && status.days[0]) status = await snapshotStatus(snapshotRoot(), status.days[0])
  return { ...status, storagePath: dirname(snapshotRoot()), migrationWarning, workflow: await readWorkflow(snapshotRoot(), status.day) }
}
let settingsQueue: Promise<unknown> = Promise.resolve()
function changeSettings<T>(action: () => Promise<T>) {
  const next = settingsQueue.then(() => {
    if (closing) throw new Error('应用正在退出')
    return action()
  })
  settingsQueue = next.catch(() => {})
  return next
}
function agentFile() { return join(app.getAppPath(), app.isPackaged ? 'dist-electron/diary-agent.cjs' : 'local-tools/diary-snapshot-agent.cjs') }
function launch(mode: 'watch' | 'manual') {
  if (process.platform !== 'win32') throw new Error('本地工作流采集当前仅支持 Windows')
  if (!existsSync(agentFile())) throw new Error('缺少采集代理，请重新构建或安装完整版本')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return spawn(process.execPath, snapshotLaunchArguments(app.isPackaged, agentFile(), snapshotRoot(), mode, process.pid), { env, windowsHide: true, stdio: 'ignore' })
}
export async function initializeSnapshots() {
  // Every app session starts paused; installation and app startup never start capture.
  await setSnapshotEnabled(snapshotRoot(), false)
  if (process.argv.includes('--snapshot-root')) return
  const candidates = new Set([join(app.getAppPath(), 'local-diary-archive')])
  let directory = dirname(process.execPath)
  for (let level = 0; level < 3; level++) { candidates.add(join(directory, 'local-diary-archive')); directory = dirname(directory) }
  for (const source of candidates) {
    if (!existsSync(source)) continue
    try { await importDeviceArchive(source, dirname(snapshotRoot())) }
    catch (error) { migrationWarning = `旧记录导入未完成：${error instanceof Error ? error.message : String(error)}` }
  }
}
export const importSavedDeviceArchive = (source: string) => changeSettings(async () => {
  if (await snapshotEnabled(snapshotRoot())) throw new Error('请先停止采集，再导入已有记录')
  const result = await importDeviceArchive(source, dirname(snapshotRoot()))
  migrationWarning = ''
  return result
})
export function shutdownSnapshots() {
  closing = true
  const root = snapshotRoot()
  mkdirSync(root, { recursive: true })
  const file = join(root, 'settings.json')
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {}
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...current, schemaVersion: 1, enabled: false }, null, 2))
  renameSync(temporary, file)
  // The owned agent checks the flag and owner PID separately from its OCR queue.
}
export const saveWorkflowEdit = (day: string, edit: WorkflowEdit) => editWorkflow(snapshotRoot(), day, edit)
export const saveWorkflowSettings = (settings: WorkflowSettings) => changeSettings(() => updateWorkflowSettings(snapshotRoot(), settings))
export const enableSnapshots = (enabled: boolean) => changeSettings(async () => {
  if (!enabled) {
    await setSnapshotEnabled(snapshotRoot(), false)
    const child = watcher
    if (child && child.exitCode === null) await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { child.kill(); resolve() }, 3000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
    })
    return
  }
  await setSnapshotEnabled(snapshotRoot(), true)
  if (closing) { await setSnapshotEnabled(snapshotRoot(), false); return }
  if (watcher && watcher.exitCode === null) return
  try {
    const child = launch('watch')
    watcher = child
    child.once('exit', () => {
      if (watcher === child) {
        watcher = undefined
        if (!closing) void changeSettings(() => setSnapshotEnabled(snapshotRoot(), false)).catch(() => {})
      }
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    const deadline = Date.now() + 8000
    let ready = false
    while (!closing && Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('采集代理在启动时退出，请检查本地日志')
      const status = await readFile(join(snapshotRoot(), 'agent-status.json'), 'utf8').then(text => JSON.parse(text.replace(/^\uFEFF/, '')), () => undefined)
      if (status?.pid === child.pid) { ready = true; break }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    if (!ready) { child.kill(); throw new Error('采集代理启动超时') }
  } catch (error) {
    watcher = undefined
    await setSnapshotEnabled(snapshotRoot(), false)
    throw error
  }
})
export const getSnapshotImage = (day: string, id: string) => snapshotImage(snapshotRoot(), day, id)
export const saveSnapshotNote = (day: string, id: string, note: string) => noteSnapshot(snapshotRoot(), day, id, note)
export async function captureSnapshotNow() {
  if (!await snapshotEnabled(snapshotRoot())) return getSnapshots()
  await new Promise<void>((resolve, reject) => {
    const child = launch('manual')
    const timeout = setTimeout(() => { child.kill(); reject(new Error('截图超时')) }, 30000)
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error(`截图失败（${code}），请查看本地日志`)) })
  })
  return getSnapshots()
}
