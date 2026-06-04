import { supabaseAdmin } from '../config/supabase.js';

/**
 * Group Analytics Service
 *
 * Computes and stores per-group metrics:
 *   - total tickets, lines quoted/positive/negative/pedido
 *   - conversion rate = lines_pedido / lines_positive
 *   - automatic A/B/C categorization
 *
 * Conversion rule (from client):
 *   conversion = lines_pedido ÷ lines_positive
 *   Negative lines do NOT affect conversion calculation.
 */

// ─── Category thresholds ───────────────────────────────────────────────────────
// A: conversion >= 60% AND at least 5 tickets in the period
// B: conversion >= 30% AND at least 3 tickets
// C: everything else (low conversion or insufficient volume)
const CATEGORY_A_MIN_CONVERSION = 0.60;
const CATEGORY_A_MIN_TICKETS = 5;
const CATEGORY_B_MIN_CONVERSION = 0.30;
const CATEGORY_B_MIN_TICKETS = 3;

/**
 * Compute analytics for a single group in a date range.
 * @param {string} groupCode
 * @param {string} periodStart - ISO date (YYYY-MM-DD)
 * @param {string} periodEnd   - ISO date (YYYY-MM-DD)
 * @returns {Promise<object>} computed metrics
 */
export async function computeGroupStats(groupCode, periodStart, periodEnd) {
  // Fetch all closed/pedido tickets for this group in the period
  const { data: tickets, error: tErr } = await supabaseAdmin
    .from('tickets')
    .select('id, status, is_venta_concreta, closed_at')
    .eq('group_code', groupCode)
    .in('status', ['pedido', 'closed'])
    .gte('closed_at', `${periodStart}T00:00:00`)
    .lte('closed_at', `${periodEnd}T23:59:59.999`);

  if (tErr) throw tErr;
  if (!tickets || tickets.length === 0) {
    return {
      group_code: groupCode,
      total_tickets: 0,
      lines_quoted: 0,
      lines_positive: 0,
      lines_negative: 0,
      lines_pedido: 0,
      lines_positive_not_sold: 0,
      total_pedido_value: 0,
      conversion_rate: null
    };
  }

  const ticketIds = tickets.map(t => t.id);
  const ventaConcretaIds = new Set(tickets.filter(t => t.is_venta_concreta).map(t => t.id));

  // Fetch all items for these tickets
  const { data: items, error: iErr } = await supabaseAdmin
    .from('ticket_items')
    .select('ticket_id, status, selling_price, quantity')
    .in('ticket_id', ticketIds);

  if (iErr) throw iErr;

  let linesQuoted = 0;
  let linesPositive = 0;
  let linesNegative = 0;
  let linesPedido = 0;
  let linesPositiveNotSold = 0;
  let totalPedidoValue = 0;

  for (const item of (items || [])) {
    linesQuoted++;

    if (item.status === 'positive') {
      linesPositive++;

      if (ventaConcretaIds.has(item.ticket_id)) {
        // This positive line belongs to a ticket that became a real order
        linesPedido++;
        const price = parseFloat(item.selling_price) || 0;
        const qty = item.quantity || 1;
        totalPedidoValue += price * qty;
      } else {
        // Positive but the ticket didn't convert to a sale
        linesPositiveNotSold++;
      }
    } else if (item.status === 'negative') {
      linesNegative++;
    }
  }

  // Conversion = lines_pedido / lines_positive (negatives excluded per client rule)
  const conversionRate = linesPositive > 0
    ? Math.round((linesPedido / linesPositive) * 10000) / 10000
    : null;

  return {
    group_code: groupCode,
    total_tickets: tickets.length,
    lines_quoted: linesQuoted,
    lines_positive: linesPositive,
    lines_negative: linesNegative,
    lines_pedido: linesPedido,
    lines_positive_not_sold: linesPositiveNotSold,
    total_pedido_value: Math.round(totalPedidoValue * 100) / 100,
    conversion_rate: conversionRate
  };
}

