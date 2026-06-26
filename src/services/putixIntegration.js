/**
 * PUTIX Integration Service (v1)
 * Exposes the full Mini Web proforma structure for external consumption.
 */

import { supabaseAdmin } from '../config/supabase.js';
import { getSlaStatus } from './slaService.js';
import { getCoincidenceCountsForTickets } from './duplicateService.js';
import { getAttachments, getAttachmentUrl } from './mediaProcessor.js';
import {
  generateControlBlock,
  generateControlAB,
  generateCustomerProformaBlock,
  generateAuxSeguimientoBlock,
  generateReenviosBlock,
  generateProveedorBlock,
  generateDespachosBlock,
  generateInternoBlock,
  generatePerSupplierBlocks,
  generateAuditoriaBlock,
  generatePedidoFinalBlock,
  generatePedidoSupplierBlocks,
} from './blockGenerator.js';

export const PUTIX_API_VERSION = 'v1';

/** Integration roadmap phases — shown in admin dashboard */
export const PUTIX_PHASES = [
  {
    id: 'phase_1',
    name: 'Contrato API',
    description: 'Schema versionado, enums y documentación de campos completos (modo proforma normal).',
    status: 'completed',
  },
  {
    id: 'phase_2',
    name: 'API Mini Web',
    description: 'Endpoints de lectura: listado, detalle completo y bloques generados.',
    status: 'completed',
  },
  {
    id: 'phase_3',
    name: 'Sincronización',
    description: 'Polling con updated_since; webhooks en fase posterior según acuerdo con PUTIX.',
    status: 'in_progress',
  },
  {
    id: 'phase_4',
    name: 'Pantallas PUTIX',
    description: 'Proforma y Pedido en PUTIX basados en la estructura expuesta por Mini Web.',
    status: 'pending',
    owner: 'PUTIX',
  },
  {
    id: 'phase_5',
    name: 'Escritura (opcional)',
    description: 'Endpoints de write-back desde PUTIX si el equipo confirma campos bidireccionales.',
    status: 'pending',
  },
];

export const PUTIX_ENDPOINTS = [
  { method: 'GET', path: '/api/integrations/v1/schema', auth: 'X-API-Key o JWT admin', description: 'Catálogo de campos, enums y ejemplo de payload' },
  { method: 'GET', path: '/api/integrations/v1/tickets', auth: 'X-API-Key', description: 'Listado paginado con filtros y updated_since' },
  { method: 'GET', path: '/api/integrations/v1/tickets/:id', auth: 'X-API-Key', description: 'Ticket completo: ítems, alternativas, usuarios, SLA, extensiones' },
  { method: 'GET', path: '/api/integrations/v1/tickets/:id/blocks', auth: 'X-API-Key', description: 'Todos los bloques de texto generados (proforma, pedido, control, etc.)' },
  { method: 'GET', path: '/api/integrations/v1/health', auth: 'X-API-Key', description: 'Health check y estadísticas de sincronización' },
  { method: 'POST', path: '/api/integrations/c0-import', auth: 'X-API-Key', description: 'Legacy: importación masiva C0 histórica (opcional)' },
];

