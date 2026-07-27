# Deploy and Host Document Search on Railway

Upload a PDF and ask a question of it a moment later — and get back the passage that answers the question rather than the one that repeats your words.

Four services wired together: an API, an indexer, a document converter and Postgres with pgvector. No API keys to obtain, and no document text leaves the deployment.

## About Hosting Document Search

Docling has a template in this catalogue. pgvector has several. Neither is a pipeline, and the pipeline is the part that takes a week to get right.

What sits between "a converter exists" and "search works" is: a queue that survives restarts and can be worked by more than one process; chunking that follows the document's structure instead of cutting sentences in half; embeddings that have to come from somewhere; idempotency, so the same file uploaded twice is one document rather than two; and a retry path for the document that failed because a service was still starting when it arrived.

Every one of those is a decision someone has to make. This template makes them, and the verification script proves the result end to end.

## Common Use Cases

- **A knowledge base your agent can query.** One HTTP call returns the passages that bear on a question — the retrieval half of retrieval-augmented generation, without a vector database subscription.
- **Search across contracts, reports or manuals.** Ask in your own words; the match is by meaning, so the answer surfaces even when it shares no vocabulary with the question.
- **Turn a pile of PDFs into text.** Docling handles PDF, Word, PowerPoint and HTML, and the extracted markdown is kept alongside the original.

## Dependencies for Document Search Hosting

### Deployment Dependencies

- [Docling](https://github.com/docling-project/docling-serve) `v1.28.0` — document conversion
- Postgres with [pgvector](https://github.com/pgvector/pgvector) — documents, queue and vectors in one place
- `all-MiniLM-L6-v2` embeddings, running locally on CPU
- [Template source](https://github.com/ak40u/document-search-railway-starter)

### Implementation Details

- **Embeddings are computed in the container.** No key to obtain before a fresh deployment works, no text sent to a third party, no per-token cost. The model is baked into the image at build time, so the first upload is not also a download.
- **The API never waits for a conversion.** Upload writes the file and returns 202; the indexer does the work. An endpoint that parses a large PDF inline is an endpoint that times out.
- **The indexer claims work with `for update skip locked`**, so several of them take different documents instead of racing over the same one — the difference between a queue you can scale and one you cannot.
- **A document is its hash.** The same file twice is one document, enforced by a unique index rather than a check-then-insert that two concurrent uploads would both pass.
- **Indexing happens in one transaction.** A half-indexed document that reports itself ready is worse than one that failed outright, because nothing will ever retry it.
- **The indexer is patient by default** — ten attempts with a pause between them. On a first deploy the converter is still pulling its models while the first upload arrives, and being early should not mean being marked failed.
- **`UVICORN_HOST` is set to `::` on the converter.** Railway's private network is IPv6; a service listening only on `0.0.0.0` is invisible to the rest of the project, and the symptom is an unhelpful `fetch failed` in the indexer.

The repository carries `scripts/verify-search.sh`, which uploads a document containing a fact nobody would guess and then searches for it **in different words** — "how much did the rodent numbers grow" against a document that says "the marmot population increased by fourteen percent". A keyword search cannot pass that check. This template was published only after that script passed against a deployment created from the template itself.

## Why Deploy Document Search on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying document search on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
