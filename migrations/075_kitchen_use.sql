-- Kitchen Use: stock consumed without a sale (tasting, recipe testing, staff
-- meals, owner use, guest samples). Additive only; no history is rewritten.
-- Accounts 3030/5015/5080-5083 are seeded by ensureAccountingSchema at boot.
CREATE TABLE IF NOT EXISTS kitchen_use_records (
  id SERIAL PRIMARY KEY,
  reference_number TEXT NOT NULL UNIQUE,
  client_key TEXT UNIQUE,
  consumption_type TEXT NOT NULL CHECK (consumption_type IN ('chef_tasting','recipe_testing','staff_meal','owner_use','guest_sample')),
  source_mode TEXT NOT NULL CHECK (source_mode IN ('dish','ingredient')),
  menu_item_id INTEGER REFERENCES menu_items(id),
  inventory_item_id INTEGER REFERENCES inventory_items(id),
  item_label TEXT NOT NULL,
  quantity NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
  unit TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_approval','posted','rejected','reversed')),
  reason TEXT NOT NULL,
  notes TEXT,
  estimated_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  posted_cost NUMERIC(14,2),
  business_day_id INTEGER REFERENCES business_days(id),
  journal_id INTEGER REFERENCES journal_entries(id),
  reversal_journal_id INTEGER REFERENCES journal_entries(id),
  recorded_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMP,
  posted_at TIMESTAMP,
  decided_note TEXT,
  reversed_by INTEGER REFERENCES users(id),
  reversed_at TIMESTAMP,
  reversal_reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((source_mode = 'dish' AND menu_item_id IS NOT NULL) OR (source_mode = 'ingredient' AND inventory_item_id IS NOT NULL)),
  -- A posted or reversed record always carries its posting.
  CHECK (status IN ('pending_approval','rejected') OR posted_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS kitchen_use_components (
  id SERIAL PRIMARY KEY,
  kitchen_use_id INTEGER NOT NULL REFERENCES kitchen_use_records(id) ON DELETE RESTRICT,
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  item_name TEXT NOT NULL,
  quantity NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
  unit TEXT,
  unit_cost NUMERIC(18,6) NOT NULL DEFAULT 0,
  total_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  movement_id INTEGER REFERENCES stock_movements(id),
  reversal_movement_id INTEGER REFERENCES stock_movements(id),
  UNIQUE (kitchen_use_id, inventory_item_id)
);
CREATE INDEX IF NOT EXISTS idx_kitchen_use_status_day ON kitchen_use_records (status, business_day_id);
CREATE INDEX IF NOT EXISTS idx_kitchen_use_created ON kitchen_use_records (created_at);