export const PUTIX_SCHEMA = {
  version: PUTIX_API_VERSION,
  description: 'Estructura completa de ticket Mini Web (modo proforma normal). PUTIX consume los campos que necesite.',
  enums: {
    ticket_status: ['pending', 'pending_review', 'in_progress', 'ready', 'pedido', 'closed', 'cancelled', 'en_revision', 'reenviado'],
    item_status: ['positive', 'negative', 'pending_info', 'no_registra', 'no_registra_verificar'],
    length_class: ['short', 'medium', 'long'],
    priority: ['low', 'normal', 'high', 'urgent'],
    validity_status: ['vigente', 'vencido'],
    item_source: ['importadora', 'almacen', 'distrimia'],
    duplicate_label: ['dup_positive', 'dup_neutral', 'dup_negative'],
    audit_code_type: ['codigo_distrimia_con_oem', 'sin_oem', 'sin_oem_referencial', 'sin_codigo'],
    entry_type: ['manual', 'express', 'audio', 'putix_c0'],
    conversion_status: ['positive', 'negative', 'pending'],
    block_types: [
      'control', 'control_a', 'control_b', 'proforma_cliente', 'aux_seguimiento',
      'reenvios', 'proveedor', 'despachos', 'interno', 'per_supplier',
      'auditoria', 'pedido_final', 'pedido_supplier',
    ],
    user_role: ['operator', 'dispatcher', 'seller', 'aux', 'admin'],
  },
  ticket_fields: {
    id: 'uuid',
    k_number: 'string — clave única #K',
    group_code: 'string',
    raw_text: 'string',
    item_count: 'integer (IT)',
    length_class: 'short | medium | long',
    priority: 'enum',
    status: 'enum ticket_status',
    vin: 'string | null — interno, no mostrar al cliente',
    vehicle_info: '{ marca, modelo, anio, placa, chasis, motor, serie, cilindraje }',
    seller_notes: 'string | null',
    block_notes: 'observaciones por bloque (proforma_cliente, control_a, pedido_final, etc.)',
    assigned_to: 'uuid | null',
    assigned_at: 'timestamp | null',
    assigned_to_user: '{ id, email, full_name, role }',
    created_by_user: '{ id, email, full_name, role }',
    locked_by_user: '{ id, full_name } | null',
    sla: '{ started_at, deadline, completed_at, exceeded, status }',
    is_venta_concreta: 'boolean',
    duplicate_label: 'enum | null',
    coincidence_count: 'integer',
    entry_type: 'enum',
    putix_ref: 'string | null — ID externo PUTIX',
    conversion_status: 'enum | null',
    notes: 'string | null',
    parent_ticket_id: 'uuid | null',
    extension_group_code: 'string | null',
    forwarded_to_ticket_id: 'uuid | null',
    forwarded_to_group: 'string | null',
    is_merged: 'boolean',
    merged_into_ticket_id: 'uuid | null',
    sender_name: 'string | null',
    sender_phone: 'string | null',
    closed_at: 'timestamp | null',
    created_at: 'timestamp',
    updated_at: 'timestamp — usar para polling updated_since',
    quote_total: 'number | null',
  },
  item_fields: {
    id: 'uuid',
    ticket_id: 'uuid',
    item_order: 'integer',
    raw_line: 'string',
    parsed_description: 'string',
    quantity: 'integer',
    status: 'enum item_status',
    source: 'enum item_source | null',
    brand: 'string | null — marca',
    cost_price: 'number | null — costo',
    selling_price: 'number | null — precio venta',
    supplier_code: 'string | null — código proveedor',
    codigo_distrimia: 'string | null',
    codigo_oem: 'string | null',
    codigo_fabrica: 'string | null',
    validity_status: 'enum',
    validity_expires_at: 'timestamp | null',
    estimated_delivery: 'string | null',
    seller_note: 'string | null — observación vendedor',
    internal_note: 'string | null',
    pedido_excluded: 'boolean',
    control_group: 'A | B | null',
    audit_code_type: 'enum | null',
    alternative_confirmed: 'boolean',
    confirmed_alternative_id: 'uuid | null',
    alternatives: 'array — ver alternative_fields',
    created_at: 'timestamp',
    updated_at: 'timestamp',
  },
  alternative_fields: {
    id: 'uuid',
    brand: 'string',
    selling_price: 'number | null',
    cost_price: 'number | null',
    source: 'enum item_source | null',
    supplier_code: 'string | null',
    estimated_delivery: 'string | null',
    notes: 'string | null',
  },
  attachment_fields: {
    id: 'uuid',
    file_name: 'string',
    mime_type: 'string',
    file_size: 'integer | null',
    url: 'string — URL firmada (1h), opcional en detalle',
    created_at: 'timestamp',
  },
  sync: {
    strategy: 'polling',
    recommended_interval_seconds: 60,
    delta_filter: 'updated_since (ISO-8601) en GET /tickets',
    note: 'Mini Web es la fuente de verdad para proforma; PUTIX lee y refleja en sus pantallas.',
  },
};

