-- Wardrobe Stylist Bot - PostgreSQL schema (PostgreSQL 13+; gen_random_uuid() is built in).
-- Idempotent: safe to run again.  psql "$DATABASE_URL" -f schema.sql

-- ---------------------------------------------------------------------------
-- items: one row per piece of clothing in the closet
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Durable reference to the photo. Recommended: 'tg:<telegram file_id>' (the bot can re-send it any time
    -- with sendPhoto) or your own bucket URL. Never store api.telegram.org/file/bot<TOKEN>/... links:
    -- they contain the bot token and expire.
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

-- Handy view for the stylist: what's available to wear, least-recently-worn first.
CREATE OR REPLACE VIEW closet_available AS
SELECT id, category, sub_category, primary_color, secondary_color, fabric, silhouette,
       aesthetic_tags, detailed_desc, versatility_score, last_worn, wear_count
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
