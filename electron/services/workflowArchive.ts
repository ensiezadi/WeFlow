import { appendFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorkflowEvidence, WorkflowSource, WorkflowSettings, WorkflowView, WorkflowSession, WorkflowEdit } from '../../src/types/workflow'

export const workflowPolicy = { settleMs: 3000, sampleMs: 15000, idleSeconds: 300, maxText: 6000, dailyBytes: 8 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 }
export const defaultWorkflowSettings: WorkflowSettings = {
  contextEnabled: true,
  deniedApps: ['1password.exe', 'bitwarden.exe', 'keepass.exe', 'keepassxc.exe', 'credentialuibroker.exe', 'lockapp.exe', 'logonui.exe', 'darksoulsiii.exe'],
  deniedTitles: ['InPrivate', 'Incognito', '无痕', '隐私浏览']
}
const validDay = (day: string) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
const validId = (id: string) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)
export const workflowDay = (now: number) => new Date(now + 8 * 3600000).toISOString().slice(0, 10)
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()
const canonicalText = (text: string) => text.replace(/\s+/g, ' ').trim()
async function json(file: string, fallback: any) {
  try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error }
}
async function atomic(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2))
  await rename(temp, file)
}
export async function workflowSettings(root: string): Promise<WorkflowSettings> {
  const data = await json(join(root, 'settings.json'), {})
  return {
    contextEnabled: data.contextEnabled !== false,
    deniedApps: Array.isArray(data.deniedApps) ? data.deniedApps.filter((s: unknown) => typeof s === 'string') : [...defaultWorkflowSettings.deniedApps],
    deniedTitles: Array.isArray(data.deniedTitles) ? data.deniedTitles.filter((s: unknown) => typeof s === 'string') : [...defaultWorkflowSettings.deniedTitles]
  }
}
export async function updateWorkflowSettings(root: string, settings: WorkflowSettings) {
  if (!settings || typeof settings.contextEnabled !== 'boolean') throw new Error('工作记录设置无效')
  for (const list of [settings.deniedApps, settings.deniedTitles]) {
    if (!Array.isArray(list) || list.length > 100 || list.some(s => typeof s !== 'string' || s.length > 200)) throw new Error('排除规则无效，最多 100 条，每条 200 字')
  }
  await mkdir(root, { recursive: true })
  await atomic(join(root, 'settings.json'), { ...await json(join(root, 'settings.json'), {}), contextEnabled: settings.contextEnabled, deniedApps: settings.deniedApps, deniedTitles: settings.deniedTitles })
}
export function workflowSourceAllowed(source: WorkflowSource, settings: WorkflowSettings) {
  return settings.contextEnabled && !!source.app && !settings.deniedApps.some(app => normalize(app) === normalize(source.app)) &&
    !settings.deniedTitles.some(title => title.trim() && normalize(source.title).includes(normalize(title)))
}
export async function workflowUsage(root: string) {
  let files: string[]
  try { files = await readdir(join(root, 'context')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error }
  let total = 0
  for (const file of files.filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))) total += (await stat(join(root, 'context', file))).size
  return total
}
export async function readWorkflowEvents(root: string, day: string) {
  if (!validDay(day)) throw new Error('日期格式无效')
  const events: WorkflowEvidence[] = []
  let content: string
  try {
    const file = join(root, 'context', `${day}.jsonl`)
    if ((await stat(file)).size > workflowPolicy.dailyBytes) throw new Error('当天文字归档过大')
    content = await readFile(file, 'utf8')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return events; throw error }
  // An appending writer may be halfway through its final line. Only parse complete lines.
  for (const line of content.split('\n').slice(0, -1)) {
    if (!line.trim()) continue
    const value = JSON.parse(line)
    if (value.kind === 'seen') {
      const last = events.at(-1)
      if (last && last.id === value.id && typeof value.at === 'string' && value.at >= last.until) last.until = value.at
      if (last && last.id === value.id && validId(value.imageId)) { last.imageId = value.imageId; last.imageAt = String(value.imageAt ?? value.at) }
    } else if (value.kind === 'evidence' && validId(value.id) && typeof value.text === 'string' && typeof value.at === 'string') {
      events.push({ id: value.id, at: value.at, until: value.at, app: String(value.app), title: String(value.title), text: value.text, addedText: String(value.addedText ?? ''), language: String(value.language ?? ''), imageId: validId(value.imageId ?? '') ? value.imageId : undefined, imageAt: typeof value.imageAt === 'string' ? value.imageAt : undefined })
    }
  }
  return events
}
const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
export function workflowTextDelta(previous: string, current: string) {
  const old = new Set(lines(previous).map(canonicalText))
  return lines(current).filter(line => !old.has(canonicalText(line))).join('\n').slice(0, workflowPolicy.maxText)
}
function nearIdentical(previous: string, current: string) {
  return canonicalText(previous) === canonicalText(current)
}

export class WorkflowRecorder {
  private day = ''
  private last: WorkflowEvidence | undefined
  private previousTexts = new Map<string, string>()
  private lastWrittenSeen = 0
  private interrupted = false
  constructor(private root: string) {}
  breakContinuity() { this.last = undefined; this.interrupted = true }