export function buildSampleTicketPayload() {
  return {
    api_version: PUTIX_API_VERSION,
    ticket: {
      id: '00000000-0000-0000-0000-000000000001',
      k_number: 'K-20250625-0001',
      group_code: 'GRP-042',
      status: 'ready',
      item_count: 2,
      length_class: 'short',
      priority: 'normal',
      vehicle_info: { marca: 'CHEVROLET', modelo: 'LUV', anio: '2004', cilindraje: '2500cc' },
      seller_notes: 'Cliente pide entrega rápida',
      assigned_to_user: { id: '...', email: 'vendedor@distrimia.com', full_name: 'Juan Pérez', role: 'seller' },
      sla: { status: 'completed', exceeded: false },
      quote_total: 145.50,
      updated_at: '2025-06-25T14:30:00.000Z',
    },
    items: [
      {
        item_order: 1,
        parsed_description: 'Filtro de aceite',
        quantity: 1,
        status: 'positive',
        brand: 'MANN',
        cost_price: 12.00,
        selling_price: 18.50,
        supplier_code: 'IMP-001',
        source: 'importadora',
        seller_note: 'Original preferido',
        alternatives: [
          { brand: 'WIX', selling_price: 15.00, cost_price: 10.00, supplier_code: 'IMP-002' },
        ],
        alternative_confirmed: true,
        confirmed_alternative_id: null,
      },
      {
        item_order: 2,
        parsed_description: 'Pastillas de freno delanteras',
        quantity: 1,
        status: 'positive',
        brand: 'BOSCH',
        cost_price: 45.00,
        selling_price: 67.00,
        supplier_code: 'ALM-015',
        source: 'almacen',
        alternatives: [],
      },
    ],
    extensions: [],
    forwarding_log: [],
    attachments: [],
    blocks_preview: {
      proforma_cliente: '...(texto generado)...',
      pedido_final: '...(texto generado)...',
    },
  };
}

