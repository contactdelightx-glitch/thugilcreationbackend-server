-- Razorpay may send the same webhook more than once; the ids seen so far are kept so each event is handled once
-- (one email, not several).
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id     VARCHAR(100) PRIMARY KEY,
  event        VARCHAR(60)  NOT NULL,
  received_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
