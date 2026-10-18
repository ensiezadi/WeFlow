import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Download, FileJson, FolderOpen, Search, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { buildDailyDiary, diaryMarkdown, type DiaryArchive } from '../utils/chatDiary'
import { diaryExampleFiles } from '../utils/chatDiaryExample'
import SnapshotPanel from '../components/SnapshotPanel'
import './ChatDiaryPage.scss'

export default function ChatDiaryPage() {
  const [archive, setArchive] = useState<DiaryArchive | null>(null)
  const [day, setDay] = useState('')
  const [people, setPeople] = useState<string[]>([])
  const [personSearch, setPersonSearch] = useState('')
  const [keyword, setKeyword] = useState('')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [savedPath, setSavedPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [example, setExample] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [focusedEvidence, setFocusedEvidence] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const worker = useRef<Worker | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; worker.current?.terminate() } }, [])

  const diary = useMemo(() => archive ? buildDailyDiary(archive, day, people, keyword) : null, [archive, day, people, keyword])
  const markdown = useMemo(() => diary ? diaryMarkdown(diary, notes[day] || '') : '', [diary, notes, day])
  const visiblePeople = useMemo(() => archive?.people.filter(person =>
    `${person.name} ${person.id}`.toLocaleLowerCase().includes(personSearch.toLocaleLowerCase())).slice(0, 60) || [], [archive, personSearch])

  async function saveDiary(format: 'md' | 'json') {
    if (!diary || !archive) return
    setSaving(true); setError(''); setSavedPath('')
    try {
      const content = format === 'md' ? markdown : JSON.stringify({ schemaVersion: 1, kind: 'weflow-daily-diary', generatedAt: new Date().toISOString(), mode: 'local-excerpts', diary, note: notes[day] || '', warnings: archive.warnings }, null, 2)
      const result = await window.electronAPI.diary.save({ day, format, content })
      if (result.success) setSavedPath(result.filePath || '')
      else if (!result.canceled) setError(result.error || '日记保存失败')
    } catch (error) { setError(String(error)) }
    finally { setSaving(false) }
  }

  async function importFiles(fileList: FileList | File[] | null, isExample = false) {
    if (!fileList?.length) return
    setError('')
    const files = Array.from(fileList)
    if (files.length > 100 || files.reduce((sum, file) => sum + file.size, 0) > 40 * 1024 * 1024) {
      setError('每次最多导入 100 个文件、总计 40 MB，请按月份分批导入。')
      if (input.current) input.current.value = ''
      return
    }
    setBusy(true)
    worker.current?.terminate()
    try {
      const payload = await Promise.all(files.map(async file => ({ name: file.name, content: await file.text() })))
      if (!mounted.current) return
      const next = new Worker(new URL('../workers/chatDiary.worker.ts', import.meta.url), { type: 'module' })
      worker.current = next
      next.onmessage = (event: MessageEvent<{ archive?: DiaryArchive; error?: string }>) => {
        if (event.data.archive) {
          setArchive(event.data.archive)
          setExample(isExample)
          setDay(event.data.archive.days[0] || '')
          setPeople([])
          setKeyword('')
          setExpanded(false)
        } else setError(event.data.error || '导入失败')
        setBusy(false)
        next.terminate()
      }
      next.onerror = () => { setError('导入任务失败，请缩小文件范围后重试。'); setBusy(false); next.terminate() }
      next.postMessage(payload)
    } catch (error) { setError(String(error)); setBusy(false) }
    finally { if (input.current) input.current.value = '' }
  }

  return <div className="chat-diary-page">
    <header className="diary-header">
      <div><div className="diary-eyebrow"><BookOpen size={16} /> 本地聊天手记</div>
        <h1>把一天的记录，串成一篇日记。</h1>
        <p>从多个会话看见当天的人物与线索，每段摘录都能回查原文。</p></div>
      <button className="diary-button primary" disabled={busy} onClick={() => input.current?.click()}>
        <FolderOpen size={17} />{busy ? '正在整理记录…' : archive ? '重新导入 JSON' : '导入聊天 JSON'}
      </button>
      <input ref={input} type="file" accept=".json,application/json" multiple hidden onChange={event => void importFiles(event.target.files)} />
    </header>
    {error && <p className="diary-error" role="alert">{error}</p>}
    {savedPath && <p className="diary-fact-label" role="status">已保存到：{savedPath}</p>}
    <SnapshotPanel />
    {!archive && <section className="diary-empty">
      <div className="diary-empty-icon"><BookOpen size={36} /></div>
      <h2>一天一页，记录与你有关的人。</h2>
      <p>先在 <Link to="/export">导出</Link> 中选择几个私聊或群聊，使用 JSON 或 Arkme JSON 格式，关闭媒体和头像下载，再同时导入这些文件。</p>
      <div className="diary-steps"><span>01　选择会话</span><span>02　按天整理</span><span>03　补记与保存</span></div>
      <button className="diary-button" disabled={busy} style={{ marginTop: 26 }} onClick={() => void importFiles(diaryExampleFiles(), true)}>先看一篇示例日记</button>
      <small>第一版生成事实摘录，不调用 AI，不上传聊天内容。导入数据仅保留在当前页面内存中，离开前请保存日记。</small>
    </section>}
    {archive && <>
      {example && <p className="diary-fact-label" role="status">正在展示虚构的示例对话，不含你的真实聊天记录。点击「重新导入 JSON」开始整理自己的日记。</p>}
      <div className="diary-stats"><span><strong>{archive.files}</strong> 份会话文件</span><span><strong>{archive.people.length}</strong> 位发言人物</span><span><strong>{archive.messages.length.toLocaleString()}</strong> 条消息</span><span><strong>{archive.days.length}</strong> 个有记录的日子</span></div>
      {archive.warnings.length > 0 && <details className="diary-warnings"><summary>数据检查提示（{archive.warnings.length}）</summary>{archive.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      {archive.days.length === 0 ? <p>没有可用于生成日记的记录，请检查文件和上方提示。</p> : <div className="diary-workspace">
        <aside className="diary-filters">
          <label htmlFor="diary-day">日记日期 · 北京时间</label>
          <select id="diary-day" value={day} onChange={event => { setDay(event.target.value); setExpanded(false) }}>{archive.days.map(value => <option key={value}>{value}</option>)}</select>
          <label htmlFor="diary-keyword">当天线索</label>
          <input id="diary-keyword" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="如：聚餐、项目、旅行" />
          <div className="diary-filter-heading"><span><Users size={15} /> 关注人物</span><button onClick={() => setPeople([])}>全部人物</button></div>
          <small>未勾选时包含所有人；勾选后仅整理这些人的发言。</small>
          <div className="diary-person-search"><Search size={15} /><input aria-label="搜索人物" value={personSearch} onChange={event => setPersonSearch(event.target.value)} placeholder="姓名或微信 ID" /></div>
          <div className="diary-people">{visiblePeople.map(person => <label key={person.id}>
            <input type="checkbox" checked={people.includes(person.id)} onChange={event => setPeople(previous => event.target.checked ? [...previous, person.id] : previous.filter(id => id !== person.id))} />
            <span>{person.name}<small title={person.id}>{person.id}</small></span>
          </label>)}</div>
          {archive.people.length > 60 && <small>列表最多显示 60 人，可搜索定位其他人物。</small>}
          <small>人物按微信 ID 归并，同名账号分别保留。共同出现不代表彼此熟识。</small>
        </aside>
        <main className="diary-notebook">
          <div className="diary-page-heading"><div><span>DAILY NOTES</span><h2>{day}</h2></div>
            <div className="diary-actions"><button className="diary-button" disabled={!diary?.messages.length || saving} onClick={() => void saveDiary('md')}><Download size={15} />保存日记</button>
              <button className="diary-button" disabled={!diary?.messages.length || saving} onClick={() => void saveDiary('json')}><FileJson size={15} />保存 JSON</button></div></div>
          <p className="diary-summary">{diary?.summary}</p>
          <p className="diary-fact-label">本地事实摘录 · 未调用 AI · 当前筛选范围</p>
          <label className="diary-note-label" htmlFor="diary-note">我的补记</label>
          <textarea id="diary-note" value={notes[day] || ''} onChange={event => setNotes(previous => ({ ...previous, [day]: event.target.value }))} placeholder="今天发生了什么？对哪些人的话有印象？写下记录之外的感受。" rows={3} />
          {diary?.crossSessionPeople.length ? <section className="diary-connections"><h3>串起不同会话的人</h3>{diary.crossSessionPeople.map(person => <p key={person.id}><strong>{person.name}</strong> 在 {person.sessions.join('、')} 中均有发言。</p>)}</section> : null}
          {diary?.sessions.map(session => <section className="diary-session" key={session.id}><div className="diary-session-title"><h3>{session.name}</h3><span>{session.messages.length} 条记录</span></div>
            {session.messages.slice(0, 6).map(message => <p className="diary-excerpt" key={message.evidenceId}><time>{message.time}</time><span><strong>{message.senderName}</strong>：{message.content.slice(0, 240)}{message.content.length > 240 ? '…' : ''} <a href={`#diary-evidence-${message.evidenceId}`} onClick={event => {
              event.preventDefault(); setExpanded(true); setFocusedEvidence(message.evidenceId)
              window.setTimeout(() => document.getElementById(`diary-evidence-${message.evidenceId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100)
            }}>[{message.evidenceId}]</a></span></p>)}
            {session.messages.length > 6 && <small>另有 {session.messages.length - 6} 条记录，完整内容保留在下载文件中。</small>}
          </section>)}
          {diary?.replies.length ? <section className="diary-connections"><h3>明确的引用回复</h3>{diary.replies.slice(0, 20).map(reply => <p key={reply.from.evidenceId}>{reply.from.time}，<strong>{reply.from.senderName}</strong> 引用了 <strong>{reply.to.senderName}</strong> 的消息。<br /><small>{reply.from.evidenceId} → {reply.to.evidenceId} · {reply.to.day} {reply.to.time} · {reply.to.content.slice(0, 180)}</small></p>)}</section> : null}
          <button className="diary-evidence-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '查看'}原文证据（{diary?.messages.length || 0} 条）</button>
          {expanded && <div className="diary-evidence">{diary?.messages.filter((message, index) => index < 200 || message.evidenceId === focusedEvidence).map(message => <article id={`diary-evidence-${message.evidenceId}`} key={message.evidenceId}><small>{message.evidenceId} · {message.time} · {message.sessionName} · {message.sourceFile}</small><p><strong>{message.senderName}</strong>：{message.content}</p></article>)}{(diary?.messages.length || 0) > 200 && <p>页面预览前 200 条及选中的摘录，下载文件包含完整证据。</p>}</div>}
          <footer>这份日记仅覆盖导入的聊天记录。表情与图片不下载，不将上下文推断写成事实。补记和导入内容不会自动保存，请在离开页面前下载。</footer>
        </main>
      </div>}
    </>}
  </div>
}
