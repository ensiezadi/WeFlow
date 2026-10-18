export interface SnapshotView {
  enabled: boolean; days: string[]; day: string; count: number; usedBytes: number
  records: { id: string; at: string; day: string; bytes: number; width: number; height: number; note: string; reason: string }[]
  lastCheck?: string; lastResult?: string
  agent?: { heartbeatAt: string; startedAt: string; pid: number; windowEvents: number; ocrState?: string; ocrLanguages?: string[]; lastContextAt?: string; contextResult?: string }
  workflow?: import('./workflow').WorkflowView
}