  async record(source: WorkflowSource, text: string, language: string, now: number, imageId?: string, imageAt?: string) {
    const day = workflowDay(now)
    if (this.day !== day) {
      const file = join(this.root, 'context', `${day}.jsonl`)
      try {
        if ((await stat(file)).size > workflowPolicy.dailyBytes) throw new Error('当天文字归档过大')
        const buffer = await readFile(file)
        const complete = buffer.lastIndexOf(10) + 1
        if (complete < buffer.length) {
          const handle = await open(file, 'r+')
          try { await handle.truncate(complete) } finally { await handle.close() }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const existing = await readWorkflowEvents(this.root, day)
      this.last = this.interrupted ? undefined : existing.at(-1)
      this.previousTexts.clear()
      for (const event of existing.slice(-32)) this.previousTexts.set(`${event.app}\n${event.title}`, event.text)
      this.day = day
    }
    const at = new Date(now).toISOString()
    const clean = { app: source.app.slice(0, 200), title: source.title.slice(0, 500) }
    text = text.replace(/\u0000/g, '').replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '$1').trim().slice(0, workflowPolicy.maxText)
    const same = this.last && this.last.app === clean.app && this.last.title === clean.title && now - Date.parse(this.last.until) <= 60000 && nearIdentical(this.last.text, text)
    if (same && !imageId && now - this.lastWrittenSeen < 15000) return { added: false, reason: '重复文字已合并' }
    const key = `${clean.app}\n${clean.title}`
    const evidence: WorkflowEvidence = { ...clean, id: randomUUID(), at, until: at, text, addedText: workflowTextDelta(this.previousTexts.get(key) ?? '', text), language, imageId, imageAt: imageId ? imageAt ?? at : undefined }
    const value = same ? { kind: 'seen', id: this.last!.id, at, imageId, imageAt: evidence.imageAt } : { kind: 'evidence', ...evidence }
    const encoded = JSON.stringify(value) + '\n'
    const bytes = Buffer.byteLength(encoded)
    await mkdir(join(this.root, 'context'), { recursive: true })
    const file = join(this.root, 'context', `${day}.jsonl`)
    const currentBytes = await stat(file).then(info => info.size, error => { if (error.code === 'ENOENT') return 0; throw error })
    if (currentBytes + bytes > workflowPolicy.dailyBytes || await workflowUsage(this.root) + bytes > workflowPolicy.totalBytes) return { added: false, reason: '文字归档达到空间上限，已暂停写入' }
    await appendFile(file, encoded, 'utf8')
    this.interrupted = false
    this.lastWrittenSeen = now
    if (same) this.last!.until = at
    else {
      this.last = evidence
      this.previousTexts.delete(key)
      this.previousTexts.set(key, text)
      if (this.previousTexts.size > 32) this.previousTexts.delete(this.previousTexts.keys().next().value!)
    }
    return { added: !same, reason: same ? '重复文字已合并' : '已记录一条工作上下文' }
  }
}

const stopWords = new Set('https http www com html chrome microsoft windows google browser electron powershell terminal title document untitled localhost'.split(' '))
function keywords(event: WorkflowEvidence) {
  return new Set((event.title + '\n' + event.text.slice(0, 3000)).toLowerCase().match(/[a-z][a-z0-9_.-]{3,}|[\u4e00-\u9fff]{2,12}/g)?.filter(word => !stopWords.has(word)).slice(0, 300) ?? [])
}
interface Edits { titles: Record<string, string>; breaks: string[]; joins: string[] }
const emptyEdits = (): Edits => ({ titles: {}, breaks: [], joins: [] })
export function groupWorkflow(events: WorkflowEvidence[], edits: Edits = emptyEdits()) {
  const sessions: WorkflowSession[] = []
  for (const event of events) {
    const previous = sessions.at(-1)
    const last = previous?.evidence.at(-1)
    const candidate = keywords(event)
    const recentKeywords = new Set(previous?.evidence.slice(-8).flatMap(item => [...keywords(item)]) ?? [])
    const common = [...candidate].filter(word => recentKeywords.has(word))
    const related = !!last && (event.app === last.app && event.title === last.title || common.length >= 2 || common.some(word => word.length >= 7))
    const continuous = !!previous && Date.parse(event.at) - Date.parse(previous.end) <= 5 * 60000 && Date.parse(event.at) - Date.parse(previous.start) < 30 * 60000
    const merge = previous && !edits.breaks.includes(event.id) && (edits.joins.includes(event.id) || continuous && related)
    if (merge) {
      previous.evidence.push(event)
      previous.end = event.until
      if (!previous.apps.includes(event.app)) previous.apps.push(event.app)
    } else sessions.push({ id: event.id, title: edits.titles[event.id] || (event.title || event.app).slice(0, 200), start: event.at, end: event.until, apps: [event.app], evidence: [event] })
  }
  return sessions
}
export async function readWorkflow(root: string, day: string): Promise<WorkflowView> {
  const events = await readWorkflowEvents(root, day)
  const edits: Edits = await json(join(root, 'context', `${day}.edits.json`), emptyEdits())
  return { events, sessions: groupWorkflow(events, edits), settings: await workflowSettings(root), usedBytes: await workflowUsage(root) }
}
export async function editWorkflow(root: string, day: string, edit: WorkflowEdit) {
  if (!validDay(day) || !edit || !validId(edit.id)) throw new Error('工作片段编号无效')
  const events = await readWorkflowEvents(root, day)
  if (!events.some(event => event.id === edit.id)) throw new Error('工作片段不存在')
  const file = join(root, 'context', `${day}.edits.json`)
  const edits: Edits = await json(file, emptyEdits())
  if (edit.kind === 'rename') {
    if (typeof edit.title !== 'string' || !edit.title.trim() || edit.title.length > 200) throw new Error('标题需为 1–200 字')
    edits.titles[edit.id] = edit.title.trim()
  } else if (edit.kind === 'split') {
    edits.joins = edits.joins.filter(id => id !== edit.id)
    if (!edits.breaks.includes(edit.id)) edits.breaks.push(edit.id)
  } else if (edit.kind === 'merge') {
    edits.breaks = edits.breaks.filter(id => id !== edit.id)
    if (!edits.joins.includes(edit.id)) edits.joins.push(edit.id)
  } else throw new Error('编辑操作无效')
  await atomic(file, edits)
}
