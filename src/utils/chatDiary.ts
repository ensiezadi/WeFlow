export interface DiaryMessage {
  evidenceId: string
  sessionId: string
  sessionName: string
  isGroup: boolean
  senderId: string
  senderName: string
  timestamp: number
  day: string
  time: string
  content: string
  type: string
  platformId: string
  replyTo: string
  sourceFile: string
}

export interface DiaryArchive {
  messages: DiaryMessage[]
  people: Array<{ id: string; name: string; count: number }>
  days: string[]
  warnings: string[]
  files: number
}

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function shanghaiDate(timestamp: number): { day: string; time: string } {
  const date = new Date((timestamp + 8 * 3600) * 1000)
  const iso = date.toISOString()
  return { day: iso.slice(0, 10), time: iso.slice(11, 16) }
}

/** Accept only the two documented WeFlow JSON exports; never infer identity from names. */
export function importDiaryFiles(files: Array<{ name: string; content: string }>): DiaryArchive {
  const messages: DiaryMessage[] = []
  const warnings: string[] = []
  const documents = new Set<string>()
  const stableMessages = new Map<string, DiaryMessage>()
  let importedFiles = 0
  let missingIds = 0
  for (const file of files) {
    if (documents.has(file.content)) { warnings.push(`${file.name}：文件内容重复，已跳过。`); continue }
    let parsed: unknown
    try { parsed = JSON.parse(file.content) } catch { warnings.push(`${file.name}：JSON 无法解析，未导入。`); continue }
    const data = object(parsed)
    const session = object(data.session)
    const sessionId = text(session.wxid)
    if (!sessionId || !Array.isArray(data.messages)) {
      warnings.push(`${file.name}：需要 WeFlow 的 JSON 或 Arkme JSON 导出（包含 session.wxid 和 messages）。`)
      continue
    }
    if (messages.length + data.messages.length > 200000) throw new Error('本次导入超过 20 万条消息，请按月份分批导入。')
    documents.add(file.content)
    importedFiles++
    const senders = new Map<string, Record<string, unknown>>()
    if (Array.isArray(data.senders)) for (const value of data.senders) {
      const sender = object(value)
      senders.set(text(sender.senderID), sender)
    }
    let invalid = 0
    for (const value of data.messages) {
      const raw = object(value)
      const sender = senders.get(text(raw.senderID)) || {}
      const senderId = text(raw.senderUsername) || text(sender.wxid)
      let timestamp = Number(raw.createTime)
      if (timestamp > 1e12) timestamp /= 1000
      if (!senderId || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 253402271999) { invalid++; continue }
      const date = shanghaiDate(timestamp)
      const rawId = text(raw.platformMessageId) || text(raw.serverId)
      const platformId = rawId === '0' ? '' : rawId
      const message: DiaryMessage = {
        evidenceId: '', sessionId,
        sessionName: text(session.displayName) || text(session.nickname) || sessionId,
        isGroup: sessionId.endsWith('@chatroom'), senderId,
        senderName: text(raw.senderDisplayName) || text(sender.displayName) || text(sender.nickname) || senderId,
        timestamp, ...date,
        content: text(raw.content) || (text(raw.emojiCaption) ? `[表情] ${text(raw.emojiCaption)}` : `[${text(raw.type) || '非文字消息'}]`),
        type: text(raw.type), platformId, replyTo: text(raw.replyToMessageId), sourceFile: file.name
      }
      // Export localId is an ordinal, not a stable database identity.
      const key = platformId ? JSON.stringify([sessionId, platformId]) : ''
      if (key && stableMessages.has(key)) {
        const previous = stableMessages.get(key)!
        if (previous.content !== message.content || previous.senderId !== senderId || previous.timestamp !== timestamp) {
          warnings.push(`${file.name}：同一消息 ID 存在不同版本，保留先导入的版本。`)
        }
        continue
      }
      if (key) stableMessages.set(key, message)
      else missingIds++
      messages.push(message)
    }
    if (invalid) warnings.push(`${file.name}：${invalid} 条消息缺少人物 ID 或有效时间，未纳入日记。`)
  }
  messages.sort((a, b) => a.timestamp - b.timestamp || a.sessionId.localeCompare(b.sessionId))
  const people = new Map<string, { id: string; name: string; count: number }>()
  messages.forEach((message, index) => {
    message.evidenceId = `M${String(index + 1).padStart(6, '0')}`
    const person = people.get(message.senderId) || { id: message.senderId, name: message.senderName, count: 0 }
    person.count++
    people.set(message.senderId, person)
  })
  if (missingIds) warnings.push(`${missingIds} 条消息没有稳定消息 ID，已保留原记录；重叠导出可能重复，请勿重复导入同一时间段。`)
  return {
    messages, people: [...people.values()].sort((a, b) => b.count - a.count),
    days: [...new Set(messages.map(message => message.day))].sort().reverse(),
    warnings: [...new Set(warnings)], files: importedFiles
  }
}

