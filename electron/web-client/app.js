(() => {
  "use strict"

  const $ = (selector) => document.querySelector(selector)
  const elements = {
    loginOverlay: $("#login-overlay"),
    loginForm: $("#login-form"),
    tokenInput: $("#token-input"),
    tokenVisibility: $("#token-visibility"),
    connectButton: $("#connect-button"),
    loginError: $("#login-error"),
    app: $("#app"),
    accountButton: $("#account-button"),
    logoutButton: $("#logout-button"),
    connectionStrip: $(".connection-strip"),
    connectionLabel: $("#connection-label"),
    sessionSearch: $("#session-search"),
    refreshButton: $("#refresh-button"),
    sessionList: $("#session-list"),
    sessionEmpty: $("#session-empty"),
    sidebar: $("#sidebar"),
    mobileMenuButton: $("#mobile-menu-button"),
    mobileScrim: $("#mobile-scrim"),
    chatTitle: $("#chat-title"),
    chatSubtitle: $("#chat-subtitle"),
    welcomePanel: $("#welcome-panel"),
    messagesPanel: $("#messages-panel"),
    messageList: $("#message-list"),
    messageLoading: $("#message-loading"),
    messageError: $("#message-error"),
    loadMoreWrap: $("#load-more-wrap"),
    loadMoreButton: $("#load-more-button"),
    toast: $("#toast"),
    changePasswordOverlay: $("#change-password-overlay"),
    changePasswordForm: $("#change-password-form"),
    changePasswordClose: $("#change-password-close"),
    changePasswordSubmit: $("#change-password-submit"),
    changePasswordError: $("#change-password-error"),
    currentPasswordInput: $("#current-password-input"),
    newPasswordInput: $("#new-password-input"),
    confirmPasswordInput: $("#confirm-password-input"),
  }

  const state = {
    sessions: [],
    selectedSessionId: "",
    selectedSessionName: "",
    messages: [],
    messageOffset: 0,
    messageHasMore: false,
    eventSource: null,
    refreshTimer: null,
    toastTimer: null,
    requestVersion: 0,
  }

  function setAuthenticated(authenticated) {
    elements.loginOverlay.hidden = authenticated
    elements.app.setAttribute("aria-hidden", authenticated ? "false" : "true")
    elements.app.hidden = !authenticated
    if (!authenticated) {
      closeEventStream()
      state.sessions = []
      state.messages = []
      state.selectedSessionId = ""
    }
  }

  async function requestJson(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    })
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = {}
    }
    if (response.status === 401) {
      const error = new Error(payload.error || "登录状态已失效")
      error.code = "UNAUTHORIZED"
      throw error
    }
    if (!response.ok) {
      throw new Error(payload.error || `请求失败 (${response.status})`)
    }
    return payload
  }

  function showToast(message) {
    clearTimeout(state.toastTimer)
    elements.toast.textContent = message
    elements.toast.classList.add("visible")
    state.toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2600)
  }

  function setConnection(mode, label) {
    elements.connectionStrip.classList.remove("connected", "reconnecting")
    if (mode) elements.connectionStrip.classList.add(mode)
    elements.connectionLabel.textContent = label
  }

  function formatTimestamp(timestamp) {
    const value = Number(timestamp || 0)
    if (!value) return ""
    const date = new Date(value > 10_000_000_000 ? value : value * 1000)
    const now = new Date()
    if (date.toDateString() === now.toDateString()) {
      return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)
    }
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date)
  }

  function formatFullTimestamp(timestamp) {
    const value = Number(timestamp || 0)
    if (!value) return ""
    const date = new Date(value > 10_000_000_000 ? value : value * 1000)
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date)
  }

  function dayKey(timestamp) {
    const value = Number(timestamp || 0)
    if (!value) return "unknown"
    const date = new Date(value > 10_000_000_000 ? value : value * 1000)
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
  }

  function displayInitial(name) {
    const text = String(name || "微信").trim()
    return [...text].slice(0, 2).join("").toUpperCase()
  }

  function sessionPreview(session) {
    const preview = String(session.preview || "").trim()
    if (preview) return preview
    if (session.sessionType === "group") return "群聊"
    if (session.sessionType === "channel") return "公众号"
    return "点击查看消息"
  }

  function renderSessions() {
    const keyword = elements.sessionSearch.value.trim().toLowerCase()
    const filtered = state.sessions.filter((session) => {
      if (!keyword) return true
      return String(session.displayName || "").toLowerCase().includes(keyword) ||
        String(session.username || "").toLowerCase().includes(keyword)
    })
    elements.sessionList.replaceChildren()
    elements.sessionEmpty.hidden = filtered.length > 0

    for (const session of filtered) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = `session-item${session.username === state.selectedSessionId ? " active" : ""}`
      button.setAttribute("role", "option")
      button.setAttribute("aria-selected", session.username === state.selectedSessionId ? "true" : "false")

      const avatar = document.createElement("span")
      avatar.className = "session-avatar"
      avatar.textContent = displayInitial(session.displayName || session.username)

      const copy = document.createElement("span")
      copy.className = "session-copy"
      const name = document.createElement("span")
      name.className = "session-name"
      name.textContent = session.displayName || session.username
      const preview = document.createElement("span")
      preview.className = "session-preview"
      preview.textContent = sessionPreview(session)
      copy.append(name, preview)

      const meta = document.createElement("span")
      meta.className = "session-meta"
      const time = document.createElement("span")
      time.textContent = formatTimestamp(session.lastTimestamp)
      meta.append(time)
      const unreadCount = Number(session.unreadCount || 0)
      if (unreadCount > 0) {
        const badge = document.createElement("span")
        badge.className = "unread-badge"
        badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount)
        meta.append(badge)
      }

      button.append(avatar, copy, meta)
      button.addEventListener("click", () => selectSession(session))
      elements.sessionList.append(button)
    }
  }

  async function loadSessions({ selectFirst = false } = {}) {
    const payload = await requestJson("/api/v1/sessions?limit=1000")
    state.sessions = Array.isArray(payload.sessions) ? payload.sessions : []
    renderSessions()
    if (selectFirst && !state.selectedSessionId && state.sessions.length > 0) {
      await selectSession(state.sessions[0])
    }
  }

  function mediaElementFor(message) {
    const mediaUrl = String(message.mediaUrl || "").trim()
    if (!mediaUrl) return null
    let element = null
    if (message.mediaType === "image" || message.mediaType === "emoji") {
      element = document.createElement("img")
      element.alt = message.mediaType === "emoji" ? "动画表情" : "图片"
      element.loading = "lazy"
    } else if (message.mediaType === "voice") {
      element = document.createElement("audio")
      element.controls = true
      element.preload = "metadata"
    } else if (message.mediaType === "video") {
      element = document.createElement("video")
      element.controls = true
      element.preload = "metadata"
    }
    if (!element) return null
    element.className = "message-media"
    element.src = mediaUrl
    element.referrerPolicy = "no-referrer"
    return element
  }

  function renderMessages({ preserveScroll = false } = {}) {
    const panel = elements.messagesPanel
    const oldHeight = panel.scrollHeight
    const oldTop = panel.scrollTop
    elements.messageList.replaceChildren()
    let previousDay = ""

    for (const message of state.messages) {
      const currentDay = dayKey(message.createTime)
      if (currentDay !== previousDay) {
        previousDay = currentDay
        const divider = document.createElement("div")
        divider.className = "date-divider"
        divider.textContent = formatFullTimestamp(message.createTime).split(" ")[0] || ""
        elements.messageList.append(divider)
      }

      const outgoing = Number(message.isSend || 0) === 1
      const row = document.createElement("article")
      row.className = `message-row ${outgoing ? "outgoing" : "incoming"}`
      const block = document.createElement("div")
      block.className = "message-block"

      const sender = document.createElement("p")
      sender.className = "message-sender"
      sender.textContent = outgoing ? "我" : (message.senderDisplayName || message.senderUsername || state.selectedSessionName)

      const bubble = document.createElement("div")
      bubble.className = "message-bubble"
      const content = document.createElement("span")
      content.textContent = message.revoked
        ? "这条消息已被撤回"
        : String(message.content ?? (message.mediaType ? `[${message.mediaType}]` : "[消息]"))
      bubble.append(content)
      const media = mediaElementFor(message)
      if (media && !message.revoked) bubble.append(media)

      const time = document.createElement("p")
      time.className = "message-time"
      time.textContent = formatFullTimestamp(message.createTime)
      block.append(sender, bubble, time)
      row.append(block)
      elements.messageList.append(row)
    }

    elements.loadMoreWrap.hidden = !state.messageHasMore
    requestAnimationFrame(() => {
      if (preserveScroll) panel.scrollTop = panel.scrollHeight - oldHeight + oldTop
      else panel.scrollTop = panel.scrollHeight
    })
  }

  async function loadMessages({ appendOlder = false, quiet = false } = {}) {
    if (!state.selectedSessionId) return
    const version = ++state.requestVersion
    const offset = appendOlder ? state.messageOffset : 0
    if (!quiet) elements.messageLoading.hidden = false
    elements.messageError.hidden = true
    try {
      const params = new URLSearchParams({
        talker: state.selectedSessionId,
        limit: "200",
        offset: String(offset),
      })
      const payload = await requestJson(`/api/v1/messages?${params.toString()}`)
      if (version !== state.requestVersion) return
      const incoming = Array.isArray(payload.messages) ? payload.messages : []
      state.messages = appendOlder ? [...incoming, ...state.messages] : incoming
      state.messageOffset = offset + incoming.length
      state.messageHasMore = payload.hasMore === true
      renderMessages({ preserveScroll: appendOlder })
    } catch (error) {
      if (error.code === "UNAUTHORIZED") {
        setAuthenticated(false)
        elements.loginError.textContent = "登录已失效，请重新输入密码。"
        return
      }
      elements.messageError.textContent = error.message || String(error)
      elements.messageError.hidden = false
    } finally {
      if (version === state.requestVersion) elements.messageLoading.hidden = true
    }
  }

  async function selectSession(session) {
    state.selectedSessionId = session.username
    state.selectedSessionName = session.displayName || session.username
    state.messageOffset = 0
    state.messageHasMore = false
    elements.chatTitle.textContent = state.selectedSessionName
    elements.chatSubtitle.textContent = session.sessionType === "group"
      ? "群聊 · 云端只读镜像"
      : "微信会话 · 云端只读镜像"
    elements.welcomePanel.hidden = true
    elements.messagesPanel.hidden = false
    renderSessions()
    closeMobileSidebar()
    await loadMessages()
  }

  function scheduleRealtimeRefresh(event) {
    clearTimeout(state.refreshTimer)
    const sameSession = event && event.sessionId === state.selectedSessionId
    const label = event?.event === "message.revoke" ? "收到撤回更新" : "收到新消息"
    showToast(sameSession ? label : `${label} · ${event?.groupName || event?.sourceName || "其他会话"}`)
    state.refreshTimer = setTimeout(async () => {
      try {
        await loadSessions()
        if (sameSession) await loadMessages({ quiet: true })
      } catch (error) {
        if (error.code === "UNAUTHORIZED") setAuthenticated(false)
      }
    }, 320)
  }

  function closeEventStream() {
    if (state.eventSource) {
      state.eventSource.close()
      state.eventSource = null
    }
  }

  function connectEventStream() {
    closeEventStream()
    setConnection("reconnecting", "正在连接实时消息…")
    const source = new EventSource("/api/v1/push/messages", { withCredentials: true })
    state.eventSource = source
    source.addEventListener("ready", () => setConnection("connected", "实时消息已连接"))
    source.addEventListener("message.new", (event) => {
      try { scheduleRealtimeRefresh(JSON.parse(event.data)) } catch { scheduleRealtimeRefresh(null) }
    })
    source.addEventListener("message.revoke", (event) => {
      try { scheduleRealtimeRefresh(JSON.parse(event.data)) } catch { scheduleRealtimeRefresh({ event: "message.revoke" }) }
    })
    source.onerror = () => setConnection("reconnecting", "连接中断，正在自动重连…")
  }

  async function login(password) {
    elements.connectButton.disabled = true
    elements.connectButton.textContent = "正在验证…"
    elements.loginError.textContent = ""
    try {
      await requestJson("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      })
      elements.tokenInput.value = ""
      setAuthenticated(true)
      await loadSessions({ selectFirst: true })
      connectEventStream()
    } catch (error) {
      elements.loginError.textContent = error.message || "连接失败"
      setAuthenticated(false)
    } finally {
      elements.connectButton.disabled = false
      elements.connectButton.textContent = "连接 WeFlow"
    }
  }

  async function resumeSession() {
    try {
      await loadSessions({ selectFirst: true })
      setAuthenticated(true)
      connectEventStream()
    } catch {
      setAuthenticated(false)
      elements.tokenInput.focus()
    }
  }

  async function logout() {
    try {
      await requestJson("/api/v1/auth/logout", { method: "POST", body: JSON.stringify({ logout: true }) })
    } catch {
      // The local UI is cleared even if the network request fails.
    }
    setAuthenticated(false)
    elements.tokenInput.focus()
  }

  function openChangePassword() {
    if (!elements.app || elements.app.hidden) return
    elements.changePasswordError.textContent = ""
    elements.currentPasswordInput.value = ""
    elements.newPasswordInput.value = ""
    elements.confirmPasswordInput.value = ""
    elements.changePasswordOverlay.hidden = false
    elements.currentPasswordInput.focus()
  }

  function closeChangePassword() {
    elements.changePasswordOverlay.hidden = true
    // Wipe the in-memory password fields so they don't linger in the DOM.
    elements.currentPasswordInput.value = ""
    elements.newPasswordInput.value = ""
    elements.confirmPasswordInput.value = ""
  }

  async function submitChangePassword(event) {
    event.preventDefault()
    const currentPassword = elements.currentPasswordInput.value
    const newPassword = elements.newPasswordInput.value
    const confirmPassword = elements.confirmPasswordInput.value
    elements.changePasswordError.textContent = ""
    if (newPassword !== confirmPassword) {
      elements.changePasswordError.textContent = "两次输入的新密码不一致"
      return
    }
    elements.changePasswordSubmit.disabled = true
    elements.changePasswordSubmit.textContent = "正在更新…"
    try {
      await requestJson("/api/v1/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      closeChangePassword()
      // Server bumped auth generation: all cookies (including the current one)
      // are now invalid. Force a clean re-login.
      closeEventStream()
      setAuthenticated(false)
      elements.loginError.textContent = "密码已更新，请使用新密码重新登录。"
      elements.tokenInput.focus()
    } catch (error) {
      elements.changePasswordError.textContent = error.message || "更新失败"
    } finally {
      elements.changePasswordSubmit.disabled = false
      elements.changePasswordSubmit.textContent = "更新密码"
      // Wipe password fields so they don't sit in the DOM after the call.
      elements.currentPasswordInput.value = ""
      elements.newPasswordInput.value = ""
      elements.confirmPasswordInput.value = ""
    }
  }

  function openMobileSidebar() {
    elements.sidebar.classList.add("mobile-open")
    elements.mobileScrim.hidden = false
  }

  function closeMobileSidebar() {
    elements.sidebar.classList.remove("mobile-open")
    elements.mobileScrim.hidden = true
  }

  elements.loginForm.addEventListener("submit", (event) => {
    event.preventDefault()
    const password = elements.tokenInput.value
    if (password) login(password)
  })
  elements.tokenVisibility.addEventListener("click", () => {
    const visible = elements.tokenInput.type === "text"
    elements.tokenInput.type = visible ? "password" : "text"
    elements.tokenVisibility.textContent = visible ? "显示" : "隐藏"
  })
  elements.logoutButton.addEventListener("click", logout)
  elements.accountButton.addEventListener("click", openChangePassword)
  elements.changePasswordClose.addEventListener("click", closeChangePassword)
  elements.changePasswordForm.addEventListener("submit", submitChangePassword)
  elements.changePasswordOverlay.addEventListener("click", (event) => {
    if (event.target === elements.changePasswordOverlay) closeChangePassword()
  })
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.changePasswordOverlay.hidden) closeChangePassword()
  })
  elements.sessionSearch.addEventListener("input", renderSessions)
  elements.refreshButton.addEventListener("click", async () => {
    elements.refreshButton.disabled = true
    try {
      await loadSessions()
      if (state.selectedSessionId) await loadMessages({ quiet: true })
      showToast("已刷新")
    } catch (error) {
      showToast(error.message || "刷新失败")
    } finally {
      elements.refreshButton.disabled = false
    }
  })
  elements.loadMoreButton.addEventListener("click", () => loadMessages({ appendOlder: true }))
  elements.mobileMenuButton.addEventListener("click", openMobileSidebar)
  elements.mobileScrim.addEventListener("click", closeMobileSidebar)
  window.addEventListener("beforeunload", closeEventStream)

  setAuthenticated(false)
  resumeSession()
})()
