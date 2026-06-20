CREATE TABLE preparation_events (
    id             SERIAL PRIMARY KEY,
    appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    status         VARCHAR(20) NOT NULL,    -- STARTED | READY
    event_min      INTEGER,                 -- minutes from midnight
    recorded_by    INTEGER REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_prep_appt ON preparation_events(appointment_id);

-- track current readiness directly on appointment for fast checks
ALTER TABLE appointments ADD COLUMN products_ready BOOLEAN NOT NULL DEFAULT FALSE;