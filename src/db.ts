/**
 * Storage: the documents themselves, the queue that processes them, and the
 * vectors they turn into.
 *
 * Everything lives in one Postgres. The original file is kept alongside its
 * chunks so a re-index never needs the uploader to still have the file.
 */
import { Pool } from "pg"

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 8),
  connectionTimeoutMillis: 10_000,
})

/** all-MiniLM-L6-v2 produces 384 dimensions; the column has to match exactly. */
export const EMBEDDING_DIMENSIONS = 384

const SCHEMA = `
create extension if not exists vector;

create table if not exists documents (
  id           bigserial primary key,
  filename     text not null,
  content_type text not null,
  byte_size    integer not null,
  sha256       text not null unique,
  content      bytea not null,
  status       text not null default 'pending'
               check (status in ('pending', 'processing', 'ready', 'failed')),
  attempts     integer not null default 0,
  error        text,
  markdown     text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The worker claims work through this index; without it the claim query scans
-- the whole table on every poll.
create index if not exists documents_status_idx on documents (status, created_at);

create table if not exists chunks (
  id           bigserial primary key,
  document_id  bigint not null references documents(id) on delete cascade,
  ordinal      integer not null,
  text         text not null,
  embedding    vector(${EMBEDDING_DIMENSIONS}) not null,
  unique (document_id, ordinal)
);
`

/**
 * The vector index is built separately: ivfflat refuses to be created on an
 * empty table in some versions, and a missing index is a performance problem
 * rather than a broken deployment.
 */
const VECTOR_INDEX = `
create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops)
`

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA)
  try {
    await pool.query(VECTOR_INDEX)
  } catch (error) {
    console.warn("vector index not created:", error instanceof Error ? error.message : error)
  }
}
