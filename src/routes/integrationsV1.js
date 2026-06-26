/**
 * PUTIX Integration API v1 routes
 */

import { Router } from 'express';
import { authenticateApiKey } from '../middleware/apiKey.js';
import { authenticate, authorize } from '../middleware/auth.js';
import {
  PUTIX_API_VERSION,
  PUTIX_PHASES,
  PUTIX_ENDPOINTS,
  PUTIX_SCHEMA,
  buildSampleTicketPayload,
  buildFullTicketPayload,
  listTicketsForPutix,
  getIntegrationStats,
  generateAllBlocks,
  loadItemsWithAlternatives,
} from '../services/putixIntegration.js';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requirePutixApiKey(req, res, next) {
  return authenticateApiKey(req, res, next);
}

function requireAdminDashboard(req, res, next) {
  authenticate(req, res, (err) => {
    if (err) return next(err);
    authorize(['admin', 'dispatcher'])(req, res, next);
  });
}

router.get('/schema', requirePutixApiKey, asyncRoute(async (req, res) => {
  res.json({
    ...PUTIX_SCHEMA,
    sample_payload: buildSampleTicketPayload(),
  });
}));

router.get('/health', requirePutixApiKey, asyncRoute(async (req, res) => {
  const stats = await getIntegrationStats();
  res.json({
    status: 'ok',
    api_version: PUTIX_API_VERSION,
    api_key_configured: !!process.env.PUTIX_API_KEY,
    sync: {
      strategy: 'polling',
      delta_param: 'updated_since',
      recommended_interval_seconds: 60,
    },
    stats,
  });
}));

router.get('/tickets', requirePutixApiKey, asyncRoute(async (req, res) => {
  res.json(await listTicketsForPutix(req.query));
}));

router.get('/tickets/:id', requirePutixApiKey, asyncRoute(async (req, res) => {
  const payload = await buildFullTicketPayload(req.params.id, {
    includeBlocks: req.query.include_blocks !== 'false',
    includeAttachmentUrls: req.query.include_attachment_urls !== 'false',
  });

  if (!payload) {
    return res.status(404).json({ error: 'Ticket not found', code: 'NOT_FOUND' });
  }

  res.json(payload);
}));

router.get('/tickets/:id/blocks', requirePutixApiKey, asyncRoute(async (req, res) => {
  const { data: ticket, error } = await supabaseAdmin
    .from('tickets')
    .select('*, assigned_to_user:users!tickets_assigned_to_fkey(id, full_name)')
    .eq('id', req.params.id)
    .single();

  if (error || !ticket) {
    return res.status(404).json({ error: 'Ticket not found', code: 'NOT_FOUND' });
  }

  const items = await loadItemsWithAlternatives(req.params.id);
  const { data: forwardingLog } = await supabaseAdmin
    .from('forwarding_log')
    .select('*')
    .eq('ticket_id', req.params.id)
    .order('forwarded_at', { ascending: false });

  res.json({
    api_version: PUTIX_API_VERSION,
    ticket_id: ticket.id,
    k_number: ticket.k_number,
    blocks: generateAllBlocks(ticket, items, forwardingLog || []),
  });
}));

router.get('/admin/dashboard', requireAdminDashboard, asyncRoute(async (req, res) => {
  const stats = await getIntegrationStats();
  const baseUrl = process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`;

  res.json({
    api_version: PUTIX_API_VERSION,
    phases: PUTIX_PHASES,
    endpoints: PUTIX_ENDPOINTS,
    configuration: {
      api_key_configured: !!process.env.PUTIX_API_KEY,
      backend_public_url: baseUrl,
      auth_header: 'X-API-Key',
      env_var: 'PUTIX_API_KEY',
    },
    stats,
    schema_summary: {
      ticket_field_count: Object.keys(PUTIX_SCHEMA.ticket_fields).length,
      item_field_count: Object.keys(PUTIX_SCHEMA.item_fields).length,
      enums: PUTIX_SCHEMA.enums,
    },
    sample_payload: buildSampleTicketPayload(),
    documentation: {
      file: 'docs/PUTIX-API-v1.md',
      schema_endpoint: `${baseUrl}/api/integrations/v1/schema`,
    },
  });
}));

router.get('/admin/schema-preview', requireAdminDashboard, asyncRoute(async (req, res) => {
  res.json({
    ...PUTIX_SCHEMA,
    sample_payload: buildSampleTicketPayload(),
  });
}));

export default router;
