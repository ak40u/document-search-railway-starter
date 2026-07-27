/**
 * The API: upload a document, ask a question of the corpus.
 *
 * Uploading only writes the file and returns - the conversion and embedding
 * happen in the worker. A request that waits for a large PDF to be parsed is a
 * request that times out.
 */
import { createHash } from "node:crypto"
import express from "express"
import multer from "multer"

import { pool, migrate } from "./db.js"
import { embed, toVector, warmUp } from "./embed.js"

const port = Number(process.env.PORT ?? 8080)
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB ?? 25)
const token = process.env.API_TOKEN ?? ""

if (token.length < 16) {
  console.error("API_TOKEN is missing or shorter than 16 characters. Refusing to start with an open corpus.")
  process.exit(1)
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxUploadMb * 1024 * 1024 } })
const app = express()
app.disable("x-powered-by")

function authorize(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization ?? ""
  const presented = header.startsWith("Bearer ") ? header.slice(7) : ""
  if (presented !== token) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  next()
}

app.post("/documents", authorize, upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "file is required" })
    return
  }
  const sha256 = createHash("sha256").update(req.file.buffer).digest("hex")

  // The same file uploaded twice is the same document. The unique index on the
  // hash is what enforces it - not a check-then-insert, which two concurrent
  // uploads would both pass.
  const { rows } = await pool.query<{ id: string; status: string; existed: boolean }>(
    `insert into documents (filename, content_type, byte_size, sha256, content)
     values ($1, $2, $3, $4, $5)
     on conflict (sha256) do update set updated_at = now()
     returning id::text, status, (xmax <> 0) as existed`,
    [req.file.originalname, req.file.mimetype || "application/octet-stream", req.file.size, sha256, req.file.buffer],
  )
  res.status(rows[0].existed ? 200 : 202).json({ id: rows[0].id, status: rows[0].status, duplicate: rows[0].existed })
})

app.get("/documents/:id", authorize, async (req, res) => {
  const { rows } = await pool.query(
    `select d.id::text, d.filename, d.status, d.attempts, d.error, d.byte_size,
            (select count(*)::int from chunks c where c.document_id = d.id) as chunks
     from documents d where d.id = $1`,
    [req.params.id],
  )
  if (!rows[0]) {
    res.status(404).json({ error: "not found" })
    return
  }
  res.json(rows[0])
})

app.get("/documents", authorize, async (_req, res) => {
  const { rows } = await pool.query(
    `select id::text, filename, status, byte_size,
            (select count(*)::int from chunks c where c.document_id = documents.id) as chunks
     from documents order by created_at desc limit 100`,
  )
  res.json({ documents: rows })
})

app.post("/documents/:id/retry", authorize, async (req, res) => {
  // A document that failed - because the converter was down, or the file was
  // briefly unreadable - goes back in the queue with its attempt count reset.
  const { rowCount } = await pool.query(
    `update documents set status = 'pending', attempts = 0, error = null, updated_at = now()
     where id = $1 and status = 'failed'`,
    [req.params.id],
  )
  if (!rowCount) {
    res.status(409).json({ error: "only a failed document can be retried" })
    return
  }
  res.json({ id: req.params.id, status: "pending" })
})

app.post("/search", authorize, express.json(), async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : ""
  const limit = Math.min(Math.max(Number(req.body?.limit ?? 5), 1), 50)
  if (!query) {
    res.status(400).json({ error: "query is required" })
    return
  }

  const [vector] = await embed([query])
  // Cosine distance, so smaller is closer; the score is turned back into
  // "1 is a perfect match" because that is what callers expect to sort by.
  const { rows } = await pool.query(
    `select c.text, c.ordinal, d.id::text as document_id, d.filename,
            1 - (c.embedding <=> $1) as score
     from chunks c join documents d on d.id = c.document_id
     order by c.embedding <=> $1
     limit $2`,
    [toVector(vector), limit],
  )
  res.json({ query, results: rows })
})

app.get("/health", async (_req, res) => {
  try {
    await pool.query("select 1")
    res.json({ status: "ok" })
  } catch {
    res.status(503).json({ status: "degraded" })
  }
})

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<meta charset="utf-8"><title>Document search</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:4rem auto;padding:0 1rem;color-scheme:light dark}
pre{background:#8881;padding:12px;border-radius:8px;overflow-x:auto}code{background:#8882;padding:2px 5px;border-radius:4px}</style>
<h1>Document search</h1>
<p>Upload a PDF, Word or PowerPoint file; ask questions of it a moment later.
Send the token from <code>API_TOKEN</code>.</p>
<pre>curl -X POST https://<span id="h"></span>/documents \\
  -H "authorization: Bearer $API_TOKEN" -F file=@report.pdf

curl -X POST https://<span id="h2"></span>/search \\
  -H "authorization: Bearer $API_TOKEN" -H "content-type: application/json" \\
  -d '{"query":"what were the findings?"}'</pre>
<script>for (const id of ["h","h2"]) document.getElementById(id).textContent = location.host</script>`)
})

async function main() {
  await migrate()
  await warmUp()
  const server = app.listen(port, () => console.log(`api listening on ${port}`))
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => server.close(() => void pool.end().then(() => process.exit(0))))
  }
}

main().catch((error) => {
  console.error("api failed to start", error)
  process.exit(1)
})
