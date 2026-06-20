CREATE TABLE acdc_tasks (
    id             SERIAL PRIMARY KEY,
    appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    status         VARCHAR(30) NOT NULL DEFAULT 'REQUESTED',
    -- REQUESTED | ACCEPTED | COLLECTION_STARTED | PRODUCTS_COLLECTED | TRANSFERRED | DOCK_RELEASED | CANCELLED | FAILED
    requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at    TIMESTAMPTZ,
    transferred_at TIMESTAMPTZ,
    released_at    TIMESTAMPTZ,
    accepted_by    INTEGER REFERENCES users(id),
    UNIQUE (appointment_id)
);

CREATE INDEX idx_acdc_status ON acdc_tasks(status);