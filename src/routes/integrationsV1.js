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
  updateTicketFromPutix,
  listUsersForPutix,
  getUserForPutix,
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
    authorize(['admin', 'dispatcher', 'operator', 'seller'])(req, res, next);
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
      resources: ['tickets', 'users'],
    },
    stats,
  });
}));

router.get('/users', requirePutixApiKey, asyncRoute(async (req, res) => {
  res.json(await listUsersForPutix(req.query));
}));

router.get('/users/:id', requirePutixApiKey, asyncRoute(async (req, res) => {
  const payload = await getUserForPutix(req.params.id);
  if (!payload) {
    return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
  }
  res.json(payload);
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

/**
 * Write-back: PUTIX updates a ticket header (cabecera) and/or its items (detalle).
 *
 * Body: { ticket?: {...}, items?: [
 *   { id, ...fields },                 // update
 *   { client_ref, parsed_description }, // create (in_progress)
 *   { id, _delete: true },              // delete (in_progress)
 *   { id, pedido_excluded: true },      // exclude (in_progress|pedido)
 * ]}
 *
 * Response.updated includes items_created[{client_ref,id}], items_deleted, items_excluded.
 */
const writeBackHandler = asyncRoute(async (req, res) => {
  const result = await updateTicketFromPutix(req.params.id, req.body, {
    includeBlocks: req.query.include_blocks !== 'false',
  });

  if (!result.ok) {
    const errorBody = { error: result.error, code: result.code };
    if (result.validation_errors) errorBody.validation_errors = result.validation_errors;
    if (result.ignored_fields) errorBody.ignored_fields = result.ignored_fields;
    return res.status(result.statusCode).json(errorBody);
  }

  res.json({
    api_version: PUTIX_API_VERSION,
    updated: result.updated,
    ignored_fields: result.ignored_fields,
    ticket: result.payload,
  });
});

router.patch('/tickets/:id', requirePutixApiKey, writeBackHandler);
router.put('/tickets/:id', requirePutixApiKey, writeBackHandler);

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
      user_field_count: Object.keys(PUTIX_SCHEMA.user_fields).length,
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
