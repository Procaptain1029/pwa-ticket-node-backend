/**
 * Reports Routes
 * Daily operational report: tickets & items worked per seller per carril (C0, C1, C2)
 * C0 is manual entry since those tickets don't enter via MINI WEB yet.
 */

import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

router.use(authenticate);

/**
 * GET /api/reports/daily?date=YYYY-MM-DD
 * Returns daily operational report grouped by carril and seller.
 * Carril classification:
 *   C0 = manual entries (separate table)
 *   C1 = tickets with 1-3 items (length_class = 'short')
 *   C2 = tickets with 4+ items (length_class = 'medium' or 'long')
 *
 * "Worked" = ticket was assigned to a seller (assigned_at) on the given date,
 *            OR its status was updated on that date while assigned.
 */
router.get('/daily', asyncHandler(async (req, res) => {
  const { date } = req.query;

  // Default to today (in UTC-5 Ecuador timezone approximation)
  const targetDate = date || new Date().toISOString().split('T')[0];
  const dayStart = `${targetDate}T00:00:00.000Z`;
  const dayEnd = `${targetDate}T23:59:59.999Z`;

  // ─── C1 & C2: Query tickets worked on this date ───
  // A ticket counts as "worked" if:
  //   - It was assigned on that date (assigned_at within range), OR
  //   - It was updated on that date while having an assigned seller
  const { data: tickets, error: ticketErr } = await supabaseAdmin
    .from('tickets')
    .select(`
      id,
      item_count,
      length_class,
      assigned_to,
      assigned_at,
      updated_at,
      status,
      assigned_to_user:users!tickets_assigned_to_fkey(id, full_name)
    `)
    .not('assigned_to', 'is', null)
    .or(`and(assigned_at.gte.${dayStart},assigned_at.lte.${dayEnd}),and(updated_at.gte.${dayStart},updated_at.lte.${dayEnd})`)
    .eq('is_merged', false)
    .is('parent_ticket_id', null);

  if (ticketErr) throw ticketErr;

  // Group by carril and seller
  const c1Sellers = {}; // short (1-3 items)
  const c2Sellers = {}; // medium/long (4+ items)

  for (const t of (tickets || [])) {
    const sellerId = t.assigned_to;
    const sellerName = t.assigned_to_user?.full_name || 'Desconocido';
    const itemCount = t.item_count || 0;

    // Determine carril: C1 = short, C2 = medium/long
    // Note: C0 (1 item) tickets that DO come through MINI WEB are grouped into C1 for now
    const isC2 = itemCount >= 4; // medium or long
    const bucket = isC2 ? c2Sellers : c1Sellers;

    if (!bucket[sellerId]) {
      bucket[sellerId] = { seller_id: sellerId, seller_name: sellerName, tickets: 0, items: 0 };
    }
    bucket[sellerId].tickets += 1;
    bucket[sellerId].items += itemCount;
  }

  // Sort by tickets desc within each carril
  const sortBucket = (bucket) =>
    Object.values(bucket).sort((a, b) => b.tickets - a.tickets || b.items - a.items);

  // ─── C0: Manual entries ───
  const { data: c0Entries, error: c0Err } = await supabaseAdmin
    .from('daily_c0_entries')
    .select(`
      id,
      seller_id,
      tickets,
      items,
      seller:users!daily_c0_entries_seller_id_fkey(id, full_name)
    `)
    .eq('report_date', targetDate);

  // If table doesn't exist yet, gracefully handle
  const c0Data = (c0Entries || []).map(e => ({
    id: e.id,
    seller_id: e.seller_id,
    seller_name: e.seller?.full_name || 'Desconocido',
    tickets: e.tickets,
    items: e.items
  }));

  // ─── Totals ───
  const c0Total = c0Data.reduce((acc, e) => ({ tickets: acc.tickets + e.tickets, items: acc.items + e.items }), { tickets: 0, items: 0 });
  const c1List = sortBucket(c1Sellers);
  const c2List = sortBucket(c2Sellers);
  const c1Total = c1List.reduce((acc, s) => ({ tickets: acc.tickets + s.tickets, items: acc.items + s.items }), { tickets: 0, items: 0 });
  const c2Total = c2List.reduce((acc, s) => ({ tickets: acc.tickets + s.tickets, items: acc.items + s.items }), { tickets: 0, items: 0 });

  res.json({
    date: targetDate,
    c0: {
      entries: c0Data,
      total: c0Total
    },
    c1: {
      sellers: c1List,
      total: c1Total
    },
    c2: {
      sellers: c2List,
      total: c2Total
    },
    grand_total: {
      tickets: c0Total.tickets + c1Total.tickets + c2Total.tickets,
      items: c0Total.items + c1Total.items + c2Total.items
    }
  });
}));

/**
 * GET /api/reports/c0-entries?date=YYYY-MM-DD
 * Get C0 manual entries for a specific date
 */
router.get('/c0-entries', asyncHandler(async (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];

  const { data, error } = await supabaseAdmin
    .from('daily_c0_entries')
    .select(`
      id,
      seller_id,
      tickets,
      items,
      notes,
      seller:users!daily_c0_entries_seller_id_fkey(id, full_name)
    `)
    .eq('report_date', targetDate)
    .order('tickets', { ascending: false });

  if (error) throw error;

  res.json({ entries: data || [] });
}));

/**
 * POST /api/reports/c0-entries
 * Add or update a C0 manual entry for a seller on a date
 * Body: { seller_id, tickets, items, date?, notes? }
 * Upserts: one entry per seller per date
 */
router.post('/c0-entries',
  authorize(['admin', 'dispatcher']),
  asyncHandler(async (req, res) => {
    const { seller_id, tickets, items, date, notes } = req.body;

    if (!seller_id || tickets == null || items == null) {
      return res.status(400).json({ error: 'seller_id, tickets, and items are required' });
    }

    const reportDate = date || new Date().toISOString().split('T')[0];

    const { data, error } = await supabaseAdmin
      .from('daily_c0_entries')
      .upsert({
        seller_id,
        report_date: reportDate,
        tickets: parseInt(tickets),
        items: parseInt(items),
        notes: notes || null,
        updated_by: req.user.id
      }, { onConflict: 'seller_id,report_date' })
      .select()
      .single();

    if (error) throw error;

    res.json({ entry: data, message: 'C0 entry saved' });
  })
);

/**
 * DELETE /api/reports/c0-entries/:id
 * Delete a C0 manual entry
 */
router.delete('/c0-entries/:id',
  authorize(['admin', 'dispatcher']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { error } = await supabaseAdmin
      .from('daily_c0_entries')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ message: 'C0 entry deleted' });
  })
);

export default router;
