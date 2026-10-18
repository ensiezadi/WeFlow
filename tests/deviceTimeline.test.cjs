const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const { normalize, dailyTimeline, markdown, writeArchive, fetchExport, bounds } = require('../scripts/archive-device-timeline.cjs')

const event = (id, timestamp, duration, data) => ({ id, timestamp, duration, data })
const input = (windows, afk = [], phone = []) => ({ buckets: {
  'window-pc': { type: 'currentwindow', hostname: 'pc', events: windows },
  'afk-pc': { type: 'afkstatus', hostname: 'pc', events: afk },
  'aw-import-screentime_ios_demo': { type: 'app.screentime', hostname: 'iphone', events: phone }
} })
const when = '2026-10-18T01:00:00Z'

test('preserves cross-midnight evidence while clipping each daily display', () => {
  const source = normalize(input([event(1, '2026-10-17T15:59:00Z', 120, { app: 'Editor' })]))
  const today = dailyTimeline(source, '2026-10-18')
  assert.equal(today.events[0].start, '2026-10-17T15:59:00.000Z')
  assert.equal(today.events[0].displayStart, '2026-10-17T16:00:00.000Z')
  assert.equal(dailyTimeline(source, '2026-10-17').events[0].evidenceId, today.events[0].evidenceId)
  assert.throws(() => bounds('2026-02-30'))
})

test('deduplicates same bucket IDs, refuses conflicting content, isolates devices', () => {
  const e = event(1, when, 600, { app: 'Editor' })
  const source = normalize(input([e, e], [], [e]))
  assert.equal(source.events.length, 2)
  assert.notEqual(source.events[0].evidenceId, source.events[1].evidenceId)
  assert.throws(() => normalize(input([e, { ...e, duration: 700 }])), /冲突/)
})

test('intersects AFK with foreground on same device and never sums concurrent phone time', () => {
  const source = normalize(input([
    event(1, when, 600, { app: 'A' }), event(2, when, 600, { app: 'B' })
  ], [event(1, when, 300, { status: 'not-afk' }), event(2, '2026-10-18T01:05:00Z', 300, { status: 'afk' })],
  [event(1, when, 600, { app: 'Phone' })]))
  const daily = dailyTimeline(source, '2026-10-18')
  assert.equal(daily.activeByDevice.find(x => x.device === 'pc').observedActiveSeconds, 300)
  assert.equal(daily.activeByDevice.find(x => x.device === 'iphone').observedActiveSeconds, null)
  assert.equal(daily.totalSeconds, undefined)
})

test('missing data stays unknown; invalid timezone/duration are rejected and text escaped', () => {
  const source = normalize(input([
    event(1, when, 30, { app: '<img>\n# injection' }),
    event(2, '2026-10-18T09:00:00', 30, {}), event(3, when, -2, {})
  ]))
  const daily = dailyTimeline(source, '2026-10-18')
  assert.equal(daily.events.length, 1)
  assert.equal(daily.activeByDevice[0].observedActiveSeconds, null)
  assert.ok(daily.warnings.some(x => x.includes('无效')))
  assert.ok(!markdown(daily).includes('<img>'))
  assert.match(markdown(dailyTimeline(source, '2026-10-19')), /暂无记录/)
})

test('archives raw snapshots once and keeps both revisions for late data', async () => {
  const logs = path.resolve(__dirname, '../logs')
  await fs.mkdir(logs, { recursive: true })
  const out = await fs.mkdtemp(path.join(logs, 'device-timeline-test-'))
  const source = input([event(1, when, 30, { app: 'Demo' })])
  const first = await writeArchive(source, out, ['2026-10-18'])
  const second = await writeArchive(source, out, ['2026-10-18'])
  assert.notEqual(first[0].path, second[0].path)
  assert.equal((await fs.readdir(path.join(out, 'raw'))).length, 1)
  const latest = JSON.parse(await fs.readFile(path.join(out, '2026-10-18/latest.json'), 'utf8'))
  const daily = JSON.parse(await fs.readFile(path.join(out, '2026-10-18', latest.timeline), 'utf8'))
  assert.equal(daily.events.length, 1)
  assert.equal(daily.status, 'provisional')
  assert.equal(daily.raw.sha256.length, 64)
  await fs.access(path.join(first[0].path, 'timeline.json'))
  const phoneOnly = { buckets: { 'phone-only': { type: 'currentwindow', hostname: 'phone', events: [event(1, when, 45, { app: 'Phone' })] } } }
  const third = await writeArchive(phoneOnly, out, ['2026-10-18'])
  const merged = JSON.parse(await fs.readFile(path.join(third[0].path, 'timeline.json'), 'utf8'))
  assert.equal(merged.events.length, 2)
  assert.equal(merged.rawSources.length, 2)
  assert.ok(merged.events.every(event => event.rawSha256.length === 64))
})

test('refuses remote ActivityWatch servers before making requests', async () => {
  await assert.rejects(fetchExport('https://example.com'), /只允许本机/)
  await assert.rejects(fetchExport('http://192.168.1.20:5600'), /只允许本机/)
})

test('reads a local ActivityWatch export without uploading', async () => {
  const source = input([event(1, when, 30, { app: 'Local demo' })])
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'GET')
    assert.equal(request.url, '/api/0/export')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(source))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    assert.deepEqual(await fetchExport(`http://127.0.0.1:${server.address().port}`), source)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('app reader follows published revisions, limits rows and omits window titles', async () => {
  const logs = path.resolve(__dirname, '../logs')
  const out = await fs.mkdtemp(path.join(logs, 'device-reader-test-'))
  const compiled = path.join(out, 'reader.cjs')
  await require('esbuild').build({ entryPoints: [path.resolve(__dirname, '../electron/services/deviceTimelineService.ts')], outfile: compiled, platform: 'node', format: 'cjs', bundle: true })
  const { readDeviceTimeline } = require(compiled)
  const empty = await readDeviceTimeline(path.join(out, 'missing'))
  assert.equal(empty.success, true)
  assert.equal(empty.days.length, 0)
  assert.equal((await readDeviceTimeline(out, '../../secret')).success, false)
  const source = input(Array.from({ length: 205 }, (_, id) => event(id, when, 30, { app: 'Editor', title: 'PRIVATE TITLE' })))
  await writeArchive(source, out, ['2026-10-18'])
  const visible = await readDeviceTimeline(out)
  assert.equal(visible.success, true)
  assert.equal(visible.events.length, 200)
  assert.equal(visible.totalEvents, 205)
  assert.ok(!JSON.stringify(visible).includes('PRIVATE TITLE'))
  await fs.writeFile(path.join(out, '2026-10-18/latest.json'), JSON.stringify({ revision: '../secret' }))
  assert.equal((await readDeviceTimeline(out)).success, false)
})
