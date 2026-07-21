-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "root_uri" TEXT NOT NULL,
    "title" TEXT,
    "strategy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "meta_json" TEXT NOT NULL DEFAULT '{}',
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source_id" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "title" TEXT,
    "content_hash" TEXT,
    "extracted_path" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "meta_json" TEXT NOT NULL DEFAULT '{}',
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    CONSTRAINT "documents_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "document_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "heading" TEXT,
    "section_path" TEXT,
    "start_offset" INTEGER,
    "end_offset" INTEGER,
    "content_hash" TEXT NOT NULL,
    "meta_json" TEXT NOT NULL DEFAULT '{}',
    "created_at" TEXT NOT NULL,
    CONSTRAINT "chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "chunks_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "chunk_embeddings" (
    "chunk_id" TEXT NOT NULL PRIMARY KEY,
    "model_id" TEXT NOT NULL,
    "dims" INTEGER NOT NULL,
    "embedding" BLOB NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "chunk_embeddings_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "chunks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ingest_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source_id" TEXT NOT NULL,
    "started_at" TEXT NOT NULL,
    "finished_at" TEXT,
    "status" TEXT NOT NULL,
    "strategy" TEXT,
    "pages_ok" INTEGER NOT NULL DEFAULT 0,
    "pages_failed" INTEGER NOT NULL DEFAULT 0,
    "pages_skipped" INTEGER NOT NULL DEFAULT 0,
    "report_path" TEXT,
    "meta_json" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "ingest_errors" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "run_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "uri" TEXT,
    "error" TEXT NOT NULL,
    "created_at" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "sources_root_uri_key" ON "sources"("root_uri");

-- CreateIndex
CREATE INDEX "idx_documents_source" ON "documents"("source_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_source_id_uri_key" ON "documents"("source_id", "uri");

-- CreateIndex
CREATE INDEX "idx_chunks_document" ON "chunks"("document_id");

-- CreateIndex
CREATE INDEX "idx_chunks_source" ON "chunks"("source_id");


-- FTS5 index over chunks (custom; not expressible in Prisma schema)
CREATE VIRTUAL TABLE IF NOT EXISTS "chunks_fts" USING fts5(
  text,
  heading,
  section_path,
  content='chunks',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading, section_path)
  VALUES (new.rowid, new.text, new.heading, new.section_path);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading, section_path)
  VALUES ('delete', old.rowid, old.text, old.heading, old.section_path);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading, section_path)
  VALUES ('delete', old.rowid, old.text, old.heading, old.section_path);
  INSERT INTO chunks_fts(rowid, text, heading, section_path)
  VALUES (new.rowid, new.text, new.heading, new.section_path);
END;
