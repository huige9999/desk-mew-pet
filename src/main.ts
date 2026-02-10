import './style.css'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { PhysicalPosition, getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window'

type PetAnimState = 'idle' | 'drag' | 'tap_react'
type ChatRuntimeState = 'idle' | 'waiting_first_token' | 'streaming' | 'round_done' | 'error'

type PositionLike = { x: number; y: number }
type SizeLike = { width: number; height: number }
type RectLike = { x: number; y: number; width: number; height: number }
type MonitorLike = {
  position: PositionLike
  size: SizeLike
  workArea?: {
    position: PositionLike
    size: SizeLike
  }
}

type PointerTrack = {
  pointerId: number
  startX: number
  startY: number
  downAt: number
  dragTriggered: boolean
}

type Direction = { x: number; y: number }

type SendAck = {
  ok: boolean
  roundId: number
}

type RetryAck = {
  ok: boolean
  resent: boolean
  roundId?: number | null
}

type StreamChunkPayload = {
  roundId: number
  chunk: string
}

type StreamErrorPayload = {
  roundId: number
  kind: string
  message: string
}

type SessionInterruptedPayload = {
  message: string
}

type FirstSendFailedPayload = {
  title: string
  message: string
}

type OpenAiConfig = {
  openaiApiKey?: string
  openaiBaseUrl?: string
  openaiModel?: string
}

type ApprovalMode = 'default' | 'auto-edit' | 'yolo' | 'plan'

type HeadlessConfig = {
  workingDirectory?: string
  approvalMode?: ApprovalMode
}

type StoredOpenAiConfig = {
  openaiApiKey: string
  openaiBaseUrl: string
  openaiModel: string
  workingDirectory: string
  approvalMode: ApprovalMode
}

const WALK_INTERVAL_MS = 2000
const WALK_DISTANCE_PX = 10
const WALK_ANIMATION_DURATION_MS = 280
const DRAG_TRIGGER_THRESHOLD_PX = 2
const CLICK_MOVE_THRESHOLD_PX = 4
const CLICK_MAX_DURATION_MS = 200

const STREAM_FLUSH_MS = 50
const STREAM_BATCH_CHARS = 8
const ROUND_SILENCE_MS = 800
const FIRST_TOKEN_TIMEOUT_MS = 15000
const ANSI_CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g
const ANSI_OSC_PATTERN = /\u001b\][^\u0007]*(\u0007|\u001b\\)/g

const EMPTY_INPUT_HINT = '请说点什么～'
const THINKING_HINT = '思考中…'
const SESSION_INTERRUPTED_HINT = '会话已中断，请重试'
const STREAM_UNPARSABLE_HINT = '收到终端控制输出，暂未解析到可展示文本。'
const RETRY_FAILED_HINT = '重试失败，请在终端运行 qwen 并完成登录后再试。'
const OPENAI_CONFIG_SAVED_HINT = '配置已保存'
const OPENAI_CONFIG_STORAGE_KEY = 'mew_openai_compatible_config_v2'
const LEGACY_OPENAI_CONFIG_STORAGE_KEY = 'mew_openai_compatible_config_v1'
const DEFAULT_APPROVAL_MODE: ApprovalMode = 'default'

const appWindow = getCurrentWindow()

let currentPetState: PetAnimState = 'idle'
let chatState: ChatRuntimeState = 'idle'
let pointerTrack: PointerTrack | null = null
let isDragging = false
let walkBusy = false
let inputVisible = false
let firstFailModalVisible = false

let currentRoundId = 0
let renderedStreamText = ''
let pendingStreamText = ''
let gotFirstToken = false
let sawRawChunk = false

let walkTimer: number | null = null
let flushTimer: number | null = null
let silenceTimer: number | null = null
let firstTokenTimer: number | null = null

const unlisteners: UnlistenFn[] = []

const WALK_DIRECTIONS: Direction[] = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 }
]

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('Missing #app root element')
}

