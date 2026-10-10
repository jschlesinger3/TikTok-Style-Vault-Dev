-- Wardrobe system - the single PostgreSQL schema shared by the Telegram bot (+ n8n) and the Style Vault
-- dashboard. PostgreSQL 13+ (gen_random_uuid() is built in).
-- Idempotent: safe to run again, also to upgrade an existing database.
--   psql "$DATABASE_URL" -f wardrobe-bot/schema.sql
--
--   items          your closet (written by Style Vault analysis; read by the stylist, audit, dashboard)
--   user_profile   build / colouring / aesthetic / colour rules (single row)
--   wear_logs      what you wore + ratings (bot /worn, dashboard)
--   inspo          saved looks broken down (Style Vault scraper, bot "inspo" photos/links)
--   closet_audits  /audit results
--   ingest_jobs    Style Vault's analysis queue (uploads, links, Telegram photos/videos)
--   drops          Drop Tracker

-- ---------------------------------------------------------------------------
-- items: one row per piece of clothing in the closet
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Style Vault stores the photo (or a video frame) and puts its URL here: '/media/...' for local storage
    -- or a bucket URL. Never store api.telegram.org/file/bot<TOKEN>/... links: they contain the token and expire.
    image_url         TEXT        NOT NULL,
    category          TEXT        NOT NULL
        CHECK (category IN ('top', 'bottom', 'outerwear', 'tailoring', 'footwear', 'accessory', 'other')),
    sub_category      TEXT,
    primary_color     TEXT,
    secondary_color   TEXT,
    fabric            TEXT,
    silhouette        TEXT,
    aesthetic_tags    TEXT[]      NOT NULL DEFAULT '{}',
    detailed_desc     TEXT,
    versatility_score SMALLINT    CHECK (versatility_score BETWEEN 1 AND 10),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_worn         DATE,
    wear_count        INTEGER     NOT NULL DEFAULT 0 CHECK (wear_count >= 0),
    status            TEXT        NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'laundry', 'archived', 'purged'))
);

CREATE INDEX IF NOT EXISTS idx_items_status_category ON items (status, category);
CREATE INDEX IF NOT EXISTS idx_items_aesthetic_tags  ON items USING GIN (aesthetic_tags);
CREATE INDEX IF NOT EXISTS idx_items_last_worn       ON items (last_worn NULLS FIRST);

