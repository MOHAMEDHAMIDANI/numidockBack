ALTER TABLE appointments ADD COLUMN prep_state VARCHAR(20) NOT NULL DEFAULT 'PENDING';
-- PENDING = needs prep, not started; STARTED; READY; NONE = no prep needed (unload)