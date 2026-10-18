import { workflowPolicy } from './workflowArchive'

export class WorkflowCadence {
  private key = ''
  private settledAt = 0
  private sampledAt = -Infinity
  invalidate() { this.key = '' }
  observe(key: string, available: boolean, now: number) {
    if (!available) { this.invalidate(); return false }
    if (key !== this.key) { this.key = key; this.settledAt = now; this.sampledAt = -Infinity }
    if (now - this.settledAt < workflowPolicy.settleMs || now - this.sampledAt < workflowPolicy.sampleMs) return false
    this.sampledAt = now
    return true
  }
}
export function workflowFrameChanged(previous: number[], next: number[]) {
  if (!previous.length || previous.length !== next.length) return true
  let changed = 0, delta = 0
  for (let i = 0; i < next.length; i++) {
    const difference = Math.abs(previous[i] - next[i])
    delta += difference
    if (difference > 10) changed++
  }
  return delta / next.length >= 0.2 || changed / next.length >= 0.001
}
export function workflowCaptureRegion(window: { left: number; top: number; right: number; bottom: number }, display: { x: number; y: number; width: number; height: number }, image: { width: number; height: number }) {
  const left = Math.max(window.left, display.x), top = Math.max(window.top, display.y)
  const right = Math.min(window.right, display.x + display.width), bottom = Math.min(window.bottom, display.y + display.height)
  if (right <= left || bottom <= top) return null
  const x = Math.max(0, Math.floor((left - display.x) * image.width / display.width))
  const y = Math.max(0, Math.floor((top - display.y) * image.height / display.height))
  return { x, y, width: Math.min(image.width - x, Math.max(1, Math.floor((right - left) * image.width / display.width))), height: Math.min(image.height - y, Math.max(1, Math.floor((bottom - top) * image.height / display.height))) }
}
