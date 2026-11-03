import data from '../data/baking-reference.json'

/** data/baking-reference.json 的一筆：常見烘焙菜的烤箱設定，由 AI 整理、未經食譜核對。 */
export interface BakingReference {
  name: string
  aliases: string[]
  type: string
  top: number | null
  bottom: number | null
  minutes: [number, number] | null
  rack: string | null
  steam: boolean
  confidence: 'typical' | 'estimate' | 'n/a'
  note?: string
}

const ENTRIES: BakingReference[] = data.countries.flatMap((c) => c.items as BakingReference[])

function normalize(text: string): string {
  return text.trim().toLowerCase()
}

/** 查詢字串等於菜名或別名（不分大小寫）才算命中；部分相符不算，避免「蛋糕」誤中戚風。不烤的菜（confidence 為 n/a）不算命中。 */
export function findBakingReference(query: string): BakingReference | null {
  const q = normalize(query)
  if (!q) return null
  return (
    ENTRIES.find(
      (e) => e.confidence !== 'n/a' && (normalize(e.name) === q || e.aliases.some((a) => normalize(a) === q)),
    ) ?? null
  )
}

/** 把命中的烤箱設定寫成一段給模型的指示；估計值會明確標示，讓模型知道可能需要保留彈性。 */
export function referencePrompt(ref: BakingReference): string {
  const oven = [
    ref.top !== null ? `top heat ${ref.top}°C` : null,
    ref.bottom !== null ? `bottom heat ${ref.bottom}°C` : null,
    ref.minutes ? `${ref.minutes[0]}-${ref.minutes[1]} minutes` : null,
    ref.rack ? `${ref.rack} rack` : null,
    ref.steam ? 'steam or a hot water tray for the first part of baking' : null,
  ].filter(Boolean)
  const verified = ref.confidence === 'typical' ? 'Use these oven settings exactly.' : 'These are estimates; keep them unless they clearly conflict with the dish.'
  return `Oven settings for ${ref.name} (reference): ${oven.join(', ')}.${ref.note ? ` Note: ${ref.note}.` : ''} ${verified}`
}
