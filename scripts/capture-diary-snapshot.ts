import { app, desktopCapturer, powerMonitor, screen, type NativeImage } from 'electron'
import { join, resolve } from 'node:path'
import { mkdir, readFile, writeFile, unlink, rename, readdir } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { snapshotEnabled, snapshotStatus, snapshotPolicy, saveSnapshot, recordSnapshotCheck, recordSnapshotAgent, latestSnapshot } from '../electron/services/snapshotArchive'
import type { SnapshotReason } from '../electron/services/snapshotArchive'
import { WorkflowRecorder, workflowPolicy, workflowSettings, workflowSourceAllowed } from '../electron/services/workflowArchive'
import { WorkflowCadence, workflowFrameChanged, workflowCaptureRegion } from '../electron/services/workflowSampling'
import { watchForeground } from './snapshot-foreground'
import { WorkflowOcr } from './workflow-ocr'
import { workflowGameBlockReason } from '../electron/services/workflowGameGuard'

const args = process.argv.slice(1)
const rootArg = args.indexOf('--root')
if (rootArg < 0 || !args[rootArg + 1]) throw new Error('Missing --root')
const root = resolve(args[rootArg + 1])
const manual = args.includes('--manual')
const watching = args.includes('--watch') && !manual
const ownerIndex = args.indexOf('--owner-pid')
const ownerPid = ownerIndex >= 0 ? Number(args[ownerIndex + 1]) : undefined
if (ownerPid !== undefined && (!Number.isSafeInteger(ownerPid) || ownerPid < 1)) throw new Error('Invalid owner process')
const runtime = join(root, 'agent-runtime')
mkdirSync(runtime, { recursive: true })
app.setPath('userData', runtime)

type CaptureResult = { success: boolean; result: string }
type Foreground = NonNullable<ReturnType<ReturnType<typeof watchForeground>['context']>>
let locked = false
let suspended = false
let queue = Promise.resolve()
let lastSavedAt: number | undefined
let foreground: ReturnType<typeof watchForeground>
let windowEvents = 0
let invalidate = () => {}
const sourceKey = (source: Foreground) => `${source.windowId}\n${source.app}\n${source.title}\n${JSON.stringify(source.bounds)}`
const active = () => !locked && !suspended && powerMonitor.getSystemIdleState(300) !== 'locked'
let gameQuietUntil = 0
function gameBlockReason(source: Foreground) {
  const reason = workflowGameBlockReason(source, screen.getAllDisplays().map(display => screen.dipToScreenRect(null, display.bounds)))
  if (reason) gameQuietUntil = Date.now() + 60000
  return reason || (Date.now() < gameQuietUntil ? '游戏结束后缓冲 1 分钟，暂不采集' : undefined)
}

