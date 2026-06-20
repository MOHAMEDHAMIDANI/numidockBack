-- NumiDock initial schema (Step 2)

-- 1. Users (login + role)
CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    email         VARCHAR(255) UNIQUE NOT NULL,
    name          VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(50)  NOT NULL,   -- admin | supervisor | gate | acdc | preparation
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 2. Parameter sets (configurable operational settings, versioned)
CREATE TABLE parameter_sets (
    id                  SERIAL PRIMARY KEY,
    version             INTEGER     NOT NULL,
    dock_count          INTEGER     NOT NULL DEFAULT 16,
    slot_minutes        INTEGER     NOT NULL DEFAULT 30,
    horizon_start_min   INTEGER     NOT NULL DEFAULT 0,     -- minutes from midnight
    horizon_end_min     INTEGER     NOT NULL DEFAULT 1440,
    workers_per_dock    INTEGER     NOT NULL DEFAULT 3,
    arrival_window_min  INTEGER     NOT NULL DEFAULT 20,    -- +/- window around appointment
    lateness_tolerance_min INTEGER  NOT NULL DEFAULT 30,
    acdc_delay_threshold_min INTEGER NOT NULL DEFAULT 30,
    max_overtime_min    INTEGER     NOT NULL DEFAULT 0,
    is_active           BOOLEAN     NOT NULL DEFAULT FALSE,
    created_by          INTEGER     REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Shifts (belong to a parameter set)
CREATE TABLE shifts (
    id                SERIAL PRIMARY KEY,
    parameter_set_id  INTEGER NOT NULL REFERENCES parameter_sets(id) ON DELETE CASCADE,
    name              VARCHAR(50) NOT NULL,
    start_min         INTEGER NOT NULL,   -- minutes from midnight
    end_min           INTEGER NOT NULL,
    workers_available INTEGER NOT NULL
);

-- 4. Operation durations (belong to a parameter set)
CREATE TABLE operation_durations (
    id               SERIAL PRIMARY KEY,
    parameter_set_id INTEGER NOT NULL REFERENCES parameter_sets(id) ON DELETE CASCADE,
    operation_type   VARCHAR(20) NOT NULL,  -- LOAD | UNLOAD | LOAD_UNLOAD
    preparation_min  INTEGER NOT NULL,
    service_min      INTEGER NOT NULL,
    mise_en_stock_min INTEGER NOT NULL
);

-- 5. Schedules (one per planning day)
CREATE TABLE schedules (
    id            SERIAL PRIMARY KEY,
    planning_date DATE        NOT NULL,
    status        VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    active_version INTEGER,
    created_by    INTEGER     REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (planning_date)
);

-- 6. Truck requests (imported trucks for a schedule)
CREATE TABLE truck_requests (
    id               SERIAL PRIMARY KEY,
    schedule_id      INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    reference        VARCHAR(100) NOT NULL,
    operation_type   VARCHAR(20)  NOT NULL,   -- LOAD | UNLOAD | LOAD_UNLOAD
    carrier          VARCHAR(255),
    priority         VARCHAR(20)  NOT NULL DEFAULT 'NORMAL',
    driver_name      VARCHAR(255),
    driver_phone     VARCHAR(50),
    vehicle_plate    VARCHAR(50),
    status           VARCHAR(30)  NOT NULL DEFAULT 'IMPORTED',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 7. Schedule versions (each generation/edit creates a version)
CREATE TABLE schedule_versions (
    id               SERIAL PRIMARY KEY,
    schedule_id      INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    version_number   INTEGER NOT NULL,
    parameter_set_id INTEGER REFERENCES parameter_sets(id),
    engine_version   VARCHAR(50),
    objective_value  DOUBLE PRECISION,
    generation_ms    INTEGER,
    reason           TEXT,
    created_by       INTEGER REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. Appointments (the generated result per truck, within a version)
CREATE TABLE appointments (
    id                  SERIAL PRIMARY KEY,
    schedule_version_id INTEGER NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
    truck_request_id    INTEGER NOT NULL REFERENCES truck_requests(id) ON DELETE CASCADE,
    appointment_min     INTEGER,            -- generated appointment time (minutes from midnight)
    window_start_min    INTEGER,
    window_end_min      INTEGER,
    dock_number         INTEGER,            -- which dock (1..dock_count)
    preparation_start_min INTEGER,
    service_start_min   INTEGER,
    expected_completion_min INTEGER,
    expected_dock_release_min INTEGER,
    status              VARCHAR(30) NOT NULL DEFAULT 'PLANNED',
    is_locked           BOOLEAN     NOT NULL DEFAULT FALSE
);

-- Helpful indexes
CREATE INDEX idx_truck_requests_schedule ON truck_requests(schedule_id);
CREATE INDEX idx_appointments_version ON appointments(schedule_version_id);