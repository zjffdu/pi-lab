-- The receiver: a stand-in for the downstream booking system. It lives in its own Postgres schema and
-- is written only through its own connection pool and transactions, so "the receiver committed" and
-- "the application committed" are two different commits, as they would be for a real remote system.
-- Its tables know nothing about the application's actions or outbox.

CREATE TABLE receiver_bookings (
  tenant_id   text    NOT NULL,
  booking_no  text    NOT NULL,
  status      text    NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, booking_no)
);

-- One row per business effect actually applied. There is deliberately NO unique constraint on the
-- key: a receiver mode without idempotency must be able to apply the same request twice, and this
-- table is how a test counts that. `request_ref` is the client's key as the receiver logged it.
CREATE TABLE receiver_effects (
  id             bigserial PRIMARY KEY,
  request_ref    text,
  tenant_id      text        NOT NULL,
  booking_no     text        NOT NULL,
  from_status    text        NOT NULL,
  to_status      text        NOT NULL,
  from_version   integer     NOT NULL,
  to_version     integer     NOT NULL,
  fencing_token  bigint,
  applied_at     timestamptz NOT NULL
);

-- Idempotency records (used only by a receiver that supports idempotency keys): the first outcome
-- for a key, replayed verbatim for every later request with the same key and the same request.
CREATE TABLE receiver_keys (
  idempotency_key  text PRIMARY KEY,
  request_hash     text        NOT NULL,
  outcome          text        NOT NULL CHECK (outcome IN ('applied', 'rejected')),
  response         jsonb       NOT NULL,
  created_at       timestamptz NOT NULL
);

-- Highest fencing token accepted per key, for a receiver that validates fencing at its write boundary.
CREATE TABLE receiver_fences (
  idempotency_key  text PRIMARY KEY,
  max_token        bigint NOT NULL
);

-- Every request that reached the receiver, whatever happened to it. Ground truth for "attempts".
CREATE TABLE receiver_requests (
  id             bigserial PRIMARY KEY,
  request_ref    text,
  fencing_token  bigint,
  kind           text        NOT NULL CHECK (kind IN ('deliver', 'lookup')),
  outcome        text        NOT NULL,
  at             timestamptz NOT NULL
);
