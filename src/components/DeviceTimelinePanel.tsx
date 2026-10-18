import { useEffect, useState } from 'react'
import type { DeviceTimelineResult } from '../types/deviceTimeline'

const clock = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

export default function DeviceTimelinePanel() {
  const [day, setDay] = useState('')
  const [reload, setReload] = useState(0)
  const [result, setResult] = useState<DeviceTimelineResult | null>(null)
  const [pending, setPending] = useState(false)
  const [folderError, setFolderError] = useState('')
  useEffect(() => {
    let mounted = true
    async function refresh() {
      setPending(true)
      try {
        const next = await window.electronAPI.diary.deviceTimeline(day || undefined)
        if (mounted) setResult(next)
      } catch (error) {
        if (mounted) setResult({ success: false, error: String(error), archivePath: '', days: [] })
      } finally { if (mounted) setPending(false) }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60000)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [day, reload])

  async function openFolder() {
    try { setFolderError(await window.electronAPI.diary.openDeviceArchive()) }
    catch (error) { setFolderError(String(error)) }
  }

  return <section className="device-timeline-panel" aria-label="设备时间线">
    <div className="device-timeline-heading"><div><h2>设备时间线</h2><p>自动归档的应用与活动记录 · 北京时间</p></div>
      <div className="diary-actions">
        {Boolean(result?.days.length) && <select aria-label="设备记录日期" value={day || result?.day || ''} onChange={event => setDay(event.target.value)}>
          {result?.days.map(value => <option key={value}>{value}</option>)}
        </select>}
        <button className="diary-button" disabled={pending} onClick={() => setReload(value => value + 1)}>{pending ? '读取中…' : '刷新记录'}</button>
        <button className="diary-button" onClick={() => void openFolder()}>打开归档目录</button>
      </div>
    </div>
    {result && !result.success && <p className="diary-error" role="alert">设备记录读取失败：{result.error}</p>}
    {folderError && <p className="diary-error" role="alert">无法打开目录：{folderError}</p>}
    {result?.success && <>
      <p className="diary-fact-label">{result.receivedAt ? `上次归档：${new Date(result.receivedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · ${result.totalEvents ?? 0} 条记录` : '还没有归档，采集服务连接后会在此显示。'}</p>
      {result.receivedAt && Date.now() - Date.parse(result.receivedAt) > 30 * 60000 && <p className="diary-error">归档已超过 30 分钟未更新，请检查采集任务；所选日期为历史日期时，显示的是最后一次修订时间。</p>}
      {result.activeByDevice?.map(device => <p className="diary-fact-label" key={device.device}>{device.device} · 已观测活动时长：{device.observedActiveSeconds === null ? '未知' : `${Math.floor(device.observedActiveSeconds / 60)} 分钟`}</p>)}
      {result.events?.length ? <details open><summary>查看时间线（{result.events.length} 条{(result.totalEvents ?? 0) > 200 ? '，其余见完整 JSON' : ''}）</summary>
        <div className="device-timeline-list">{result.events.map(event => <article key={event.evidenceId}>
          <time>{clock(event.displayStart)}–{clock(event.displayEnd)}</time>
          <div><strong>{event.label}</strong><small>{event.device} · {event.evidenceId}</small></div>
        </article>)}</div>
      </details> : result.receivedAt ? <p>当天暂无记录。采集从启动后开始，空白时段不推断。</p> : null}
      <p className="diary-fact-label">前台应用不代表完成事项。手机、健康和聊天数据接入后，将保留各自的来源证据。</p>
    </>}
  </section>
}
