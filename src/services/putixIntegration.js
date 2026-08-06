/**
 * PUTIX Integration Service (v1)
 * Exposes the full Mini Web proforma structure for external consumption.
 */

import { supabaseAdmin } from '../config/supabase.js';
import { getSlaStatus, calculateSlaDeadline } from './slaService.js';
import {
  getCoincidenceCountsForTickets,
  getCoincidenceReferencesForTicket,
} from './duplicateService.js';
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

/**
 * Ticket statuses PUTIX synchronizes / is allowed to write back to.
 * Maps to flujo.md: Pendiente, Pendiente de Revisión, En Proceso, Listo.
 * `pedido` is also writable, but only for item exclusion (pedido_excluded).
 */
export const PUTIX_SYNC_STATUSES = ['pending', 'pending_review', 'in_progress', 'ready'];
export const PUTIX_WRITEABLE_STATUSES = [...PUTIX_SYNC_STATUSES, 'pedido'];

/** Item create/delete only in assigned elaboration. */
export const PUTIX_ITEM_CREATE_DELETE_STATUSES = ['in_progress'];
/** Soft-exclude allowed in elaboration and pedido (reports keep history). */
export const PUTIX_ITEM_EXCLUDE_STATUSES = ['in_progress', 'pedido'];

/**
 * Allow-list of ticket header fields PUTIX may update via write-back.
 * Anything not listed (PKs, FKs, integrity identifiers, audit/lock/SLA fields)
 * is silently ignored and reported back in `ignored_fields`.
 */
export const PUTIX_EDITABLE_TICKET_FIELDS = [
  'status',
  'priority',
  'length_class',
  'vin',
  'vehicle_info',
  'seller_notes',
  'block_notes',
  'notes',
  'is_venta_concreta',
  'conversion_status',
  'duplicate_label',
  'sender_name',
  'sender_phone',
  'client_phone',
  // Exception to the "no FKs" rule: PUTIX assigns Mini Web users when taking a ticket.
  // Validated against users table (must exist + is_active).
  'assigned_to',
];

/** Allow-list of ticket_item (detalle) fields PUTIX may update via write-back. */
export const PUTIX_EDITABLE_ITEM_FIELDS = [
  'parsed_description',
  'quantity',
  'status',
  'source',
  'brand',
  'cost_price',
  'selling_price',
  'supplier_code',
  'codigo_distrimia',
  'codigo_oem',
  'codigo_fabrica',
  'validity_status',
  'validity_expires_at',
  'estimated_delivery',
  'seller_note',
  'internal_note',
  'pedido_excluded',
  'control_group',
  'audit_code_type',
  'alternative_confirmed',
  'confirmed_alternative_id',
  'item_order',
];

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
    description: 'Polling con updated_since (PUTIX usa lastSyncAt = ahora - 24h). Webhooks en fase posterior según acuerdo.',
    status: 'completed',
  },
  {
    id: 'phase_4',
    name: 'Pantallas PUTIX',
    description: 'Proforma y Pedido en PUTIX basados en la estructura expuesta por Mini Web.',
    status: 'in_progress',
    owner: 'PUTIX',
  },
  {
    id: 'phase_5',
    name: 'Escritura (write-back)',
    description: 'PATCH /tickets/:id: PUTIX actualiza cabecera y detalle (campos editables). Incluye assigned_to para tomar el ticket.',
    status: 'completed',
  },
  {
    id: 'phase_6',
    name: 'Sincronización de usuarios',
    description: 'GET /users: catálogo de usuarios Mini Web para que PUTIX asigne responsables al tomar tickets.',
    status: 'completed',
  },
];

