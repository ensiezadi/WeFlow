import { useEffect, useState } from 'react'
import type { WorkflowView, WorkflowEdit } from '../types/workflow'

const clock = (at: string) => new Date(at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
export default function WorkflowPanel({ view, day, images, refresh }: { view: WorkflowView; day: string; images: Record<string, string>; refresh: () => void }) {
  const [query, setQuery] = useState('')
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [visibleCount, setVisibleCount] = useState(40)
  const [enabled, setEnabled] = useState(view.settings.contextEnabled)
  const [apps, setApps] = useState(view.settings.deniedApps.join('\n'))
  const [deniedTitles, setDeniedTitles] = useState(view.settings.deniedTitles.join('\n'))
  const settingsKey = JSON.stringify(view.settings)
  useEffect(() => setVisibleCount(40), [day, query])
  useEffect(() => {
    setEnabled(view.settings.contextEnabled)
    setApps(view.settings.deniedApps.join('\n'))
    setDeniedTitles(view.settings.deniedTitles.join('\n'))
  }, [settingsKey])
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setSaved('')
    try { await action(); setSaved(message); refresh() }
    catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  const edit = (value: WorkflowEdit) => run(() => window.electronAPI.diary.workflowEdit(day, value), '工作片段已更新')
  const sessions = view.sessions.filter(session => !query.trim() || session.evidence.some(event => `${event.app}\n${event.title}\n${event.text}\n${session.title}`.toLowerCase().includes(query.trim().toLowerCase())))
  return <div className="workflow-panel">
    <div className="workflow-heading"><div><h3>工作片段</h3><p>{view.sessions.length} 个片段 · {view.events.length} 条文字证据 · 文字归档 {(view.usedBytes / 1024 / 1024).toFixed(1)} / 100 MB</p></div>
      <input aria-label="搜索工作片段" type="search" placeholder="搜索应用、标题或画面中的文字" value={query} onChange={event => setQuery(event.target.value)} />
    </div>
    <p className="diary-fact-label">按时间和共同关键词初步归组。标题、时间和识别文字均可展开核对；可手动改名、拆分和合并。</p>
    <details className="workflow-settings"><summary>采集设置与排除应用</summary>
      <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> 开启工作流自动采集</label>
      <div className="workflow-settings-grid">
        <label>排除的应用（每行一个，例如 bitwarden.exe）<textarea rows={5} value={apps} onChange={event => setApps(event.target.value)} /></label>
        <label>标题包含以下内容时跳过（每行一条）<textarea rows={5} value={deniedTitles} onChange={event => setDeniedTitles(event.target.value)} /></label>
      </div>
      <p className="diary-fact-label">排除规则在采集前检查；标题规则只能匹配应用公开的标题。已归档的记录仍可查看。</p>
      <button className="diary-button" disabled={busy} onClick={() => void run(() => window.electronAPI.diary.workflowSettings({ contextEnabled: enabled, deniedApps: apps.split(/[\n,，]/).map(item => item.trim()).filter(Boolean), deniedTitles: deniedTitles.split('\n').map(item => item.trim()).filter(Boolean) }), '采集设置已保存')}>保存采集设置</button>
    </details>
    {error && <p className="diary-error" role="alert">{error}</p>}
    {saved && <p className="diary-fact-label" role="status">{saved}</p>}
    {!sessions.length && <p className="diary-fact-label">{query ? '没有匹配的工作片段。' : '正在等待新的工作上下文。窗口稳定 3 秒后会开始采集。'}</p>}
    <div className="workflow-sessions">{sessions.slice(0, visibleCount).map(session => <article key={session.id} className="workflow-session">
      <div className="workflow-session-heading"><time>{clock(session.start)}–{clock(session.end)}</time><small>{session.evidence.length} 条证据 · {session.apps.join('、')}</small></div>
      <div className="workflow-title"><input aria-label={`片段标题 ${session.id}`} maxLength={200} value={titles[session.id] ?? session.title} onChange={event => setTitles(previous => ({ ...previous, [session.id]: event.target.value }))} />
        <button className="diary-button" disabled={busy} onClick={() => void edit({ kind: 'rename', id: session.id, title: titles[session.id] ?? session.title })}>保存标题</button>
        <button className="diary-button" disabled={busy || view.sessions[0]?.id === session.id} onClick={() => void edit({ kind: 'merge', id: session.id })}>与上一片段合并</button>
      </div>
      <details><summary>展开过程与文字证据</summary><ol className="workflow-evidence">{session.evidence.map((event, index) => <li key={event.id}>
        <div className="workflow-evidence-heading"><strong>{clock(event.at)}{event.until !== event.at ? `–${clock(event.until)}` : ''} · {event.app}</strong>
          {index > 0 && <button className="diary-button" disabled={busy} onClick={() => void edit({ kind: 'split', id: event.id })}>从这里拆开</button>}
        </div>
        <p className="workflow-window-title">{event.title || '未提供窗口标题'}</p>
        {event.addedText && <details open><summary>本次新增文字</summary><pre>{event.addedText}</pre></details>}
        <details><summary>采集到的画面文字 · {event.language || '未返回语言'}</summary><pre>{event.text || '这次画面没有识别出文字。'}</pre></details>
        {event.imageId && images[event.imageId] && <details><summary>代表截图 · {clock(event.imageAt ?? event.at)}</summary><img src={images[event.imageId]} alt={`${clock(event.imageAt ?? event.at)} 的工作窗口`} loading="lazy" /></details>}
      </li>)}</ol></details>
    </article>)}</div>
    {sessions.length > visibleCount && <button className="diary-button" onClick={() => setVisibleCount(value => value + 40)}>再显示 40 个片段</button>}
  </div>
}
