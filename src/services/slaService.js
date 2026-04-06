/**
 * SLA Service
 * Manages SLA timing, alerts, and deadline calculations
 */

import { supabaseAdmin } from '../config/supabase.js';

/**
 * SLA thresholds by item count (in minutes)
 * Updated per client spec §6:
 *   IT 1-3 → 5 minutes
 *   IT 4-8 → 8 minutes
 *   IT 9+  → 10 minutes
 */
const SLA_THRESHOLDS = {
  3: 5,      // 1-3 items = 5 minutes
  8: 8,      // 4-8 items = 8 minutes
  max: 10    // 9+ items = 10 minutes
};

/**
 * Calculate SLA deadline based on item count
 * @param {number} itemCount - Number of items in ticket
 * @param {Date} startTime - When the ticket was taken
 * @returns {Date} Deadline timestamp
 */
export function calculateSlaDeadline(itemCount, startTime = new Date()) {
  let minutes;
  
  if (itemCount >= 1 && itemCount <= 3) {
    minutes = SLA_THRESHOLDS[3];
  } else if (itemCount >= 4 && itemCount <= 8) {
    minutes = SLA_THRESHOLDS[8];
  } else {
    minutes = SLA_THRESHOLDS.max;
  }
  
  const deadline = new Date(startTime);
  deadline.setMinutes(deadline.getMinutes() + minutes);
  
  return deadline;
}

/**
 * Get the SLA limit in minutes for a given item count
 */
export function getSlaLimitMinutes(itemCount) {
  if (itemCount >= 1 && itemCount <= 3) return SLA_THRESHOLDS[3];
  if (itemCount >= 4 && itemCount <= 8) return SLA_THRESHOLDS[8];
  return SLA_THRESHOLDS.max;
}

/**
 * Start SLA timer for a ticket
 * @param {string} ticketId - Ticket UUID
 * @param {number} itemCount - Number of items
 * @returns {Promise<Object>} Updated ticket with SLA fields
 */
