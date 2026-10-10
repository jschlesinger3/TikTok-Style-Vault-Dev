-- TikTok Style Vault: PostgreSQL schema.
-- Docker: auto-run on first start of the postgres container.
-- Managed DB: psql "$DATABASE_URL" -f db/init.sql   (idempotent)

CREATE TABLE IF NOT EXISTS outfits (
    id                  BIGSERIAL PRIMARY KEY,
    image_url           TEXT        NOT NULL,
    original_source_url TEXT,
    aesthetic_tags      TEXT[]      NOT NULL DEFAULT '{}',
    clothing_items      JSONB       NOT NULL DEFAULT '[]'::jsonb,
    date_added          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outfits_tags ON outfits USING GIN (aesthetic_tags);
CREATE INDEX IF NOT EXISTS idx_outfits_date ON outfits (date_added DESC);

CREATE TABLE IF NOT EXISTS drops (
    id               BIGSERIAL PRIMARY KEY,
    creator_name     TEXT          NOT NULL,
    collection_title TEXT          NOT NULL,
    target_url       TEXT          NOT NULL UNIQUE,
    drop_timestamp   TIMESTAMPTZ,
    last_known_price NUMERIC(10,2),
    status           TEXT          NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('unknown', 'upcoming', 'live', 'sold_out', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_drops_status ON drops (status);

-- v2: media analysis (safe to re-run on an existing database)
ALTER TABLE outfits ALTER COLUMN image_url SET DEFAULT '';
ALTER TABLE outfits ADD COLUMN IF NOT EXISTS media_type      TEXT NOT NULL DEFAULT 'image';
ALTER TABLE outfits ADD COLUMN IF NOT EXISTS video_url       TEXT;
ALTER TABLE outfits ADD COLUMN IF NOT EXISTS caption         TEXT;
ALTER TABLE outfits ADD COLUMN IF NOT EXISTS summary         TEXT;
ALTER TABLE outfits ADD COLUMN IF NOT EXISTS color_palette   TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE outfits ADD COLUMN IF NOT EXISTS analysis_status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE outfits ADD COLUMN IF NOT EXISTS analysis_error  TEXT;
ALTER TABLE outfits ADD COLUMN IF NOT EXISTS analyzed_at     TIMESTAMPTZ;

DO $$ BEGIN
    ALTER TABLE outfits ADD CONSTRAINT outfits_media_type_chk CHECK (media_type IN ('image', 'video'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    ALTER TABLE outfits ADD CONSTRAINT outfits_analysis_status_chk
        CHECK (analysis_status IN ('pending', 'processing', 'done', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_outfits_analysis_status ON outfits (analysis_status) WHERE analysis_status <> 'done';
