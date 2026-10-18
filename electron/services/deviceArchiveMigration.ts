import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, writeFile, rename, link, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const day = /^\d{4}-\d{2}-\d{2}$/
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
async function json(file: string) {
  try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) }
  catch (error) { if (missing(error)) return {}; throw error }
}
async function digest(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function atomicJson(file: string, data: unknown) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(data, null, 2), { flag: 'wx' })
  await rename(temp, file)
}
export async function importDeviceArchive(sourcePath: string, destinationPath: string) {
  const source = resolve(sourcePath), destination = resolve(destinationPath)
  const inside = (parent: string, child: string) => { const path = relative(parent, child); return !path || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)) }
  if (inside(source, destination) || inside(destination, source)) throw new Error('导入目录不能与软件数据目录相同或互相包含')
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('请选择有效的记录归档目录')
  const sourceEntries = await readdir(source, { withFileTypes: true })
  if (!sourceEntries.some(entry => !entry.isSymbolicLink() && entry.isDirectory() && (entry.name === 'snapshots' || day.test(entry.name)))) throw new Error('此目录不包含可识别的记录归档')
  const marker = join(destination, 'migrations', createHash('sha256').update(source.toLowerCase()).digest('hex') + '.json')
  async function checkParents(target: string) {
    let folder = dirname(target)
    while (inside(destination, folder)) {
      try { const info = await lstat(folder); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('软件归档目录包含链接或无效目录') }
      catch (error) { if (!missing(error)) throw error }
      if (folder === destination) break
      folder = dirname(folder)
    }
  }
  await checkParents(marker)
  try { await lstat(marker); return { copied: 0, alreadyImported: true } } catch (error) { if (!missing(error)) throw error }
  const files: string[] = []
  async function collect(folder: string) {
    const sourceFolder = join(source, folder)
    if ((await lstat(sourceFolder)).isSymbolicLink()) throw new Error('归档包含链接目录，未导入')
    for (const entry of await readdir(sourceFolder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('归档包含链接文件，未导入')
      const file = join(folder, entry.name)
      if (entry.isDirectory()) await collect(file)
      else if (entry.isFile()) files.push(file)
    }
  }
  for (const entry of sourceEntries) {
    if (entry.isSymbolicLink()) throw new Error('归档包含链接文件，未导入')
    if (entry.isDirectory() && (day.test(entry.name) || entry.name === 'raw')) await collect(entry.name)
    if (entry.isFile() && entry.name === 'sources.json') files.push(entry.name)
    if (entry.isDirectory() && entry.name === 'snapshots') {
      for (const child of await readdir(join(source, 'snapshots'), { withFileTypes: true })) {
        if (child.isSymbolicLink()) throw new Error('归档包含链接文件，未导入')
        if (child.isDirectory() && (day.test(child.name) || child.name === 'context')) await collect(join('snapshots', child.name))
      }
    }
  }
  // Preflight all conflicts before copying: existing records and annotations win.
  const pending: string[] = []
  for (const file of files) {
    const target = join(destination, file)
    await checkParents(target)
    try {
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink() || await digest(join(source, file)) !== await digest(target)) throw new Error(`已有同名记录且内容不同，未覆盖：${file}`)
    } catch (error) { if (!missing(error)) throw error; pending.push(file) }
  }
  // Do not import runtime heartbeats, agent binaries or the old enabled state.
  const oldSettingsFile = join(source, 'snapshots', 'settings.json')
  try { if ((await lstat(oldSettingsFile)).isSymbolicLink()) throw new Error('设置文件不能是链接') } catch (error) { if (!missing(error)) throw error }
  const old = await json(oldSettingsFile)
  const settingsFile = join(destination, 'snapshots', 'settings.json')
  await checkParents(settingsFile)
  try { if ((await lstat(settingsFile)).isSymbolicLink()) throw new Error('软件设置文件不能是链接') } catch (error) { if (!missing(error)) throw error }
  const current = await json(settingsFile)
  for (const file of pending) {
    const target = join(destination, file)
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${randomUUID()}.tmp`
    try {
      await copyFile(join(source, file), temp, constants.COPYFILE_EXCL)
      await link(temp, target)
    } finally { await unlink(temp).catch(() => {}) }
  }
  const combined = { ...old, ...current, schemaVersion: 1, enabled: false }
  for (const key of ['deniedApps', 'deniedTitles']) {
    if (Array.isArray(old[key]) || Array.isArray(current[key])) combined[key] = [...new Set([...(Array.isArray(old[key]) ? old[key] : []), ...(Array.isArray(current[key]) ? current[key] : [])])]
  }
  if (old.contextEnabled === false || current.contextEnabled === false) combined.contextEnabled = false
  await atomicJson(settingsFile, combined)
  await atomicJson(marker, { schemaVersion: 1, importedAt: new Date().toISOString(), source, files: files.length })
  return { copied: pending.length, alreadyImported: false }
}
