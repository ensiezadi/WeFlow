import { useEffect, useState } from 'react'
import type { SnapshotView } from '../types/snapshot'
import WorkflowPanel from './WorkflowPanel'

const reasonLabels: Record<string, string> = {
  manual: '主动记录', scheduled: '定时采样', 'window-stable': '窗口停留后',
  'activity-resumed': '恢复使用后', periodic: '持续工作', workflow: '工作片段'
}

export default function SnapshotPanel() {
  const [view, setView] = useState<SnapshotView | null>(null)
  const [day, setDay] = useState('')
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [images, setImages] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState('')
  useEffect(() => {
    let mounted = true
    async function refresh() {
      try {
        const next = await window.electronAPI.diary.snapshots(day || undefined)
        if (!mounted) return
        setView(next)
        const previews = await Promise.all(next.records.map(async record => [record.id, await window.electronAPI.diary.snapshotImage(record.day, record.id)] as const))
        if (mounted) setImages(Object.fromEntries(previews))
      } catch (error) { if (mounted) setError(String(error)) }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15000)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [day, reload])

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(''); setSaved('')
    try { await action(); setReload(value => value + 1) }
    catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }

  return <section className="device-timeline-panel" aria-label="本地工作流记录">
    <div className="device-timeline-heading"><div><h2>今天，做过哪些事。</h2><p>窗口稳定 3 秒后采集 · 持续使用每 15 秒检查变化 · 本地识别与归组</p></div>
      <div className="diary-actions">
        <button className="diary-button" disabled={!view || busy} onClick={() => void run(() => window.electronAPI.diary.snapshotEnabled(!view?.enabled))}>{view?.enabled ? '停止采集' : '开启本次采集'}</button>
        <button className="diary-button" disabled={!view?.enabled || busy} onClick={() => void run(async () => { await window.electronAPI.diary.snapshotNow(); setDay('') })}>{busy ? '处理中…' : '现在记一张'}</button>
        <button className="diary-button" onClick={() => void run(() => window.electronAPI.diary.openDeviceArchive())}>打开归档目录</button>
        <button className="diary-button" disabled={busy || view?.enabled} onClick={() => void run(async () => {
          const result = await window.electronAPI.diary.importDeviceArchive()
          if (!result.canceled) { setDay(''); setSaved(result.alreadyImported ? '这些记录已经保存在软件中。' : '已有记录已导入，原文件保留。') }
        })}>导入已有记录</button>
      </div>
    </div>
    {error && <p className="diary-error" role="alert">{error}</p>}
    {saved && <p className="diary-fact-label" role="status">{saved}</p>}
    {view && <>
      <p className="diary-fact-label">记录自动保存在本机，重新打开或升级软件后仍可查看。{view.storagePath && <span title={view.storagePath}>「打开归档目录」可查看保存位置。</span>}</p>
      {view.migrationWarning && <p className="diary-error" role="alert">{view.migrationWarning}</p>}
      <p className="diary-fact-label">{view.enabled ? '采样已开启' : '采样已暂停'} · {view.day} 已留 {view.count} 张 · 图片占用 {(view.usedBytes / 1024 / 1024).toFixed(1)} / 200 MB</p>
      <p className="diary-fact-label">每次打开应用默认关闭采集，手动开启后仅在本次应用运行期间生效；停止采集或退出应用会停止代理。安装和启动应用均不创建后台计划任务。</p>
      <p className="diary-fact-label">记录前台应用、窗口标题和画面文字，相似文字合并；游戏、全屏演示、锁屏和闲置时暂停。代表截图每天最多 20 张、自动保存至少间隔 10 分钟，图片空间上限 200 MB。</p>
      <p className="diary-fact-label">采集代理：{!view.enabled ? '已关闭' : view.agent && Date.now() - Date.parse(view.agent.heartbeatAt) < 90000 ? '运行中' : '正在启动或已退出'} · 本地 OCR：{!view.enabled ? '已关闭' : view.agent?.ocrState || '等待连接'}{view.enabled && view.agent?.ocrLanguages?.length ? `（${view.agent.ocrLanguages.join('、')}）` : ''}。{view.enabled && view.agent?.contextResult}</p>
      <p className="diary-fact-label">{view.lastCheck ? `最近检查：${new Date(view.lastCheck).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · ${view.lastResult}` : '等待首次采样。'}　随时按 Ctrl + Alt + F8 记一张。</p>
      <div className="diary-actions snapshot-date"><label>记录日期 <input type="date" value={day || view.day} onChange={event => setDay(event.target.value)} /></label>{view.days.length > 0 && <label>历史记录 <select value={view.days.includes(day || view.day) ? day || view.day : ''} onChange={event => setDay(event.target.value)}><option value="" disabled>选择日期</option>{view.days.map(date => <option key={date} value={date}>{date}</option>)}</select></label>}<button className="diary-button" onClick={() => setReload(value => value + 1)}>刷新记录</button></div>
      {view.workflow && <WorkflowPanel view={view.workflow} day={view.day} images={images} refresh={() => setReload(value => value + 1)} />}
      <h3>代表截图与旧记录</h3>
      {!view.records.length && <p>当天还没有代表截图，可以主动记下一张。</p>}
      <div className="snapshot-cards">{view.records.map(record => <article key={record.id}>
        <div className="snapshot-card-heading"><time>{new Date(record.at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</time><small>{Math.ceil(record.bytes / 1024)} KB · {reasonLabels[record.reason] || '自动采样'}</small></div>
        {images[record.id] && <details open><summary>当时的画面</summary><img src={images[record.id]} alt={`${record.at} 的瞬时截图`} loading="lazy" /></details>}
        <input aria-label={`给 ${record.id} 写一句补记`} maxLength={300} value={notes[record.id] ?? record.note} onChange={event => setNotes(previous => ({ ...previous, [record.id]: event.target.value }))} placeholder="一句话：当时做了什么？（可选）" />
        <button className="diary-button" disabled={busy} onClick={() => void run(async () => { await window.electronAPI.diary.snapshotNote(record.day, record.id, notes[record.id] ?? record.note); setSaved('补记已保存到本地 JSON') })}>保存补记</button>
      </article>)}</div>
      <p className="diary-fact-label">标题、识别文字、截图和补记均保存在本地。工作片段按时间和关键词归组，完成结果请以原始证据为准。</p>
    </>}
  </section>
}