app.innerHTML = `
  <div class="pet-shell" aria-live="polite">
    <div id="pet" class="pet state-idle" title="点击和我说话">
      <div class="pet-media">
        <img src="/mew/cat.svg" alt="mew cat pet" draggable="false" />
        <span class="blink-eyes" aria-hidden="true">
          <span class="blink-eye blink-eye-left"></span>
          <span class="blink-eye blink-eye-right"></span>
        </span>
        <span class="smile" aria-hidden="true"></span>
      </div>
    </div>

    <form id="chat-form" class="chat-form hidden" autocomplete="off">
      <input
        id="chat-input"
        class="chat-input"
        type="text"
        maxlength="240"
        placeholder="输入后回车，内容会原样发给 qwen"
      />
      <div class="chat-form-actions">
        <button id="provider-config-trigger" class="chat-link-btn" type="button">配置</button>
      </div>
    </form>

    <button id="chat-bubble" class="chat-bubble hidden" type="button"></button>

    <div id="first-fail-modal" class="dialog-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="fail-title">
      <div class="dialog-card">
        <h2 id="fail-title" class="dialog-title"></h2>
        <p id="fail-message" class="dialog-message"></p>
        <div class="dialog-actions">
          <button id="fail-ack" type="button" class="dialog-btn">我知道了</button>
          <button id="fail-retry" type="button" class="dialog-btn dialog-btn-primary">重试</button>
        </div>
      </div>
    </div>

    <div id="provider-config-modal" class="dialog-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="provider-config-title">
      <div class="dialog-card dialog-card-config">
        <h2 id="provider-config-title" class="dialog-title">OpenAI 兼容配置</h2>
        <p class="dialog-message">支持 OpenAI、Azure 或本地兼容端点。保存后会在 headless 调用 qwen 时注入环境变量，并按工作目录启动。</p>

        <div class="config-form">
          <label class="config-field" for="provider-openai-api-key">
            <span class="config-label">OPENAI_API_KEY</span>
            <input id="provider-openai-api-key" class="config-input" type="password" autocomplete="off" placeholder="必填（如果系统环境变量中未设置）" />
          </label>

          <label class="config-field" for="provider-openai-base-url">
            <span class="config-label">OPENAI_BASE_URL</span>
            <input id="provider-openai-base-url" class="config-input" type="text" autocomplete="off" placeholder="可选，例如 https://api.openai.com/v1" />
          </label>

          <label class="config-field" for="provider-openai-model">
            <span class="config-label">OPENAI_MODEL</span>
            <input id="provider-openai-model" class="config-input" type="text" autocomplete="off" placeholder="可选，例如 gpt-4o-mini" />
          </label>

          <label class="config-field" for="provider-working-directory">
            <span class="config-label">工作目录</span>
            <input id="provider-working-directory" class="config-input" type="text" autocomplete="off" placeholder="可选，例如 D:\\assets" />
          </label>

          <label class="config-field" for="provider-approval-mode">
            <span class="config-label">审批模式</span>
            <select id="provider-approval-mode" class="config-input">
              <option value="default">default（默认，需审批）</option>
              <option value="auto-edit">auto-edit（自动改文件）</option>
              <option value="yolo">yolo（自动执行命令，高风险）</option>
              <option value="plan">plan（规划模式）</option>
            </select>
          </label>
        </div>

        <div class="dialog-actions">
          <button id="provider-config-cancel" type="button" class="dialog-btn">取消</button>
          <button id="provider-config-clear" type="button" class="dialog-btn">清空</button>
          <button id="provider-config-save" type="button" class="dialog-btn dialog-btn-primary">保存</button>
        </div>
      </div>
    </div>
  </div>
`

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Missing required UI element: ${selector}`)
  }
  return element
}

const pet = requireElement<HTMLDivElement>('#pet')
const chatForm = requireElement<HTMLFormElement>('#chat-form')
const chatInput = requireElement<HTMLInputElement>('#chat-input')
const chatBubble = requireElement<HTMLButtonElement>('#chat-bubble')
const firstFailModal = requireElement<HTMLDivElement>('#first-fail-modal')
const firstFailTitle = requireElement<HTMLHeadingElement>('#fail-title')
const firstFailMessage = requireElement<HTMLParagraphElement>('#fail-message')
const firstFailAck = requireElement<HTMLButtonElement>('#fail-ack')
const firstFailRetry = requireElement<HTMLButtonElement>('#fail-retry')
const providerConfigTrigger = requireElement<HTMLButtonElement>('#provider-config-trigger')
const providerConfigModal = requireElement<HTMLDivElement>('#provider-config-modal')
const providerConfigApiKey = requireElement<HTMLInputElement>('#provider-openai-api-key')
const providerConfigBaseUrl = requireElement<HTMLInputElement>('#provider-openai-base-url')
const providerConfigModel = requireElement<HTMLInputElement>('#provider-openai-model')
const providerConfigWorkingDirectory = requireElement<HTMLInputElement>('#provider-working-directory')
const providerConfigApprovalMode = requireElement<HTMLSelectElement>('#provider-approval-mode')
const providerConfigCancel = requireElement<HTMLButtonElement>('#provider-config-cancel')
const providerConfigClear = requireElement<HTMLButtonElement>('#provider-config-clear')
const providerConfigSave = requireElement<HTMLButtonElement>('#provider-config-save')

const PET_STATE_CLASS: Record<PetAnimState, string> = {
  idle: 'state-idle',
  drag: 'state-drag',
  tap_react: 'state-tap-react'
}

function normalizeConfigValue(value: string): string {
  return value.trim()
}

function normalizeApprovalMode(value: string): ApprovalMode {
  if (value === 'auto-edit' || value === 'yolo' || value === 'plan') {
    return value
  }
  return DEFAULT_APPROVAL_MODE
}

function normalizeWorkingDirectory(value: string): string {
  return value.replace(/\r/g, '').split(/[\n;]+/)[0]?.trim() ?? ''
}

function loadOpenAiConfigFromStorage(): StoredOpenAiConfig {
  const fallback: StoredOpenAiConfig = {
    openaiApiKey: '',
    openaiBaseUrl: '',
    openaiModel: '',
    workingDirectory: '',
    approvalMode: DEFAULT_APPROVAL_MODE
  }

  window.localStorage.removeItem(LEGACY_OPENAI_CONFIG_STORAGE_KEY)
  const stored = window.localStorage.getItem(OPENAI_CONFIG_STORAGE_KEY)
  if (!stored) {
    return fallback
  }

  try {
    const parsed = JSON.parse(stored) as Partial<StoredOpenAiConfig>
    return {
      openaiApiKey: typeof parsed.openaiApiKey === 'string' ? parsed.openaiApiKey : '',
      openaiBaseUrl: typeof parsed.openaiBaseUrl === 'string' ? parsed.openaiBaseUrl : '',
      openaiModel: typeof parsed.openaiModel === 'string' ? parsed.openaiModel : '',
      workingDirectory: normalizeWorkingDirectory(typeof parsed.workingDirectory === 'string' ? parsed.workingDirectory : ''),
      approvalMode: normalizeApprovalMode(typeof parsed.approvalMode === 'string' ? parsed.approvalMode : DEFAULT_APPROVAL_MODE)
    }
  } catch (error) {
    console.warn('[mew] failed to parse stored OpenAI config, ignoring', error)
    return fallback
  }
}

function saveOpenAiConfigToStorage(config: StoredOpenAiConfig): void {
  const isEmpty = config.openaiApiKey.length === 0
    && config.openaiBaseUrl.length === 0
    && config.openaiModel.length === 0
    && config.workingDirectory.length === 0
    && config.approvalMode === DEFAULT_APPROVAL_MODE
  if (isEmpty) {
    window.localStorage.removeItem(OPENAI_CONFIG_STORAGE_KEY)
    return
  }

  window.localStorage.setItem(OPENAI_CONFIG_STORAGE_KEY, JSON.stringify(config))
}

function applyOpenAiConfigToInputs(config: StoredOpenAiConfig): void {
  providerConfigApiKey.value = config.openaiApiKey
  providerConfigBaseUrl.value = config.openaiBaseUrl
  providerConfigModel.value = config.openaiModel
  providerConfigWorkingDirectory.value = config.workingDirectory
  providerConfigApprovalMode.value = config.approvalMode
}

function readOpenAiConfigFromInputs(): StoredOpenAiConfig {
  return {
    openaiApiKey: normalizeConfigValue(providerConfigApiKey.value),
    openaiBaseUrl: normalizeConfigValue(providerConfigBaseUrl.value),
    openaiModel: normalizeConfigValue(providerConfigModel.value),
    workingDirectory: normalizeWorkingDirectory(providerConfigWorkingDirectory.value),
    approvalMode: normalizeApprovalMode(providerConfigApprovalMode.value)
  }
}

function buildOpenAiConfigPayload(): OpenAiConfig | null {
  const config = readOpenAiConfigFromInputs()
  const payload: OpenAiConfig = {}

  if (config.openaiApiKey.length > 0) {
    payload.openaiApiKey = config.openaiApiKey
  }
  if (config.openaiBaseUrl.length > 0) {
    payload.openaiBaseUrl = config.openaiBaseUrl
  }
  if (config.openaiModel.length > 0) {
    payload.openaiModel = config.openaiModel
  }

  if (!payload.openaiApiKey && !payload.openaiBaseUrl && !payload.openaiModel) {
    return null
  }

  return payload
}

function buildHeadlessConfigPayload(): HeadlessConfig | null {
  const config = readOpenAiConfigFromInputs()
  const payload: HeadlessConfig = {}
  if (config.workingDirectory.length > 0) {
    payload.workingDirectory = config.workingDirectory
  }

  if (config.approvalMode !== DEFAULT_APPROVAL_MODE) {
    payload.approvalMode = config.approvalMode
  }

  if (!payload.workingDirectory && !payload.approvalMode) {
    return null
  }

  return payload
}

function clearPetStateClasses(): void {
  pet.classList.remove(PET_STATE_CLASS.idle, PET_STATE_CLASS.drag, PET_STATE_CLASS.tap_react)
}

function setPetState(nextState: PetAnimState): void {
  currentPetState = nextState
  clearPetStateClasses()

  if (nextState === 'tap_react') {
    void pet.offsetWidth
  }

  pet.classList.add(PET_STATE_CLASS[nextState])
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by)
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min
  }
  return Math.min(max, Math.max(min, value))
}

function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3)
}

function nextAnimationFrame(): Promise<number> {
  return new Promise((resolve) => {
    window.requestAnimationFrame((timestamp) => resolve(timestamp))
  })
}

function getRandomDirectionOrder(): Direction[] {
  const next = [...WALK_DIRECTIONS]
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const value = next[index]
    next[index] = next[swapIndex]
    next[swapIndex] = value
  }
  return next
}

function clearStreamTimers(): void {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }

  if (silenceTimer !== null) {
    window.clearTimeout(silenceTimer)
    silenceTimer = null
  }

  if (firstTokenTimer !== null) {
    window.clearTimeout(firstTokenTimer)
    firstTokenTimer = null
  }
}

function hideBubble(): void {
  clearStreamTimers()
  pendingStreamText = ''
  renderedStreamText = ''
  gotFirstToken = false
  chatBubble.textContent = ''
  chatBubble.classList.add('hidden')
  chatState = 'idle'
}

function showBubbleInstant(message: string): void {
  chatBubble.textContent = message
  chatBubble.classList.remove('hidden')
}

function flushPendingStream(): void {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }

  if (pendingStreamText.length === 0) {
    return
  }

  if (!gotFirstToken) {
    gotFirstToken = true
    renderedStreamText = ''
    chatState = 'streaming'
    if (firstTokenTimer !== null) {
      window.clearTimeout(firstTokenTimer)
      firstTokenTimer = null
    }
  }

  renderedStreamText += pendingStreamText
  pendingStreamText = ''
  showBubbleInstant(renderedStreamText)
}

function scheduleFlush(): void {
  if (flushTimer !== null) {
    return
  }

  flushTimer = window.setTimeout(() => {
    flushPendingStream()
  }, STREAM_FLUSH_MS)
}

function resetSilenceTimer(): void {
  if (silenceTimer !== null) {
    window.clearTimeout(silenceTimer)
  }

  silenceTimer = window.setTimeout(() => {
    flushPendingStream()
    if (chatState === 'error') {
      silenceTimer = null
      return
    }

    if (!gotFirstToken && sawRawChunk) {
      showBubbleInstant(STREAM_UNPARSABLE_HINT)
      chatState = 'error'
      silenceTimer = null
      return
    }

    chatState = 'round_done'
    silenceTimer = null
  }, ROUND_SILENCE_MS)
}

function resetFirstTokenTimer(): void {
  if (firstTokenTimer !== null) {
    window.clearTimeout(firstTokenTimer)
  }

  firstTokenTimer = window.setTimeout(() => {
    if (chatState !== 'waiting_first_token' || gotFirstToken) {
      firstTokenTimer = null
      return
    }

    console.error('[mew] first token timeout from qwen stream')
    showBubbleInstant(SESSION_INTERRUPTED_HINT)
    chatState = 'error'
    firstTokenTimer = null
  }, FIRST_TOKEN_TIMEOUT_MS)
}

function startRound(roundId: number): void {
  clearStreamTimers()
  closeInput()

  currentRoundId = roundId
  renderedStreamText = ''
  pendingStreamText = ''
  gotFirstToken = false
  sawRawChunk = false
  chatState = 'waiting_first_token'

  showBubbleInstant(THINKING_HINT)
  resetFirstTokenTimer()
}

function appendChunk(roundId: number, chunk: string): void {
  if (roundId !== currentRoundId) {
    return
  }

  sawRawChunk = true
  if (!gotFirstToken && firstTokenTimer !== null) {
    window.clearTimeout(firstTokenTimer)
    firstTokenTimer = null
  }
  resetSilenceTimer()

  const sanitizedChunk = chunk
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_OSC_PATTERN, '')
    .replace(/\r/g, '')

  if (sanitizedChunk.length === 0) {
    return
  }

  pendingStreamText += sanitizedChunk

  if ([...pendingStreamText].length >= STREAM_BATCH_CHARS) {
    flushPendingStream()
    return
  }

  scheduleFlush()
}

function openFirstFailModal(title: string, message: string): void {
  firstFailTitle.textContent = title
  firstFailMessage.textContent = message
  firstFailModal.classList.remove('hidden')
  firstFailModalVisible = true
}

function closeFirstFailModal(): void {
  firstFailModal.classList.add('hidden')
  firstFailModalVisible = false
}

function openProviderConfigModal(): void {
  providerConfigModal.classList.remove('hidden')
  providerConfigApiKey.focus()
  providerConfigApiKey.select()
}

function closeProviderConfigModal(): void {
  providerConfigModal.classList.add('hidden')
}

function saveProviderConfig(): void {
  const config = readOpenAiConfigFromInputs()
  saveOpenAiConfigToStorage(config)
  closeProviderConfigModal()
  showBubbleInstant(OPENAI_CONFIG_SAVED_HINT)
}

function clearProviderConfig(): void {
  applyOpenAiConfigToInputs({
    openaiApiKey: '',
    openaiBaseUrl: '',
    openaiModel: '',
    workingDirectory: '',
    approvalMode: DEFAULT_APPROVAL_MODE
  })
  saveOpenAiConfigToStorage({
    openaiApiKey: '',
    openaiBaseUrl: '',
    openaiModel: '',
    workingDirectory: '',
    approvalMode: DEFAULT_APPROVAL_MODE
  })
}

async function retryLastFailedInput(): Promise<void> {
  try {
    const ack = await invoke<RetryAck>('qwen_retry_last')
    if (!ack.ok || !ack.resent || ack.roundId == null) {
      showBubbleInstant(RETRY_FAILED_HINT)
      chatState = 'error'
      return
    }

    startRound(ack.roundId)
  } catch (error) {
    console.error('[mew] retry failed', error)
    showBubbleInstant(RETRY_FAILED_HINT)
    chatState = 'error'
  }
}

function openInput(): void {
  inputVisible = true
  chatForm.classList.remove('hidden')
  chatInput.focus()
  chatInput.select()
}

function closeInput(): void {
  inputVisible = false
  chatForm.classList.add('hidden')
}

function closeChatUI(): void {
  closeInput()
  hideBubble()
  chatInput.value = ''
}

async function submitInput(): Promise<void> {
  const raw = chatInput.value
  const trimmed = raw.trim()

  if (trimmed.length === 0) {
    showBubbleInstant(EMPTY_INPUT_HINT)
    chatState = 'error'
    return
  }

  try {
    const ack = await invoke<SendAck>('qwen_send', {
      input: raw,
      openaiConfig: buildOpenAiConfigPayload(),
      headlessConfig: buildHeadlessConfigPayload()
    })
    if (!ack.ok) {
      showBubbleInstant(SESSION_INTERRUPTED_HINT)
      chatState = 'error'
      return
    }

    chatInput.value = ''
    startRound(ack.roundId)
  } catch (error) {
    console.error('[mew] qwen_send failed', error)
    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), 0)
    })
    if (!firstFailModalVisible) {
      showBubbleInstant(SESSION_INTERRUPTED_HINT)
      chatState = 'error'
    }
  }
}

async function setWindowPosition(x: number, y: number, reason: string): Promise<boolean> {
  try {
    await appWindow.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
    return true
  } catch (error) {
    console.error(`[mew] failed to set window position (${reason})`, error)
    return false
  }
}

async function getMainWorkArea(): Promise<RectLike> {
  const monitor = await primaryMonitor() as MonitorLike | null
  if (monitor) {
    const area = monitor.workArea ?? { position: monitor.position, size: monitor.size }
    return {
      x: area.position.x,
      y: area.position.y,
      width: area.size.width,
      height: area.size.height
    }
  }

  const screenWithAvail = window.screen as Screen & {
    availLeft?: number
    availTop?: number
  }

  return {
    x: screenWithAvail.availLeft ?? 0,
    y: screenWithAvail.availTop ?? 0,
    width: window.screen.availWidth,
    height: window.screen.availHeight
  }
}

async function clampWindowToBounds(): Promise<void> {
  try {
    const [position, size, workArea] = await Promise.all([
      appWindow.outerPosition() as Promise<PositionLike>,
      appWindow.outerSize() as Promise<SizeLike>,
      getMainWorkArea()
    ])

    const minX = workArea.x
    const minY = workArea.y
    const maxX = workArea.x + workArea.width - size.width
    const maxY = workArea.y + workArea.height - size.height

    const x = clamp(position.x, minX, maxX)
    const y = clamp(position.y, minY, maxY)

    if (x !== position.x || y !== position.y) {
      await setWindowPosition(x, y, 'clamp-to-bounds')
    }
  } catch (error) {
    console.error('[mew] failed to clamp window bounds', error)
  }
}

async function animateWindowPosition(from: PositionLike, to: PositionLike): Promise<boolean> {
  const deltaX = to.x - from.x
  const deltaY = to.y - from.y

  if (deltaX === 0 && deltaY === 0) {
    return true
  }

  const startAt = performance.now()
  let lastX = from.x
  let lastY = from.y

  while (true) {
    if (inputVisible || isDragging) {
      return false
    }

    const now = await nextAnimationFrame()
    const elapsed = now - startAt
    const progress = clamp(elapsed / WALK_ANIMATION_DURATION_MS, 0, 1)
    const eased = easeOutCubic(progress)
    const nextX = from.x + deltaX * eased
    const nextY = from.y + deltaY * eased

    if (Math.round(nextX) !== Math.round(lastX) || Math.round(nextY) !== Math.round(lastY)) {
      const moved = await setWindowPosition(nextX, nextY, 'random-walk-animate')
      if (!moved) {
        return false
      }
      lastX = nextX
      lastY = nextY
    }

    if (progress >= 1) {
      return true
    }
  }
}

async function randomWalkStep(): Promise<void> {
  if (walkBusy || inputVisible || isDragging) {
    return
  }

  walkBusy = true

  try {
    const [rawPosition, size, workArea] = await Promise.all([
      appWindow.outerPosition() as Promise<PositionLike>,
      appWindow.outerSize() as Promise<SizeLike>,
      getMainWorkArea()
    ])

    const minX = workArea.x
    const minY = workArea.y
    const maxX = workArea.x + workArea.width - size.width
    const maxY = workArea.y + workArea.height - size.height

    const position = {
      x: clamp(rawPosition.x, minX, maxX),
      y: clamp(rawPosition.y, minY, maxY)
    }

    if (position.x !== rawPosition.x || position.y !== rawPosition.y) {
      await setWindowPosition(position.x, position.y, 'pre-walk-clamp')
    }

    const directions = getRandomDirectionOrder()
    for (let index = 0; index < directions.length && index < 4; index += 1) {
      const direction = directions[index]
      const nextX = clamp(position.x + direction.x * WALK_DISTANCE_PX, minX, maxX)
      const nextY = clamp(position.y + direction.y * WALK_DISTANCE_PX, minY, maxY)

      if (nextX === position.x && nextY === position.y) {
        continue
      }

      const moved = await animateWindowPosition(position, { x: nextX, y: nextY })
      if (moved) {
        break
      }
      if (inputVisible || isDragging) {
        break
      }
    }
  } catch (error) {
    console.error('[mew] random walk step failed', error)
  } finally {
    walkBusy = false
  }
}

async function triggerNativeDrag(): Promise<void> {
  if (isDragging) {
    return
  }

  isDragging = true
  setPetState('drag')

  try {
    await appWindow.startDragging()
  } catch (error) {
    console.error('[mew] start dragging failed', error)
  } finally {
    isDragging = false
    if (currentPetState === 'drag') {
      setPetState('idle')
    }
    await clampWindowToBounds()
  }
}

function clearPointerTrack(): void {
  pointerTrack = null
}

async function setupQwenEventListeners(): Promise<void> {
  const unlistenChunk = await listen<StreamChunkPayload>('qwen_stream_chunk', (event) => {
    appendChunk(event.payload.roundId, event.payload.chunk)
  })

  const unlistenStreamError = await listen<StreamErrorPayload>('qwen_stream_error', (event) => {
    if (event.payload.roundId !== currentRoundId) {
      return
    }

    console.error(`[mew] stream error (${event.payload.kind})`, event.payload.message)
    showBubbleInstant(SESSION_INTERRUPTED_HINT)
    chatState = 'error'
    clearStreamTimers()
  })

  const unlistenInterrupted = await listen<SessionInterruptedPayload>('qwen_session_interrupted', (event) => {
    showBubbleInstant(event.payload.message || SESSION_INTERRUPTED_HINT)
    chatState = 'error'
    clearStreamTimers()
  })

  const unlistenFirstSendFailed = await listen<FirstSendFailedPayload>('qwen_first_send_failed', (event) => {
    openFirstFailModal(event.payload.title, event.payload.message)
  })

  unlisteners.push(unlistenChunk, unlistenStreamError, unlistenInterrupted, unlistenFirstSendFailed)
}

pet.addEventListener('pointerdown', (event) => {
  pointerTrack = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    downAt: performance.now(),
    dragTriggered: false
  }

  pet.setPointerCapture(event.pointerId)
})

pet.addEventListener('pointermove', (event) => {
  if (!pointerTrack || pointerTrack.pointerId !== event.pointerId || pointerTrack.dragTriggered) {
    return
  }

  const movedPx = distance(event.clientX, event.clientY, pointerTrack.startX, pointerTrack.startY)
  const heldMs = performance.now() - pointerTrack.downAt

  if (movedPx >= DRAG_TRIGGER_THRESHOLD_PX && heldMs > CLICK_MAX_DURATION_MS) {
    pointerTrack.dragTriggered = true
    if (pet.hasPointerCapture(event.pointerId)) {
      pet.releasePointerCapture(event.pointerId)
    }
    void triggerNativeDrag()
  }
})

pet.addEventListener('pointerup', (event) => {
  if (!pointerTrack || pointerTrack.pointerId !== event.pointerId) {
    return
  }

  const movedPx = distance(event.clientX, event.clientY, pointerTrack.startX, pointerTrack.startY)
  const heldMs = performance.now() - pointerTrack.downAt
  const isClick = heldMs <= CLICK_MAX_DURATION_MS && movedPx <= CLICK_MOVE_THRESHOLD_PX

  if (isClick && !pointerTrack.dragTriggered) {
    setPetState('tap_react')
    openInput()
  }

  clearPointerTrack()
})

pet.addEventListener('pointercancel', clearPointerTrack)
pet.addEventListener('lostpointercapture', clearPointerTrack)

pet.addEventListener('animationend', (event) => {
  if (event.animationName === 'tap-bounce' && currentPetState === 'tap_react' && !isDragging) {
    setPetState('idle')
  }
})

chatForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void submitInput()
})

chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeChatUI()
    return
  }

  if (event.key === 'Enter' && event.isComposing) {
    event.preventDefault()
  }
})

chatBubble.addEventListener('click', () => {
  hideBubble()
})

firstFailAck.addEventListener('click', () => {
  closeFirstFailModal()
})

firstFailRetry.addEventListener('click', () => {
  closeFirstFailModal()
  void retryLastFailedInput()
})

providerConfigTrigger.addEventListener('click', () => {
  openProviderConfigModal()
})

providerConfigCancel.addEventListener('click', () => {
  closeProviderConfigModal()
})

providerConfigSave.addEventListener('click', () => {
  saveProviderConfig()
})

providerConfigClear.addEventListener('click', () => {
  clearProviderConfig()
})

providerConfigModal.addEventListener('click', (event) => {
  if (event.target === providerConfigModal) {
    closeProviderConfigModal()
  }
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !providerConfigModal.classList.contains('hidden')) {
    event.preventDefault()
    closeProviderConfigModal()
    return
  }

  if (event.key === 'Escape' && (inputVisible || !chatBubble.classList.contains('hidden'))) {
    event.preventDefault()
    closeChatUI()
  }
})

window.addEventListener('beforeunload', () => {
  if (walkTimer !== null) {
    window.clearInterval(walkTimer)
    walkTimer = null
  }

  clearStreamTimers()

  while (unlisteners.length > 0) {
    const unlisten = unlisteners.pop()
    if (unlisten) {
      unlisten()
    }
  }
})

setPetState('idle')
applyOpenAiConfigToInputs(loadOpenAiConfigFromStorage())
void clampWindowToBounds()
void setupQwenEventListeners().catch((error) => {
  console.error('[mew] failed to register qwen event listeners', error)
})
walkTimer = window.setInterval(() => {
  void randomWalkStep()
}, WALK_INTERVAL_MS)
