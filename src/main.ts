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

const WALK_INTERVAL_MS = 2000
const WALK_DISTANCE_PX = 10
const WALK_ANIMATION_DURATION_MS = 280
const DRAG_TRIGGER_THRESHOLD_PX = 2
const CLICK_MOVE_THRESHOLD_PX = 4
const CLICK_MAX_DURATION_MS = 200

const STREAM_FLUSH_MS = 50
const STREAM_BATCH_CHARS = 8
const ROUND_SILENCE_MS = 800
const ANSI_CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g
const ANSI_OSC_PATTERN = /\u001b\][^\u0007]*(\u0007|\u001b\\)/g

const EMPTY_INPUT_HINT = '请说点什么～'
const THINKING_HINT = '思考中…'
const SESSION_INTERRUPTED_HINT = '会话已中断，请重试'
const RETRY_FAILED_HINT = '重试失败，请在终端运行 qwen 并完成登录后再试。'

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

let walkTimer: number | null = null
let flushTimer: number | null = null
let silenceTimer: number | null = null

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
  </div>
`

const pet = document.querySelector<HTMLDivElement>('#pet')
const chatForm = document.querySelector<HTMLFormElement>('#chat-form')
const chatInput = document.querySelector<HTMLInputElement>('#chat-input')
const chatBubble = document.querySelector<HTMLButtonElement>('#chat-bubble')
const firstFailModal = document.querySelector<HTMLDivElement>('#first-fail-modal')
const firstFailTitle = document.querySelector<HTMLHeadingElement>('#fail-title')
const firstFailMessage = document.querySelector<HTMLParagraphElement>('#fail-message')
const firstFailAck = document.querySelector<HTMLButtonElement>('#fail-ack')
const firstFailRetry = document.querySelector<HTMLButtonElement>('#fail-retry')

if (!pet || !chatForm || !chatInput || !chatBubble || !firstFailModal || !firstFailTitle || !firstFailMessage || !firstFailAck || !firstFailRetry) {
  throw new Error('Pet UI elements were not initialized correctly')
}

const PET_STATE_CLASS: Record<PetAnimState, string> = {
  idle: 'state-idle',
  drag: 'state-drag',
  tap_react: 'state-tap-react'
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
    if (chatState !== 'error') {
      chatState = 'round_done'
    }
    silenceTimer = null
  }, ROUND_SILENCE_MS)
}

function startRound(roundId: number): void {
  clearStreamTimers()

  currentRoundId = roundId
  renderedStreamText = ''
  pendingStreamText = ''
  gotFirstToken = false
  chatState = 'waiting_first_token'

  showBubbleInstant(THINKING_HINT)
  resetSilenceTimer()
}

function appendChunk(roundId: number, chunk: string): void {
  if (roundId !== currentRoundId) {
    return
  }

  const sanitizedChunk = chunk
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_OSC_PATTERN, '')
    .replace(/\r/g, '')

  if (sanitizedChunk.length === 0) {
    return
  }

  pendingStreamText += sanitizedChunk
  resetSilenceTimer()

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
    const ack = await invoke<SendAck>('qwen_send', { input: raw })
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

window.addEventListener('keydown', (event) => {
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
void clampWindowToBounds()
void setupQwenEventListeners().catch((error) => {
  console.error('[mew] failed to register qwen event listeners', error)
})
walkTimer = window.setInterval(() => {
  void randomWalkStep()
}, WALK_INTERVAL_MS)
