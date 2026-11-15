-- A shopper's checkout between "Razorpay order created" and "payment verified".
-- The prices are fixed here by the server (never taken from the browser), and the items are kept so the
-- order can be written once Razorpay confirms the payment. Rows are removed after the order is saved.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS checkout_sessions (
  razorpay_order_id  VARCHAR(40)    PRIMARY KEY,
  customer_id        BIGINT         NOT NULL REFERENCES users (customer_id) ON DELETE CASCADE,
  amount             NUMERIC(10,2)  NOT NULL CHECK (amount > 0),
  items              JSONB          NOT NULL,
  created_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS checkout_sessions_customer_idx ON checkout_sessions (customer_id);
