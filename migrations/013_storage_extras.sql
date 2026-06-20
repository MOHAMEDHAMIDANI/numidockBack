-- 013: Storage zone management + pallet constraints

-- Zone management table
CREATE TABLE IF NOT EXISTS storage_zones (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(100) NOT NULL UNIQUE,
  warehouse       VARCHAR(100) NOT NULL DEFAULT 'WH1 - Central',
  status          VARCHAR(10)  NOT NULL DEFAULT 'OPEN',  -- OPEN | CLOSED
  capacity_pallets INTEGER     NOT NULL DEFAULT 50,
  is_prep_zone    BOOLEAN      NOT NULL DEFAULT FALSE,
  description     VARCHAR(255),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Pallet constraint columns
ALTER TABLE storage_pallets
  ADD COLUMN IF NOT EXISTS max_weight_kg      INTEGER,
  ADD COLUMN IF NOT EXISTS product_type       VARCHAR(50),
  ADD COLUMN IF NOT EXISTS compatibility_group VARCHAR(50),
  ADD COLUMN IF NOT EXISTS max_slots          INTEGER DEFAULT 1;

-- Seed zones from existing distinct zone/warehouse combos
INSERT INTO storage_zones (name, warehouse, capacity_pallets, is_prep_zone)
VALUES
  ('Z01 - Receiving',  'WH1 - Central', 30,  FALSE),
  ('Z02 - Storage',    'WH1 - Central', 100, FALSE),
  ('Z03 - Bulk',       'WH2 - North',   80,  FALSE),
  ('Z04 - Picking',    'WH3 - South',   40,  TRUE),
  ('Z05 - Chemical',   'WH2 - North',   20,  FALSE)
ON CONFLICT (name) DO NOTHING;
