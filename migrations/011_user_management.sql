-- 011: Extend users table for full account management

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS department    VARCHAR(100)  DEFAULT 'General',
  ADD COLUMN IF NOT EXISTS modules_access JSONB        NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_login    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS employee_id   VARCHAR(50);

-- Back-fill reasonable defaults for existing rows
UPDATE users SET
  department = CASE role
    WHEN 'admin'      THEN 'IT'
    WHEN 'supervisor' THEN 'Operations'
    WHEN 'gate'       THEN 'Gate'
    WHEN 'acdc'       THEN 'ACDC'
    ELSE 'General'
  END,
  modules_access = CASE role
    WHEN 'admin'      THEN '["workspace","gate","acdc","storage","users","settings"]'::jsonb
    WHEN 'supervisor' THEN '["workspace","gate","acdc","storage"]'::jsonb
    WHEN 'gate'       THEN '["gate"]'::jsonb
    WHEN 'acdc'       THEN '["acdc","storage"]'::jsonb
    ELSE '[]'::jsonb
  END,
  last_login = now() - (random() * interval '2 hours')
WHERE department IS NULL OR department = 'General';
