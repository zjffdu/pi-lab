-- A booking can carry several containers; its status belongs to the booking as a whole. Replaces the
-- single `container_no` column. Existing rows keep their one container.
ALTER TABLE bookings ADD COLUMN container_nos text[];
UPDATE bookings SET container_nos = ARRAY[container_no];
ALTER TABLE bookings ALTER COLUMN container_nos SET NOT NULL;
ALTER TABLE bookings ADD CONSTRAINT bookings_container_nos_nonempty CHECK (cardinality(container_nos) >= 1);
ALTER TABLE bookings DROP COLUMN container_no;