export const PUTIX_ENDPOINTS = [
  { method: 'GET', path: '/api/integrations/v1/schema', auth: 'X-API-Key o JWT admin', description: 'Catálogo de campos, enums y ejemplo de payload' },
  { method: 'GET', path: '/api/integrations/v1/tickets', auth: 'X-API-Key', description: 'Listado paginado con filtros: status, updated_since, created_since. Para histórico usar status=closed' },
  { method: 'GET', path: '/api/integrations/v1/tickets/:id', auth: 'X-API-Key', description: 'Ticket completo: ítems, alternativas, usuarios, SLA, extensiones' },
  { method: 'GET', path: '/api/integrations/v1/tickets/:id/blocks', auth: 'X-API-Key', description: 'Todos los bloques de texto generados (proforma, pedido, control, etc.)' },
  { method: 'PATCH', path: '/api/integrations/v1/tickets/:id', auth: 'X-API-Key', description: 'Write-back: cabecera + ítems (actualizar/crear/eliminar/excluir según estado). Incluye assigned_to=Tomar' },
  { method: 'GET', path: '/api/integrations/v1/users', auth: 'X-API-Key', description: 'Catálogo de usuarios Mini Web para sincronizar y asignar en PUTIX' },
  { method: 'GET', path: '/api/integrations/v1/users/:id', auth: 'X-API-Key', description: 'Detalle de un usuario Mini Web' },
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
  coincidence_fields: {
    id: 'uuid — id del ticket coincidente',
    k_number: 'string — #K del ticket coincidente',
    status: 'enum ticket_status',
    group_code: 'string',
    created_at: 'timestamp',
    similarity: 'number 0..1 | null',
    label: 'enum duplicate_label | null',
  },
  user_fields: {
    id: 'uuid — usar este valor en ticket.assigned_to',
    email: 'string',
    full_name: 'string',
    role: 'enum user_role',
    is_active: 'boolean — sincronizar solo activos recomendado',
    avatar_url: 'string | null',
    created_at: 'timestamp',
    updated_at: 'timestamp — usar para polling updated_since',
  },
  sync: {
    strategy: 'polling',
    recommended_interval_seconds: 60,
    delta_filter: 'updated_since (ISO-8601) en GET /tickets y GET /users',
    lookback_window: 'PUTIX usa lastSyncAt = ahora - 24h para no perder cambios entre ciclos',
    syncable_statuses: ['pending', 'pending_review', 'in_progress', 'ready'],
    closed_history: 'Para el histórico interno de PUTIX: GET /tickets?status=closed&sort_order=asc (opcional created_since para backfill incremental)',
    users: 'GET /users?is_active=true&updated_since=... — catálogo para asignar responsables en PUTIX',
    note: 'Mini Web es la fuente de verdad para proforma y usuarios; PUTIX lee y refleja en sus pantallas.',
  },
  write_back: {
    endpoint: 'PATCH /api/integrations/v1/tickets/:id',
    description: 'PUTIX actualiza cabecera (ticket) y detalle (items). Modelo allow-list + ciclo de vida de ítems según estado.',
    writable_statuses: PUTIX_WRITEABLE_STATUSES,
    item_lifecycle: {
      create: 'ítem sin id (opcional client_ref). Solo in_progress. Respuesta: items_created[{client_ref,id}]',
      delete: 'ítem con id + _delete:true. Solo in_progress. Respuesta: items_deleted[id]',
      exclude: 'ítem con id + pedido_excluded:true. Permitido en in_progress y pedido (en pedido es la única baja).',
      update: 'ítem con id y campos editables. Permitido en estados sincronizables; en pedido solo pedido_excluded',
    },
    body_example: {
      ticket: {
        status: 'in_progress',
        assigned_to: '<uuid-usuario-miniweb>',
        seller_notes: 'Tomado desde PUTIX',
      },
      items: [
        { id: '<uuid-existente>', selling_price: 18.5 },
        { client_ref: 'tmp-1', parsed_description: 'Filtro de aceite', quantity: 1 },
        { id: '<uuid-a-eliminar>', _delete: true },
        { id: '<uuid-a-excluir>', pedido_excluded: true },
      ],
    },
    editable_ticket_fields: PUTIX_EDITABLE_TICKET_FIELDS,
    editable_item_fields: PUTIX_EDITABLE_ITEM_FIELDS,
    non_editable: 'id, k_number, group_code, raw_text, putix_ref, *_ticket_id, created_by/updated_by, created_at/updated_at, sla_*, lock_* y demás identificadores de integridad',
    note: 'assigned_to aplica Tomar (lock+SLA). client_ref y _delete son metadatos de control (no columnas). Al crear se regeneran item_count/length_class.',
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
      duplicate_label: 'dup_positive',
      coincidence_count: 1,
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
    coincidences: [
      {
        id: '00000000-0000-0000-0000-000000000099',
        k_number: 'K-20250620-0099',
        status: 'closed',
        group_code: 'GRP-042',
        created_at: '2025-06-20T10:00:00.000Z',
        similarity: 0.85,
        label: 'dup_positive',
      },
    ],
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
  const coincidences = await getCoincidenceReferencesForTicket(ticketId);
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
      coincidence_count: coincidences.length,
      quote_total,
    },
    items,
    coincidences,
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
    created_since,
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
  if (created_since) query = query.gte('created_at', created_since);

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
      created_since: created_since || null,
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
    { count: activeUsers },
  ] = await Promise.all([
    supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).eq('is_merged', false),
    supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).gte('updated_at', dayAgo.toISOString()),
    supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).eq('status', 'ready'),
    supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).eq('status', 'pedido'),
    supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).eq('status', 'in_progress'),
    supabaseAdmin.from('tickets').select('id', { count: 'exact', head: true }).eq('entry_type', 'putix_c0'),
    supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).eq('is_active', true),
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
    active_users: activeUsers || 0,
    latest_ticket: latestTicket || null,
    server_time: now.toISOString(),
  };
}