-- ---------------------------------------------------------------------------
-- user_profile: single-row table (id is always 1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_profile (
    id                INT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    skin_tone         TEXT,
    hair_color        TEXT,
    eye_color         TEXT,
    build             TEXT,
    target_aesthetics TEXT[]  NOT NULL DEFAULT '{}',
    color_rules       JSONB   NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- wear_logs: one row per day/outfit worn
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wear_logs (
    id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    item_ids        UUID[]  NOT NULL CHECK (cardinality(item_ids) > 0),
    worn_date       DATE    NOT NULL DEFAULT CURRENT_DATE,
    event_context   TEXT,
    feedback_rating SMALLINT CHECK (feedback_rating BETWEEN 1 AND 10),
    feedback_notes  TEXT
);

CREATE INDEX IF NOT EXISTS idx_wear_logs_item_ids  ON wear_logs USING GIN (item_ids);
CREATE INDEX IF NOT EXISTS idx_wear_logs_worn_date ON wear_logs (worn_date DESC);

-- ---------------------------------------------------------------------------
-- Keep items.wear_count / items.last_worn in sync with wear_logs automatically,
-- so n8n only has to INSERT a wear log. Also rejects logs that reference unknown items
-- (arrays can't carry foreign keys).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wear_logs_apply() RETURNS trigger AS $$
DECLARE
    missing UUID[];
BEGIN
    SELECT array_agg(x) INTO missing
    FROM unnest(NEW.item_ids) AS x
    WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id = x);
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'wear_logs: unknown item id(s): %', missing USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF TG_OP = 'INSERT' THEN
        UPDATE items
           SET wear_count = wear_count + 1,
               last_worn  = GREATEST(COALESCE(last_worn, NEW.worn_date), NEW.worn_date)
         WHERE id = ANY (SELECT DISTINCT unnest(NEW.item_ids));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wear_logs_apply ON wear_logs;
CREATE TRIGGER trg_wear_logs_apply
    BEFORE INSERT OR UPDATE OF item_ids ON wear_logs
    FOR EACH ROW EXECUTE FUNCTION wear_logs_apply();

-- Style Vault additions (nullable; safe on existing databases)
ALTER TABLE items ADD COLUMN IF NOT EXISTS brand         TEXT;  -- only when identifiable (logo, tag, signature design)
ALTER TABLE items ADD COLUMN IF NOT EXISTS product_name  TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS video_url     TEXT;  -- source clip if added from a video
ALTER TABLE items ADD COLUMN IF NOT EXISTS source_job_id UUID;  -- ingest_jobs.id that created it

-- Handy view for the stylist: what's available to wear, least-recently-worn first.
DROP VIEW IF EXISTS closet_available;
CREATE VIEW closet_available AS
SELECT id, category, sub_category, primary_color, secondary_color, fabric, silhouette,
       aesthetic_tags, detailed_desc, versatility_score, last_worn, wear_count, brand, product_name
  FROM items
 WHERE status = 'active'
 ORDER BY last_worn NULLS FIRST, versatility_score DESC NULLS LAST;

-- ---------------------------------------------------------------------------
-- inspo: looks you've saved (photos captioned "inspo" or /inspo <link>), broken down by Claude.
-- The stylist and the closet audit read the recent board to steer recommendations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inspo (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    image_url      TEXT,                       -- 'tg:<file_id>' like items.image_url
    source_url     TEXT,                       -- TikTok / Pinterest / IG link if given
    user_notes     TEXT,                       -- what you said you liked
    look_summary   TEXT,
    why_it_works   TEXT,
    formula        TEXT,                       -- the transferable rule, e.g. "tailored trouser + hoodie + loafer"
    key_pieces     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    aesthetic_tags TEXT[]      NOT NULL DEFAULT '{}',
    palette        TEXT[]      NOT NULL DEFAULT '{}',
    fit_for_user   TEXT,                       -- how to adapt it to your build/colouring
    status         TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inspo_created ON inspo (created_at DESC) WHERE status = 'active';
ALTER TABLE inspo ADD COLUMN IF NOT EXISTS video_url      TEXT;
ALTER TABLE inspo ADD COLUMN IF NOT EXISTS caption        TEXT;   -- post caption pulled from TikTok/IG
ALTER TABLE inspo ADD COLUMN IF NOT EXISTS recreate_with  JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE inspo ADD COLUMN IF NOT EXISTS missing_pieces JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE inspo ADD COLUMN IF NOT EXISTS source_job_id  UUID;

-- ---------------------------------------------------------------------------
-- closet_audits: each /audit run (the closet rework plan), kept so you can track progress.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS closet_audits (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    focus          TEXT,
    style_direction TEXT,
    item_verdicts  JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- [{item_id, verdict, reason, action}]
    shopping_list  JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- ranked buys that close the gaps
    outfit_formulas JSONB      NOT NULL DEFAULT '[]'::jsonb,  -- repeatable uniforms from what you own
    raw_response   JSONB
);

-- ---------------------------------------------------------------------------
-- ingest_jobs: Style Vault's analysis queue. Every photo/video/link - from the dashboard or from Telegram -
-- becomes a job; when done it points at the items / inspo rows it created.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_jobs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    kind                TEXT        NOT NULL CHECK (kind IN ('closet', 'inspo')),
    source              TEXT        NOT NULL CHECK (source IN ('upload', 'link', 'telegram')),
    source_url          TEXT,                     -- TikTok/IG/Pinterest/direct link
    media_url           TEXT,                     -- stored image (or video cover frame)
    video_url           TEXT,                     -- stored original video
    media_type          TEXT        CHECK (media_type IN ('image', 'video')),
    notes               TEXT,                     -- what the user typed with it
    caption             TEXT,                     -- caption pulled from the post
    telegram_chat_id    BIGINT,                   -- reply here when done (Telegram jobs)
    telegram_message_id BIGINT,
    status              TEXT        NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    error               TEXT,
    result_item_ids     UUID[]      NOT NULL DEFAULT '{}',
    result_inspo_id     UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_open ON ingest_jobs (created_at DESC) WHERE status <> 'done';

-- ---------------------------------------------------------------------------
-- drops: Style Vault Drop Tracker
-- ---------------------------------------------------------------------------
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
