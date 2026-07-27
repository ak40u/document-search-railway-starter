# Document search starter for Railway

Upload a PDF; ask a question of it a moment later and get the passage that
answers it — not the passage that repeats your words.

Four services wired together: an API, an indexer, a document converter and
Postgres with pgvector. No API keys, nothing leaves the deployment.

## Why this exists

Docling has a template. pgvector has a template. Neither of them is a pipeline,
and the pipeline is the part that takes a week: a queue that survives restarts,
chunking that does not cut sentences in half, embeddings that come from
somewhere, idempotency so the same file twice is one document, and a retry path
for the document that failed while a service was still starting.

That is what this is.

## How it works

```
POST /documents ──▶ Postgres (file + queue)
                          │
                    Indexer claims it
                          ├──▶ Docling: PDF, DOCX, PPTX, HTML → markdown
                          ├──▶ chunk on paragraph boundaries
                          ├──▶ embed locally (all-MiniLM-L6-v2)
                          └──▶ pgvector

POST /search ──────▶ embed the question, nearest chunks by cosine distance
```

## Endpoints

| Route | What it does |
|-------|--------------|
| `POST /documents` | Multipart upload. Returns immediately with an id — the work happens in the indexer |
| `GET /documents/:id` | Status: `pending`, `processing`, `ready` or `failed`, with the chunk count |
| `GET /documents` | The hundred most recent |
| `POST /documents/:id/retry` | Puts a failed document back in the queue |
| `POST /search` | `{"query": "...", "limit": 5}` → passages with scores |

All of them need `Authorization: Bearer $API_TOKEN`.

## Try it

```bash
curl -X POST https://your-api.up.railway.app/documents \
  -H "authorization: Bearer $API_TOKEN" -F file=@report.pdf

curl -X POST https://your-api.up.railway.app/search \
  -H "authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"query":"what did the report recommend?"}'
```

## Prove it works

```bash
scripts/verify-search.sh https://your-api.up.railway.app 'the-token'
```

It uploads a document containing a fact nobody would guess, waits for the
indexer, then searches for that fact **in different words** — "how much did the
rodent numbers grow" against a document that says "the marmot population
increased by fourteen percent". A keyword search cannot pass that. It also
checks that the same file uploaded twice is one document, and that the corpus is
not readable without the token.

## Decisions worth knowing

- **Embeddings are computed locally.** No API key to obtain before a deployment
  works, no document text leaving the container, no per-token cost.
  `all-MiniLM-L6-v2` is 384 dimensions, small enough for CPU and good enough for
  search over your own documents. The model is baked into the image at build
  time.
- **The API never waits for a conversion.** A request that parses a large PDF
  inline is a request that times out; upload writes the file and returns 202.
- **The indexer claims work with `for update skip locked`**, so running several
  of them takes different documents instead of racing over the same one.
- **A document is its hash.** Uploading the same file twice returns the first
  document, enforced by a unique index rather than a check-then-insert two
  concurrent uploads would both pass.
- **Indexing is one transaction.** A half-indexed document that reports itself
  ready is worse than one that failed, because nothing will retry it.
- **The indexer is patient.** On a first deploy the converter is still pulling
  models while the first upload arrives; ten attempts with a pause between them,
  rather than three and a permanent failure.

## Configuration

| Variable | Required | Purpose |
|----------|----------|---------|
| `API_TOKEN` | yes | Bearer token for every route. At least 16 characters |
| `DATABASE_URL` | yes | Postgres **with the pgvector extension** |
| `DOCLING_URL` | yes | Private address of the converter |
| `MAX_UPLOAD_MB` | no | Default 25 |
| `CHUNK_CHARS` / `CHUNK_OVERLAP` | no | 1200 and 150 |
| `EMBEDDING_MODEL` | no | Changing it means changing the vector column width too |
| `MAX_ATTEMPTS` | no | Default 10 before a document is marked failed |

## Scaling

The API and the indexer are separate services from the same repository, so add
indexers when the queue grows and API replicas when search traffic does. Both
are stateless; everything is in Postgres.

The converter is the slow part — a scanned PDF with OCR takes real CPU. Give it
the memory, or run more than one and point `DOCLING_URL` at a load balancer.

## License

MIT. Docling is MIT; the embedding model is Apache-2.0.
