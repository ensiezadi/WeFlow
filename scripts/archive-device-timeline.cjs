// Local-only ActivityWatch adapter. No packages, uploads, or OS scheduling required.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const DAY = 86400000
const OFFSET = 8 * 3600000
const LIMIT = 100 * 1024 * 1024
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const iso = value => new Date(value).toISOString()
const dayOf = value => new Date(value + OFFSET).toISOString().slice(0, 10)
const escape = value => String(value).replace(/[\r\n]/g, ' ').replace(/[&<>\\`*_{}\[\]()#!|]/g, char => `&#${char.charCodeAt(0)};`)

function bounds(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期必须为 YYYY-MM-DD')
  const start = Date.parse(`${day}T00:00:00+08:00`)
  if (!Number.isFinite(start) || dayOf(start) !== day) throw new Error('日期无效')
  return [start, start + DAY]
}

function normalize(input) {
  if (!input || typeof input.buckets !== 'object' || Array.isArray(input.buckets) || input.buckets === null) {
    throw new Error('需要 ActivityWatch 导出的 {buckets:{...}} JSON')
  }
  const events = []
  const warnings = new Set()
  for (const [bucketId, bucket] of Object.entries(input.buckets)) {
    if (!bucket || !Array.isArray(bucket.events)) throw new Error(`数据桶缺少 events: ${bucketId}`)
    const kind = bucket.type === 'currentwindow' ? 'foreground'
      : bucket.type === 'afkstatus' ? 'afk'
        : /screentime/i.test(bucketId) ? 'screen-time' : null
    if (!kind) { warnings.add(`未解析的数据桶：${bucketId}`); continue }
    const seen = new Map()
    for (const raw of bucket.events) {
      const start = typeof raw?.timestamp === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(raw.timestamp)
        ? Date.parse(raw.timestamp) : NaN
      const duration = raw?.duration
      if (!Number.isFinite(start) || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 ||
          !Number.isFinite(start + duration * 1000) || Math.abs(start + duration * 1000) > 8.64e15 ||
          !raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) {
        warnings.add(`跳过无效记录：${bucketId}`); continue
      }
      const sourceId = raw.id === undefined || raw.id === null ? `hash:${hash(JSON.stringify(raw))}` : String(raw.id)
      const event = {
        evidenceId: `E${hash(`${bucketId}\0${sourceId}`).slice(0, 24)}`,
        source: 'activitywatch', bucketId, sourceId,
        device: typeof bucket.hostname === 'string' && bucket.hostname ? bucket.hostname : bucketId,
        kind, start: iso(start), end: iso(start + duration * 1000),
        originalTimestamp: raw.timestamp, data: raw.data,
        precision: kind === 'screen-time' ? 'best-effort-interval' : 'sampled-interval'
      }
      if (seen.has(sourceId) && JSON.stringify(seen.get(sourceId)) !== JSON.stringify(event)) {
        throw new Error(`同一来源 ID 内容冲突，拒绝静默合并：${bucketId}/${sourceId}`)
      }
      seen.set(sourceId, event)
    }
    events.push(...seen.values())
    if (kind === 'screen-time') warnings.add('iOS 屏幕记录来自同步导入，时间段可能不完整。')
  }
  if (events.length > 200000) throw new Error('超过 20 万条记录，请先缩小导出范围')
  return { events, warnings: [...warnings] }
}

function union(intervals) {
  const result = []
  for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
    const previous = result.at(-1)
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1])
    else result.push([...interval])
  }
  return result
}

