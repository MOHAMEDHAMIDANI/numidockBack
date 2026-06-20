-- 012: Storage / inventory management

CREATE TABLE IF NOT EXISTS storage_pallets (
  id           SERIAL PRIMARY KEY,
  item_code    VARCHAR(50)  NOT NULL,
  description  VARCHAR(255) NOT NULL DEFAULT '',
  sku          VARCHAR(100),
  warehouse    VARCHAR(100) NOT NULL DEFAULT 'WH1 - Central',
  zone         VARCHAR(100) NOT NULL DEFAULT 'Z02 - Storage',
  location     VARCHAR(100),
  pallet_id    VARCHAR(50),
  pallet_type  VARCHAR(20)  NOT NULL DEFAULT 'EUR',
  quantity     INTEGER      NOT NULL DEFAULT 0,
  base_unit    VARCHAR(20)  NOT NULL DEFAULT 'PCS',
  status       VARCHAR(20)  NOT NULL DEFAULT 'Available',
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_storage_pallets_item_code ON storage_pallets(item_code);
CREATE INDEX IF NOT EXISTS idx_storage_pallets_status    ON storage_pallets(status);
CREATE INDEX IF NOT EXISTS idx_storage_pallets_zone      ON storage_pallets(zone);

-- Seed demo rows
INSERT INTO storage_pallets (item_code, description, sku, warehouse, zone, location, pallet_id, pallet_type, quantity, base_unit, status) VALUES
  ('ITM-10001','Electric Motor 5kW',   'EM-5KW',     'WH1 - Central','Z01 - Receiving','Z01-R01-L02','PALT-000123','EUR', 12,'PCS','Available'),
  ('ITM-10002','Gearbox Reducer',       'GBX-RED-50', 'WH1 - Central','Z02 - Storage',  'Z02-A03-L01','PALT-000124','EUR',  8,'PCS','Available'),
  ('ITM-10003','Bearing 6205',          'BRG-6205',   'WH1 - Central','Z02 - Storage',  'Z02-B01-L03','PALT-000125','EUR',200,'PCS','Available'),
  ('ITM-10004','Hydraulic Pump',        'HDP-10A',    'WH2 - North',  'Z03 - Bulk',     'Z03-C02-L01','PALT-000126','IND',  6,'PCS','Reserved'),
  ('ITM-10005','Filter Element',        'FLT-100',    'WH1 - Central','Z02 - Storage',  'Z02-B02-L02','PALT-000127','EUR',150,'PCS','Available'),
  ('ITM-10006','Seal Kit',              'SEAL-KIT-01','WH3 - South',  'Z04 - Picking',  'Z04-P01-L01','PALT-000128','EUR', 30,'PCS','Available'),
  ('ITM-10007','Vent Valve',            'VV-25',      'WH2 - North',  'Z02 - Storage',  'Z02-A01-L04','PALT-000129','IND', 25,'PCS','On Hold'),
  ('ITM-10008','Pressure Gauge',        'PG-63',      'WH3 - South',  'Z03 - Bulk',     'Z03-C01-L02','PALT-000130','EUR', 40,'PCS','Available'),
  ('ITM-10009','Coupling',              'CPG-24',     'WH1 - Central','Z02 - Storage',  'Z02-B03-L01','PALT-000131','EUR', 18,'PCS','Reserved'),
  ('ITM-10010','Lubricant Oil 20L',     'LUB-20L',    'WH2 - North',  'Z05 - Chemical', 'Z05-D01-L01','PALT-000132','IND', 60,'PCS','Available')
ON CONFLICT DO NOTHING;
