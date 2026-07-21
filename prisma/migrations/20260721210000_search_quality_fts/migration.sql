-- Denormalize document title onto chunks for weighted FTS ranking.
-- Rebuild FTS5 with unicode61 (no Porter stemming) and a title column.

ALTER TABLE "chunks" ADD COLUMN "title" TEXT;

UPDATE "chunks"
SET "title" = (
  SELECT d."title" FROM "documents" d WHERE d."id" = "chunks"."document_id"
);

DROP TRIGGER IF EXISTS chunks_ai;
DROP TRIGGER IF EXISTS chunks_ad;
DROP TRIGGER IF EXISTS chunks_au;

DROP TABLE IF EXISTS "chunks_fts";

CREATE VIRTUAL TABLE "chunks_fts" USING fts5(
  text,
  heading,
  section_path,
  title,
  content='chunks',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading, section_path, title)
  VALUES (new.rowid, new.text, new.heading, new.section_path, new.title);
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading, section_path, title)
  VALUES ('delete', old.rowid, old.text, old.heading, old.section_path, old.title);
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading, section_path, title)
  VALUES ('delete', old.rowid, old.text, old.heading, old.section_path, old.title);
  INSERT INTO chunks_fts(rowid, text, heading, section_path, title)
  VALUES (new.rowid, new.text, new.heading, new.section_path, new.title);
END;

INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