/**
 * List Mini Web users for PUTIX sync (assign sellers / operators in PUTIX UI).
 * Supports the same polling pattern as tickets via updated_since.
 */
export async function listUsersForPutix(filters = {}) {
  const {
    page = 1,
    limit = 100,
    role,
    is_active = 'true',
    updated_since,
    email,
    sort_order = 'asc',
  } = filters;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 100));
  const offset = (pageNum - 1) * limitNum;

  let query = supabaseAdmin
    .from('users')
    .select('id, email, full_name, role, is_active, avatar_url, created_at, updated_at', { count: 'exact' });

  if (is_active === 'true' || is_active === true) {
    query = query.eq('is_active', true);
  } else if (is_active === 'false' || is_active === false) {
    query = query.eq('is_active', false);
  }
  // is_active=all → no filter

  if (role) {
    if (String(role).includes(',')) {
      query = query.in('role', String(role).split(',').map((r) => r.trim()).filter(Boolean));
    } else {
      query = query.eq('role', role);
    }
  }
  if (email) query = query.ilike('email', `%${email}%`);
  if (updated_since) query = query.gte('updated_at', updated_since);

  query = query
    .order('updated_at', { ascending: sort_order === 'asc' })
    .order('full_name', { ascending: true })
    .range(offset, offset + limitNum - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    api_version: PUTIX_API_VERSION,
    users: data || [],
    pagination: {
      page: pageNum,
      limit: limitNum,
      total: count || 0,
      total_pages: Math.ceil((count || 0) / limitNum),
    },
    filters_applied: {
      role: role || null,
      is_active: is_active === 'all' ? 'all' : (is_active === 'false' || is_active === false ? false : true),
      updated_since: updated_since || null,
      email: email || null,
    },
  };
}

