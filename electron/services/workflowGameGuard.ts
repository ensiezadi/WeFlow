export interface GameWindow {
  app: string
  gameProcess?: boolean
  notificationState?: number
  windowStyle?: number
  bounds: { left: number; top: number; right: number; bottom: number }
}
export function isGameExecutable(path: string) {
  return /(?:^|[\\/])steamapps[\\/](?:common|compatdata)[\\/]/i.test(path) || /(?:^|[\\/])darksoulsiii\.exe$/i.test(path)
}
export function workflowGameBlockReason(source: GameWindow, displays: { x: number; y: number; width: number; height: number }[]) {
  if (source.gameProcess || source.app.toLowerCase() === 'darksoulsiii.exe') return '游戏运行中，已暂停采集'
  // Windows notification state: Direct3D full screen (3), presentation mode (4).
  if (source.notificationState === 3 || source.notificationState === 4) return '全屏游戏或演示模式，已暂停采集'
  const captioned = source.windowStyle === undefined || (source.windowStyle & 0x00c00000) !== 0
  if (!captioned && displays.some(display => source.bounds.left <= display.x + 2 && source.bounds.top <= display.y + 2 && source.bounds.right >= display.x + display.width - 2 && source.bounds.bottom >= display.y + display.height - 2)) return '无边框全屏窗口，已暂停采集'
  return undefined
}
