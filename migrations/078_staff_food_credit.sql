-- Staff food credit: a staff member's linked customer account carries food taken
-- on credit at POS; salary payments can settle it. Additive only.
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_login INTEGER NOT NULL DEFAULT 1;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_employee_id ON customers(employee_id) WHERE employee_id IS NOT NULL;
ALTER TABLE salary_payments ADD COLUMN IF NOT EXISTS food_deduction DOUBLE PRECISION NOT NULL DEFAULT 0;
INSERT INTO system_settings (setting_key, setting_value)
VALUES ('payroll_food_credit_cap_enabled', 'false') ON CONFLICT DO NOTHING;
