import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, unlink, open } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

await mkdir(resolve('logs'), { recursive: true })
const scratch = await mkdtemp(resolve('logs/snapshot-tests-'))
const compiled = join(scratch, 'core.mjs')
await build({ entryPoints: [resolve('electron/services/snapshotArchive.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'esm' })
const core = await import(pathToFileURL(compiled).href)
const triggersCompiled = join(scratch, 'triggers.mjs')
await build({ entryPoints: [resolve('electron/services/snapshotTriggers.ts')], outfile: triggersCompiled, bundle: true, platform: 'node', format: 'esm' })
const { SnapshotTriggers } = await import(pathToFileURL(triggersCompiled).href)
const now = Date.parse('2026-10-18T01:00:00Z')
const frame = (color = 20) => ({ jpeg: Buffer.from('synthetic-test-image'), width: 1600, height: 900, fingerprint: Array(2304).fill(color) })
async function folder() { const root = await mkdtemp(join(scratch, 'archive-')); await core.setSnapshotEnabled(root, true); return root }

test('scheduled samples obey interval and similarity; manual notes save locally', async () => {
  const root = await folder()
  const first = await core.saveSnapshot(root, frame(), 'scheduled', now)
  assert.equal(first.saved, true)
  assert.equal((await core.saveSnapshot(root, frame(200), 'scheduled', now + 60000)).saved, false)
  assert.equal((await core.saveSnapshot(root, frame(21), 'scheduled', now + 31 * 60000)).saved, false)
  assert.equal((await core.saveSnapshot(root, frame(200), 'scheduled', now + 31 * 60000)).saved, true)
  await core.noteSnapshot(root, first.record.day, first.record.id, '完成了一个小改动')
  const status = await core.snapshotStatus(root, undefined, now)
  assert.equal(status.records[0].note, '完成了一个小改动')
  await assert.rejects(core.snapshotImage(root, '../', first.record.id))
})

test('all automatic reasons share the ten-minute cooldown and similarity filter', async () => {
  for (const reason of ['window-stable', 'activity-resumed', 'periodic']) {
    const root = await folder()
    await core.saveSnapshot(root, frame(), 'manual', now)
    assert.equal((await core.saveSnapshot(root, frame(200), reason, now + 9 * 60000)).saved, false)
    assert.equal((await core.saveSnapshot(root, frame(21), reason, now + 10 * 60000)).saved, false)
    const result = await core.saveSnapshot(root, frame(200), reason, now + 10 * 60000)
    assert.equal(result.saved, true)
    assert.equal(result.record.reason, reason)
  }
})

test('automatic cooldown also applies across Shanghai midnight', async () => {
  const root = await folder()
  const beforeMidnight = Date.parse('2026-10-18T15:58:00Z')
  await core.saveSnapshot(root, frame(), 'manual', beforeMidnight)
  assert.equal((await core.saveSnapshot(root, frame(200), 'activity-resumed', beforeMidnight + 4 * 60000)).saved, false)
  assert.equal((await core.saveSnapshot(root, frame(200), 'window-stable', beforeMidnight + 10 * 60000)).saved, true)
})

test('short window visits cancel the dwell; stable windows and activity recovery trigger', () => {
  const trigger = new SnapshotTriggers(now)
  trigger.observe('editor', true, now)
  assert.equal(trigger.next(now + 119000), undefined)
  assert.equal(trigger.next(now + 120000), 'activity-resumed')
  trigger.attempted(now + 120000)
  trigger.observe('browser', true, now + 180000)
  trigger.observe('editor', true, now + 210000)
  assert.equal(trigger.next(now + 300000), undefined)
  assert.equal(trigger.next(now + 330000), 'window-stable')
  trigger.observe(null, false, now + 331000)
  assert.equal(trigger.next(now + 1000000), undefined)
  trigger.observe('editor', true, now + 1000000)
  assert.equal(trigger.next(now + 1119000), undefined)
  assert.equal(trigger.next(now + 1120000), 'activity-resumed')
})

test('pending windows wait for cooldown; periodic fallback waits 45 minutes after skipped samples', () => {
  const trigger = new SnapshotTriggers(now)
  trigger.observe('editor', true, now)
  assert.equal(trigger.next(now + 120000, now), undefined)
  assert.equal(trigger.next(now + 600000, now), 'activity-resumed')
  trigger.attempted(now + 600000)
  assert.equal(trigger.next(now + 600000 + 2699000, now), undefined)
  assert.equal(trigger.next(now + 600000 + 2700000, now), 'periodic')
  trigger.attempted(now + 3300000)
  assert.equal(trigger.next(now + 3305000, now), undefined)
  // A manual capture postpones fallback as well.
  assert.equal(trigger.next(now + 6000000, now + 5900000), undefined)
})

test('pausing or locking cancels old work and starts a fresh dwell when available', () => {
  const trigger = new SnapshotTriggers(now)
  trigger.observe('editor', true, now)
  trigger.observe('browser', true, now + 100000)
  trigger.observe(null, false, now + 110000)
  trigger.observe('browser', true, now + 200000)
  assert.equal(trigger.next(now + 319000), undefined)
  assert.equal(trigger.next(now + 320000), 'activity-resumed')
  trigger.attempted(now + 320000)
  trigger.observe(null, true, now + 330000)
  assert.equal(trigger.next(now + 4000000), undefined)
})

test('manual sampling cannot bypass daily limit; Shanghai midnight starts a new day', async () => {
  const root = await folder()
  for (let i = 0; i < 20; i++) assert.equal((await core.saveSnapshot(root, frame(), 'manual', now + i)).saved, true)
  assert.equal((await core.saveSnapshot(root, frame(), 'manual', now + 21)).saved, false)
  assert.equal((await core.saveSnapshot(root, frame(), 'manual', Date.parse('2026-10-18T16:00:00Z'))).saved, true)
  assert.equal(core.snapshotDay(Date.parse('2026-10-18T15:59:59Z')), '2026-10-18')
})

test('pausing, per-image and total storage caps prevent new images without deleting old ones', async () => {
  const root = await folder()
  await core.setSnapshotEnabled(root, false)
  assert.equal((await core.saveSnapshot(root, frame(), 'manual', now)).saved, false)
  await core.setSnapshotEnabled(root, true)
  assert.equal((await core.saveSnapshot(root, { ...frame(), jpeg: Buffer.alloc(200 * 1024 + 1) }, 'manual', now)).saved, false)
  const dateFolder = join(root, '2026-10-18')
  await mkdir(dateFolder, { recursive: true })
  const existing = await open(join(dateFolder, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg'), 'w')
  await existing.truncate(200 * 1024 * 1024)
  await existing.close()
  assert.equal((await core.saveSnapshot(root, frame(), 'manual', now)).saved, false)
  assert.equal((await core.snapshotStatus(root, undefined, now)).usedBytes, 200 * 1024 * 1024)
  await unlink(join(dateFolder, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg'))
})
