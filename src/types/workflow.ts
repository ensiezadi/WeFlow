export interface WorkflowSource { app: string; title: string }
export interface WorkflowEvidence extends WorkflowSource {
  id: string; at: string; until: string; text: string; addedText: string; imageId?: string; imageAt?: string; language: string
}
export interface WorkflowSession {
  id: string; title: string; start: string; end: string; apps: string[]; evidence: WorkflowEvidence[]
}
export interface WorkflowSettings {
  contextEnabled: boolean; deniedApps: string[]; deniedTitles: string[]
}
export interface WorkflowView {
  events: WorkflowEvidence[]; sessions: WorkflowSession[]; settings: WorkflowSettings; usedBytes: number
}
export type WorkflowEdit = { kind: 'rename'; id: string; title: string } | { kind: 'split' | 'merge'; id: string }
