import * as https from 'https'
import { URL } from 'url'
import { ConfigService } from './config'

export type TelegramParseMode = 'Markdown' | 'MarkdownV2' | 'HTML'

export interface TelegramSendOptions {
  chatId: string
  text: string
  parseMode?: TelegramParseMode
  disableWebPagePreview?: boolean
  disableNotification?: boolean
}

export interface TelegramDiscoveryResult {
  ok: boolean
  botUsername?: string
  botId?: number
  chats: Array<{
    chatId: string
    type: 'private' | 'group' | 'supergroup' | 'channel'
    title?: string
    username?: string
    firstName?: string
    lastName?: string
    lastMessageAt?: number
  }>
  error?: string
}

export interface TelegramTriggerFlags {
  onInsight: boolean
  onExport: boolean
  onNewMessage: boolean
}

interface TelegramConfigSnapshot {
  enabled: boolean
  token: string
  chatIds: string[]
  triggers: TelegramTriggerFlags
  newMessageCooldownMs: number
  newMessageSessionFilter: { mode: 'all' | 'whitelist' | 'blacklist'; ids: string[] }
}

const DEFAULT_COOLDOWN_MS = 5_000
const TELEGRAM_HOST = 'api.telegram.org'
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Telegram Bot API service for WeFlow.
 *
 * Provides:
 * - sendMessage (MarkdownV2 with safe escaping)
 * - Auto-discover chat_ids via getUpdates (so the user only has to paste
 *   a bot token; we read pending updates after they message the bot)
 * - Per-trigger config (insight / export / new message)
 * - Per-session cooldown for the noisy new-message trigger
 */
export class TelegramService {
  private readonly config = new ConfigService()
  private lastMessagePushAt = new Map<string, number>()
  private resolvedConfig: TelegramConfigSnapshot | null = null
  private resolvedConfigAt = 0
  private static readonly CONFIG_CACHE_MS = 30_000

  /**
   * Telegram MarkdownV2 reserved characters that must be escaped in user
   * content. See https://core.telegram.org/bots/api#markdownv2-style
   */
  static escapeMarkdownV2(text: string): string {
    return String(text ?? '').replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
  }

  /** Less strict: only escape HTML-like characters. Useful for short titles. */
  static escapeHtml(text: string): string {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  private readConfig(): TelegramConfigSnapshot {
    const now = Date.now()
    if (this.resolvedConfig && now - this.resolvedConfigAt < TelegramService.CONFIG_CACHE_MS) {
      return this.resolvedConfig
    }
    // Prefer the new generic keys; fall back to the legacy insight-only
    // ones so users who set up Telegram for AI Insights keep working.
    const newToken = String(this.config.get('telegramBotToken') || '').trim()
    const legacyToken = String(this.config.get('aiInsightTelegramToken') || '').trim()
    const token = newToken || legacyToken
    const newEnabled = this.config.get('telegramEnabled')
    const legacyEnabled = this.config.get('aiInsightTelegramEnabled')
    const enabled = newEnabled !== undefined ? Boolean(newEnabled) : Boolean(legacyEnabled)
    const newChatIds = String(this.config.get('telegramChatIds') || '').trim()
    const legacyChatIds = String(this.config.get('aiInsightTelegramChatIds') || '').trim()
    const chatIdsRaw = newChatIds || legacyChatIds
    const chatIds = chatIdsRaw ? chatIdsRaw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean) : []
    const triggers: TelegramTriggerFlags = {
      onInsight: this.config.get('telegramOnInsight') !== false,  // default true
      onExport: this.config.get('telegramOnExport') === true,    // default false (noisy)
      onNewMessage: this.config.get('telegramOnNewMessage') === true
    }
    const cooldownRaw = Number(this.config.get('telegramNewMessageCooldownMs'))
    const newMessageCooldownMs = Number.isFinite(cooldownRaw) && cooldownRaw >= 0
      ? cooldownRaw
      : DEFAULT_COOLDOWN_MS
    const filterMode = String(this.config.get('telegramNewMessageFilterMode') || 'all')
    const newMessageSessionFilter = {
      mode: (filterMode === 'whitelist' || filterMode === 'blacklist') ? filterMode : 'all' as const,
      ids: String(this.config.get('telegramNewMessageFilterIds') || '')
        .split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
    }
    this.resolvedConfig = {
      enabled, token, chatIds, triggers,
      newMessageCooldownMs, newMessageSessionFilter
    }
    this.resolvedConfigAt = now
    return this.resolvedConfig
  }

  private invalidateConfigCache(): void {
    this.resolvedConfig = null
    this.resolvedConfigAt = 0
  }

  isReady(): { ready: boolean; reason?: string } {
    const cfg = this.readConfig()
    if (!cfg.enabled) return { ready: false, reason: 'Telegram 推送未启用' }
    if (!cfg.token) return { ready: false, reason: '未配置 Bot Token' }
    if (cfg.chatIds.length === 0) return { ready: false, reason: '尚未发现任何 chat_id' }
    return { ready: true }
  }

  async sendMessage(options: TelegramSendOptions): Promise<void> {
    return this.callApi(options.chatId, options.text, options.parseMode ?? 'MarkdownV2',
      options.disableWebPagePreview ?? false, options.disableNotification ?? false)
  }

