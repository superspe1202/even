/**
 * 語音指令（原型）：眼鏡麥克風 → 原始 PCM → Worker 轉文字 → 比對關鍵字 → 和手勢做同樣的事。
 *
 * 音訊格式已由官方 Device APIs 文件確認：PCM 16 kHz、16 位元有號、小端序、單聲道。
 * 文件沒寫每個區塊的大小與送出頻率，要用眼鏡實測。辨識結果只會是四個指令之一，其他話一律忽略。
 * 使用前要先執行 createStartUpPageContainer，否則眼鏡麥克風打不開。
 */
import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import { transcribeAudio } from '../core/importer'

export type VoiceCommand = 'next' | 'back' | 'timer' | 'menu'

const SAMPLE_RATE = 16_000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16
/** 每段收多久的音訊才送去辨識：太短不準，太長延遲大。 */
const WINDOW_SECONDS = 2
const WINDOW_BYTES = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) * WINDOW_SECONDS

/** 原型先支援中文與英文的四個指令。 */
const PHRASES: Record<VoiceCommand, string[]> = {
  next: ['下一步', 'next step', 'next'],
  back: ['上一步', 'previous step', 'back'],
  timer: ['開始計時', 'start timer', 'timer'],
  menu: ['選單', 'menu'],
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 辨識出的整句裡只要含有某個指令的關鍵字就算。順序就是優先序。 */
export function matchCommand(text: string): VoiceCommand | null {
  const heard = normalize(text)
  if (!heard) return null
  for (const cmd of Object.keys(PHRASES) as VoiceCommand[]) {
    if (PHRASES[cmd].some(p => heard.includes(normalize(p)))) return cmd
  }
  return null
}

/** SDK 送來的 PCM 可能是 Uint8Array、數字陣列，或 base64 字串（經過 JSON 之後）。 */
export function toPcmBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[])
  if (typeof raw === 'string' && raw) return Uint8Array.from(atob(raw), c => c.charCodeAt(0))
  return null
}

/** 把小段 PCM 攢成一整段，攢滿才回傳，然後清空。 */
export class PcmWindow {
  private chunks: Uint8Array[] = []
  private size = 0

  push(chunk: Uint8Array): Uint8Array | null {
    this.chunks.push(chunk)
    this.size += chunk.length
    if (this.size < WINDOW_BYTES) return null
    const out = new Uint8Array(this.size)
    let offset = 0
    for (const c of this.chunks) {
      out.set(c, offset)
      offset += c.length
    }
    this.clear()
    return out
  }

  clear(): void {
    this.chunks = []
    this.size = 0
  }
}

/** 在原始 PCM 前面加上 44 位元組的 WAV 檔頭，Whisper 才認得。 */
export function pcmToWav(pcm: Uint8Array): Uint8Array {
  const header = new DataView(new ArrayBuffer(44))
  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) header.setUint8(offset + i, s.charCodeAt(i))
  }
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8
  writeAscii(0, 'RIFF')
  header.setUint32(4, 36 + pcm.length, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true) // PCM
  header.setUint16(22, CHANNELS, true)
  header.setUint32(24, SAMPLE_RATE, true)
  header.setUint32(28, SAMPLE_RATE * blockAlign, true)
  header.setUint16(32, blockAlign, true)
  header.setUint16(34, BITS_PER_SAMPLE, true)
  writeAscii(36, 'data')
  header.setUint32(40, pcm.length, true)
  const out = new Uint8Array(44 + pcm.length)
  out.set(new Uint8Array(header.buffer), 0)
  out.set(pcm, 44)
  return out
}

interface VoiceBridge {
  audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean>
}

export class VoiceControl {
  private readonly window = new PcmWindow()
  private recognizing = false

  constructor(
    private readonly bridge: VoiceBridge,
    private readonly onCommand: (cmd: VoiceCommand) => void,
  ) {}

  /** 打開眼鏡麥克風。 */
  async start(): Promise<void> {
    await this.bridge.audioControl(true, AudioInputSource.Glasses)
  }

  /** 關掉麥克風，丟掉還沒攢滿的音訊。 */
  async stop(): Promise<void> {
    this.window.clear()
    await this.bridge.audioControl(false)
  }

  /** 收到 audioEvent 時呼叫。辨識中來的音訊直接丟掉，免得排隊越積越久。 */
  feedEvent(event: unknown): void {
    const audio = (event as { audioEvent?: { audioPcm?: unknown; speakerRole?: unknown } } | null)?.audioEvent
    // 只收使用者自己講的話：SDK 會標註說話人（self / other / unknown），別人講的一律丟掉。
    if (audio?.speakerRole !== 'self') return
    const raw = audio.audioPcm
    if (raw === undefined) return
    const bytes = toPcmBytes(raw)
    if (!bytes) return
    const pcm = this.window.push(bytes)
    if (!pcm || this.recognizing) return
    this.recognizing = true
    void this.recognize(pcm).finally(() => {
      this.recognizing = false
    })
  }

  private async recognize(pcm: Uint8Array): Promise<void> {
    try {
      const text = await transcribeAudio(pcmToWav(pcm))
      const cmd = matchCommand(text)
      if (cmd) this.onCommand(cmd)
    } catch {
      // 辨識失敗就略過這一段，下一段照常處理。
    }
  }
}
