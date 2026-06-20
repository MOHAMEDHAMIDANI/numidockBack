ALTER TABLE parameter_sets ADD COLUMN dock_turnover_buffer_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parameter_sets ADD COLUMN blocked_docks INTEGER NOT NULL DEFAULT 0;