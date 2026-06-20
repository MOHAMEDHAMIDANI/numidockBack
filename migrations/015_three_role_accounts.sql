-- 015: Collapse account access to three roles only

UPDATE users
SET role = 'supervisor',
    name = CASE WHEN name = 'Administrator' THEN 'Supervisor' ELSE name END,
    department = COALESCE(department, 'Operations')
WHERE role = 'admin';

UPDATE users
SET modules_access = '[]'::jsonb
WHERE modules_access IS NOT NULL;
