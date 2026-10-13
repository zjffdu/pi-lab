-- Lab 21: the transactional outbox and its append-only event trail.
--
-- One outbox row per admitted action (UNIQUE action_id and UNIQUE idempotency_key are the database
-- backstops for "one approved action, one delivery obligation"). The columns from `booking_no`
-- through `base_version` are the request the receiver will get, copied from the action's immutable
-- proposal columns at admission; they never change.
--
--   pending        waiting for a worker to deliver it (also the state after a *safe* retry decision)
--   in_flight      a worker holds the lease and may have sent the request
--   unknown        an attempt ended without a definite answer (timeout, lost response, expired lease);
--                  nothing about the receiver is assumed until it is reconciled
--   succeeded      the receiver confirmed the effect and the result is durably recorded here
--   failed         the effect is known NOT to have happened, and no further delivery is planned
--                  (`last_error` says why: rejected_by_receiver | retries_exhausted)
--   manual_review  the application cannot decide safely; a person resolves it (see RUNBOOK.md)
CREATE TABLE outbox (
  id                  bigserial PRIMARY KEY,
  action_id           uuid        NOT NULL UNIQUE REFERENCES actions (id),
  tenant_id           text        NOT NULL,
  idempotency_key     text        NOT NULL UNIQUE,
  booking_no          text        NOT NULL,
  new_status          text        NOT NULL,
  base_version        integer     NOT NULL,
  status              text        NOT NULL CHECK (status IN ('pending', 'in_flight', 'unknown', 'succeeded', 'failed', 'manual_review')),
  -- Deliveries begun (claims of kind 'deliver') and reconciliation passes begun.
  delivery_attempts   integer     NOT NULL DEFAULT 0,
  reconcile_attempts  integer     NOT NULL DEFAULT 0,
  -- Bumped on every claim. A worker's write is accepted only if it still holds the current token.
  fencing_token       bigint      NOT NULL DEFAULT 0,
  lease_owner         text,
  lease_expires_at    timestamptz,
  next_attempt_at     timestamptz NOT NULL,
  last_error          text,
  review_reason       text,
  -- The durable result: what the receiver reported, recorded in the same transaction that flips
  -- `status` to succeeded and updates the local booking view.
  result              jsonb,
  resolution          jsonb,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);
CREATE INDEX outbox_claimable ON outbox (status, next_attempt_at);

-- The request-defining columns are immutable, and a terminal status stays terminal except through
-- the explicit manual-review resolution path (which moves manual_review, never a terminal state).
CREATE FUNCTION outbox_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.action_id <> OLD.action_id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.booking_no <> OLD.booking_no
     OR NEW.new_status <> OLD.new_status OR NEW.base_version <> OLD.base_version THEN
    RAISE EXCEPTION 'outbox request fields are immutable';
  END IF;
  IF OLD.status IN ('succeeded', 'failed') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'outbox status % is terminal', OLD.status;
  END IF;
  IF NEW.fencing_token < OLD.fencing_token THEN
    RAISE EXCEPTION 'fencing token may only increase';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_guard BEFORE UPDATE ON outbox
  FOR EACH ROW EXECUTE FUNCTION outbox_guard();

-- Append-only trail of everything that happened to an outbox row: claims, outcomes, expired leases,
-- discarded stale writes, reconciliation decisions, manual resolutions.
CREATE TABLE outbox_events (
  id             bigserial PRIMARY KEY,
  outbox_id      bigint      NOT NULL REFERENCES outbox (id),
  action_id      uuid        NOT NULL,
  event          text        NOT NULL,
  worker_id      text,
  fencing_token  bigint,
  at             timestamptz NOT NULL,
  detail         jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX outbox_events_outbox ON outbox_events (outbox_id, id);

CREATE TRIGGER outbox_events_append_only BEFORE UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
