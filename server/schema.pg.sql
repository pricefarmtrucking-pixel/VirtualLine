

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  is_banned INTEGER NOT NULL DEFAULT 0,
  banned_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',
  expires_at TIMESTAMPTZ NOT NULL,
  attempts_left INTEGER NOT NULL DEFAULT 5,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_otp_phone ON otp_codes(phone, purpose, expires_at);

CREATE TABLE IF NOT EXISTS facility_info (
  id INTEGER PRIMARY KEY CHECK (id=1),
  facility_phone TEXT,
  support_phone TEXT,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO facility_info (id, facility_phone, support_phone) VALUES (1, '(555) 123-4567', '(555) 987-6543');

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);
INSERT OR IGNORE INTO sites (id, code, name) VALUES (1,'EAST','East'),(2,'WEST','West');

CREATE TABLE IF NOT EXISTS site_settings (
  id BIGSERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  loads_target INTEGER NOT NULL,
  open_time TEXT NOT NULL,
  close_time TEXT NOT NULL,
  workins_per_hour INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  UNIQUE(site_id, date)
);

CREATE TABLE IF NOT EXISTS time_slots (
  id BIGSERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  slot_time TEXT NOT NULL,
  is_workin INTEGER NOT NULL DEFAULT 0,
  hold_token TEXT,
  hold_expires_at TIMESTAMPTZ,
  reserved_truck_id INTEGER,
  reserved_at TIMESTAMPTZ,
  UNIQUE(site_id, date, slot_time)
);
CREATE INDEX IF NOT EXISTS ix_slots_lookup ON time_slots(site_id, date, slot_time);
CREATE INDEX IF NOT EXISTS ix_slots_hold ON time_slots(hold_expires_at);

CREATE TABLE IF NOT EXISTS slot_reservations (
  id BIGSERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  slot_time TEXT NOT NULL,
  truck_id INTEGER,
  license_plate TEXT,
  driver_name TEXT,
  driver_phone TEXT,
  vendor_name TEXT,
  farm_or_ticket TEXT,
  est_amount DOUBLE PRECISION,
  est_unit TEXT,
  manage_token TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_res_site_date_time ON slot_reservations(site_id, date, slot_time);

CREATE TABLE IF NOT EXISTS trucks (
  id BIGSERIAL PRIMARY KEY,
  ticket TEXT, license_plate TEXT, carrier TEXT, driver_name TEXT, phone TEXT,
  commodity TEXT, gross_weight DOUBLE PRECISION, status TEXT DEFAULT 'QUEUED',
  queue_code TEXT, site_id INTEGER DEFAULT 1, checkin_date TEXT, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  , enroute_at TIMESTAMPTZ
  , arrived_at TIMESTAMPTZ
  , loading_at TIMESTAMPTZ
  , departed_at TIMESTAMPTZ
  , eta_prompted_at TIMESTAMPTZ
  , last_eta_sms_at TIMESTAMPTZ
  , line_type TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_trucks_code_site_day ON trucks(queue_code, site_id, checkin_date);
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  truck_id INTEGER,
  type TEXT,
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
