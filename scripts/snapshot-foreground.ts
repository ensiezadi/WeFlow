import * as koffi from 'koffi'
import { win32 } from 'node:path'
import { isGameExecutable } from '../electron/services/workflowGameGuard'

export function watchForeground(onChange: () => void) {
  if (process.platform !== 'win32') throw new Error('窗口事件监听当前仅支持 Windows')
  const user32 = koffi.load('user32.dll')
  const callbackType = koffi.proto('void __stdcall SnapshotWinEvent(void *hook, uint32_t event, void *hwnd, int32_t object, int32_t child, uint32_t thread, uint32_t time)')
  const install = user32.func('__stdcall', 'SetWinEventHook', 'void *', ['uint32_t', 'uint32_t', 'void *', koffi.pointer(callbackType), 'uint32_t', 'uint32_t', 'uint32_t'])
  const uninstall = user32.func('int __stdcall UnhookWinEvent(void *hook)')
  const foreground = user32.func('void * __stdcall GetForegroundWindow()')
  const windowStyle = user32.func('int32_t __stdcall GetWindowLongW(void *window, int index)')
  const shell32 = koffi.load('shell32.dll')
  const notificationState = shell32.func('int32_t __stdcall SHQueryUserNotificationState(_Out_ int32_t *state)')
  const rectType = koffi.struct('SnapshotWindowRect', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' })
  const windowRect = user32.func('__stdcall', 'GetWindowRect', 'int', ['void *', koffi.out(koffi.pointer(rectType))])
  const title = user32.func('int __stdcall GetWindowTextW(void *window, void *buffer, int maxCount)')
  const processId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *window, _Out_ uint32_t *processId)')
  const kernel32 = koffi.load('kernel32.dll')
  const openProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t processId)')
  const processName = kernel32.func('int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *buffer, _Inout_ uint32_t *size)')
  const closeHandle = kernel32.func('int __stdcall CloseHandle(void *handle)')
  const callback = koffi.register(onChange, koffi.pointer(callbackType))
  // EVENT_SYSTEM_FOREGROUND, out-of-context delivery on Electron's main message loop.
  const hook = install(3, 3, null, callback, 0, 0, 0)
  if (!hook) { koffi.unregister(callback); throw new Error('无法注册前台窗口事件') }
  return {
    current: () => { const window = foreground(); return window ? koffi.address(window).toString() : null },
    context: () => {
      const window = foreground()
      if (!window) return null
      const bounds = { left: 0, top: 0, right: 0, bottom: 0 }
      if (!windowRect(window, bounds) || bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null
      const text = Buffer.alloc(1024)
      const length = title(window, text, 512)
      const pid = [0]
      processId(window, pid)
      let app = ''
      let gameProcess = false
      const process = openProcess(0x1000, 0, pid[0])
      if (process) {
        try {
          const file = Buffer.alloc(65536)
          const size = [32768]
          if (processName(process, 0, file, size)) {
            const executable = file.toString('utf16le', 0, size[0] * 2)
            app = win32.basename(executable).toLowerCase()
            gameProcess = isGameExecutable(executable)
          }
        } finally { closeHandle(process) }
      }
      const state = [0]
      const result = notificationState(state)
      return { windowId: koffi.address(window).toString(), app, title: text.toString('utf16le', 0, length * 2), bounds, gameProcess, notificationState: result === 0 ? state[0] : undefined, windowStyle: windowStyle(window, -16) }
    },
    close: () => { uninstall(hook); koffi.unregister(callback) }
  }
}
