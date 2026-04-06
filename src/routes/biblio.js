import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getSlaStatus } from '../services/slaService.js';

const router = Router();

// Apply authentication to all routes
router.use(authenticate);

/**
 * GET /api/biblio
 * Biblio main search endpoint with pagination and filters
 */
router.get('/', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    search, // Search by #K
    group_code,
    status,
    created_by,
    date_from,
    date_to,
    sort_by = 'created_at',
    sort_order = 'desc'
  } = req.query;
  
  const offset = (parseInt(page) - 1) * parseInt(limit);
  
  let query = supabaseAdmin
    .from('tickets')
    .select(`
      id,
      k_number,
      group_code,
      item_count,
      length_class,
      priority,
      status,
      possible_grouping,
      duplicate_label,
      sla_exceeded,
      created_at,
      updated_at,
      created_by_user:users!tickets_created_by_fkey(id, full_name),
      locked_by_user:users!tickets_locked_by_fkey(id, full_name)
    `, { count: 'exact' });
  
  // Apply filters
  if (search) {
    // Search by K number
    query = query.ilike('k_number', `%${search}%`);
  }
  
  if (group_code) {
    query = query.eq('group_code', group_code);
  }
  
  if (status) {
    query = query.eq('status', status);
  }
  
  if (created_by) {
    query = query.eq('created_by', created_by);
  }
  
  if (date_from) {
    query = query.gte('created_at', date_from);
  }
  
  if (date_to) {
    query = query.lte('created_at', date_to);
  }
  
  // Only get parent tickets (not extensions) by default
  query = query.is('parent_ticket_id', null);
  
  // Apply sorting
  const validSortFields = ['created_at', 'updated_at', 'k_number', 'priority', 'status'];
  const sortField = validSortFields.includes(sort_by) ? sort_by : 'created_at';
  query = query.order(sortField, { ascending: sort_order === 'asc' });
  
  // Apply pagination
  query = query.range(offset, offset + parseInt(limit) - 1);
  
  const { data, error, count } = await query;
  
  if (error) throw error;
  
  res.json({
    tickets: data,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: count,
      total_pages: Math.ceil(count / parseInt(limit))
    }
  });
}));

/**
 * GET /api/biblio/search/:kNumber
 * Search by exact K number
 */
router.get('/search/:kNumber', asyncHandler(async (req, res) => {
  const { kNumber } = req.params;
  
  // Get the main ticket
  const { data: ticket, error: ticketError } = await supabaseAdmin
    .from('tickets')
    .select(`
      *,
      created_by_user:users!tickets_created_by_fkey(id, full_name, email)
    `)
    .eq('k_number', kNumber)
    .single();
  
  if (ticketError) {
    if (ticketError.code === 'PGRST116') {
      return res.status(404).json({
        error: 'Ticket not found',
        code: 'NOT_FOUND'
      });
    }
    throw ticketError;
  }
  
  // Get extensions
  const { data: extensions } = await supabaseAdmin
    .from('tickets')
    .select(`
      id,
      k_number,
      extension_group_code,
      item_count,
      status,
      created_at,
      created_by_user:users!tickets_created_by_fkey(id, full_name)
    `)
    .eq('parent_ticket_id', ticket.id)
    .order('created_at', { ascending: true });
  
  res.json({
    ticket: {
      ...ticket,
      sla_status: getSlaStatus(ticket)
    },
    extensions: extensions || [],
    is_origin: true
  });
}));

/**
 * GET /api/biblio/groups
 * Get list of groups for filtering
 */
router.get('/groups', asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('tickets')
    .select('group_code')
    .not('group_code', 'is', null);
  
  if (error) throw error;
  
  // Get unique groups with count
  const groupCounts = data.reduce((acc, ticket) => {
    acc[ticket.group_code] = (acc[ticket.group_code] || 0) + 1;
    return acc;
  }, {});
  
  const groups = Object.entries(groupCounts).map(([code, count]) => ({
    code,
    count
  })).sort((a, b) => b.count - a.count);
  
  res.json({ groups });
}));

/**
 * GET /api/biblio/stats
 * Get biblio statistics
 */
router.get('/stats', asyncHandler(async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Calculate start of week (Monday)
  const startOfWeek = new Date(today);
  const dayOfWeek = startOfWeek.getDay();
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Adjust for Monday start
  startOfWeek.setDate(startOfWeek.getDate() - diff);
  
  // Total tickets
  const { count: total } = await supabaseAdmin
    .from('tickets')
    .select('*', { count: 'exact', head: true });
  
  // Today's tickets
  const { count: todayCount } = await supabaseAdmin
    .from('tickets')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', today.toISOString());
  
  // This week's tickets
  const { count: thisWeekCount } = await supabaseAdmin
    .from('tickets')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', startOfWeek.toISOString());
  
  // By status
  const { data: statusData } = await supabaseAdmin
    .from('tickets')
    .select('status');
  
  const byStatus = statusData?.reduce((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {}) || {};
  
  // SLA exceeded count
  const { count: slaExceeded } = await supabaseAdmin
    .from('tickets')
    .select('*', { count: 'exact', head: true })
    .eq('sla_exceeded', true);
  
  res.json({
    total,
    today: todayCount,
    this_week: thisWeekCount,
    by_status: byStatus,
    sla_exceeded: slaExceeded
  });
}));

/**
 * GET /api/biblio/recent
 * Get recently accessed/modified tickets
 */
router.get('/recent', asyncHandler(async (req, res) => {
  const { limit = 10 } = req.query;
  
  const { data, error } = await supabaseAdmin
    .from('tickets')
    .select(`
      id,
      k_number,
      group_code,
      item_count,
      status,
      priority,
      updated_at,
      created_by_user:users!tickets_created_by_fkey(id, full_name)
    `)
    .order('updated_at', { ascending: false })
    .limit(parseInt(limit));
  
  if (error) throw error;
  
  res.json({ tickets: data });
}));

export default router;
