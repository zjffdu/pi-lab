-- Lab 18 schema. Timestamps are supplied by the application clock, never by now(), so tests can
-- move time deterministically. No schema qualifiers: tests run this inside a throwaway schema.

CREATE TABLE bookings (
  tenant_id          text NOT NULL,
  booking_no         text NOT NULL,
  container_no       text NOT NULL,
  origin             text NOT NULL,
  destination        text NOT NULL,
  vessel             text NOT NULL,
  planned_departure  text NOT NULL,
  planned_arrival    text NOT NULL,
  status             text NOT NULL,
  -- Bumped by every executed action. An approval is bound to the version it was proposed against.
  version            integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, booking_no)
);

-- One row per proposed business action. The columns from tenant_id through digest are the
-- normalized arguments plus the resource version they were computed against; a trigger below
-- keeps them immutable after insert. Only `state` moves.
CREATE TABLE actions (
  id            uuid PRIMARY KEY,
  tenant_id     text        NOT NULL,
  requester     text        NOT NULL,
  action_type   text        NOT NULL CHECK (action_type = 'set_booking_status'),
  booking_no    text        NOT NULL,
  new_status    text        NOT NULL,
  reason        text        NOT NULL,
  base_version  integer     NOT NULL,
  digest        text        NOT NULL,
  state         text        NOT NULL CHECK (state IN
                  ('pending', 'approved', 'rejected', 'expired', 'revoked', 'invalidated', 'executed')),
  session_id    text,
  request_id    text        NOT NULL,
  created_at    timestamptz NOT NULL,
  -- Decision deadline: a proposal still pending at this instant can no longer be approved.
  expires_at    timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, booking_no) REFERENCES bookings (tenant_id, booking_no)
);
CREATE INDEX actions_tenant_state ON actions (tenant_id, state);

-- At most one decision per action. `digest` is the digest the approver confirmed; execution
-- recomputes the digest from the immutable proposal columns and compares it to this value.
CREATE TABLE approvals (
  id           uuid PRIMARY KEY,
  action_id    uuid        NOT NULL UNIQUE REFERENCES actions (id),
  approver     text        NOT NULL,
  decision     text        NOT NULL CHECK (decision IN ('approved', 'rejected')),
  digest       text        NOT NULL,
  decided_at   timestamptz NOT NULL,
  -- Execution deadline for an approved action.
  expires_at   timestamptz,
  consumed_at  timestamptz,
  revoked_at   timestamptz,
  revoked_by   text
);

-- The local simulated business effect, and the admission record. The primary key on action_id is
-- the database-level backstop for "one approved action, one executable business action".
CREATE TABLE effects (
  action_id     uuid PRIMARY KEY REFERENCES actions (id),
  tenant_id     text        NOT NULL,
  booking_no    text        NOT NULL,
  from_status   text        NOT NULL,
  to_status     text        NOT NULL,
  from_version  integer     NOT NULL,
  to_version    integer     NOT NULL,
  executed_by   text        NOT NULL,
  executed_at   timestamptz NOT NULL
);

-- Append-only audit trail for inspection. Denials on an action the caller could see are recorded
-- too, so a refused execution leaves a trace without leaving an effect.
CREATE TABLE action_events (
  id         bigserial PRIMARY KEY,
  action_id  uuid        NOT NULL REFERENCES actions (id),
  tenant_id  text        NOT NULL,
  event      text        NOT NULL,
  actor      text        NOT NULL,
  at         timestamptz NOT NULL,
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE FUNCTION actions_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.requester <> OLD.requester
     OR NEW.action_type <> OLD.action_type OR NEW.booking_no <> OLD.booking_no
     OR NEW.new_status <> OLD.new_status OR NEW.reason <> OLD.reason
     OR NEW.base_version <> OLD.base_version OR NEW.digest <> OLD.digest
     OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'proposal fields are immutable';
  END IF;
  IF OLD.state IN ('rejected', 'expired', 'revoked', 'invalidated', 'executed') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'state % is terminal', OLD.state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER actions_guard BEFORE UPDATE ON actions
  FOR EACH ROW EXECUTE FUNCTION actions_guard();

CREATE FUNCTION events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'action_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON action_events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
