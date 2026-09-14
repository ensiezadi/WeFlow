import { net } from 'electron'

export interface AiHttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface AiHttpTextResponse {
  statusCode: number
  body: string
}

/**
 * 使用 Electron Chromium 网络栈发送请求。
 * 与 Node 原生 https.request 不同，它会遵循 macOS/Windows 的系统代理配置。
 */
export async function requestText(
  url: string,
  options: AiHttpRequestOptions,
  timeoutMs: number
): Promise<AiHttpTextResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const headers = Object.fromEntries(
    Object.entries(options.headers || {}).filter(([name]) => name.toLowerCase() !== 'content-length')
  )

  try {
    const response = await net.fetch(url, {
      method: options.method,
      headers,
      body: options.body,
      signal: controller.signal
    })
    return {
      statusCode: response.status,
      body: await response.text()
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('API 请求超时')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