function fingerprint(image: NativeImage, width = 64, height = 36) {
  const bitmap = image.resize({ width, height }).toBitmap()
  const values: number[] = []
  for (let i = 0; i < bitmap.length; i += 4) values.push(Math.round((bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3))
  return values
}
async function readFrame(source: Foreground) {
  const displays = screen.getAllDisplays().map(display => ({ display, physical: screen.dipToScreenRect(null, display.bounds) }))
  const overlap = (bounds: { x: number; y: number; width: number; height: number }) => Math.max(0, Math.min(source.bounds.right, bounds.x + bounds.width) - Math.max(source.bounds.left, bounds.x)) * Math.max(0, Math.min(source.bounds.bottom, bounds.y + bounds.height) - Math.max(source.bounds.top, bounds.y))
  const targetDisplay = displays.sort((a, b) => overlap(b.physical) - overlap(a.physical))[0]
  if (!targetDisplay || !overlap(targetDisplay.physical)) throw new Error('前台窗口不在可见屏幕范围内')
  let timeout: ReturnType<typeof setTimeout> | undefined
  const sources = await Promise.race([
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 2400, height: 2400 }, fetchWindowIcons: false }),
    new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('获取窗口画面超时')), 15000) })
  ]).finally(() => clearTimeout(timeout))
  const target = sources.find(item => item.display_id === String(targetDisplay.display.id))
  if (!target || target.thumbnail.isEmpty()) throw new Error('无法获取前台窗口所在屏幕')
  const crop = workflowCaptureRegion(source.bounds, targetDisplay.physical, target.thumbnail.getSize())
  if (!crop) throw new Error('前台窗口没有可见区域')
  return target.thumbnail.crop(crop)
}
function compressedFrame(original: NativeImage) {
  let image = original
  const size = image.getSize()
  if (Math.max(size.width, size.height) > 1600) image = image.resize(size.width >= size.height ? { width: 1600 } : { height: 1600 })
  const pixels = fingerprint(image)
  let jpeg = image.toJPEG(60)
  if (jpeg.length > snapshotPolicy.maxImageBytes) jpeg = image.toJPEG(40)
  for (const edge of [1280, 960]) {
    if (jpeg.length <= snapshotPolicy.maxImageBytes) break
    const size = image.getSize()
    image = image.resize(size.width >= size.height ? { width: edge } : { height: edge })
    jpeg = image.toJPEG(40)
  }
  return { jpeg, fingerprint: pixels, ...image.getSize() }
}
async function allowed(source: Foreground, includeIdle = true) {
  return !gameBlockReason(source) && active() && (!includeIdle || powerMonitor.getSystemIdleTime() < workflowPolicy.idleSeconds) &&
    await snapshotEnabled(root) && workflowSourceAllowed(source, { ...await workflowSettings(root), contextEnabled: true })
}
async function capture(reason: SnapshotReason): Promise<CaptureResult> {
  try {
    let result = '采样已暂停'
    if (await snapshotEnabled(root)) {
      const source = foreground.context()
      if (!source || !await allowed(source, reason !== 'manual')) result = '窗口被排除、锁屏或闲置，跳过'
      else {
        const version = windowEvents
        const image = await readFrame(source)
        const current = foreground.context()
        if (!current || sourceKey(current) !== sourceKey(source) || windowEvents !== version || !await allowed(current, reason !== 'manual')) result = '窗口或采集设置已变化，取消这次记录'
        else {
          const saved = await saveSnapshot(root, compressedFrame(image), reason)
          if (saved.saved && saved.record) lastSavedAt = Date.parse(saved.record.at)
          result = saved.reason
        }
      }
    }
    await recordSnapshotCheck(root, result)
    return { success: true, result }
  } catch (error) {
    const result = `采样失败：${error instanceof Error ? error.message : String(error)}`
    await recordSnapshotCheck(root, result)
    return { success: false, result }
  }
}
function enqueue(action: () => Promise<void>) {
  queue = queue.then(action).catch(error => { console.error(error); app.exit(1) })
  return queue
}
function responsePath(id: string) { return join(runtime, `response-${id}.json`) }

