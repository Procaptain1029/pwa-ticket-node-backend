-- Per-block observations (Punto 19 — "Notas por bloque").
--
-- Lets the seller attach an optional, free-text note to a specific
-- copy/paste block (Proforma Cliente, Control A, Control B, Pedido por
-- Proveedor, Pedido Final). When the note exists, it is appended to the
-- end of the generated block; otherwise the block stays exactly the
-- same as before.
--
-- Why JSONB instead of a side table:
--   - There are at most ~5 distinct block types per ticket. A side
--     table would mean an extra round-trip and an awkward join for
--     every block dispatch.
--   - JSONB lets us load all notes with the ticket itself (single
--     SELECT) and atomically merge a single key from the API.
--   - Each note is independent (different keys) so concurrent writes
--     on different blocks of the same ticket don't collide.
--
-- Shape of the column: { "<block_type>": "<note>", ... }
--
-- Example payloads:
--   {}                                              -- nothing set (default)
--   { "proforma_cliente": "MUESTRA DISCO" }
--   { "control_a": "FAVOR AYUDAR CON DESPACHO",
--     "pedido_supplier": "REVISAR MEDIDA CON BODEGA" }
--
-- Allowed block_type keys (validated server-side in the route, NOT in
-- SQL — kept in sync with BLOCK_NOTE_KEYS in routes/tickets.js):
--   proforma_cliente | control_a | control_b | pedido_supplier | pedido_final

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS block_notes JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN tickets.block_notes IS
  'Per-block observations (Punto 19). Keys are block_type strings, values are short free-text notes appended to the end of that block when generated.';