export async function startSlaTimer(ticketId, itemCount) {
  const startTime = new Date();
  const deadline = calculateSlaDeadline(itemCount, startTime);
  
  const { data, error } = await supabaseAdmin
    .from('tickets')
    .update({
      sla_started_at: startTime.toISOString(),
      sla_deadline: deadline.toISOString(),
      sla_exceeded: false
    })
    .eq('id', ticketId)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

/**
 * Complete SLA for a ticket (mark as ready)
 * @param {string} ticketId - Ticket UUID
 * @returns {Promise<Object>} Updated ticket
 */
export async function completeSla(ticketId) {
  const completedAt = new Date();
  
  // First get the ticket to check if exceeded
  const { data: ticket, error: fetchError } = await supabaseAdmin
    .from('tickets')
    .select('sla_deadline')
    .eq('id', ticketId)
    .single();
  
  if (fetchError) throw fetchError;
  
  const exceeded = ticket.sla_deadline && completedAt > new Date(ticket.sla_deadline);
  
  const { data, error } = await supabaseAdmin
    .from('tickets')
    .update({
      sla_completed_at: completedAt.toISOString(),
      sla_exceeded: exceeded
    })
    .eq('id', ticketId)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

/**
 * Get SLA status for a ticket
 * @param {Object} ticket - Ticket object with SLA fields
 * @returns {Object} SLA status info
 */
export function getSlaStatus(ticket) {
  if (!ticket.sla_started_at) {
    return {
      status: 'not_started',
      message: 'SLA no iniciado',
      color: 'gray'
    };
  }
  
  if (ticket.sla_completed_at) {
    return {
      status: ticket.sla_exceeded ? 'exceeded' : 'completed',
      message: ticket.sla_exceeded ? 'SLA excedido' : 'Completado a tiempo',
      color: ticket.sla_exceeded ? 'red' : 'green',
      duration: calculateDuration(ticket.sla_started_at, ticket.sla_completed_at)
    };
  }
  
  const now = new Date();
  const deadline = new Date(ticket.sla_deadline);
  const remaining = deadline - now;
  
  if (remaining < 0) {
    return {
      status: 'exceeded',
      message: 'SLA excedido',
      color: 'red',
      exceededBy: Math.abs(remaining)
    };
  }
  
  // Calculate total SLA duration for percentage-based alerts
  const totalDuration = deadline - new Date(ticket.sla_started_at);
  const elapsed = totalDuration - remaining;
  const percentUsed = totalDuration > 0 ? (elapsed / totalDuration) * 100 : 0;
  
  // Alert at 80% of time (warning) and 100% (critical) per client spec §6
  if (percentUsed >= 100) {
    return {
      status: 'exceeded',
      message: 'SLA excedido - Alerta crítica',
      color: 'red',
      remaining,
      percentUsed
    };
  }
  
  if (percentUsed >= 80) {
    return {
      status: 'warning',
      message: 'Alerta: 80% del tiempo consumido',
      color: 'yellow',
      remaining,
      percentUsed
    };
  }
  
  return {
    status: 'active',
    message: 'En tiempo',
    color: 'green',
    remaining,
    percentUsed
  };
}

/**
 * Get overdue tickets grouped by user
 * @returns {Promise<Object>} Overdue tickets by user
 */
export async function getOverdueTickets() {
  const now = new Date().toISOString();
  
  const { data, error } = await supabaseAdmin
    .from('tickets')
    .select(`
      *,
      locked_by_user:users!tickets_locked_by_fkey(id, full_name, email),
      created_by_user:users!tickets_created_by_fkey(id, full_name, email)
    `)
    .not('sla_deadline', 'is', null)
    .is('sla_completed_at', null)
    .lt('sla_deadline', now)
    .order('sla_deadline', { ascending: true });
  
  if (error) throw error;
  
  // Group by user
  const byUser = {};
  data.forEach(ticket => {
    const userId = ticket.locked_by || ticket.created_by;
    const user = ticket.locked_by_user || ticket.created_by_user;
    
    if (!byUser[userId]) {
      byUser[userId] = {
        user,
        tickets: [],
        count: 0
      };
    }
    
    byUser[userId].tickets.push(ticket);
    byUser[userId].count++;
  });
  
  return {
    total: data.length,
    byUser
  };
}

/**
 * Calculate duration between two timestamps
 */
function calculateDuration(start, end) {
  const ms = new Date(end) - new Date(start);
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  return {
    ms,
    formatted: `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
  };
}

/**
 * Reset SLA timer on activity (comment or status change)
 * Per client spec §6: counter resets on activity
 * @param {string} ticketId - Ticket UUID
 * @returns {Promise<Object>} Updated ticket
 */
export async function resetSlaTimer(ticketId) {
  // Get current ticket to know item count
  const { data: ticket, error: fetchError } = await supabaseAdmin
    .from('tickets')
    .select('item_count, sla_started_at')
    .eq('id', ticketId)
    .single();
  
  if (fetchError) throw fetchError;
  if (!ticket.sla_started_at) return ticket; // SLA not started yet
  
  const now = new Date();
  const newDeadline = calculateSlaDeadline(ticket.item_count, now);
  
  const { data, error } = await supabaseAdmin
    .from('tickets')
    .update({
      sla_started_at: now.toISOString(),
      sla_deadline: newDeadline.toISOString(),
      sla_exceeded: false
    })
    .eq('id', ticketId)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

/**
 * Get pending ticket alerts
 * Per client spec §7:
 *   Minute 5 → visual alert
 *   Minute 10 → critical alert
 * Only visible to Dispatcher and Admin
 */
export async function getPendingAlerts() {
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
  
  // Get all pending tickets (not yet taken)
  const { data: pendingTickets, error } = await supabaseAdmin
    .from('tickets')
    .select(`
      id, k_number, group_code, item_count, priority, created_at,
      created_by_user:users!tickets_created_by_fkey(id, full_name)
    `)
    .eq('status', 'pending')
    .is('assigned_to', null)
    .lt('created_at', fiveMinAgo.toISOString())
    .order('created_at', { ascending: true });
  
  if (error) throw error;
  
  const alerts = (pendingTickets || []).map(ticket => {
    const createdAt = new Date(ticket.created_at);
    const minutesPending = (now - createdAt) / 60000;
    
    return {
      ...ticket,
      minutes_pending: Math.round(minutesPending),
      alert_level: minutesPending >= 10 ? 'critical' : 'warning',
      alert_message: minutesPending >= 10 
        ? `Alerta crítica: ${Math.round(minutesPending)} min sin tomar`
        : `Alerta: ${Math.round(minutesPending)} min sin tomar`
    };
  });
  
  return {
    total: alerts.length,
    critical: alerts.filter(a => a.alert_level === 'critical').length,
    warning: alerts.filter(a => a.alert_level === 'warning').length,
    alerts
  };
}

export default {
  calculateSlaDeadline,
  getSlaLimitMinutes,
  startSlaTimer,
  completeSla,
  getSlaStatus,
  getOverdueTickets,
  resetSlaTimer,
  getPendingAlerts
};
