ALTER TABLE appointments ADD COLUMN gate_state VARCHAR(20) NOT NULL DEFAULT 'EXPECTED';
ALTER TABLE check_ins ADD COLUMN waiting_started_at_min INTEGER;
ALTER TABLE check_ins ADD COLUMN dock_admitted_at_min INTEGER;
ALTER TABLE check_ins ADD COLUMN departed_at_min INTEGER;