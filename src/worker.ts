/**
 * The worker: takes uploaded documents, turns them into text, and stores the
 * vectors.
 *
 * It runs as its own service so that indexing a large PDF does not block the
 * API, and so the two can be scaled apart - which is the whole reason this is a
 * pipeline rather than an endpoint that does everything inline.
 */
import { chunk } from "./chunk.js"
import { pool, migrate } from "./db.js"
import { embed, toVector, warmUp } from "./embed.js"

const DOCLING_URL = (process.env.DOCLING_URL ?? "http://localhost:5001").replace(/\/$/, "")
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2000)
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3)

interface Claimed {
  id: string
  filename: string
  content_type: string
  content: Buffer
  attempts: number
}

/**
 * Claims one document. `for update skip locked` is what makes it safe to run
 * several workers: each takes a different row instead of two workers racing to
 * process the same upload.
 */
async function claim(): Promise<Claimed | null> {
  const { rows } = await pool.query<Claimed>(
    `update documents set status = 'processing', attempts = attempts + 1, updated_at = now()
     where id = (
       select id from documents
       where status = 'pending'
       order by created_at
       for update skip locked
       limit 1
     )
     returning id::text, filename, content_type, content, attempts`,
  )
  return rows[0] ?? null
}

async function toMarkdown(document: Claimed): Promise<string> {
  const form = new FormData()
  form.append("files", new Blob([new Uint8Array(document.content)], { type: document.content_type }), document.filename)
  form.append("to_formats", "md")

  const response = await fetch(`${DOCLING_URL}/v1/convert/file`, { method: "POST", body: form })
  if (!response.ok) {
    throw new Error(`docling returned ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
  const result = (await response.json()) as { document?: { md_content?: string } }
  const markdown = result?.document?.md_content
  if (typeof markdown !== "string" || !markdown.trim()) {
    throw new Error("docling returned no markdown")
  }
  return markdown
}

async function index(document: Claimed): Promise<number> {
  const markdown = await toMarkdown(document)
  const pieces = chunk(markdown)
  const vectors = await embed(pieces)

  const client = await pool.connect()
  try {
    // One transaction per document: a half-indexed document that reports itself
    // ready is worse than one that failed outright, because nothing will retry it.
    await client.query("begin")
    await client.query(`delete from chunks where document_id = $1`, [document.id])
    for (let i = 0; i < pieces.length; i++) {
      await client.query(
        `insert into chunks (document_id, ordinal, text, embedding) values ($1, $2, $3, $4)`,
        [document.id, i, pieces[i], toVector(vectors[i])],
      )
    }
    await client.query(
      `update documents set status = 'ready', markdown = $2, error = null, updated_at = now() where id = $1`,
      [document.id, markdown],
    )
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  } finally {
    client.release()
  }
  return pieces.length
}

async function tick(): Promise<boolean> {
  const document = await claim()
  if (!document) return false

  try {
    const count = await index(document)
    console.log(`indexed ${document.filename} into ${count} chunks`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Back to pending while attempts remain: a document that failed because
    // the converter was still starting deserves another go.
    const nextStatus = document.attempts >= MAX_ATTEMPTS ? "failed" : "pending"
    await pool.query(`update documents set status = $2, error = $3, updated_at = now() where id = $1`, [
      document.id,
      nextStatus,
      message.slice(0, 2000),
    ])
    console.error(`failed ${document.filename} (attempt ${document.attempts}): ${message}`)
  }
  return true
}

async function main() {
  await migrate()
  await warmUp()
  console.log("worker ready")

  let stopping = false
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      stopping = true
    })
  }

  while (!stopping) {
    let worked = false
    try {
      worked = await tick()
    } catch (error) {
      console.error("worker loop error", error)
    }
    if (!worked) await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }

  await pool.end()
  process.exit(0)
}

main().catch((error) => {
  console.error("worker failed to start", error)
  process.exit(1)
})