export async function getUserForPutix(userId) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, role, is_active, avatar_url, created_at, updated_at')
    .eq('id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }

  return {
    api_version: PUTIX_API_VERSION,
    user: data,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── PUTIX write-back (v1 phase 5) ───────────────────────────────────────────

/** Enum whitelists per editable field, sourced from PUTIX_SCHEMA. */
const WRITE_BACK_ENUMS = {
  ticket: {
    status: PUTIX_SCHEMA.enums.ticket_status,
    priority: PUTIX_SCHEMA.enums.priority,
    length_class: PUTIX_SCHEMA.enums.length_class,
    conversion_status: PUTIX_SCHEMA.enums.conversion_status,
    duplicate_label: PUTIX_SCHEMA.enums.duplicate_label,
  },
  item: {
    status: PUTIX_SCHEMA.enums.item_status,
    source: PUTIX_SCHEMA.enums.item_source,
    validity_status: PUTIX_SCHEMA.enums.validity_status,
    audit_code_type: PUTIX_SCHEMA.enums.audit_code_type,
    control_group: ['A', 'B'],
  },
};

/** Keep only allow-listed keys; report the rest so PUTIX knows what was dropped. */
function pickAllowedFields(source, allowList) {
  const picked = {};
  const ignored = [];
  for (const key of Object.keys(source || {})) {
    if (key === 'id') continue; // id is used only to locate the row, never modified
    if (allowList.includes(key)) picked[key] = source[key];
    else ignored.push(key);
  }
  return { picked, ignored };
}

/** Validate enum-constrained fields; returns a list of human-readable errors. */
function validateEnumFields(obj, enumMap, prefix = '') {
  const errors = [];
  for (const [field, allowed] of Object.entries(enumMap)) {
    if (field in obj && obj[field] !== null && obj[field] !== undefined && !allowed.includes(obj[field])) {
      errors.push(`${prefix}${field}: valor no válido "${obj[field]}" (permitidos: ${allowed.join(', ')})`);
    }
  }
  return errors;
}

function classifyLengthClass(itemCount) {
  if (itemCount <= 3) return 'short';
  if (itemCount <= 8) return 'medium';
  return 'long';
}

/**
 * Apply a PUTIX write-back to a ticket (header) and/or its items (detail).
 *
 * Item lifecycle (confirmed with Distrimia):
 * - create (no id): only in_progress
 * - delete (_delete:true): only in_progress
 * - exclude (pedido_excluded): in_progress or pedido
 * - field updates: syncable statuses; in pedido only pedido_excluded
 *
 * @returns {{ ok: boolean, statusCode: number, ... }}
 */
export async function updateTicketFromPutix(ticketId, body = {}, options = {}) {
  const { enforceSyncStatus = true, includeBlocks = true } = options;
  const serviceUserId = process.env.PUTIX_SERVICE_USER_ID || null;

  const ticketPatchRaw = body?.ticket && typeof body.ticket === 'object' && !Array.isArray(body.ticket)
    ? body.ticket
    : {};
  const itemsPatchRaw = Array.isArray(body?.items) ? body.items : [];

  if (Object.keys(ticketPatchRaw).length === 0 && itemsPatchRaw.length === 0) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Debe enviar "ticket" y/o "items" con al menos un campo editable',
      code: 'EMPTY_UPDATE',
    };
  }

  // ── Load current ticket ──
  const { data: current, error: loadErr } = await supabaseAdmin
    .from('tickets')
    .select('id, status, assigned_to, item_count, locked_by, lock_expires_at, sla_started_at')
    .eq('id', ticketId)
    .single();

  if (loadErr) {
    if (loadErr.code === 'PGRST116') {
      return { ok: false, statusCode: 404, error: 'Ticket no encontrado', code: 'NOT_FOUND' };
    }
    throw loadErr;
  }

  if (enforceSyncStatus && !PUTIX_WRITEABLE_STATUSES.includes(current.status)) {
    return {
      ok: false,
      statusCode: 409,
      error: `El ticket está en estado "${current.status}" y no es actualizable vía PUTIX. Estados permitidos: ${PUTIX_WRITEABLE_STATUSES.join(', ')}`,
      code: 'TICKET_NOT_SYNCABLE',
    };
  }

  const validationErrors = [];
  const ignoredFields = { ticket: [], items: {} };
  let takeApplied = false;
  let releaseApplied = false;

  // ── Sanitize + validate ticket header ──
  const { picked: ticketPatch, ignored: ticketIgnored } = pickAllowedFields(
    ticketPatchRaw,
    PUTIX_EDITABLE_TICKET_FIELDS
  );
  ignoredFields.ticket = ticketIgnored;
  validationErrors.push(...validateEnumFields(ticketPatch, WRITE_BACK_ENUMS.ticket, 'ticket.'));

  // In pedido: header changes are not part of the confirmed item-lifecycle flow
  if (current.status === 'pedido' && Object.keys(ticketPatch).length > 0) {
    validationErrors.push(
      'ticket: en estado "pedido" solo se permite excluir ítems (pedido_excluded); no se actualiza la cabecera'
    );
  }

  // ── Validate assigned_to (Mini Web user id) + apply Tomar semantics ──
  if ('assigned_to' in ticketPatch) {
    const assigneeId = ticketPatch.assigned_to;
    if (assigneeId === null || assigneeId === '') {
      ticketPatch.assigned_to = null;
      ticketPatch.assigned_at = null;
      ticketPatch.locked_by = null;
      ticketPatch.locked_at = null;
      ticketPatch.lock_expires_at = null;
      releaseApplied = true;
    } else if (typeof assigneeId !== 'string' || !UUID_RE.test(assigneeId)) {
      validationErrors.push('ticket.assigned_to: debe ser un UUID válido de usuario Mini Web, o null');
    } else {
      const { data: assignee } = await supabaseAdmin
        .from('users')
        .select('id, is_active, role, full_name')
        .eq('id', assigneeId)
        .maybeSingle();
      if (!assignee) {
        validationErrors.push(`ticket.assigned_to: usuario "${assigneeId}" no existe en Mini Web`);
      } else if (!assignee.is_active) {
        validationErrors.push(`ticket.assigned_to: usuario "${assignee.full_name}" está inactivo`);
      } else {
        const now = new Date();
        const lockStillValid =
          current.locked_by === assigneeId &&
          current.lock_expires_at &&
          new Date(current.lock_expires_at) > now;
        const isNewAssignee = assigneeId !== current.assigned_to;

        if (isNewAssignee || !lockStillValid) {
          const LOCK_TIMEOUT = parseInt(process.env.LOCK_TIMEOUT_MINUTES || '10', 10);
          const expiresAt = new Date(now.getTime() + LOCK_TIMEOUT * 60 * 1000);
          const slaDeadline = calculateSlaDeadline(current.item_count || 1, now);

          ticketPatch.assigned_at = now.toISOString();
          ticketPatch.locked_by = assigneeId;
          ticketPatch.locked_at = now.toISOString();
          ticketPatch.lock_expires_at = expiresAt.toISOString();
          ticketPatch.sla_started_at = now.toISOString();
          ticketPatch.sla_deadline = slaDeadline.toISOString();
          ticketPatch.sla_exceeded = false;
          ticketPatch.sla_completed_at = null;

          const statusBefore = ticketPatch.status || current.status;
          if (['pending', 'pending_review', 'en_revision'].includes(statusBefore)) {
            ticketPatch.status = 'in_progress';
          }

          takeApplied = true;
        }
      }
    }
  }

  // Effective status after header patch (e.g. take → in_progress in same request)
  const effectiveStatus = ticketPatch.status || current.status;

  // ── Load existing items ──
  let existingItems = [];
  if (itemsPatchRaw.length > 0) {
    const { data: dbItems } = await supabaseAdmin
      .from('ticket_items')
      .select('id, item_order')
      .eq('ticket_id', ticketId)
      .order('item_order', { ascending: true });
    existingItems = dbItems || [];
  }
  const existingItemIds = new Set(existingItems.map((i) => i.id));
  let maxOrder = existingItems.reduce((max, i) => Math.max(max, i.item_order || 0), 0);

  const itemUpdates = [];
  const itemCreates = [];
  const itemDeletes = [];
  const itemExcludedIds = [];

  for (let i = 0; i < itemsPatchRaw.length; i++) {
    const raw = itemsPatchRaw[i] || {};
    const prefix = `items[${i}]`;
    const wantsDelete = raw._delete === true;
    const itemId = raw.id;
    const clientRef = raw.client_ref != null ? String(raw.client_ref) : null;

    // ── DELETE ──
    if (wantsDelete) {
      if (!itemId) {
        validationErrors.push(`${prefix}: _delete requiere "id" del item`);
        continue;
      }
      if (!existingItemIds.has(itemId)) {
        validationErrors.push(`${prefix}: el item "${itemId}" no pertenece a este ticket`);
        continue;
      }
      if (!PUTIX_ITEM_CREATE_DELETE_STATUSES.includes(effectiveStatus)) {
        validationErrors.push(
          `${prefix}: eliminar ítems solo está permitido en estado in_progress (actual: ${effectiveStatus})`
        );
        continue;
      }
      if (!itemDeletes.includes(itemId)) itemDeletes.push(itemId);
      continue;
    }

    // ── CREATE (no id) ──
    if (!itemId) {
      if (!PUTIX_ITEM_CREATE_DELETE_STATUSES.includes(effectiveStatus)) {
        validationErrors.push(
          `${prefix}: agregar ítems solo está permitido en estado in_progress (actual: ${effectiveStatus})`
        );
        continue;
      }

      const { picked, ignored } = pickAllowedFields(raw, PUTIX_EDITABLE_ITEM_FIELDS);
      // client_ref / _delete / raw_line are control or create-input aliases, not ignored mistakes
      const ignoredDb = ignored.filter((k) => !['client_ref', '_delete', 'raw_line'].includes(k));
      if (ignoredDb.length > 0) ignoredFields.items[clientRef || `new_${i}`] = ignoredDb;
      validationErrors.push(...validateEnumFields(picked, WRITE_BACK_ENUMS.item, `${prefix}.`));

      const description = (picked.parsed_description || '').trim();
      const rawLine = typeof raw.raw_line === 'string' ? raw.raw_line.trim() : '';
      const finalDescription = description || rawLine;
      if (!finalDescription) {
        validationErrors.push(`${prefix}: para crear un ítem se requiere "parsed_description" (o raw_line)`);
        continue;
      }

      maxOrder += 1;
      itemCreates.push({
        client_ref: clientRef,
        index: i,
        row: {
          ticket_id: ticketId,
          item_order: picked.item_order != null ? picked.item_order : maxOrder,
          raw_line: rawLine || finalDescription,
          parsed_description: finalDescription,
          quantity: picked.quantity != null ? picked.quantity : 1,
          status: picked.status || 'pending_info',
          source: picked.source ?? null,
          brand: picked.brand ?? null,
          cost_price: picked.cost_price ?? null,
          selling_price: picked.selling_price ?? null,
          supplier_code: picked.supplier_code ?? null,
          codigo_distrimia: picked.codigo_distrimia ?? null,
          codigo_oem: picked.codigo_oem ?? null,
          codigo_fabrica: picked.codigo_fabrica ?? null,
          validity_status: picked.validity_status || 'vigente',
          validity_expires_at: picked.validity_expires_at ?? null,
          estimated_delivery: picked.estimated_delivery ?? null,
          seller_note: picked.seller_note ?? null,
          internal_note: picked.internal_note ?? null,
          pedido_excluded: picked.pedido_excluded === true,
          control_group: picked.control_group ?? null,
          audit_code_type: picked.audit_code_type ?? null,
          alternative_confirmed: picked.alternative_confirmed === true,
          confirmed_alternative_id: picked.confirmed_alternative_id ?? null,
        },
      });
      continue;
    }

    // ── UPDATE existing ──
    if (!existingItemIds.has(itemId)) {
      validationErrors.push(`${prefix}: el item "${itemId}" no pertenece a este ticket`);
      continue;
    }
    if (itemDeletes.includes(itemId)) {
      validationErrors.push(`${prefix}: el item "${itemId}" también está marcado con _delete`);
      continue;
    }

    const { picked, ignored } = pickAllowedFields(raw, PUTIX_EDITABLE_ITEM_FIELDS);
    const ignoredDb = ignored.filter((k) => k !== 'client_ref' && k !== '_delete');
    if (ignoredDb.length > 0) ignoredFields.items[itemId] = ignoredDb;
    validationErrors.push(...validateEnumFields(picked, WRITE_BACK_ENUMS.item, `${prefix}.`));

    if (Object.keys(picked).length === 0) continue;

    const hasExclude = Object.prototype.hasOwnProperty.call(picked, 'pedido_excluded');
    const otherFields = Object.keys(picked).filter((k) => k !== 'pedido_excluded');

    if (hasExclude && !PUTIX_ITEM_EXCLUDE_STATUSES.includes(effectiveStatus)) {
      validationErrors.push(
        `${prefix}: pedido_excluded solo está permitido en in_progress o pedido (actual: ${effectiveStatus})`
      );
      continue;
    }

    if (effectiveStatus === 'pedido' && otherFields.length > 0) {
      validationErrors.push(
        `${prefix}: en estado "pedido" solo se permite pedido_excluded (no otras actualizaciones de ítem)`
      );
      continue;
    }

    if (otherFields.length > 0 && !PUTIX_SYNC_STATUSES.includes(effectiveStatus)) {
      validationErrors.push(
        `${prefix}: actualizar campos del ítem no está permitido en estado "${effectiveStatus}"`
      );
      continue;
    }

    if (hasExclude && picked.pedido_excluded === true) {
      itemExcludedIds.push(itemId);
    }

    itemUpdates.push({ id: itemId, patch: picked });
  }

  // ── Referential check: confirmed_alternative_id must belong to its item ──
  const altChecks = itemUpdates.filter((u) => u.patch.confirmed_alternative_id);
  if (altChecks.length > 0) {
    const altIds = altChecks.map((u) => u.patch.confirmed_alternative_id);
    const { data: alts } = await supabaseAdmin
      .from('ticket_item_alternatives')
      .select('id, ticket_item_id')
      .in('id', altIds);
    const altOwner = new Map((alts || []).map((a) => [a.id, a.ticket_item_id]));
    for (const u of altChecks) {
      if (altOwner.get(u.patch.confirmed_alternative_id) !== u.id) {
        validationErrors.push(
          `items: confirmed_alternative_id "${u.patch.confirmed_alternative_id}" no pertenece al item "${u.id}"`
        );
      }
    }
  }

  // Cannot delete the last remaining item (after creates/deletes)
  const remainingAfterDelete = existingItemIds.size - itemDeletes.length + itemCreates.length;
  if (itemDeletes.length > 0 && remainingAfterDelete < 1) {
    validationErrors.push('No se puede eliminar el único ítem del ticket (debe quedar al menos 1)');
  }

  if (validationErrors.length > 0) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Errores de validación en la solicitud',
      code: 'VALIDATION_ERROR',
      validation_errors: validationErrors,
      ignored_fields: ignoredFields,
    };
  }

  // ── Apply ticket update (always touch the row so updated_at moves for polling) ──
  const ticketUpdateData = { ...ticketPatch, updated_at: new Date().toISOString() };
  if (serviceUserId) ticketUpdateData.updated_by = serviceUserId;
  if (ticketPatch.status === 'closed' && current.status !== 'closed') {
    ticketUpdateData.closed_at = new Date().toISOString();
  }

  // ── Apply deletes ──
  for (const id of itemDeletes) {
    const { error: dErr } = await supabaseAdmin
      .from('ticket_items')
      .delete()
      .eq('id', id)
      .eq('ticket_id', ticketId);
    if (dErr) throw dErr;
  }

  // ── Apply item updates ──
  for (const { id, patch } of itemUpdates) {
    const { error: iErr } = await supabaseAdmin
      .from('ticket_items')
      .update(patch)
      .eq('id', id)
      .eq('ticket_id', ticketId);
    if (iErr) throw iErr;
  }

  // ── Apply creates ──
  const itemsCreated = [];
  for (const create of itemCreates) {
    const { data: created, error: cErr } = await supabaseAdmin
      .from('ticket_items')
      .insert(create.row)
      .select('id')
      .single();
    if (cErr) throw cErr;
    itemsCreated.push({
      client_ref: create.client_ref,
      id: created.id,
      index: create.index,
    });
  }

  // ── Sync item_count / length_class after create/delete ──
  if (itemCreates.length > 0 || itemDeletes.length > 0) {
    const { count: finalCount } = await supabaseAdmin
      .from('ticket_items')
      .select('id', { count: 'exact', head: true })
      .eq('ticket_id', ticketId);
    const newCount = finalCount || 0;
    ticketUpdateData.item_count = newCount;
    ticketUpdateData.length_class = classifyLengthClass(newCount);
  }

  const { error: tErr } = await supabaseAdmin
    .from('tickets')
    .update(ticketUpdateData)
    .eq('id', ticketId);
  if (tErr) throw tErr;

  // ── Audit log (best-effort; requires a real user id to satisfy FK) ──
  if (serviceUserId) {
    supabaseAdmin
      .from('audit_log')
      .insert({
        entity_type: 'ticket',
        entity_id: ticketId,
        action: 'update',
        new_values: {
          source: 'putix_writeback',
          ticket: ticketPatch,
          items_updated: itemUpdates,
          items_created: itemsCreated,
          items_deleted: itemDeletes,
        },
        performed_by: serviceUserId,
      })
      .then(null, (e) => console.error('[PUTIX] audit log failed:', e.message));
  }

  const payload = await buildFullTicketPayload(ticketId, {
    includeBlocks,
    includeAttachmentUrls: false,
  });

  return {
    ok: true,
    statusCode: 200,
    updated: {
      ticket_fields: Object.keys(ticketPatch),
      items_updated: itemUpdates.length,
      items_created: itemsCreated,
      items_deleted: itemDeletes,
      items_excluded: itemExcludedIds,
      take_applied: takeApplied,
      release_applied: releaseApplied,
    },
    ignored_fields: ignoredFields,
    payload,
  };
}
