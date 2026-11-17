-- "Contact designer": a visitor describes the work they want done (and attaches up to 2 pictures); the admin follows up.
CREATE TABLE IF NOT EXISTS design_requests (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT,                                  -- set when the visitor was logged in
  name         VARCHAR(150) NOT NULL,
  email        VARCHAR(255) NOT NULL,
  phone        VARCHAR(30)  NOT NULL,
  requirement  TEXT         NOT NULL,
  notes        TEXT,
  images       TEXT[]       NOT NULL DEFAULT '{}',      -- private S3 references (s3://bucket/requests/...), at most 2
  source       VARCHAR(10)  NOT NULL DEFAULT 'web',     -- web | app
  status       VARCHAR(20)  NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'done')),
  admin_note   TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT design_requests_max_two_images CHECK (cardinality(images) <= 2)
);
CREATE INDEX IF NOT EXISTS design_requests_status_created ON design_requests (status, created_at DESC);