function noteForBlock(blockNotes, key) {
  const v = blockNotes?.[key];
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

export async function loadItemsWithAlternatives(ticketId) {
  const { data: items, error } = await supabaseAdmin
    .from('ticket_items')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('item_order', { ascending: true });

  if (error) throw error;

  const itemIds = (items || []).map((i) => i.id);
  let alternatives = [];
  if (itemIds.length > 0) {
    const { data: alts } = await supabaseAdmin
      .from('ticket_item_alternatives')
      .select('*')
      .in('ticket_item_id', itemIds)
      .order('created_at', { ascending: true });
    alternatives = alts || [];
  }

  return (items || []).map((item) => ({
    ...item,
    alternatives: alternatives.filter((a) => a.ticket_item_id === item.id),
  }));
}

export async function loadAttachmentsWithUrls(ticketId, includeUrls = true) {
  const attachments = await getAttachments(ticketId);
  if (!includeUrls) return attachments;

  return Promise.all(
    attachments.map(async (att) => {
      try {
        const url = await getAttachmentUrl(att.file_path);
        return {
          id: att.id,
          file_name: att.file_name,
          mime_type: att.mime_type,
          file_size: att.file_size,
          created_at: att.created_at,
          url,
        };
      } catch {
        return {
          id: att.id,
          file_name: att.file_name,
          mime_type: att.mime_type,
          file_size: att.file_size,
          created_at: att.created_at,
          url: null,
        };
      }
    })
  );
}

export async function generateAllBlocks(ticket, items, forwardingLog = []) {
  const blockNotes = ticket?.block_notes && typeof ticket.block_notes === 'object'
    ? ticket.block_notes
    : {};
  const activeItems = items.filter((i) => !i.pedido_excluded);

  const supplierCodes = [...new Set(
    activeItems.map((i) => i.supplier_code).filter(Boolean)
  )];

  const blocks = {
    control: generateControlBlock(ticket),
    control_a: generateControlAB(ticket, activeItems, 'A', noteForBlock(blockNotes, 'control_a')),
    control_b: generateControlAB(ticket, activeItems, 'B', noteForBlock(blockNotes, 'control_b')),
    proforma_cliente: generateCustomerProformaBlock(ticket, items, noteForBlock(blockNotes, 'proforma_cliente')),
    aux_seguimiento: generateAuxSeguimientoBlock(ticket, items),
    reenvios: generateReenviosBlock(ticket, forwardingLog),
    interno: generateInternoBlock(ticket, activeItems),
    pedido_final: generatePedidoFinalBlock(ticket, items, noteForBlock(blockNotes, 'pedido_final')),
    per_supplier: generatePerSupplierBlocks(
      ticket,
      activeItems,
      noteForBlock(blockNotes, 'per_supplier'),
      blockNotes.per_supplier_by_code || {}
    ),
    pedido_supplier: generatePedidoSupplierBlocks(
      ticket,
      items,
      noteForBlock(blockNotes, 'pedido_supplier'),
      blockNotes.pedido_supplier_by_code || {}
    ),
    proveedor_by_code: {},
    despachos_by_code: {},
    auditoria_by_item: {},
  };

  for (const code of supplierCodes) {
    blocks.proveedor_by_code[code] = generateProveedorBlock(ticket, items, code);
    blocks.despachos_by_code[code] = generateDespachosBlock(ticket, items, code);
  }

  for (const item of items) {
    blocks.auditoria_by_item[item.id] = generateAuditoriaBlock(item);
  }

  return blocks;
}

export async function computeQuoteTotal(ticketId, items) {
  let total = 0;
  for (const item of items) {
    if (item.status !== 'positive') continue;
    let price = item.selling_price;
    if (item.alternative_confirmed && item.confirmed_alternative_id && item.alternatives) {
      const alt = item.alternatives.find((a) => a.id === item.confirmed_alternative_id);
      if (alt?.selling_price != null) price = alt.selling_price;
    }
    if (price != null) total += parseFloat(price) * (item.quantity || 1);
  }
  return total > 0 ? total : null;
}

export async function buildFullTicketPayload(ticketId, options = {}) {
  const { includeBlocks = true, includeAttachmentUrls = true } = options;

  const { data: ticket, error: ticketError } = await supabaseAdmin
    .from('tickets')
    .select(`
      *,
      created_by_user:users!tickets_created_by_fkey(id, full_name, email, role),
      locked_by_user:users!tickets_locked_by_fkey(id, full_name, email),
      assigned_to_user:users!tickets_assigned_to_fkey(id, full_name, email, role),
      revision_origin_seller:users!tickets_revision_origin_seller_id_fkey(id, full_name)
    `)
    .eq('id', ticketId)
    .single();

  if (ticketError) {
    if (ticketError.code === 'PGRST116') return null;
    throw ticketError;
  }

  const items = await loadItemsWithAlternatives(ticketId);
  const coincidenceCounts = await getCoincidenceCountsForTickets([ticketId]);
  const quote_total = await computeQuoteTotal(ticketId, items);

  const { data: extensions } = await supabaseAdmin
    .from('tickets')
    .select('id, k_number, group_code, status, created_at, extension_group_code, item_count')
    .eq('parent_ticket_id', ticketId);

  const forwardingLog = await loadForwardingLog(ticketId);
  const attachments = await loadAttachmentsWithUrls(ticketId, includeAttachmentUrls);

  const payload = {
    api_version: PUTIX_API_VERSION,
    ticket: {
      ...ticket,
      sla: {
        started_at: ticket.sla_started_at,
        deadline: ticket.sla_deadline,
        completed_at: ticket.sla_completed_at,
        exceeded: ticket.sla_exceeded,
        status: getSlaStatus(ticket),
      },
      coincidence_count: coincidenceCounts[ticketId] || 0,
      quote_total,
    },
    items,
    extensions: extensions || [],
    forwarding_log: forwardingLog,
    attachments,
  };

  if (includeBlocks) {
    payload.blocks = generateAllBlocks(ticket, items, forwardingLog);
  }

  return payload;
}

async function loadForwardingLog(ticketId) {
  const { data } = await supabaseAdmin
    .from('forwarding_log')
    .select('id, target_type, target_code, target_name, forwarded_at, notes')
    .eq('ticket_id', ticketId)
    .order('forwarded_at', { ascending: false });
  return data || [];
}

export async function listTicketsForPutix(filters = {}) {
  const {
    page = 1,
    limit = 50,
    status,
    group_code,
    assigned_to,
    updated_since,
    k_number,
    entry_type,
    sort_order = 'desc',
  } = filters;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (pageNum - 1) * limitNum;

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
      entry_type,
      assigned_to,
      assigned_at,
      vehicle_info,
      seller_notes,
      is_venta_concreta,
      putix_ref,
      conversion_status,
      created_at,
      updated_at,
      closed_at,
      assigned_to_user:users!tickets_assigned_to_fkey(id, full_name, email, role)
    `, { count: 'exact' })
    .eq('is_merged', false);

  if (status) {
    if (status.includes(',')) {
      query = query.in('status', status.split(',').map((s) => s.trim()));
    } else {
      query = query.eq('status', status);
    }
  }
  if (group_code) query = query.eq('group_code', group_code);
  if (assigned_to) query = query.eq('assigned_to', assigned_to);
  if (entry_type) query = query.eq('entry_type', entry_type);
  if (k_number) query = query.ilike('k_number', `%${k_number}%`);
  if (updated_since) query = query.gte('updated_at', updated_since);

  query = query
    .order('updated_at', { ascending: sort_order === 'asc' })
    .range(offset, offset + limitNum - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  const tickets = (data || []).map((t) => ({
    ...t,
    sla_status: getSlaStatus(t),
  }));

  return {
    api_version: PUTIX_API_VERSION,
    tickets,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total: count || 0,
      total_pages: Math.ceil((count || 0) / limitNum),
    },
    filters_applied: {
      status: status || null,
      group_code: group_code || null,
      assigned_to: assigned_to || null,
      updated_since: updated_since || null,
      entry_type: entry_type || null,
      k_number: k_number || null,
    },
  };
}

export async function getIntegrationStats() {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [
    { count: totalTickets },
    { count: updatedLast24h },
    { count: readyCount },
    { count: pedidoCount },
    { count: inProgressCount },
    { count: putixC0Count },
  ] = await Promise.all([
    supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).eq('is_merged', false),
    supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).gte('updated_at', dayAgo.toISOString()),
    supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).eq('status', 'ready'),
    supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).eq('status', 'pedido'),
    supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).eq('status', 'in_progress'),
    supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).eq('entry_type', 'putix_c0'),
  ]);

  const { data: latestTicket } = await supabaseAdmin
    .from('tickets')
    .select('k_number, updated_at, status')
    .eq('is_merged', false)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    total_tickets: totalTickets || 0,
    updated_last_24h: updatedLast24h || 0,
    by_status: {
      in_progress: inProgressCount || 0,
      ready: readyCount || 0,
      pedido: pedidoCount || 0,
    },
    putix_c0_imported: putixC0Count || 0,
    latest_ticket: latestTicket || null,
    server_time: now.toISOString(),
  };
}
