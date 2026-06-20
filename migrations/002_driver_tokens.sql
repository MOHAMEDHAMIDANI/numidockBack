
CREATE TABLE driver_tokens (
    id            SERIAL PRIMARY KEY,
    appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    token         VARCHAR(64) UNIQUE NOT NULL,
    confirmed     BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_at  TIMESTAMPTZ,
    delay_reported BOOLEAN NOT NULL DEFAULT FALSE,
    delay_minutes INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_driver_tokens_token ON driver_tokens(token);
CREATE INDEX idx_driver_tokens_appt ON driver_tokens(appointment_id);