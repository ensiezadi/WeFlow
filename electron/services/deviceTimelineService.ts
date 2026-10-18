import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeviceTimelineResult } from '../../src/types/deviceTimeline'

export async function readDeviceTimeline(archivePath: string, requestedDay?: unknown): Promise<DeviceTimelineResult> {
  try {
    if (requestedDay !== undefined && (typeof requestedDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(requestedDay))) {
      throw new Error('日期格式无效')
    }
    let days: string[]
    try {
      days = (await readdir(archivePath, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
        .map(entry => entry.name).sort().reverse()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { success: true, archivePath, days: [], events: [] }
      throw error
    }
    const day = requestedDay as string | undefined || days[0]
    if (!day) return { success: true, archivePath, days, events: [] }
    const latest = JSON.parse(await readFile(join(archivePath, day, 'latest.json'), 'utf8'))
    if (typeof latest.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(latest.revision)) throw new Error('归档版本无效')
    const timelinePath = join(archivePath, day, 'revisions', latest.revision, 'timeline.json')
    if ((await stat(timelinePath)).size > 64 * 1024 * 1024) throw new Error('归档过大，请查看本地 JSON')
    const timeline = JSON.parse(await readFile(timelinePath, 'utf8'))
    if (timeline.kind !== 'weflow-device-timeline' || timeline.day !== day || !Array.isArray(timeline.events)) throw new Error('归档格式无效')
    return {
      success: true, archivePath, days, day, receivedAt: timeline.receivedAt,
      totalEvents: timeline.events.length, activeByDevice: timeline.activeByDevice,
      warnings: timeline.warnings,
      events: timeline.events.slice(0, 200).map(event => ({
        evidenceId: event.evidenceId, device: event.device, kind: event.kind,
        displayStart: event.displayStart, displayEnd: event.displayEnd,
        label: event.kind === 'afk' ? (event.data?.status === 'not-afk' ? '检测到电脑活动' : event.data?.status === 'afk' ? '离开电脑' : '活动状态未知')
          : `前台应用：${String(event.data?.app ?? event.data?.bundle_id ?? event.data?.package ?? '未知应用')}`
      }))
    }
  } catch (error) {
    return { success: false, archivePath, days: [], error: error instanceof Error ? error.message : String(error) }
  }
}
