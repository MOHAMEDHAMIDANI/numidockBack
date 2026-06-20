-- 014: Align stored account module keys with the current app routes

UPDATE users
SET modules_access = (
  SELECT COALESCE(jsonb_agg(DISTINCT CASE WHEN value = 'settings' THEN 'parameters' ELSE value END), '[]'::jsonb)
  FROM jsonb_array_elements_text(users.modules_access)
)
WHERE modules_access ? 'settings';

UPDATE users
SET modules_access = CASE role
  WHEN 'admin'      THEN '["dashboard","workspace","gate","acdc","storage","users","parameters"]'::jsonb
  WHEN 'supervisor' THEN '["dashboard","workspace","gate","acdc","storage","users","parameters"]'::jsonb
  WHEN 'gate'       THEN '["gate"]'::jsonb
  WHEN 'acdc'       THEN '["acdc"]'::jsonb
  ELSE modules_access
END
WHERE modules_access IS NULL
   OR modules_access = '[]'::jsonb
   OR modules_access = '["workspace","gate","acdc","storage","users","settings"]'::jsonb
   OR modules_access = '["workspace","gate","acdc","storage"]'::jsonb
   OR modules_access = '["acdc","storage"]'::jsonb;
