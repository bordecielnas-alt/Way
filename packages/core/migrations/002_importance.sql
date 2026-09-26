-- Importance now includes a category nudge (see CATEGORY_WEIGHT in pipeline.ts).
UPDATE pois SET importance = LEAST(1, GREATEST(0, importance + CASE category
  WHEN 'polity' THEN 0.08
  WHEN 'battle' THEN 0.04
  WHEN 'disaster' THEN 0.04
  WHEN 'event' THEN 0.03
  WHEN 'city' THEN 0.02
  WHEN 'place' THEN -0.1
  ELSE 0 END));
