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
