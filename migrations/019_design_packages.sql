-- "Contact designer" packages: a customer subscribes to a package (paid once, valid for a number of days), then sends
-- work to the designer. Each package says how much of the normal work cost is charged (cost_percent) and how many
-- days the work takes (delivery_days). The admin sets all of this.
CREATE TABLE IF NOT EXISTS design_packages (
  id             BIGSERIAL PRIMARY KEY,
  name           VARCHAR(80)   NOT NULL,
  description    TEXT,                                   -- one line under the name
  details        TEXT,                                   -- what is included, one point per line
  price          NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  cost_percent   INTEGER       NOT NULL CHECK (cost_percent BETWEEN 1 AND 100),   -- 75 = the work costs 75% of the normal cost
  delivery_days  INTEGER       NOT NULL CHECK (delivery_days BETWEEN 1 AND 365),  -- days the designer takes for one work
  validity_days  INTEGER       NOT NULL DEFAULT 30 CHECK (validity_days BETWEEN 1 AND 3650),
  max_requests   INTEGER       CHECK (max_requests IS NULL OR max_requests >= 1), -- NULL = as many as they like
  is_active      BOOLEAN       NOT NULL DEFAULT TRUE,
  position       INTEGER       NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- what a customer bought. The terms are copied here, so changing a package later never changes what they paid for.
CREATE TABLE IF NOT EXISTS design_subscriptions (
  id                   BIGSERIAL PRIMARY KEY,
  customer_id          BIGINT        NOT NULL,
  package_id           BIGINT        REFERENCES design_packages(id) ON DELETE SET NULL,
  package_name         VARCHAR(80)   NOT NULL,
  price_paid           NUMERIC(10,2) NOT NULL,
  cost_percent         INTEGER       NOT NULL,
  delivery_days        INTEGER       NOT NULL,
  max_requests         INTEGER,
  razorpay_order_id    VARCHAR(60),
  razorpay_payment_id  VARCHAR(60) UNIQUE,
  starts_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at           TIMESTAMPTZ   NOT NULL,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS design_subscriptions_customer ON design_subscriptions (customer_id, expires_at DESC);

-- a request now belongs to a subscription, has a due date and a quote, and moves through more steps
ALTER TABLE design_requests
  ADD COLUMN IF NOT EXISTS subscription_id BIGINT REFERENCES design_subscriptions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS package_name    VARCHAR(80),
  ADD COLUMN IF NOT EXISTS cost_percent    INTEGER,
  ADD COLUMN IF NOT EXISTS delivery_days   INTEGER,
  ADD COLUMN IF NOT EXISTS due_date        DATE,
  ADD COLUMN IF NOT EXISTS normal_cost     NUMERIC(10,2),   -- the admin's normal price for this work
  ADD COLUMN IF NOT EXISTS quoted_price    NUMERIC(10,2),   -- normal_cost x the package's cost_percent
  ADD COLUMN IF NOT EXISTS delivered_at    TIMESTAMPTZ;
ALTER TABLE design_requests DROP CONSTRAINT IF EXISTS design_requests_status_check;
ALTER TABLE design_requests ADD CONSTRAINT design_requests_status_check CHECK (status IN ('new', 'contacted', 'in_progress', 'review', 'done'));
CREATE INDEX IF NOT EXISTS design_requests_customer ON design_requests (customer_id, created_at DESC);

-- the steps a request has been through, with the admin's message, shown to the customer as its progress
CREATE TABLE IF NOT EXISTS design_request_updates (
  id          BIGSERIAL PRIMARY KEY,
  request_id  BIGINT      NOT NULL REFERENCES design_requests(id) ON DELETE CASCADE,
  status      VARCHAR(20) NOT NULL,
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS design_request_updates_request ON design_request_updates (request_id, created_at);