export function buildDailyDiary(archive: DiaryArchive, day: string, personIds: string[] = [], keyword = '') {
  const people = new Set(personIds)
  const query = keyword.trim().toLocaleLowerCase()
  const messages = archive.messages.filter(message => message.day === day &&
    (!people.size || people.has(message.senderId)) &&
    (!query || message.content.toLocaleLowerCase().includes(query)))
  const sessions = new Map<string, { id: string; name: string; messages: DiaryMessage[] }>()
  const involved = new Map<string, string>()
  const appearances = new Map<string, Map<string, string>>()
  for (const message of messages) {
    const session = sessions.get(message.sessionId) || { id: message.sessionId, name: message.sessionName, messages: [] }
    session.messages.push(message)
    sessions.set(session.id, session)
    involved.set(message.senderId, message.senderName)
    const personSessions = appearances.get(message.senderId) || new Map<string, string>()
    personSessions.set(message.sessionId, message.sessionName)
    appearances.set(message.senderId, personSessions)
  }
  const visible = new Set(messages.map(message => message.evidenceId))
  const originals = new Map(archive.messages.filter(message => message.platformId)
    .map(message => [JSON.stringify([message.sessionId, message.platformId]), message]))
  const replies = messages.flatMap(message => {
    const original = message.replyTo && originals.get(JSON.stringify([message.sessionId, message.replyTo]))
    return original && original.senderId !== message.senderId
      ? [{ from: message, to: original, originalOutsideFilter: !visible.has(original.evidenceId) }]
      : []
  })
  const names = [...involved.values()]
  const summary = messages.length
    ? `这一天，导入的聊天记录中出现了 ${names.slice(0, 8).join('、')}${names.length > 8 ? `等 ${names.length} 人` : ''}。在当前筛选范围内，共留下 ${messages.length} 条消息，分布在 ${sessions.size} 个会话中。`
    : '当前日期和筛选条件下没有聊天记录。'
  return { day, summary, messages, sessions: [...sessions.values()], replies,
    crossSessionPeople: [...involved].flatMap(([id, name]) => {
      const personSessions = [...(appearances.get(id)?.values() || [])]
      return personSessions.length > 1 ? [{ id, name, sessions: personSessions }] : []
    }),
    people: [...involved].map(([id, name]) => ({ id, name })),
    filter: { personIds, keyword: keyword.trim() }, timezone: 'Asia/Shanghai' as const
  }
}

const mdText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}\[\]#!|]/g, '\\$&').replace(/\r?\n/g, ' ')

export function diaryMarkdown(diary: ReturnType<typeof buildDailyDiary>, note = ''): string {
  const lines = [`# ${diary.day} · 聊天日记`, '', mdText(diary.summary), '',
    '> 根据本地导入记录整理的事实摘录，未调用 AI；不代表当天全部经历，也不推断人物的真实关系或情绪。日期按北京时间划分。', '']
  if (note.trim()) lines.push('## 我的补记', '', note.trim(), '')
  for (const session of diary.sessions) {
    lines.push(`## ${mdText(session.name)}`, '')
    const excerpts = session.messages.filter(message => !message.content.startsWith('[')).slice(0, 6)
    const selected = excerpts.length ? excerpts : session.messages.slice(0, 3)
    for (const message of selected) lines.push(`- ${message.time}，${mdText(message.senderName)}：${mdText(message.content.slice(0, 240))}${message.content.length > 240 ? '…' : ''} [${message.evidenceId}]`)
    if (session.messages.length > selected.length) lines.push(`- 此会话另有 ${session.messages.length - selected.length} 条记录，完整原文见证据记录。`)
    lines.push('')
  }
  if (diary.crossSessionPeople.length) {
    lines.push('## 人物与会话的联系', '')
    for (const person of diary.crossSessionPeople) lines.push(`- ${mdText(person.name)} 在 ${person.sessions.map(mdText).join('、')} 中均有发言记录。`)
    lines.push('')
  }
  if (diary.replies.length) {
    lines.push('## 可核对的回复', '')
    for (const reply of diary.replies.slice(0, 30)) lines.push(`- ${reply.from.time}，${mdText(reply.from.senderName)} 引用了 ${mdText(reply.to.senderName)} 的消息。[${reply.from.evidenceId}] → [${reply.to.evidenceId}]${reply.originalOutsideFilter ? '（原消息在当天筛选范围外）' : ''}`)
    lines.push('')
  }
  lines.push('## 证据记录', '')
  const evidence = new Map(diary.messages.map(message => [message.evidenceId, message]))
  for (const reply of diary.replies) evidence.set(reply.to.evidenceId, reply.to)
  for (const message of evidence.values()) lines.push(
    `### ${message.evidenceId} · ${message.day} ${message.time}`, '',
    `会话：${mdText(message.sessionName)}；发送者：${mdText(message.senderName)}；来源：${mdText(message.sourceFile)}`, '',
    ...message.content.split(/\r?\n/).map(line => `> ${mdText(line)}`), '')
  return lines.join('\n')
}