  /**
   * High-level send that respects enabled/token/chatIds config and the
   * per-trigger toggle. Returns a non-throwing result so callers in fire-
   * and-forget paths don't need to wrap every push in try/catch.
   */
  async sendForTrigger(
    trigger: keyof TelegramTriggerFlags,
    text: string,
    options?: { parseMode?: TelegramParseMode; sessionId?: string; silent?: boolean }
  ): Promise<{ sent: boolean; reason?: string }> {
    const cfg = this.readConfig()
    if (!cfg.enabled) return { sent: false, reason: 'disabled' }
    if (!cfg.triggers[trigger]) return { sent: false, reason: `trigger ${trigger} disabled` }
    if (!cfg.token) return { sent: false, reason: 'no token' }
    if (cfg.chatIds.length === 0) return { sent: false, reason: 'no chat_ids' }

    if (trigger === 'onNewMessage' && options?.sessionId) {
      const allowed = this.sessionFilterAllows(cfg, options.sessionId)
      if (!allowed) return { sent: false, reason: 'session filtered out' }
      const last = this.lastMessagePushAt.get(options.sessionId) || 0
      if (Date.now() - last < cfg.newMessageCooldownMs) {
        return { sent: false, reason: 'cooldown' }
      }
    }

    const parseMode = options?.parseMode ?? 'MarkdownV2'
    const results = await Promise.allSettled(
      cfg.chatIds.map(chatId => this.callApi(
        chatId, text, parseMode, false, options?.silent ?? false
      ))
    )
    if (trigger === 'onNewMessage' && options?.sessionId) {
      this.lastMessagePushAt.set(options.sessionId, Date.now())
    }
    const failures = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    if (failures.length > 0) {
      console.warn(`[Telegram] ${failures.length}/${cfg.chatIds.length} 推送失败:`,
        failures.map(f => (f.reason as Error)?.message).join('; '))
    }
    return { sent: failures.length < cfg.chatIds.length }
  }

  private sessionFilterAllows(cfg: TelegramConfigSnapshot, sessionId: string): boolean {
    const { mode, ids } = cfg.newMessageSessionFilter
    if (mode === 'all') return true
    const matched = ids.includes(sessionId)
    return mode === 'whitelist' ? matched : !matched
  }

  /**
   * Call `getUpdates` to find chat_ids that have messaged the bot. Telegram
   * returns every incoming message since the last call; we deduplicate by
   * chat id and return a stable list the user can save with one click.
   */
  async discoverChatIds(options: { limit?: number; timeoutSec?: number; consume?: boolean } = {}): Promise<TelegramDiscoveryResult> {
    const cfg = this.readConfig()
    if (!cfg.token) {
      return { ok: false, error: '请先填写 Bot Token', chats: [] }
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100)
    const timeoutSec = Math.min(Math.max(options.timeoutSec ?? 0, 0), 50)
    const path = `/bot${cfg.token}/getUpdates?limit=${limit}&timeout=${timeoutSec}`
    try {
      const data = await this.httpGetJson(TELEGRAM_HOST, path)
      if (!data.ok) {
        return { ok: false, error: String(data.description || 'getUpdates 返回失败'), chats: [] }
      }
      const result = data.result as any[]
      if (options.consume && Array.isArray(result) && result.length > 0) {
        // Acknowledge by calling getUpdates with a high offset, so the bot
        // doesn't re-deliver the same messages next time.
        const maxOffset = Math.max(...result.map((u: any) => Number(u.update_id) || 0))
        await this.httpGetJson(TELEGRAM_HOST, `/bot${cfg.token}/getUpdates?offset=${maxOffset + 1}&limit=1&timeout=0`).catch(() => undefined)
      }
      const chats = new Map<string, TelegramDiscoveryResult['chats'][number]>()
      for (const update of result) {
        const msg = update?.message || update?.edited_message || update?.channel_post
        if (!msg || !msg.chat) continue
        const chat = msg.chat
        const chatId = String(chat.id)
        const lastMessageAt = Number(msg.date) * 1000
        chats.set(chatId, {
          chatId,
          type: chat.type,
          title: chat.title,
          username: chat.username,
          firstName: chat.first_name,
          lastName: chat.last_name,
          lastMessageAt: Number.isFinite(lastMessageAt) ? lastMessageAt : undefined
        })
      }
      // Bot info: call getMe for the username shown in the UI
      let botUsername: string | undefined
      let botId: number | undefined
      try {
        const me = await this.httpGetJson(TELEGRAM_HOST, `/bot${cfg.token}/getMe`)
        if (me.ok && me.result) {
          botUsername = me.result.username
          botId = me.result.id
        }
      } catch { /* not fatal */ }
      return {
        ok: true,
        botUsername,
        botId,
        chats: Array.from(chats.values()).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || String(e), chats: [] }
    }
  }

  async testSend(chatId: string, text = '【WeFlow】测试推送：如果你能看到这条消息，配置成功 ✅'): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.callApi(chatId, text, 'MarkdownV2', false, false)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || String(e) }
    }
  }

  private async callApi(
    chatId: string,
    text: string,
    parseMode: TelegramParseMode,
    disableWebPagePreview: boolean,
    disableNotification: boolean
  ): Promise<void> {
    const cfg = this.readConfig()
    if (!cfg.token) throw new Error('Telegram bot token not configured')
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: disableWebPagePreview,
      disable_notification: disableNotification
    })
    const path = `/bot${cfg.token}/sendMessage`
    const data = await this.httpPostJson(TELEGRAM_HOST, path, body)
    if (!data.ok) {
      throw new Error(`Telegram: ${String(data.description || data.error_code || 'unknown error')}`)
    }
  }

  private httpPostJson(host: string, path: string, body: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: host, port: 443, path, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString()
        }
      }, (res) => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error(`Telegram 响应解析失败: ${data.slice(0, 200)}`))
          }
        })
      })
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error('Telegram 请求超时'))
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  private httpGetJson(host: string, path: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: host, port: 443, path, method: 'GET'
      }, (res) => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error(`Telegram 响应解析失败: ${data.slice(0, 200)}`))
          }
        })
      })
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error('Telegram 请求超时'))
      })
      req.on('error', reject)
      req.end()
    })
  }
}

export const telegramService = new TelegramService()