function dailyTimeline(normalized, day, receivedAt = new Date().toISOString()) {
  const [start, end] = bounds(day)
  const events = normalized.events.filter(event => {
    const a = Date.parse(event.start), b = Date.parse(event.end)
    return a === b ? a >= start && a < end : a < end && b > start
  }).map(event => ({ ...event, displayStart: iso(Math.max(start, Date.parse(event.start))), displayEnd: iso(Math.min(end, Date.parse(event.end))) }))
    .sort((a, b) => a.displayStart.localeCompare(b.displayStart) || a.evidenceId.localeCompare(b.evidenceId))
  // Active time is an intersection on the same host; unknown AFK coverage stays unknown.
  const activeByDevice = []
  for (const device of [...new Set(events.map(event => event.device))].sort()) {
    const windows = events.filter(event => event.device === device && event.kind === 'foreground')
    const afk = events.filter(event => event.device === device && event.kind === 'afk')
    const available = union(afk.filter(event => event.data.status === 'not-afk').map(event => [Date.parse(event.displayStart), Date.parse(event.displayEnd)]))
    const active = []
    for (const event of windows) {
      for (const [a, b] of available) {
        const left = Math.max(a, Date.parse(event.displayStart)), right = Math.min(b, Date.parse(event.displayEnd))
        if (left < right) active.push([left, right])
      }
    }
    activeByDevice.push({ device, observedActiveSeconds: afk.length ? union(active).reduce((sum, [a, b]) => sum + (b - a) / 1000, 0) : null })
  }
  return {
    schemaVersion: 1, kind: 'weflow-device-timeline', day, timezone: 'Asia/Shanghai', receivedAt,
    status: 'provisional', warnings: [...normalized.warnings,
      '缺少记录不代表没有活动；所有日记均允许迟到数据修订。',
      '前台记录不证明完成工作；跨设备同时使用不累计成人的总时长。',
      '健康、GROW、聊天数据尚未通过此适配器接入。'],
    activeByDevice, events
  }
}

function markdown(timeline) {
  const clock = value => new Date(Date.parse(value) + OFFSET).toISOString().slice(11, 19)
  const lines = [`# ${timeline.day} 设备时间线`, '', 'Asia/Shanghai · 暂存版本，可由迟到记录修订。', '',
    '以下是设备记录摘录，不推断心情、动机或完成事项。', '']
  for (const event of timeline.events) {
    const label = event.kind === 'afk' ? `活动状态：${event.data.status ?? '未知'}`
      : `前台应用：${event.data.app ?? event.data.bundle_id ?? event.data.package ?? '未知应用'}`
    lines.push(`- ${clock(event.displayStart)}–${clock(event.displayEnd)} · ${escape(event.device)} · ${escape(label)} [${event.evidenceId}]`)
  }
  if (!timeline.events.length) lines.push('暂无记录。')
  lines.push('', '## 数据说明', '', ...timeline.warnings.map(warning => `- ${escape(warning)}`))
  return lines.join('\n') + '\n'
}

async function writeArchive(input, out, days, receivedAt = new Date().toISOString()) {
  await fs.mkdir(out, { recursive: true })
  const lockPath = path.join(out, '.archive.lock')
  const lock = await fs.open(lockPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error('归档目录正在使用或留有中断锁，请检查 .archive.lock')
    throw error
  })
  try { return await writeArchiveLocked(input, out, days, receivedAt) }
  finally { await lock.close(); await fs.unlink(lockPath) }
}

