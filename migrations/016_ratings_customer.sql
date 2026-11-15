-- Who wrote a rating, so a shopper can review a design they bought (once) and edit it later.
-- Old ratings imported from the saree site have no author (customer_id stays NULL).
-- If the account is deleted the review stays (SET NULL). Idempotent: safe to re-run.

ALTER TABLE saree_ratings ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES users (customer_id) ON DELETE SET NULL;
ALTER TABLE saree_ratings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- one review per shopper per design
CREATE UNIQUE INDEX IF NOT EXISTS saree_ratings_one_per_shopper
  ON saree_ratings (customer_id, design_category, design_id)
  WHERE customer_id IS NOT NULL AND design_id IS NOT NULL;
