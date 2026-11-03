import type { Lang } from '../../i18n'
import { deTexts } from './de'
import { enTexts } from './en'
import { esTexts } from './es'
import { frTexts } from './fr'
import { itTexts } from './it'
import { jaTexts } from './ja'
import { koTexts } from './ko'
import type { CatalogTexts } from './types'
import { zhTexts } from './zh'

export type { CatalogText, CatalogTexts } from './types'

export const CATALOG_TEXTS: Record<Lang, CatalogTexts> = {
  zh: zhTexts,
  en: enTexts,
  de: deTexts,
  fr: frTexts,
  es: esTexts,
  it: itTexts,
  ja: jaTexts,
  ko: koTexts,
}