async function writeArchiveLocked(input, out, days, receivedAt) {
  normalize(input)
  days.forEach(bounds)
  const raw = JSON.stringify(input)
  const digest = hash(raw)
  const rawDir = path.join(out, 'raw')
  await fs.mkdir(rawDir, { recursive: true })
  const rawFile = `${digest}.json`
  try { await fs.writeFile(path.join(rawDir, rawFile), raw, { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  // Each bucket is a complete snapshot. New devices join; absent devices are retained.
  const indexPath = path.join(out, 'sources.json')
  let prior = { buckets: {} }
  try { prior = JSON.parse(await fs.readFile(indexPath, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const references = { ...prior.buckets }
  for (const bucketId of Object.keys(input.buckets)) references[bucketId] = digest
  const merged = { buckets: Object.create(null) }
  const snapshots = new Map([[digest, input]])
  for (const [bucketId, sha] of Object.entries(references)) {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('来源索引损坏')
    if (!snapshots.has(sha)) {
      const text = await fs.readFile(path.join(rawDir, `${sha}.json`), 'utf8')
      if (hash(text) !== sha) throw new Error('原始来源快照校验失败')
      snapshots.set(sha, JSON.parse(text))
    }
    const bucket = snapshots.get(sha).buckets[bucketId]
    if (!bucket) throw new Error('来源索引引用的数据桶不存在')
    merged.buckets[bucketId] = bucket
  }
  const normalized = normalize(merged)
  for (const event of normalized.events) event.rawSha256 = references[event.bucketId]
  const saved = []
  for (const day of days) {
    const revision = crypto.randomUUID()
    const folder = path.join(out, day, 'revisions', revision)
    await fs.mkdir(folder, { recursive: true })
    const timeline = { ...dailyTimeline(normalized, day, receivedAt), raw: { file: `raw/${rawFile}`, sha256: digest },
      rawSources: [...new Set(Object.values(references))].sort().map(sha256 => ({ file: `raw/${sha256}.json`, sha256 })) }
    await fs.writeFile(path.join(folder, 'timeline.json'), JSON.stringify(timeline, null, 2))
    await fs.writeFile(path.join(folder, 'diary.md'), markdown(timeline))
    // Publish only after both files exist. Old versions and source snapshots remain readable.
    const temporary = path.join(out, day, `latest-${revision}.tmp`)
    await fs.writeFile(temporary, JSON.stringify({ revision, receivedAt, timeline: `revisions/${revision}/timeline.json`, diary: `revisions/${revision}/diary.md` }, null, 2))
    await fs.rename(temporary, path.join(out, day, 'latest.json'))
    saved.push({ day, events: timeline.events.length, path: folder })
  }
  const indexTemporary = path.join(out, `sources-${crypto.randomUUID()}.tmp`)
  await fs.writeFile(indexTemporary, JSON.stringify({ schemaVersion: 1, receivedAt, buckets: references }, null, 2))
  await fs.rename(indexTemporary, indexPath)
  return saved
}

async function fetchExport(base = 'http://127.0.0.1:5600') {
  const url = new URL(base)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('只允许本机 ActivityWatch 地址；跨设备数据请通过本地文件汇入')
  }
  const response = await fetch(new URL('/api/0/export', url), { redirect: 'error', signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`ActivityWatch HTTP ${response.status}`)
  let size = 0
  const chunks = []
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > LIMIT) throw new Error('导出超过 100 MB，请使用按日期裁剪的离线导出文件')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function main(argv) {
  const options = { out: path.resolve('local-diary-archive'), watch: false }
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i]
    if (option === '--watch') options.watch = true
    else if (['--input', '--out', '--day', '--server'].includes(option) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[option.slice(2)] = argv[++i]
    else throw new Error(`未知参数或缺少参数值：${option}`)
  }
  if (options.day) bounds(options.day)
  if (options.watch && options.input) throw new Error('--watch 需要本机 ActivityWatch，不能与 --input 混用')
  do {
    try {
      if (options.input && (await fs.stat(options.input)).size > LIMIT) throw new Error('输入超过 100 MB')
      const input = options.input ? JSON.parse(await fs.readFile(options.input, 'utf8')) : await fetchExport(options.server)
      const now = Date.now()
      const days = options.day ? [options.day] : [0, 1, 2].map(back => dayOf(now - back * DAY))
      console.log(JSON.stringify({ success: true, saved: await writeArchive(input, path.resolve(options.out), days) }))
    } catch (error) {
      console.error(JSON.stringify({ success: false, error: error.message }))
      if (!options.watch) { process.exitCode = 1; return }
    }
    if (options.watch) await new Promise(resolve => setTimeout(resolve, 15 * 60000))
  } while (options.watch)
}

module.exports = { normalize, dailyTimeline, markdown, writeArchive, fetchExport, bounds }
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
