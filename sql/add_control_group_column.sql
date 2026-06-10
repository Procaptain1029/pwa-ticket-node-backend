-- Punto 18: Control A / Control B
-- Add control_group column to ticket_items so sellers can split the proforma
-- into two independent control flows during elaboration (typically for C2 tickets).
-- Values: 'A' (🔴), 'B' (🟢) or NULL (unassigned).

ALTER TABLE ticket_items
  ADD COLUMN IF NOT EXISTS control_group VARCHAR(1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'ticket_items_control_group_check'
      AND table_name = 'ticket_items'
  ) THEN
    ALTER TABLE ticket_items
      ADD CONSTRAINT ticket_items_control_group_check
      CHECK (control_group IS NULL OR control_group IN ('A', 'B'));
  END IF;
END$$;

-- Partial index for fast filtering when generating Control A / Control B blocks.
CREATE INDEX IF NOT EXISTS idx_ticket_items_control_group
  ON ticket_items(ticket_id, control_group)
  WHERE control_group IS NOT NULL;
