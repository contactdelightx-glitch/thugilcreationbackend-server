-- the admin can mark one (or more) packages as "Most popular", shown as a tag on the card
ALTER TABLE design_packages ADD COLUMN IF NOT EXISTS is_popular BOOLEAN NOT NULL DEFAULT FALSE;
