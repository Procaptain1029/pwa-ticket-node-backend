-- Daily C0 manual entries table
-- C0 tickets don't enter via MINI WEB yet, so sellers/admins enter counts manually.

CREATE TABLE IF NOT EXISTS daily_c0_entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_date DATE NOT NULL,
  tickets INTEGER NOT NULL DEFAULT 0,
  items INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(seller_id, report_date)
);

-- Index for fast lookup by date
CREATE INDEX IF NOT EXISTS idx_daily_c0_entries_date ON daily_c0_entries(report_date);

-- RLS (optional, adjust to your policy)
ALTER TABLE daily_c0_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read c0 entries"
  ON daily_c0_entries FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admin and dispatcher can manage c0 entries"
  ON daily_c0_entries FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
