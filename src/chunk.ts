/**
 * Splitting a document into pieces small enough to embed.
 *
 * The split follows the document's own structure - paragraphs first, sentences
 * only when a paragraph is too large - because a chunk that ends mid-sentence
 * embeds badly and reads worse when it comes back as a search result.
 */
const MAX_CHARS = Number(process.env.CHUNK_CHARS ?? 1200)
const OVERLAP_CHARS = Number(process.env.CHUNK_OVERLAP ?? 150)

function splitLongParagraph(paragraph: string): string[] {
  const sentences = paragraph.match(/[^.!?\n]+[.!?]*\s*/g) ?? [paragraph]
  const pieces: string[] = []
  let current = ""
  for (const sentence of sentences) {
    if (current.length + sentence.length > MAX_CHARS && current) {
      pieces.push(current.trim())
      // Carry a tail of the previous piece so a fact split across the boundary
      // is still findable from either side.
      current = current.slice(-OVERLAP_CHARS)
    }
    current += sentence
  }
  if (current.trim()) pieces.push(current.trim())
  return pieces
}

export function chunk(markdown: string): string[] {
  const paragraphs = markdown.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ""

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHARS) {
      if (current.trim()) {
        chunks.push(current.trim())
        current = ""
      }
      chunks.push(...splitLongParagraph(paragraph))
      continue
    }
    if (current.length + paragraph.length + 2 > MAX_CHARS && current) {
      chunks.push(current.trim())
      current = current.slice(-OVERLAP_CHARS)
    }
    current += (current ? "\n\n" : "") + paragraph
  }

  if (current.trim()) chunks.push(current.trim())
  return chunks
}
