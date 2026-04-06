/**
 * Ranking Routes
 * Weekly ranking system per client spec §9
 * 
 * Weighting: 60% time compliance, 25% conversion to Pedido, 15% volume
 * Min target: 85%
 * Reset every Monday with weekly history
 */

import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

router.use(authenticate);

/**
 * GET /api/ranking/current
 * Get current week's ranking (visible to all per client spec §9)
 */
router.get('/current', asyncHandler(async (req, res) => {
  const now = new Date();
  // Find Monday of current week
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  monday.setHours(0, 0, 0, 0);
  
  const weekStart = monday.toISOString().split('T')[0];
  
  // Check if ranking exists for this week
  let { data: rankings } = await supabaseAdmin
    .from('weekly_ranking')
    .select(`
      *,
      user:users!weekly_ranking_user_id_fkey(id, full_name, role)
    `)
    .eq('week_start', weekStart)
    .order('position', { ascending: true });
  
  // If no rankings yet, calculate them live
  if (!rankings || rankings.length === 0) {
    rankings = await calculateWeeklyRanking(monday);
  }
  
  res.json({
    week_start: weekStart,
    week_end: new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    min_target: 85,
    rankings: rankings || []
  });
}));

/**
 * GET /api/ranking/history
 * Get ranking history for past weeks
 */
router.get('/history', asyncHandler(async (req, res) => {
  const { weeks = 4 } = req.query;
  
  const { data: rankings } = await supabaseAdmin
    .from('weekly_ranking')
    .select(`
      *,
      user:users!weekly_ranking_user_id_fkey(id, full_name, role)
    `)
    .order('week_start', { ascending: false })
    .order('position', { ascending: true })
    .limit(parseInt(weeks) * 20); // Assume max 20 users
  
  // Group by week
  const byWeek = {};
  (rankings || []).forEach(r => {
    if (!byWeek[r.week_start]) byWeek[r.week_start] = [];
    byWeek[r.week_start].push(r);
  });
  
  res.json({
    weeks: Object.entries(byWeek).map(([weekStart, entries]) => ({
      week_start: weekStart,
      rankings: entries
    }))
  });
}));

/**
 * POST /api/ranking/recalculate
 * Force recalculation of current week's ranking (admin only via middleware on caller)
 */
router.post('/recalculate', asyncHandler(async (req, res) => {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  monday.setHours(0, 0, 0, 0);
  
  const rankings = await calculateWeeklyRanking(monday);
  
  res.json({
    message: 'Ranking recalculado',
    rankings
  });
}));

/**
 * Calculate weekly ranking for sellers
 * Per client spec §9:
 *   60% time compliance (completed within SLA)
 *   25% conversion to Pedido
 *   15% volume (total tickets worked)
 */
async function calculateWeeklyRanking(mondayDate) {
  const weekStart = mondayDate.toISOString();
  const weekEnd = new Date(mondayDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const weekStartDate = mondayDate.toISOString().split('T')[0];
  const weekEndDate = new Date(mondayDate.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  
  // Get all sellers
  const { data: sellers } = await supabaseAdmin
    .from('users')
    .select('id, full_name, role')
    .in('role', ['seller', 'admin'])
    .eq('is_active', true);
  
  if (!sellers || sellers.length === 0) return [];
  
  // Get tickets worked by each seller this week
  const { data: weekTickets } = await supabaseAdmin
    .from('tickets')
    .select('id, assigned_to, status, sla_exceeded, sla_completed_at, sla_started_at')
    .not('assigned_to', 'is', null)
    .gte('assigned_at', weekStart)
    .lt('assigned_at', weekEnd);
  
  // Calculate metrics per seller
  const sellerMetrics = {};
  
  for (const seller of sellers) {
    const myTickets = (weekTickets || []).filter(t => t.assigned_to === seller.id);
    const totalWorked = myTickets.length;
    const completedOnTime = myTickets.filter(t => 
      t.sla_completed_at && !t.sla_exceeded
    ).length;
    const convertedToPedido = myTickets.filter(t => 
      t.status === 'pedido' || t.status === 'closed'
    ).length;
    
    const timeCompliance = totalWorked > 0 ? (completedOnTime / totalWorked) * 100 : 0;
    const conversionPct = totalWorked > 0 ? (convertedToPedido / totalWorked) * 100 : 0;
    
    sellerMetrics[seller.id] = {
      user_id: seller.id,
      total_tickets_worked: totalWorked,
      tickets_on_time: completedOnTime,
      tickets_converted_pedido: convertedToPedido,
      time_compliance_pct: Math.round(timeCompliance * 100) / 100,
      conversion_pct: Math.round(conversionPct * 100) / 100,
    };
  }
  
  // Find max volume for normalization
  const maxVolume = Math.max(1, ...Object.values(sellerMetrics).map(m => m.total_tickets_worked));
  
  // Calculate final scores with weighting
  const rankings = Object.values(sellerMetrics).map(m => {
    const volumeScore = (m.total_tickets_worked / maxVolume) * 100;
    const finalScore = 
      (m.time_compliance_pct * 0.60) + 
      (m.conversion_pct * 0.25) + 
      (volumeScore * 0.15);
    
    return {
      ...m,
      volume_score: Math.round(volumeScore * 100) / 100,
      final_score: Math.round(finalScore * 100) / 100
    };
  });
  
  // Sort by final score desc
  rankings.sort((a, b) => b.final_score - a.final_score);
  
  // Assign positions
  rankings.forEach((r, idx) => {
    r.position = idx + 1;
  });
  
  // Upsert into DB
  for (const r of rankings) {
    await supabaseAdmin
      .from('weekly_ranking')
      .upsert({
        user_id: r.user_id,
        week_start: weekStartDate,
        week_end: weekEndDate,
        total_tickets_worked: r.total_tickets_worked,
        tickets_on_time: r.tickets_on_time,
        tickets_converted_pedido: r.tickets_converted_pedido,
        time_compliance_pct: r.time_compliance_pct,
        conversion_pct: r.conversion_pct,
        volume_score: r.volume_score,
        final_score: r.final_score,
        position: r.position
      }, { onConflict: 'user_id,week_start' });
  }
  
  // Re-fetch with user details
  const { data: savedRankings } = await supabaseAdmin
    .from('weekly_ranking')
    .select(`
      *,
      user:users!weekly_ranking_user_id_fkey(id, full_name, role)
    `)
    .eq('week_start', weekStartDate)
    .order('position', { ascending: true });
  
  return savedRankings || rankings;
}

export default router;
