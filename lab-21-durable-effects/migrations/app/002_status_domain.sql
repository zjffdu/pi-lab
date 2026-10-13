-- Keep the status domain in the database too, so a write that bypasses the application cannot
-- introduce a status the application never validated.
ALTER TABLE bookings ADD CONSTRAINT bookings_status_domain
  CHECK (status IN ('booked', 'in_transit', 'on_hold', 'delivered', 'cancelled'));
ALTER TABLE actions ADD CONSTRAINT actions_new_status_domain
  CHECK (new_status IN ('booked', 'in_transit', 'on_hold', 'delivered', 'cancelled'));
