import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticateApiKey } from '../middleware/apiKey.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

// ─── helpers ───────────────────────────────────────────────────────────────────

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function classifyLength(itemCount) {
  if (itemCount <= 3) return 'short';
  if (itemCount <= 7) return 'medium';
  return 'long';
}

// ─── POST /c0-import ───────────────────────────────────────────────────────────
/**
 * Bulk import C0 records from PUTIX.
 *
 * Auth: X-API-Key header (PUTIX service key) OR Bearer JWT (admin).
 *
 * Body JSON:
 * {
 *   "records": [
 *     {
 *       "group_code":       "GRP-001",                    // required
 *       "seller_email":     "seller@example.com",         // required — must match a user in MINI WEB
 *       "items": [                                        // required, ≥1
 *         { "description": "Filtro de aceite", "quantity": 1 },
 *         { "description": "Pastillas de freno", "quantity": 2 }
 *       ],
 *       "vehicle_info": {                                 // optional
 *         "marca": "CHEVROLET",
 *         "modelo": "LUV",
 *         "anio": "2004",
 *         "cilindraje": "2500cc"
 *       },
 *       "conversion": "positive" | "negative" | "pending",  // optional, default "pending"
 *       "notes":           "...",                         // optional
 *       "quoted_at":       "2025-06-03T14:30:00Z",       // optional ISO-8601 timestamp
 *       "putix_ref":       "PUTIX-12345"                  // optional external reference ID
 *     }
 *   ]
 * }
 *
 * Response:
 * {
 *   "imported": 3,
 *   "errors":   [],
 *   "tickets":  [ { k_number, id, group_code, seller, status } ]
 * }
 */
