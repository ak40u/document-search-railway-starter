/**
 * Embeddings, computed here rather than bought.
 *
 * A local model means a deployment works the moment it is created - no API key
 * to obtain first - and no document text leaves the container. all-MiniLM-L6-v2
 * is small enough to run on a CPU and good enough for search over your own
 * documents.
 */
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers"

const MODEL = process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2"

let extractor: Promise<FeatureExtractionPipeline> | null = null

function load(): Promise<FeatureExtractionPipeline> {
  // Loaded once per process and shared: the model is ~90 MB, and re-reading it
  // per request is the difference between milliseconds and seconds.
  extractor ??= pipeline("feature-extraction", MODEL, { dtype: "fp32" })
  return extractor
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const model = await load()
  // Mean pooling followed by normalisation is what makes cosine distance
  // meaningful; without normalising, longer passages simply score higher.
  const output = await model(texts, { pooling: "mean", normalize: true })
  const [rows, dimensions] = output.dims as [number, number]
  const data = output.data as Float32Array
  return Array.from({ length: rows }, (_, row) =>
    Array.from(data.subarray(row * dimensions, (row + 1) * dimensions)),
  )
}

/** pgvector accepts its literal form, not a JSON array. */
export const toVector = (values: number[]): string => `[${values.join(",")}]`

export async function warmUp(): Promise<void> {
  await embed(["warm up"])
}
