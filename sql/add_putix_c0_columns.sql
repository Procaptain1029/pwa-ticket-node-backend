-- Add columns needed for PUTIX C0 import integration
-- Run this migration on your Supabase database.

-- External reference ID from PUTIX (for deduplication)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS putix_ref TEXT UNIQUE;

-- Conversion status: tracks whether the C0 quote converted to a sale
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS conversion_status TEXT DEFAULT 'pending'
  CHECK (conversion_status IN ('positive', 'negative', 'pending'));

-- Notes field (general purpose, also useful for C0 context)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS notes TEXT;

-- Index for fast lookups by entry_type (c0 import queries)
CREATE INDEX IF NOT EXISTS idx_tickets_entry_type ON tickets(entry_type);

-- Index for PUTIX deduplication
CREATE INDEX IF NOT EXISTS idx_tickets_putix_ref ON tickets(putix_ref) WHERE putix_ref IS NOT NULL;
