/**
 * Lock Service
 * Manages ticket locking for concurrent access control
 */

import { supabaseAdmin } from '../config/supabase.js';

const LOCK_TIMEOUT_MINUTES = parseInt(process.env.LOCK_TIMEOUT_MINUTES || '10');

/**
 * Attempt to acquire lock on a ticket
 * @param {string} ticketId - Ticket UUID
 * @param {string} userId - User UUID requesting lock
 * @returns {Promise<Object>} Lock result
 */
export async function acquireLock(ticketId, userId) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TIMEOUT_MINUTES * 60 * 1000);
  
  // First check if ticket is already locked by someone else
  const { data: ticket, error: fetchError } = await supabaseAdmin
    .from('tickets')
    .select('id, locked_by, locked_at, lock_expires_at')
    .eq('id', ticketId)
    .single();
  
  if (fetchError) throw fetchError;
  if (!ticket) {
    return { success: false, error: 'Ticket not found', code: 'NOT_FOUND' };
  }
  
  // Check if locked by another user and not expired
  if (ticket.locked_by && ticket.locked_by !== userId) {
    const lockExpiry = new Date(ticket.lock_expires_at);
    
    if (lockExpiry > now) {
      // Still locked by another user
      const { data: lockingUser } = await supabaseAdmin
        .from('users')
        .select('full_name')
        .eq('id', ticket.locked_by)
        .single();
      
      return {
        success: false,
        error: 'Ticket is locked by another user',
        code: 'LOCKED_BY_OTHER',
        locked_by: ticket.locked_by,
        locked_by_name: lockingUser?.full_name,
        locked_at: ticket.locked_at,
        expires_at: ticket.lock_expires_at
      };
    }
    // Lock has expired, we can take it
  }
  
  // Acquire the lock
  const { data, error } = await supabaseAdmin
    .from('tickets')
    .update({
      locked_by: userId,
      locked_at: now.toISOString(),
      lock_expires_at: expiresAt.toISOString()
    })
    .eq('id', ticketId)
    .select()
    .single();
  
  if (error) throw error;
  
  // Log the lock event
  await logLockEvent(ticketId, userId, 'lock');
  
  return {
    success: true,
    ticket: data,
    expires_at: expiresAt.toISOString()
  };
}

/**
 * Release lock on a ticket
 * @param {string} ticketId - Ticket UUID
 * @param {string} userId - User UUID releasing lock
 * @param {boolean} force - Force release (admin only)
 * @returns {Promise<Object>} Release result
 */
export async function releaseLock(ticketId, userId, force = false) {
  // Verify user owns the lock (unless force)
  if (!force) {
    const { data: ticket, error: fetchError } = await supabaseAdmin
      .from('tickets')
      .select('locked_by')
      .eq('id', ticketId)
      .single();
    
    if (fetchError) throw fetchError;
    
    if (ticket.locked_by && ticket.locked_by !== userId) {
      return {
        success: false,
        error: 'Cannot release lock owned by another user',
        code: 'NOT_LOCK_OWNER'
      };
    }
  }
  
  const { data, error } = await supabaseAdmin
    .from('tickets')
    .update({
      locked_by: null,
      locked_at: null,
      lock_expires_at: null
    })
    .eq('id', ticketId)
    .select()
    .single();
  
  if (error) throw error;
  
  // Log the unlock event
  await logLockEvent(ticketId, userId, force ? 'force_unlock' : 'unlock');
  
  return {
    success: true,
    ticket: data
  };
}

/**
 * Extend lock timeout
 * @param {string} ticketId - Ticket UUID
 * @param {string} userId - User UUID
 * @returns {Promise<Object>} Extension result
 */
export async function extendLock(ticketId, userId) {
  const now = new Date();
  const newExpiresAt = new Date(now.getTime() + LOCK_TIMEOUT_MINUTES * 60 * 1000);
  
  // Verify user owns the lock
  const { data: ticket, error: fetchError } = await supabaseAdmin
    .from('tickets')
    .select('locked_by')
    .eq('id', ticketId)
    .single();
  
  if (fetchError) throw fetchError;
  
  if (ticket.locked_by !== userId) {
    return {
      success: false,
      error: 'Cannot extend lock not owned by user',
      code: 'NOT_LOCK_OWNER'
    };
  }
  
  const { data, error } = await supabaseAdmin
    .from('tickets')
    .update({
      lock_expires_at: newExpiresAt.toISOString()
    })
    .eq('id', ticketId)
    .select()
    .single();
  
  if (error) throw error;
  
  return {
    success: true,
    ticket: data,
    expires_at: newExpiresAt.toISOString()
  };
}

/**
 * Get lock status of a ticket
 * @param {string} ticketId - Ticket UUID
 * @returns {Promise<Object>} Lock status
 */
export async function getLockStatus(ticketId) {
  const { data: ticket, error } = await supabaseAdmin
    .from('tickets')
    .select(`
      id,
      locked_by,
      locked_at,
      lock_expires_at,
      locked_by_user:users!tickets_locked_by_fkey(id, full_name, email)
    `)
    .eq('id', ticketId)
    .single();
  
  if (error) throw error;
  
  if (!ticket.locked_by) {
    return {
      locked: false,
      available: true
    };
  }
  
  const now = new Date();
  const expiresAt = new Date(ticket.lock_expires_at);
  const isExpired = expiresAt < now;
  
  return {
    locked: !isExpired,
    available: isExpired,
    locked_by: ticket.locked_by,
    locked_by_name: ticket.locked_by_user?.full_name,
    locked_at: ticket.locked_at,
    expires_at: ticket.lock_expires_at,
    is_expired: isExpired
  };
}

/**
 * Release all expired locks (scheduled task)
 * @returns {Promise<number>} Number of locks released
 */
export async function releaseExpiredLocks() {
  const now = new Date().toISOString();
  
  const { data, error } = await supabaseAdmin
    .from('tickets')
    .update({
      locked_by: null,
      locked_at: null,
      lock_expires_at: null
    })
    .lt('lock_expires_at', now)
    .not('locked_by', 'is', null)
    .select('id');
  
  if (error) throw error;
  
  return data?.length || 0;
}

/**
 * Log lock events for audit trail
 */
async function logLockEvent(ticketId, userId, action) {
  try {
    await supabaseAdmin
      .from('audit_log')
      .insert({
        entity_type: 'ticket',
        entity_id: ticketId,
        action: action,
        performed_by: userId,
        new_values: { action, timestamp: new Date().toISOString() }
      });
  } catch (error) {
    console.error('Failed to log lock event:', error);
    // Don't throw - logging failure shouldn't break the operation
  }
}

export default {
  acquireLock,
  releaseLock,
  extendLock,
  getLockStatus,
  releaseExpiredLocks
};
