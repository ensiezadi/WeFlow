export interface DeviceTimelineEntry {
  evidenceId: string
  device: string
  kind: string
  displayStart: string
  displayEnd: string
  label: string
}

export interface DeviceTimelineResult {
  success: boolean
  error?: string
  archivePath: string
  days: string[]
  day?: string
  receivedAt?: string
  totalEvents?: number
  events?: DeviceTimelineEntry[]
  activeByDevice?: { device: string; observedActiveSeconds: number | null }[]
  warnings?: string[]
}
