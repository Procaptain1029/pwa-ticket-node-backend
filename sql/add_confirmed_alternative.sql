-- Phase 2 of "Proforma / Pedido Final – Manejo de alternativas"
--
-- Adds the columns the system needs so the seller can mark which option
-- the customer confirmed when a quote line has multiple alternatives.
-- All downstream blocks (Pedido Final, Pedido por Proveedor, Copia Pedido,
-- Pedido Solo, Control A/B, Proforma Cliente) read these columns to pick
-- the right brand/price without the seller having to delete or rewrite text.
--
-- Semantics:
--   alternative_confirmed = FALSE (default)
--     → no explicit selection yet. Downstream blocks default to the primary
--       brand/price. The Pedido Final view surfaces a soft warning so the
--       seller knows there are still options pending confirmation.
--
--   alternative_confirmed = TRUE AND confirmed_alternative_id IS NULL
--     → the seller explicitly confirmed the PRIMARY brand/price. No more
--       warning for this line.
--
--   alternative_confirmed = TRUE AND confirmed_alternative_id IS <uuid>
--     → the seller confirmed the linked alternative. Downstream blocks use
--       the alternative's brand/price; other alternatives stop appearing
--       in any supplier-facing output.
--
-- The FK uses ON DELETE SET NULL so deleting an alternative row simply
-- reverts the line to "unconfirmed primary" instead of cascading or
-- failing.

ALTER TABLE ticket_items
  ADD COLUMN IF NOT EXISTS confirmed_alternative_id UUID
    REFERENCES ticket_item_alternatives(id) ON DELETE SET NULL;

ALTER TABLE ticket_items
  ADD COLUMN IF NOT EXISTS alternative_confirmed BOOLEAN NOT NULL DEFAULT FALSE;

-- Small partial index for the "show me unconfirmed lines" query the soft
-- warning runs. Index only the rows that actually have a confirmation
-- pointer so the index stays tiny on tickets without alternatives.
CREATE INDEX IF NOT EXISTS idx_ticket_items_confirmed_alt
  ON ticket_items(confirmed_alternative_id)
  WHERE confirmed_alternative_id IS NOT NULL;