/**
 * Determine A/B/C category from computed stats.
 */
export function classifyCategory(stats) {
  if (stats.conversion_rate === null || stats.total_tickets === 0) return null;

  if (stats.conversion_rate >= CATEGORY_A_MIN_CONVERSION && stats.total_tickets >= CATEGORY_A_MIN_TICKETS) {
    return 'A';
  }
  if (stats.conversion_rate >= CATEGORY_B_MIN_CONVERSION && stats.total_tickets >= CATEGORY_B_MIN_TICKETS) {
    return 'B';
  }
  return 'C';
}

/**
 * Upsert a monthly analytics snapshot for a group.
 */
export async function saveGroupSnapshot(stats, periodStart, periodEnd) {
  const category = classifyCategory(stats);

  const row = {
    group_code: stats.group_code,
    period_start: periodStart,
    period_end: periodEnd,
    total_tickets: stats.total_tickets,
    lines_quoted: stats.lines_quoted,
    lines_positive: stats.lines_positive,
    lines_negative: stats.lines_negative,
    lines_pedido: stats.lines_pedido,
    lines_positive_not_sold: stats.lines_positive_not_sold,
    total_pedido_value: stats.total_pedido_value,
    conversion_rate: stats.conversion_rate,
    category,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabaseAdmin
    .from('group_analytics')
    .upsert(row, { onConflict: 'group_code,period_start' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Recalculate analytics for ALL active groups for a given month.
 * Also updates the `category` field on the groups table.
 *
 * @param {Date|string} month - any date within the target month (defaults to current month)
 * @returns {Promise<{ processed: number, results: object[] }>}
 */
export async function recalculateAllGroups(month) {
  const date = month ? new Date(month) : new Date();
  const periodStart = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const periodEnd = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // Get all groups that have had closed tickets ever
  const { data: groups, error: gErr } = await supabaseAdmin
    .from('tickets')
    .select('group_code')
    .in('status', ['pedido', 'closed'])
    .gte('closed_at', `${periodStart}T00:00:00`)
    .lte('closed_at', `${periodEnd}T23:59:59.999`);

  if (gErr) throw gErr;

  const uniqueCodes = [...new Set((groups || []).map(g => g.group_code).filter(Boolean))];

  const results = [];
  for (const code of uniqueCodes) {
    try {
      const stats = await computeGroupStats(code, periodStart, periodEnd);
      const snapshot = await saveGroupSnapshot(stats, periodStart, periodEnd);

      // Update group category on the groups table
      const category = classifyCategory(stats);
      if (category) {
        await supabaseAdmin
          .from('groups')
          .update({ category, category_updated_at: new Date().toISOString() })
          .eq('code', code);
      }

      results.push({ group_code: code, ...stats, category, snapshot_id: snapshot.id });
    } catch (err) {
      console.error(`[GROUP-ANALYTICS] Error for ${code}:`, err.message);
      results.push({ group_code: code, error: err.message });
    }
  }

  return { processed: results.length, period: { start: periodStart, end: periodEnd }, results };
}

/**
 * Get historical analytics for a specific group (all monthly snapshots).
 */
export async function getGroupHistory(groupCode, limit = 12) {
  const { data, error } = await supabaseAdmin
    .from('group_analytics')
    .select('*')
    .eq('group_code', groupCode)
    .order('period_start', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

/**
 * Get the latest snapshot for all groups (for dashboard/ranking).
 */
export async function getLatestGroupRankings() {
  // Get the most recent period_start
  const { data: latest } = await supabaseAdmin
    .from('group_analytics')
    .select('period_start')
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest) return [];

  const { data, error } = await supabaseAdmin
    .from('group_analytics')
    .select('*')
    .eq('period_start', latest.period_start)
    .order('conversion_rate', { ascending: false, nullsFirst: false });

  if (error) throw error;
  return data || [];
}
