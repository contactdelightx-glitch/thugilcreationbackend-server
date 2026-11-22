-- Finished work the admin sends back to the customer (attached to a progress update).
CREATE TABLE IF NOT EXISTS design_request_files (
  id            BIGSERIAL PRIMARY KEY,
  request_id    BIGINT NOT NULL REFERENCES design_requests(id) ON DELETE CASCADE,
  update_id     BIGINT,
  name          VARCHAR(255) NOT NULL,
  ref           TEXT NOT NULL,            -- private S3 reference
  content_type  VARCHAR(100) NOT NULL,
  size          BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS design_request_files_request ON design_request_files (request_id);
