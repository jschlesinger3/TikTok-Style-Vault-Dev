-- Seed the single user profile. Idempotent: re-running updates the row in place.
INSERT INTO user_profile (id, skin_tone, hair_color, eye_color, build, target_aesthetics, color_rules)
VALUES (
    1,
    'olive, warm undertone',
    'dark',
    'brown',
    'athletic, broad shoulders, narrow waist',
    ARRAY['old-money tailoring', 'streetwear', 'ballhog luxury'],
    -- Starter rules for olive skin + warm undertone + dark hair/brown eyes. Edit freely; the stylist reads this.
    '{
      "best_colors": ["camel", "cream", "ivory", "chocolate brown", "olive", "forest green", "navy", "burgundy", "rust", "terracotta", "charcoal"],
      "use_carefully": ["pure white (prefer ivory/off-white near the face)", "black (break it up with texture or a warm layer)"],
      "avoid_near_face": ["neon yellow", "pastel yellow", "icy pastels", "orange-leaning beige that matches skin tone"],
      "metals": "gold and brass over silver",
      "contrast": "medium-high: dark hair + olive skin carries deep tones and tonal looks well",
      "fit_notes": "show the shoulder-to-waist V: structured shoulders, tapered or straight trousers; avoid boxy oversized tops paired with baggy bottoms"
    }'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
    skin_tone         = EXCLUDED.skin_tone,
    hair_color        = EXCLUDED.hair_color,
    eye_color         = EXCLUDED.eye_color,
    build             = EXCLUDED.build,
    target_aesthetics = EXCLUDED.target_aesthetics,
    color_rules       = EXCLUDED.color_rules;
