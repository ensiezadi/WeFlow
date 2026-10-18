import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, appendFile, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

await mkdir(resolve('logs'), { recursive: true })
const scratch = await mkdtemp(resolve('logs/workflow-tests-'))
const compiled = join(scratch, 'workflow.mjs')
await build({ entryPoints: [resolve('electron/services/workflowArchive.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'esm' })
const core = await import(pathToFileURL(compiled).href)
const samplingFile = join(scratch, 'sampling.mjs')
await build({ entryPoints: [resolve('electron/services/workflowSampling.ts')], outfile: samplingFile, bundle: true, platform: 'node', format: 'esm' })
const { WorkflowCadence, workflowFrameChanged, workflowCaptureRegion } = await import(pathToFileURL(samplingFile).href)
const now = Date.parse('2026-10-18T01:00:00Z')
const source = { app: 'code.exe', title: 'WeFlow snapshot-agent.ts' }
const root = () => mkdtemp(join(scratch, 'archive-'))

test('settling, repeated observations, switches and pause cancel sampling correctly', () => {
  const cadence = new WorkflowCadence()
  assert.equal(cadence.observe('editor', true, now), false)
  assert.equal(cadence.observe('browser', true, now + 2000), false)
  assert.equal(cadence.observe('browser', true, now + 4999), false)
  assert.equal(cadence.observe('browser', true, now + 5000), true)
  assert.equal(cadence.observe('browser', true, now + 19999), false)
  assert.equal(cadence.observe('browser', true, now + 20000), true)
  cadence.observe('browser', false, now + 21000)
  assert.equal(cadence.observe('browser', true, now + 30000), false)
  assert.equal(cadence.observe('browser', true, now + 33000), true)
  cadence.invalidate()
  assert.equal(cadence.observe('browser', true, now + 34000), false)
  assert.equal(workflowFrameChanged([10, 10], [10, 10]), false)
  assert.equal(workflowFrameChanged([10, 10], [10, 200]), true)
})

test('foreground crop respects DPI scaling, monitor offsets and partially visible windows', () => {
  assert.deepEqual(workflowCaptureRegion({ left: 100, top: 200, right: 900, bottom: 800 }, { x: 0, y: 0, width: 2000, height: 1000 }, { width: 1000, height: 500 }), { x: 50, y: 100, width: 400, height: 300 })
  assert.deepEqual(workflowCaptureRegion({ left: -2200, top: -100, right: -1000, bottom: 500 }, { x: -2000, y: 0, width: 2000, height: 1000 }, { width: 1000, height: 500 }), { x: 0, y: 0, width: 500, height: 250 })
  assert.equal(workflowCaptureRegion({ left: 3000, top: 0, right: 4000, bottom: 500 }, { x: 0, y: 0, width: 2000, height: 1000 }, { width: 1000, height: 500 }), null)
})

test('repeated OCR extends evidence; changed lines and case-sensitive code changes remain', async () => {
  const folder = await root(), recorder = new core.WorkflowRecorder(folder)
  await recorder.record(source, 'const Name = 1;\nWeFlow snapshot', 'en-US', now)
  await recorder.record(source, 'const Name = 1;\nWeFlow snapshot', 'en-US', now + 15000)
  let events = await core.readWorkflowEvents(folder, '2026-10-18')
  assert.equal(events.length, 1)
  assert.equal(events[0].until, new Date(now + 15000).toISOString())
  await recorder.record(source, 'const name = 1;\nWeFlow snapshot', 'en-US', now + 30000)
  events = await core.readWorkflowEvents(folder, '2026-10-18')
  assert.equal(events.length, 2)
  assert.equal(events[1].addedText, 'const name = 1;')
  assert.equal(core.workflowTextDelta('line\nold', 'line\nnew'), 'new')
  assert.equal((await readFile(join(folder, 'context', '2026-10-18.jsonl'), 'utf8')).includes('"kind":"seen"'), true)
})

test('a later representative image keeps its own capture time when duplicate text is merged', async () => {
  const folder = await root(), recorder = new core.WorkflowRecorder(folder)
  await recorder.record(source, 'same text', 'en-US', now)
  const imageId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const imageAt = new Date(now + 17000).toISOString()
  await recorder.record(source, 'same text', 'en-US', now + 15000, imageId, imageAt)
  const events = await core.readWorkflowEvents(folder, '2026-10-18')
  assert.equal(events.length, 1)
  assert.equal(events[0].at, new Date(now).toISOString())
  assert.equal(events[0].imageId, imageId)
  assert.equal(events[0].imageAt, imageAt)
})

test('related cross-app work groups together, unrelated topics and long gaps separate', async () => {
  const folder = await root(), recorder = new core.WorkflowRecorder(folder)
  await recorder.record(source, 'WeFlow snapshot-agent\nCheck foreground callback', 'en-US', now)
  await recorder.record({ app: 'chrome.exe', title: 'Foreground docs' }, 'WeFlow snapshot-agent\nRead callback docs', 'en-US', now + 30000)
  await recorder.record({ app: 'chrome.exe', title: 'Train ticket' }, 'Destination Shanghai\nTicket price', 'en-US', now + 60000)
  await recorder.record({ app: 'chrome.exe', title: 'Train ticket' }, 'Destination Shanghai\nTicket price', 'en-US', now + 7 * 60000)
  const view = await core.readWorkflow(folder, '2026-10-18')
  assert.equal(view.sessions.length, 3)
  assert.deepEqual(view.sessions[0].apps, ['code.exe', 'chrome.exe'])
  assert.equal(view.events[0].text.includes('Check foreground'), true)
})

test('renaming, splitting and merging persist without changing captured evidence', async () => {
  const folder = await root(), recorder = new core.WorkflowRecorder(folder)
  await recorder.record(source, 'WeFlow snapshot-agent first', 'en-US', now)
  await recorder.record(source, 'WeFlow snapshot-agent second', 'en-US', now + 15000)
  let view = await core.readWorkflow(folder, '2026-10-18')
  const [first, second] = view.events
  await core.editWorkflow(folder, '2026-10-18', { kind: 'rename', id: first.id, title: '排查窗口监听' })
  await core.editWorkflow(folder, '2026-10-18', { kind: 'split', id: second.id })
  view = await core.readWorkflow(folder, '2026-10-18')
  assert.equal(view.sessions.length, 2)
  assert.equal(view.sessions[0].title, '排查窗口监听')
  await core.editWorkflow(folder, '2026-10-18', { kind: 'merge', id: second.id })
  view = await core.readWorkflow(folder, '2026-10-18')
  assert.equal(view.sessions.length, 1)
  assert.equal(view.events[0].title, source.title)
  await assert.rejects(core.editWorkflow(folder, '../', { kind: 'rename', id: first.id, title: 'bad' }))
  await assert.rejects(core.editWorkflow(folder, '2026-10-18', { kind: 'rename', id: first.id, title: '' }))
})

test('pause boundaries, restart and Shanghai midnight do not merge observations incorrectly', async () => {
  const folder = await root(), recorder = new core.WorkflowRecorder(folder)
  await recorder.record(source, 'same text', 'en-US', now)
  recorder.breakContinuity()
  await recorder.record(source, 'same text', 'en-US', now + 15000)
  const restarted = new core.WorkflowRecorder(folder)
  await restarted.record(source, 'same text', 'en-US', now + 30000)
  assert.equal((await core.readWorkflowEvents(folder, '2026-10-18')).length, 2)
  await restarted.record(source, 'same text', 'en-US', Date.parse('2026-10-18T16:00:00Z'))
  assert.equal((await core.readWorkflowEvents(folder, '2026-10-19')).length, 1)
})

test('incomplete final journal entry is ignored while reading and recovered before append', async () => {
  const folder = await root(), recorder = new core.WorkflowRecorder(folder)
  await recorder.record(source, 'valid', 'en-US', now)
  await appendFile(join(folder, 'context', '2026-10-18.jsonl'), '{"unfinished":')
  assert.equal((await core.readWorkflowEvents(folder, '2026-10-18')).length, 1)
  await new core.WorkflowRecorder(folder).record(source, 'next', 'en-US', now + 15000)
  assert.equal((await core.readWorkflowEvents(folder, '2026-10-18')).length, 2)
})

test('app and title exclusions are case-insensitive and settings preserve the sampling switch', async () => {
  const folder = await root()
  await core.updateWorkflowSettings(folder, { contextEnabled: true, deniedApps: ['secret.exe'], deniedTitles: ['Private'] })
  const settings = await core.workflowSettings(folder)
  assert.equal(core.workflowSourceAllowed({ app: 'SECRET.EXE', title: 'safe' }, settings), false)
  assert.equal(core.workflowSourceAllowed({ app: 'chrome.exe', title: 'A private tab' }, settings), false)
  assert.equal(core.workflowSourceAllowed(source, settings), true)
  assert.equal(core.workflowSourceAllowed(source, { ...settings, contextEnabled: false }), false)
  const snapshotFile = join(scratch, 'snapshot.mjs')
  await build({ entryPoints: [resolve('electron/services/snapshotArchive.ts')], outfile: snapshotFile, bundle: true, platform: 'node', format: 'esm' })
  const snapshots = await import(pathToFileURL(snapshotFile).href)
  await snapshots.setSnapshotEnabled(folder, false)
  assert.deepEqual((await core.workflowSettings(folder)).deniedApps, ['secret.exe'])
  await core.updateWorkflowSettings(folder, { ...settings, deniedApps: ['other.exe'] })
  assert.equal(await snapshots.snapshotEnabled(folder), false)
  await assert.rejects(core.updateWorkflowSettings(folder, { ...settings, deniedApps: [2] }))
})

test('text caps stop new entries without deleting records; image quotas do not cap context', async () => {
  const folder = await root(), recorder = new core.WorkflowRecorder(folder)
  await recorder.record(source, 'x'.repeat(10000), 'en-US', now)
  assert.equal((await core.readWorkflowEvents(folder, '2026-10-18'))[0].text.length, core.workflowPolicy.maxText)
  const oversized = await open(join(folder, 'context', '2026-10-17.jsonl'), 'w')
  await oversized.truncate(core.workflowPolicy.totalBytes)
  await oversized.close()
  assert.match((await recorder.record(source, 'new text', 'en-US', now + 15000)).reason, /空间上限/)
  assert.equal((await core.readWorkflowEvents(folder, '2026-10-18')).length, 1)
})
