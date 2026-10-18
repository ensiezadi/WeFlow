import { readdir, readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AutomaticSnapshotReason } from './snapshotTriggers'

export const snapshotPolicy = { intervalMinutes: 10, dailyLimit: 20, maxImageBytes: 200 * 1024, maxStorageBytes: 200 * 1024 * 1024 }
export type SnapshotReason = 'scheduled' | 'manual' | 'workflow' | AutomaticSnapshotReason
export interface SnapshotRecord {
  id: string; at: string; day: string; file: string; bytes: number; width: number; height: number
  fingerprint: number[]; reason: SnapshotReason; note: string
}
export interface SnapshotStatus {
  enabled: boolean; days: string[]; day: string; count: number; usedBytes: number
  records: SnapshotRecord[]; policy: typeof snapshotPolicy; lastCheck?: string; lastResult?: string
  agent?: { heartbeatAt: string; startedAt: string; pid: number; windowEvents: number; ocrState?: string; ocrLanguages?: string[]; lastContextAt?: string; contextResult?: string }
}
export const snapshotDay = (time: number) => new Date(time + 8 * 3600000).toISOString().slice(0, 10)
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
const validId = (value: string) => /^[a-f0-9-]{36}$/.test(value)
async function readJson(file: string) { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) }
async function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' })
  await rename(temp, file)
}
export async function snapshotEnabled(root: string) {
  try { return (await readJson(join(root, 'settings.json'))).enabled === true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
export async function setSnapshotEnabled(root: string, enabled: boolean) {
  await mkdir(root, { recursive: true })
  let current = {}
  try { current = await readJson(join(root, 'settings.json')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await atomicJson(join(root, 'settings.json'), { ...current, schemaVersion: 1, enabled })
}
export async function snapshotStatus(root: string, requestedDay?: string, now = Date.now()): Promise<SnapshotStatus> {
  if (requestedDay && !validDay(requestedDay)) throw new Error('日期格式无效')
  let entries: string[] = []
  try { entries = await readdir(root) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let contextDays: string[] = []
  try { contextDays = (await readdir(join(root, 'context'))).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).map(name => name.slice(0, 10)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const days = [...new Set([...entries.map(String).filter(validDay), ...contextDays])].sort().reverse()
  const day = requestedDay || snapshotDay(now)
  const records: SnapshotRecord[] = []
  let usedBytes = 0
  for (const date of days) {
    let dateFiles: string[] = []
    try { dateFiles = await readdir(join(root, date)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    for (const name of dateFiles) {
      if (/^[a-f0-9-]{36}\.jpg$/.test(name)) usedBytes += (await stat(join(root, date, name))).size
      if (date === day && /^[a-f0-9-]{36}\.json$/.test(name)) {
        const record: SnapshotRecord = await readJson(join(root, date, name))
        if (record.id + '.json' !== name || record.day !== date || record.file !== record.id + '.jpg') throw new Error('截图索引格式错误')
        records.push(record)
      }
    }
  }
  let check: { lastCheck?: string; lastResult?: string } = {}
  try { check = await readJson(join(root, 'last-check.json')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let agent: SnapshotStatus['agent']
  try { agent = await readJson(join(root, 'agent-status.json')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return { enabled: await snapshotEnabled(root), days, day, count: records.length, usedBytes,
    records: records.sort((a, b) => a.at.localeCompare(b.at)), policy: snapshotPolicy, agent, ...check }
}
export function similarSnapshots(previous: number[], next: number[]) {
  if (previous.length !== next.length || !next.length) return false
  let difference = 0, changed = 0
  for (let i = 0; i < next.length; i++) {
    const delta = Math.abs(previous[i] - next[i]); difference += delta
    if (delta > 8) changed++
  }
  return difference / next.length < 3 || changed / next.length < 0.05
}
export async function recordSnapshotCheck(root: string, result: string) {
  await mkdir(root, { recursive: true })
  await atomicJson(join(root, 'last-check.json'), { lastCheck: new Date().toISOString(), lastResult: result })
}
export async function recordSnapshotAgent(root: string, agent: NonNullable<SnapshotStatus['agent']>) {
  await atomicJson(join(root, 'agent-status.json'), agent)
}
export async function latestSnapshot(root: string, current: SnapshotStatus, now = Date.now()) {
  const today = current.records.at(-1)
  if (today) return today
  const previousDay = current.days.find(day => day < current.day)
  return previousDay ? (await snapshotStatus(root, previousDay, now)).records.at(-1) : undefined
}
export async function saveSnapshot(root: string, frame: { jpeg: Buffer; width: number; height: number; fingerprint: number[] }, reason: SnapshotReason, now = Date.now()) {
  const current = await snapshotStatus(root, undefined, now)
  if (!current.enabled) return { saved: false, reason: '采样已暂停' }
  if (current.count >= snapshotPolicy.dailyLimit) return { saved: false, reason: '已达到今天 20 张上限' }
  if (frame.jpeg.length > snapshotPolicy.maxImageBytes) return { saved: false, reason: '压缩后图片仍超过 200 KB，跳过' }
  if (current.usedBytes + frame.jpeg.length > snapshotPolicy.maxStorageBytes) return { saved: false, reason: '已达到 200 MB 空间上限，暂停保存；旧记录保留' }
  const previous = current.records.at(-1)
  if (reason !== 'manual') {
    const latest = await latestSnapshot(root, current, now)
    if (latest && now - Date.parse(latest.at) < snapshotPolicy.intervalMinutes * 60000) return { saved: false, reason: '距离上次记录不足 10 分钟' }
    if (previous && similarSnapshots(previous.fingerprint, frame.fingerprint)) return { saved: false, reason: '画面变化较小，跳过' }
  }
  const id = randomUUID(), day = snapshotDay(now)
  const folder = join(root, day)
  await mkdir(folder, { recursive: true })
  const record: SnapshotRecord = { id, day, at: new Date(now).toISOString(), file: `${id}.jpg`, bytes: frame.jpeg.length,
    width: frame.width, height: frame.height, fingerprint: frame.fingerprint, reason, note: '' }
  await writeFile(join(folder, record.file), frame.jpeg, { flag: 'wx' })
  await atomicJson(join(folder, `${id}.json`), record)
  return { saved: true, reason: '已保存一张瞬时截图', record }
}
export async function snapshotImage(root: string, day: string, id: string) {
  if (!validDay(day) || !validId(id)) throw new Error('截图编号无效')
  const file = join(root, day, `${id}.jpg`)
  if ((await stat(file)).size > snapshotPolicy.maxImageBytes) throw new Error('截图大小异常')
  return `data:image/jpeg;base64,${(await readFile(file)).toString('base64')}`
}
export async function noteSnapshot(root: string, day: string, id: string, note: string) {
  if (!validDay(day) || !validId(id) || typeof note !== 'string' || note.length > 300) throw new Error('补记格式无效，最多 300 字')
  const file = join(root, day, `${id}.json`)
  const record = await readJson(file)
  await atomicJson(file, { ...record, note })
}
