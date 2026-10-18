import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(join(root, 'logs'), { recursive: true })
const scratch = await mkdtemp(join(root, 'logs', 'chat-diary-test-'))
await build({ entryPoints: [join(root, 'src/utils/chatDiary.ts')], outfile: join(scratch, 'diary.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { importDiaryFiles, buildDailyDiary, diaryMarkdown, shanghaiDate } = await import(pathToFileURL(join(scratch, 'diary.mjs')).href)
const timestamp = Date.parse('2026-10-17T16:00:00Z') / 1000
const file = (sessionId, messages, more = {}) => ({ name: `${sessionId}.json`, content: JSON.stringify({ session: { wxid: sessionId, displayName: sessionId }, messages, ...more }) })
const message = (senderUsername, content, more = {}) => ({ senderUsername, senderDisplayName: '同名人物', createTime: timestamp, content, ...more })

test('daily boundaries always use Shanghai time, regardless of host timezone', () => {
  assert.equal(shanghaiDate(timestamp - 1).day, '2026-10-17')
  assert.deepEqual(shanghaiDate(timestamp), { day: '2026-10-18', time: '00:00' })
})
test('same wxid joins across sessions; same names and session-local message IDs do not merge', () => {
  const archive = importDiaryFiles([file('group@chatroom', [message('alice', '甲', { platformMessageId: '1' }), message('bob', '乙', { platformMessageId: '2' })]), file('private', [message('alice', '丙', { platformMessageId: '1' })])])
  assert.equal(archive.people.length, 2)
  assert.equal(archive.messages.length, 3)
  const diary = buildDailyDiary(archive, '2026-10-18')
  assert.equal(diary.crossSessionPeople[0].id, 'alice')
  assert.equal(diary.crossSessionPeople[0].sessions.length, 2)
})
test('supports compact Arkme sender IDs and retains emoji captions', () => {
  const archive = importDiaryFiles([file('group@chatroom', [{ senderID: 1, createTime: timestamp, emojiCaption: '笑脸', localType: 47 }], { senders: [{ senderID: 1, wxid: 'alice', displayName: '阿甲' }] })])
  assert.equal(archive.messages[0].senderId, 'alice')
  assert.equal(archive.messages[0].content, '[表情] 笑脸')
})
test('overlapping stable IDs deduplicate; exported localId ordinals and zero IDs do not', () => {
  const archive = importDiaryFiles([file('s', [message('a', '一', { platformMessageId: '1' }), message('a', '二', { localId: 1, serverId: 0 })]), file('s', [message('a', '一', { platformMessageId: '1' }), message('a', '三', { localId: 1, serverId: 0 })])])
  assert.equal(archive.messages.length, 3)
  assert.ok(archive.warnings.some(warning => warning.includes('没有稳定消息 ID')))
})
test('quote links stay within a session and preserve earlier-day evidence in Markdown', () => {
  const archive = importDiaryFiles([file('s', [message('alice', '昨天的原文', { createTime: timestamp - 60, platformMessageId: 'old' }), message('bob', '今天回复', { platformMessageId: 'new', replyToMessageId: 'old' })]), file('other', [message('c', '不能串到这里', { platformMessageId: 'old' })])])
  const diary = buildDailyDiary(archive, '2026-10-18', ['bob'])
  assert.equal(diary.replies.length, 1)
  assert.equal(diary.replies[0].to.senderId, 'alice')
  assert.equal(diary.replies[0].originalOutsideFilter, true)
  assert.match(diaryMarkdown(diary), /昨天的原文/)
  assert.doesNotMatch(diaryMarkdown(diary), /不能串到这里/)
})
test('invalid files and missing identity are reported rather than inventing people', () => {
  const archive = importDiaryFiles([{ name: 'broken.json', content: '{' }, file('s', [{ createTime: timestamp, content: '匿名' }, message('a', '可用消息')])])
  assert.equal(archive.messages.length, 1)
  assert.equal(archive.warnings.filter(warning => warning.includes('未')).length, 2)
  assert.equal(buildDailyDiary(archive, '2026-10-18', [], '不存在的词').messages.length, 0)
})
test('identical files are skipped and source markup is escaped in Markdown', () => {
  const source = file('s', [message('a', '[点击](https://example.invalid) <img src=x>')])
  const archive = importDiaryFiles([source, { ...source, name: 'copy.json' }])
  assert.equal(archive.files, 1)
  const markdown = diaryMarkdown(buildDailyDiary(archive, '2026-10-18'))
  assert.ok(!markdown.includes('<img'))
  assert.ok(markdown.includes('\\[点击\\]'))
})
