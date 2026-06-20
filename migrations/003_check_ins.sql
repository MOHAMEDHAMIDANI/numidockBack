CREATE TABLE check_ins (
    id             SERIAL PRIMARY KEY,
    appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    arrived_at_min INTEGER NOT NULL,        -- minutes from midnight when recorded
    category       VARCHAR(30) NOT NULL,    -- EARLY | ON_TIME | LATE | NO_APPOINTMENT
    vehicle_plate  VARCHAR(50),
    recorded_by    INTEGER REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (appointment_id)
);

CREATE INDEX idx_check_ins_appt ON check_ins(appointment_id);