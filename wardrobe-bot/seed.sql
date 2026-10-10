-- Seed the single user profile. Idempotent: re-running updates the row in place.
INSERT INTO user_profile (id, skin_tone, hair_color, eye_color, build, target_aesthetics, color_rules)
VALUES (
    1,
    'olive, warm undertone',
    'dark',
    'brown',
    'athletic, broad shoulders, narrow waist',
    ARRAY['streetwear tailoring', 'tuff and elevated', 'wide-leg geometry', 'silhouette and drape over logos'],
    -- Starter rules for olive skin + warm undertone + dark hair/brown eyes. Edit freely; the stylist reads this.
    '{
      "best_colors": ["camel", "cream", "ivory", "chocolate brown", "olive", "forest green", "navy", "burgundy", "rust", "terracotta", "charcoal"],
      "use_carefully": ["pure white (prefer ivory/off-white near the face)", "black (break it up with texture or a warm layer)"],
      "avoid_near_face": ["neon yellow", "pastel yellow", "icy pastels", "orange-leaning beige that matches skin tone"],
      "metals": "gold and brass over silver",
      "contrast": "medium-high: dark hair + olive skin carries deep tones and tonal looks well",
      "fit_notes": "boxy, structured tops that fit the broad shoulders and end at the belt, over heavy wide-leg bottoms with a soft single break; never shoulder seams sliding down the arm, never skinny or tapered-to-ankle trousers",
      "footwear": "structured leather with volume to catch a wide hem: high-shaft zip boots (Our Legacy Camion shape), lug-sole derbies, chunky loafers; heavy statement sneakers or archival runners for casual. Never a slim or low-profile shoe under a wide leg",
      "foundation": "wide-leg heavyweight wool or heavy cotton tailored trousers - pass as slacks for dress codes, drape like streetwear downtown",
      "references": "Dean The Mean (@deanthemean), Chris Heyn; lower half: wide-leg wool trousers (COS / Acne Studios shape) over high-shaft structured boots (Our Legacy Camion shape). Tuff and elevated; silhouette and drape over logos; no flashy logos"
    }'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
    skin_tone         = EXCLUDED.skin_tone,
    hair_color        = EXCLUDED.hair_color,
    eye_color         = EXCLUDED.eye_color,
    build             = EXCLUDED.build,
    target_aesthetics = EXCLUDED.target_aesthetics,
    color_rules       = EXCLUDED.color_rules;
