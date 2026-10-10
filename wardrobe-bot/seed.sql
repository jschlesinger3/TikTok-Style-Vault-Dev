-- Seed the single user profile. Idempotent: re-running updates the row in place.
INSERT INTO user_profile (id, skin_tone, hair_color, eye_color, build, target_aesthetics, color_rules)
VALUES (
    1,
    'olive, warm undertone',
    'dark',
    'brown',
    'athletic, broad shoulders, narrow waist',
    ARRAY['streetwear tailoring', 'silhouette and drape over logos', 'vintage workwear', 'wide-leg tailoring'],
    -- Starter rules for olive skin + warm undertone + dark hair/brown eyes. Edit freely; the stylist reads this.
    '{
      "best_colors": ["camel", "cream", "ivory", "chocolate brown", "olive", "forest green", "navy", "burgundy", "rust", "terracotta", "charcoal"],
      "use_carefully": ["pure white (prefer ivory/off-white near the face)", "black (break it up with texture or a warm layer)"],
      "avoid_near_face": ["neon yellow", "pastel yellow", "icy pastels", "orange-leaning beige that matches skin tone"],
      "metals": "gold and brass over silver",
      "contrast": "medium-high: dark hair + olive skin carries deep tones and tonal looks well",
      "fit_notes": "boxy, structured tops that fit the broad shoulders and end at the belt, over heavy wide-leg bottoms with a soft single break; never shoulder seams sliding down the arm, never skinny or tapered-to-ankle trousers",
      "footwear": "substantial silhouettes to balance wide legs: chunky loafers, lug-sole derbies, archival runners (New Balance 990s, Salomon), boots",
      "references": "Dean The Mean (@deanthemean), Chris Heyn - silhouette and drape over logos; no logo flexing"
    }'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
    skin_tone         = EXCLUDED.skin_tone,
    hair_color        = EXCLUDED.hair_color,
    eye_color         = EXCLUDED.eye_color,
    build             = EXCLUDED.build,
    target_aesthetics = EXCLUDED.target_aesthetics,
    color_rules       = EXCLUDED.color_rules;