app.whenReady().then(async () => {
  await mkdir(root, { recursive: true })
  const requestId = randomUUID()
  const request = watching ? {} : { requestId, reason: manual ? 'manual' : 'scheduled' }
  if (!app.requestSingleInstanceLock(request)) {
    if (watching) { app.quit(); return }
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      try {
        const result: CaptureResult = JSON.parse(await readFile(responsePath(requestId), 'utf8'))
        await unlink(responsePath(requestId))
        console.log(JSON.stringify(result))
        app.exit(result.success ? 0 : 1)
        return
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('后台截图代理响应超时')
  }
  foreground = watchForeground(() => { windowEvents++; invalidate() })
  for (const file of await readdir(runtime)) if (/^ocr-[a-f0-9-]{36}\.png$/.test(file)) await unlink(join(runtime, file))
  app.on('will-quit', () => foreground.close())
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    const incoming = data as { requestId?: string; reason?: string }
    if (!incoming || !/^[a-f0-9-]{36}$/.test(incoming.requestId ?? '') || !['manual', 'scheduled'].includes(incoming.reason ?? '')) return
    void enqueue(async () => {
      const result = await capture(incoming.reason as SnapshotReason)
      const destination = responsePath(incoming.requestId!)
      await writeFile(destination + '.tmp', JSON.stringify(result), { flag: 'wx' })
      await rename(destination + '.tmp', destination)
    })
  })
  if (!watching) {
    const timeout = setTimeout(() => app.exit(1), 25000)
    let result: CaptureResult = { success: false, result: '尚未截图' }
    await enqueue(async () => { result = await capture(manual ? 'manual' : 'scheduled') })
    while (true) { const pending = queue; await pending; if (pending === queue) break }
    clearTimeout(timeout)
    console.log(JSON.stringify(result))
    app.exit(result.success ? 0 : 1)
    return
  }

  const cadence = new WorkflowCadence()
  const recorder = new WorkflowRecorder(root)
  const ocr = new WorkflowOcr(app.isPackaged ? join(process.resourcesPath, 'diary', 'Read-WorkflowOcr.ps1') : join(__dirname, 'diary-workflow-ocr.ps1'), runtime)
  const initial = await snapshotStatus(root)
  const previous = await latestSnapshot(root, initial)
  if (previous) lastSavedAt = Date.parse(previous.at)
  const startedAt = new Date().toISOString()
  let cached: { key: string; pixels: number[]; text: string; language: string; at: number } | undefined
  let ocrState = '等待采集'
  let lastContextAt: string | undefined
  let contextResult = '等待窗口稳定 3 秒'
  let heartbeatAt = 0
  let retryAt = 0
  invalidate = () => { cadence.invalidate(); cached = undefined; recorder.breakContinuity() }
  const interrupt = () => { invalidate(); ocrState = '已暂停' }
  powerMonitor.on('lock-screen', () => { locked = true; interrupt() })
  powerMonitor.on('unlock-screen', () => { locked = false; interrupt() })
  powerMonitor.on('suspend', () => { suspended = true; interrupt() })
  powerMonitor.on('resume', () => { suspended = false; interrupt() })

  async function collect(source: Foreground) {
    const version = windowEvents
    const key = sourceKey(source)
    const image = await readFrame(source)
    const pixels = fingerprint(image, 192, 108)
    let recognized: { text: string; language: string }
    const now = Date.now()
    if (cached?.key === key && now - cached.at < 60000 && !workflowFrameChanged(cached.pixels, pixels)) recognized = cached
    else { ocrState = '正在识别'; recognized = await ocr.recognize(image.toPNG()) }
    const current = foreground.context()
    const settings = await workflowSettings(root)
    if (!current || sourceKey(current) !== key || version !== windowEvents || !await allowed(current) || !settings.contextEnabled) {
      contextResult = '窗口或采集设置已变化，已丢弃这次上下文'
      invalidate()
      return
    }
    if (recognized !== cached) cached = { ...recognized, pixels, key, at: now }
    let imageId: string | undefined
    let imageAt: string | undefined
    if (lastSavedAt === undefined || now - lastSavedAt >= snapshotPolicy.intervalMinutes * 60000) {
      const saved = await saveSnapshot(root, compressedFrame(image), 'workflow')
      if (saved.saved && saved.record) { imageId = saved.record.id; imageAt = saved.record.at; lastSavedAt = Date.parse(saved.record.at) }
    }
    const result = await recorder.record(source, recognized.text, recognized.language, now, imageId, imageAt)
    ocrState = '就绪'
    lastContextAt = new Date(now).toISOString()
    contextResult = result.reason
  }
  let ticking = false
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      await enqueue(async () => {
        const now = Date.now()
        const settings = await workflowSettings(root)
        const source = foreground.context()
        const available = !!source && settings.contextEnabled && await allowed(source)
        if (!available) {
          invalidate()
          ocr.close()
          ocrState = '已暂停'
          contextResult = source && gameBlockReason(source) || '采集关闭、窗口被排除、锁屏或闲置'
        }
        if (source && cadence.observe(sourceKey(source), available, now) && now >= retryAt) {
          try { await collect(source) }
          catch (error) {
            ocrState = '识别异常'
            contextResult = error instanceof Error ? error.message : String(error)
            retryAt = Date.now() + 30000
            invalidate()
          }
        }
        if (Date.now() - heartbeatAt >= 5000) {
          heartbeatAt = Date.now()
          await recordSnapshotAgent(root, { startedAt, heartbeatAt: new Date().toISOString(), pid: process.pid, windowEvents, ocrState, ocrLanguages: ocr.languages, lastContextAt, contextResult })
        }
      })
    } finally { ticking = false }
  }
  await recordSnapshotCheck(root, '工作流监听已启动：窗口稳定 3 秒后采集，持续使用每 15 秒检查')
  const timer = setInterval(() => void tick(), 1000)
  let checkingOwner = false
  const ownerTimer = ownerPid === undefined ? undefined : setInterval(async () => {
    if (checkingOwner) return
    checkingOwner = true
    try {
      try { process.kill(ownerPid, 0) } catch { app.quit(); return }
      if (!await snapshotEnabled(root)) app.quit()
    } finally { checkingOwner = false }
  }, 500)
  app.on('will-quit', () => { clearInterval(timer); clearInterval(ownerTimer); ocr.close() })
  await tick()
  console.log(JSON.stringify({ watching: true, workflow: true, pid: process.pid }))
}).catch(error => { console.error(error); app.exit(1) })
