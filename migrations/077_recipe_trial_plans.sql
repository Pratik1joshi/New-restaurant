CREATE TABLE IF NOT EXISTS recipe_trial_plans (
  id SERIAL PRIMARY KEY,
  client_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  studio TEXT NOT NULL CHECK (studio IN ('bar', 'kitchen')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'planned', 'started')),
  ingredients TEXT NOT NULL,
  target_price DOUBLE PRECISION,
  instructions TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
