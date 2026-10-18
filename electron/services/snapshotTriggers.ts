export const snapshotTriggerPolicy = {
  dwellMs: 2 * 60000,
  cooldownMs: 10 * 60000,
  fallbackMs: 45 * 60000,
  idleSeconds: 300
}
export type AutomaticSnapshotReason = 'window-stable' | 'activity-resumed' | 'periodic'

// Window identifiers live only in memory. No titles or app history are collected.
export class SnapshotTriggers {
  private windowId: string | null = null
  private stableSince = 0
  private pending: AutomaticSnapshotReason | undefined
  private lastAttempt: number

  constructor(now: number) { this.lastAttempt = now }

  observe(windowId: string | null, available: boolean, now: number) {
    if (!available || !windowId) {
      this.windowId = null
      this.pending = undefined
      this.stableSince = now
      return
    }
    if (windowId !== this.windowId) {
      this.pending = this.windowId === null || this.pending === 'activity-resumed' ? 'activity-resumed' : 'window-stable'
      this.windowId = windowId
      this.stableSince = now
    }
  }

  next(now: number, lastSavedAt?: number): AutomaticSnapshotReason | undefined {
    if (!this.windowId || now - this.stableSince < snapshotTriggerPolicy.dwellMs) return
    if (lastSavedAt !== undefined && now - lastSavedAt < snapshotTriggerPolicy.cooldownMs) return
    if (this.pending) return this.pending
    if (now - Math.max(lastSavedAt ?? 0, this.lastAttempt) >= snapshotTriggerPolicy.fallbackMs) return 'periodic'
  }

  attempted(now: number) {
    this.pending = undefined
    this.lastAttempt = now
  }
}
