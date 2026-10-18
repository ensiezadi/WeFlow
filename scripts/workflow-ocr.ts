import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'

export class WorkflowOcr {
  private worker: ChildProcessWithoutNullStreams | undefined
  private ready: Promise<void> | undefined
  private pending = new Map<string, { resolve: (value: { text: string; language: string }) => void; reject: (error: Error) => void }>()
  languages: string[] = []
  constructor(private script: string, private runtime: string) {}

  private start() {
    if (this.ready) return this.ready
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const worker = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', this.script], { windowsHide: true, stdio: 'pipe' })
    this.worker = worker
    this.ready = new Promise<void>((resolve, reject) => {
      let ready = false
      const timeout = setTimeout(() => { reject(new Error('本地 OCR 启动超时')); worker.kill() }, 20000)
      createInterface({ input: worker.stdout }).on('line', line => {
        try {
          const value = JSON.parse(line.replace(/^\uFEFF/, ''))
          if (value.ready) { ready = true; this.languages = value.languages; clearTimeout(timeout); resolve(); return }
          const pending = this.pending.get(value.id)
          if (pending) {
            this.pending.delete(value.id)
            if (value.error) pending.reject(new Error(value.error))
            else pending.resolve({ text: String(value.text ?? ''), language: String(value.language ?? '') })
          }
        } catch { /* Ignore non-protocol diagnostics, never log captured text. */ }
      })
      let diagnostic = ''
      worker.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-1000) })
      const failed = (error: Error) => {
        clearTimeout(timeout)
        if (!ready) reject(error)
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
        if (this.worker === worker) { this.worker = undefined; this.ready = undefined }
      }
      worker.on('error', failed)
      worker.on('exit', () => failed(new Error(`本地 OCR 进程已退出${diagnostic ? '：' + diagnostic : ''}`)))
    })
    return this.ready
  }

  async recognize(png: Buffer) {
    await this.start()
    const id = randomUUID()
    const file = join(this.runtime, `ocr-${id}.png`)
    await writeFile(file, png, { flag: 'wx' })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<{ text: string; language: string }>((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        timer = setTimeout(() => { this.pending.delete(id); this.worker?.kill(); reject(new Error('本地 OCR 识别超时')) }, 20000)
        this.worker!.stdin.write(JSON.stringify({ id, path: file }) + '\n', error => { if (error) { this.pending.delete(id); reject(error) } })
      })
    } finally { clearTimeout(timer); await unlink(file).catch(() => {}) }
  }

  close() { this.worker?.kill() }
}
