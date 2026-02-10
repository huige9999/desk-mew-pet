import './style.css'
import { LogicalPosition, getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window'

type PetAnimState = 'idle' | 'drag' | 'tap_react'

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
  downAt: number
  startX: number
  startY: number
  dragTriggered: boolean
}

const WALK_INTERVAL_MS = 2000
const WALK_DISTANCE_PX = 10
const HOLD_MS = 200
const MOVE_THRESHOLD_PX = 4
const TYPEWRITER_MS = 35
const BUBBLE_AUTO_HIDE_MS = 3000

const EMPTY_INPUT_HINT = '请说点什么～'

const REPLIES: string[] = [
  '喵呜，今天也要按时喝水。',
  '我宣布：你现在的努力都在发光。',
  '摸摸头，先把最小的一步做完。',
  '好耶，又见到你啦。',
  '别急，我会一直在这儿陪你。',
  '深呼吸一下，我们继续。',
  '今天的你比昨天更厉害一点点。',
  '先完成 5 分钟，再决定要不要停。',
  '喵已经帮你把好运叠满了。',
  '你敲键盘的样子很专业。',
  '卡住很正常，慢慢来就好。',
  '要不要先站起来活动 30 秒？',
  '这题先放一放，换个角度试试。',
  '完成比完美更重要，冲！',
  '我看好你今天的进度条。',
  '给自己一点耐心，你在变强。',
  '喵提醒：记得眨眼和放松肩膀。',
  '下一步就做一件最简单的事。',
  '继续前进，我在旁边打 call。',
  '你负责努力，惊喜交给时间。'
]

const appWindow = getCurrentWindow()

let currentPetState: PetAnimState = 'idle'
let pointerTrack: PointerTrack | null = null
let isDragging = false
let walkBusy = false
let inputVisible = false

let walkTimer: number | null = null
let typeTimer: number | null = null
let bubbleHideTimer: number | null = null

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
        maxlength="120"
        placeholder="和喵说点什么..."
      />
    </form>

    <button id="chat-bubble" class="chat-bubble hidden" type="button"></button>
  </div>
`

const pet = document.querySelector<HTMLDivElement>('#pet')
const chatForm = document.querySelector<HTMLFormElement>('#chat-form')
const chatInput = document.querySelector<HTMLInputElement>('#chat-input')
const chatBubble = document.querySelector<HTMLButtonElement>('#chat-bubble')

if (!pet || !chatForm || !chatInput || !chatBubble) {
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
    // Force reflow so rapid clicks can replay the one-shot animation.
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
    await appWindow.setPosition(new LogicalPosition(x, y))
  }
}

async function randomWalkStep(): Promise<void> {
  if (walkBusy || inputVisible || isDragging) {
    return
  }

  walkBusy = true

  try {
    const position = await appWindow.outerPosition() as PositionLike
    const angle = Math.random() * Math.PI * 2
    const dx = Math.round(Math.cos(angle) * WALK_DISTANCE_PX)
    const dy = Math.round(Math.sin(angle) * WALK_DISTANCE_PX)

    await appWindow.setPosition(new LogicalPosition(position.x + dx, position.y + dy))
    await clampWindowToBounds()
  } finally {
    walkBusy = false
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

function clearBubbleTimers(): void {
  if (typeTimer !== null) {
    window.clearInterval(typeTimer)
    typeTimer = null
  }

  if (bubbleHideTimer !== null) {
    window.clearTimeout(bubbleHideTimer)
    bubbleHideTimer = null
  }
}

function hideBubble(): void {
  clearBubbleTimers()
  chatBubble.textContent = ''
  chatBubble.classList.add('hidden')
}

function showBubble(message: string): void {
  clearBubbleTimers()

  chatBubble.textContent = ''
  chatBubble.classList.remove('hidden')

  const chars = [...message]

  if (chars.length === 0) {
    bubbleHideTimer = window.setTimeout(hideBubble, BUBBLE_AUTO_HIDE_MS)
    return
  }

  let charIndex = 0
  typeTimer = window.setInterval(() => {
    charIndex += 1
    chatBubble.textContent = chars.slice(0, charIndex).join('')

    if (charIndex >= chars.length) {
      if (typeTimer !== null) {
        window.clearInterval(typeTimer)
        typeTimer = null
      }

      bubbleHideTimer = window.setTimeout(hideBubble, BUBBLE_AUTO_HIDE_MS)
    }
  }, TYPEWRITER_MS)
}

function pickRandomReply(): string {
  const index = Math.floor(Math.random() * REPLIES.length)
  return REPLIES[index]
}

function submitInput(): void {
  const raw = chatInput.value
  const trimmed = raw.trim()

  if (trimmed.length === 0) {
    showBubble(EMPTY_INPUT_HINT)
    return
  }

  showBubble(pickRandomReply())
}

async function triggerNativeDrag(): Promise<void> {
  if (isDragging) {
    return
  }

  isDragging = true
  setPetState('drag')

  try {
    await appWindow.startDragging()
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

pet.addEventListener('pointerdown', (event) => {
  pointerTrack = {
    pointerId: event.pointerId,
    downAt: performance.now(),
    startX: event.clientX,
    startY: event.clientY,
    dragTriggered: false
  }

  pet.setPointerCapture(event.pointerId)
})

pet.addEventListener('pointermove', (event) => {
  if (!pointerTrack || pointerTrack.pointerId !== event.pointerId || pointerTrack.dragTriggered) {
    return
  }

  const heldMs = performance.now() - pointerTrack.downAt
  const movedPx = distance(event.clientX, event.clientY, pointerTrack.startX, pointerTrack.startY)

  if (heldMs > HOLD_MS && movedPx > MOVE_THRESHOLD_PX) {
    pointerTrack.dragTriggered = true
    void triggerNativeDrag()
  }
})

pet.addEventListener('pointerup', (event) => {
  if (!pointerTrack || pointerTrack.pointerId !== event.pointerId) {
    return
  }

  const heldMs = performance.now() - pointerTrack.downAt
  const movedPx = distance(event.clientX, event.clientY, pointerTrack.startX, pointerTrack.startY)
  const isClick = heldMs <= HOLD_MS && movedPx <= MOVE_THRESHOLD_PX

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
  submitInput()
})

chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeInput()
    return
  }

  if (event.key === 'Enter' && event.isComposing) {
    event.preventDefault()
  }
})

chatBubble.addEventListener('click', hideBubble)
chatBubble.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    hideBubble()
  }
})

window.addEventListener('beforeunload', () => {
  if (walkTimer !== null) {
    window.clearInterval(walkTimer)
    walkTimer = null
  }
  clearBubbleTimers()
})

setPetState('idle')
void clampWindowToBounds()
walkTimer = window.setInterval(() => {
  void randomWalkStep()
}, WALK_INTERVAL_MS)
