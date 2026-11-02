/** Word counting and string helpers for message limits and templates. */
const words = new Intl.Segmenter('zh', { granularity: 'word' })
export const IM_WORDS = 100
export const NOTE_WORDS = 30
/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
export function wordCount(text: string): number {
  let count = 0
  for (const segment of words.segment(text)) if (segment.isWordLike) count++
  return count
}
/** Collapses whitespace and truncates text for display previews. */
export const preview = (text: string, length = 160): string => text.replace(/\s+/g, ' ').trim().slice(0, length)
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
export const capped = (text: string, limit: number, read: string): { text: string; chars?: number; read?: string } =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const now = (): string => new Date().toISOString()
