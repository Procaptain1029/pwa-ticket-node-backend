-- Group Analytics: category field on groups + monthly snapshots table
-- Run this migration on your Supabase database.

-- ═══════════════════════════════════════════════════════════════
-- 1. Add category + analytics fields to groups table
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE groups ADD COLUMN IF NOT EXISTS category TEXT DEFAULT NULL
  CHECK (category IN ('A', 'B', 'C'));

ALTER TABLE groups ADD COLUMN IF NOT EXISTS category_updated_at TIMESTAMPTZ DEFAULT NULL;

-- ═══════════════════════════════════════════════════════════════
-- 2. Monthly group analytics snapshots
--    Recalculated monthly; stores conversion metrics per group.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS group_analytics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  group_code TEXT NOT NULL,
  period_start DATE NOT NULL,          -- first day of the month
  period_end DATE NOT NULL,            -- last day of the month

  -- Ticket-level metrics
  total_tickets INTEGER NOT NULL DEFAULT 0,

  -- Line-level metrics
  lines_quoted INTEGER NOT NULL DEFAULT 0,        -- total items across all tickets
  lines_positive INTEGER NOT NULL DEFAULT 0,      -- items marked 'positive'
  lines_negative INTEGER NOT NULL DEFAULT 0,      -- items marked 'negative'
  lines_pedido INTEGER NOT NULL DEFAULT 0,        -- items in tickets that reached pedido/closed with is_venta_concreta
  lines_positive_not_sold INTEGER NOT NULL DEFAULT 0, -- positive but ticket NOT venta concreta

  -- Value
  total_pedido_value NUMERIC(12,2) NOT NULL DEFAULT 0, -- sum of selling_price * qty for pedido lines

  -- Conversion  (lines_pedido / lines_positive)  — NULL when lines_positive = 0
  conversion_rate NUMERIC(5,4) DEFAULT NULL,

  -- Assigned category at snapshot time
  category TEXT DEFAULT NULL CHECK (category IN ('A', 'B', 'C')),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(group_code, period_start)
);

CREATE INDEX IF NOT EXISTS idx_group_analytics_group ON group_analytics(group_code);
CREATE INDEX IF NOT EXISTS idx_group_analytics_period ON group_analytics(period_start);

-- RLS
ALTER TABLE group_analytics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read group analytics"
  ON group_analytics FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service can manage group analytics"
  ON group_analytics FOR ALL
  TO service_role
  USING (true);