router.post('/c0-import',
  // Accept either API key (PUTIX) or JWT (admin manual import)
  (req, res, next) => {
    if (req.headers['x-api-key']) {
      return authenticateApiKey(req, res, next);
    }
    // Fall back to JWT auth
    authenticate(req, res, (err) => {
      if (err) return next(err);
      authorize(['admin', 'dispatcher'])(req, res, next);
    });
  },
  asyncHandler(async (req, res) => {
    const { records } = req.body;

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({
        error: 'Se requiere un array "records" con al menos un registro',
        code: 'INVALID_BODY'
      });
    }

    if (records.length > 100) {
      return res.status(400).json({
        error: 'Máximo 100 registros por llamada',
        code: 'TOO_MANY_RECORDS'
      });
    }

    // ── Pre-fetch all sellers referenced in this batch ──
    const sellerEmails = [...new Set(records.map(r => r.seller_email?.toLowerCase()).filter(Boolean))];
    const { data: sellers } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name')
      .in('email', sellerEmails);

    const sellerMap = new Map((sellers || []).map(s => [s.email.toLowerCase(), s]));

    // ── Process each record ──
    const imported = [];
    const errors = [];

    for (let idx = 0; idx < records.length; idx++) {
      const rec = records[idx];
      try {
        // ── Validate ──
        if (!rec.group_code?.trim()) {
          errors.push({ index: idx, error: 'group_code requerido' });
          continue;
        }
        if (!rec.seller_email?.trim()) {
          errors.push({ index: idx, error: 'seller_email requerido' });
          continue;
        }
        if (!Array.isArray(rec.items) || rec.items.length === 0) {
          errors.push({ index: idx, error: 'items requerido (al menos 1)' });
          continue;
        }

        const seller = sellerMap.get(rec.seller_email.toLowerCase());
        if (!seller) {
          errors.push({ index: idx, error: `Vendedor no encontrado: ${rec.seller_email}` });
          continue;
        }

        // ── Deduplicate by putix_ref if provided ──
        if (rec.putix_ref) {
          const { data: existing } = await supabaseAdmin
            .from('tickets')
            .select('id, k_number')
            .eq('putix_ref', rec.putix_ref)
            .limit(1)
            .maybeSingle();

          if (existing) {
            errors.push({
              index: idx,
              error: `Registro PUTIX ya importado: ${rec.putix_ref} → ticket ${existing.k_number}`,
              existing_ticket: existing.k_number
            });
            continue;
          }
        }

        // ── Generate K-number ──
        const { data: kNumber, error: kErr } = await supabaseAdmin.rpc('generate_k_number');
        if (kErr) throw kErr;

        // ── Build ticket ──
        const itemCount = rec.items.length;
        const groupCode = rec.group_code.trim();
        const conversion = ['positive', 'negative', 'pending'].includes(rec.conversion)
          ? rec.conversion
          : 'pending';

        const rawText = rec.items.map(i =>
          `${i.quantity && i.quantity > 1 ? i.quantity + ' ' : ''}${i.description}`
        ).join('\n');

        const { data: ticket, error: ticketErr } = await supabaseAdmin
          .from('tickets')
          .insert({
            k_number: kNumber,
            group_code: groupCode,
            raw_text: rawText,
            item_count: itemCount,
            length_class: classifyLength(itemCount),
            priority: 'normal',
            status: 'closed',
            entry_type: 'putix_c0',
            vehicle_info: rec.vehicle_info || null,
            putix_ref: rec.putix_ref || null,
            conversion_status: conversion,
            notes: rec.notes || null,
            assigned_to: seller.id,
            assigned_at: rec.quoted_at || new Date().toISOString(),
            bg_processing_status: 'completed',
            created_by: seller.id,
            updated_by: seller.id
          })
          .select('id, k_number, group_code, status')
          .single();

        if (ticketErr) throw ticketErr;

        // ── Insert items ──
        const itemsToInsert = rec.items.map((item, i) => ({
          ticket_id: ticket.id,
          item_order: i + 1,
          raw_line: item.description,
          parsed_description: item.description,
          quantity: item.quantity || 1,
          status: conversion === 'positive' ? 'quoted' : 'pending_info'
        }));

        await supabaseAdmin.from('ticket_items').insert(itemsToInsert);

        // ── Audit ──
        await supabaseAdmin.from('audit_log').insert({
          entity_type: 'ticket',
          entity_id: ticket.id,
          action: 'create',
          new_values: {
            source: 'putix_c0',
            k_number: kNumber,
            group_code: groupCode,
            seller: seller.email,
            items: itemCount,
            conversion,
            putix_ref: rec.putix_ref || null
          },
          performed_by: req.user.id
        });

        imported.push({
          k_number: kNumber,
          id: ticket.id,
          group_code: groupCode,
          seller: seller.full_name,
          status: 'closed',
          items: itemCount
        });

      } catch (err) {
        console.error(`[C0-IMPORT] Error on record ${idx}:`, err.message);
        errors.push({ index: idx, error: err.message });
      }
    }

    const statusCode = imported.length > 0 ? 201 : 400;
    res.status(statusCode).json({
      imported: imported.length,
      errors,
      tickets: imported
    });
  })
);

// ─── GET /c0-import/status ─────────────────────────────────────────────────────
/**
 * Health-check / stats for the C0 import pipeline.
 * Returns total C0 imports today and this month.
 * Auth: API key or JWT admin.
 */
router.get('/c0-import/status',
  (req, res, next) => {
    if (req.headers['x-api-key']) {
      return authenticateApiKey(req, res, next);
    }
    authenticate(req, res, (err) => {
      if (err) return next(err);
      authorize(['admin', 'dispatcher'])(req, res, next);
    });
  },
  asyncHandler(async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const monthStart = today.slice(0, 7) + '-01';

    const { count: todayCount } = await supabaseAdmin
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('entry_type', 'putix_c0')
      .gte('created_at', `${today}T00:00:00`)
      .lt('created_at', `${today}T23:59:59.999`);

    const { count: monthCount } = await supabaseAdmin
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('entry_type', 'putix_c0')
      .gte('created_at', `${monthStart}T00:00:00`);

    res.json({
      status: 'ok',
      today: todayCount || 0,
      this_month: monthCount || 0,
      api_key_configured: !!process.env.PUTIX_API_KEY
    });
  })
);

export default router;
