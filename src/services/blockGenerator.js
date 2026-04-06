/**
 * Block Generator Service
 * Generates copy-ready text blocks for different purposes
 */

// Standard disclaimer texts (leyendas)
const LEYENDA_1 = '⚠️ Precios sujetos a cambio sin previo aviso';
const LEYENDA_2 = '📋 Disponibilidad sujeta a confirmación al momento del pedido';

/**
 * Generate Control block (internal)
 * Contains: #K + IT + priority
 */
export function generateControlBlock(ticket) {
  const priorityEmoji = {
    urgent: '🔴',
    high: '🟠',
    normal: '🟢',
    low: '⚪'
  };

  return `═══════════════════════
📋 CONTROL INTERNO
═══════════════════════
#${ticket.k_number}
IT: ${ticket.item_count}
Prioridad: ${priorityEmoji[ticket.priority] || '🟢'} ${ticket.priority.toUpperCase()}
Grupo: ${ticket.group_code}
Estado: ${formatStatus(ticket.status)}${ticket.vehicle_info ? `\n🚗 ${formatVehicleInfo(ticket.vehicle_info) || ''}` : ''}${ticket.status === 'reenviado' && ticket.forwarded_to_group ? `\n📤 Reenviado a: ${ticket.forwarded_to_group}` : ''}
═══════════════════════`;
}

/**
 * Generate Customer Proforma block
 * Customer-facing, compact horizontal layout
 */
export function generateCustomerProformaBlock(ticket, items) {
  // Compact vehicle info
  const vi = ticket.vehicle_info || {};
  const vehicleParts = [vi.marca, vi.modelo, vi.cilindraje, vi.anio ? `(${vi.anio})` : null]
    .filter(Boolean).join(' ');
  const vehicleExtra = [vi.motor ? `Motor: ${vi.motor}` : null, vi.cilindraje ? `${vi.cilindraje} cc` : null]
    .filter(Boolean).join(' | ');

  // Format date as DD/MM/YYYY
  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

  if (!items || items.length === 0) {
    return `📄 PROFORMA – DISTRIMIA S.A.
N° ${ticket.k_number} | 📅 ${dateStr}
${vehicleParts ? `🚗 ${vehicleParts}` : ''}

No hay artículos en este ticket.

⚠ Precios sujetos a cambio sin previo aviso`;
  }

  // Sort items by status for client readability: available first, then verification, then unavailable
  const statusOrder = { positive: 0, no_registra_verificar: 1, negative: 2, no_registra: 3, pending_info: 4 };
  const sortedItems = [...items].sort((a, b) =>
    (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4)
  );

  // Track if we have delivery or verification items for the legend
  let hasDelivery = false;
  let hasVerification = false;

  // Build item lines grouped by status with blank line between groups
  let lastStatusGroup = null;
  const itemLines = sortedItems.map(item => {
    const desc = item.parsed_description || item.raw_line;
    const qty = item.quantity > 1 ? ` x${item.quantity}` : '';
    const brandPart = item.brand ? ` (${item.brand})` : '';
    const note = item.seller_note ? ` 🧩 ${item.seller_note}` : '';
    const delivery = item.estimated_delivery ? (() => { hasDelivery = true; return ' 🚚'; })() : '';

    // Build alternatives suffix
    const alts = (item.alternatives || []);
    const altSuffix = alts.length > 0
      ? '\n' + alts.map((alt, i) => {
          const altPrice = alt.selling_price ? ` — ${formatPriceShort(alt.selling_price)}` : '';
          return `  🔄 Opc ${i + 2}: ${alt.brand}${altPrice}`;
        }).join('\n')
      : '';

    let line;
    if (item.status === 'positive' && item.selling_price) {
      line = `✅ ${desc}${brandPart}${qty} — ${formatPriceShort(item.selling_price)}${delivery}${note}${altSuffix}`;
    } else if (item.status === 'negative') {
      line = `❌ ${desc}${qty}`;
    } else if (item.status === 'no_registra') {
      line = `🚫 ${desc}${qty}`;
    } else if (item.status === 'no_registra_verificar') {
      hasVerification = true;
      if (item.selling_price) {
        line = `🔍 ${desc}${brandPart}${qty} — ${formatPriceShort(item.selling_price)}${note}${altSuffix}`;
      } else {
        line = `🔍 ${desc}${qty}`;
      }
    } else {
      line = `⏳ ${desc}${qty}`;
    }

    // Add blank line between different status groups
    const currentGroup = statusOrder[item.status] ?? 4;
    const prefix = (lastStatusGroup !== null && currentGroup !== lastStatusGroup) ? '\n' : '';
    lastStatusGroup = currentGroup;
    return prefix + line;
  }).join('\n');

  // Total only from positive items with price (USD format)
  const positiveItems = items.filter(i => i.status === 'positive' && i.selling_price);
  const total = positiveItems.reduce((sum, item) => 
    sum + (parseFloat(item.selling_price) * (item.quantity || 1)), 0
  );

  const totalLine = positiveItems.length > 0
    ? `\n\n💰 TOTAL: USD ${total.toFixed(2).replace('.', ',')}`
    : '';

  const sellerNotesLine = ticket.seller_notes
    ? `\n📝 ${ticket.seller_notes}`
    : '';

  // Build legend lines
  const legendParts = [];
  if (hasDelivery) legendParts.push('🚚 despacho urgente (sujeto a horario de corte)');
  if (hasVerification) legendParts.push('🔍 sujeto a verificación');
  const legend = legendParts.length > 0
    ? '\n' + legendParts.join('\n')
    : '';

  return `📄 PROFORMA – DISTRIMIA S.A.
N° ${ticket.k_number} | 📅 ${dateStr}

🚗 ${vehicleParts || 'Sin información de vehículo'}${vehicleExtra ? `\n${vehicleExtra}` : ''}

${itemLines}${totalLine}
${legend}${sellerNotesLine}
⚠ Precios sujetos a cambio sin previo aviso
📦 Disponibilidad sujeta a confirmación al momento de la solicitud
📦 Precios incluyen IVA. Transporte no incluido.

💬 Quedo atento a su confirmación para coordinar despacho.
${ticket.assigned_to_user ? `👤 Asesor comercial: ${ticket.assigned_to_user.full_name}` : ''}`;
}

/**
 * Generate Aux Seguimiento block (internal)
 */
export function generateAuxSeguimientoBlock(ticket, items) {
  const itemLines = items.map((item, idx) => {
    const statusEmoji = getStatusEmoji(item.status);
    const validity = item.validity_status === 'vigente' ? '🟢' : '🟠';
    return `${idx + 1}. ${statusEmoji} ${item.parsed_description || item.raw_line}
   Estado: ${item.status} | Vigencia: ${validity}
   Código Distrimia: ${item.codigo_distrimia || '---'}
   Código OEM: ${item.codigo_oem || '---'}`;
  }).join('\n\n');

  return `╔═══════════════════════════════════╗
║     AUX SEGUIMIENTO INTERNO       ║
╚═══════════════════════════════════╝
#${ticket.k_number} | IT: ${ticket.item_count}
Grupo: ${ticket.group_code}
───────────────────────────────────

${itemLines}

───────────────────────────────────
Creado: ${formatDate(ticket.created_at)}
Actualizado: ${formatDate(ticket.updated_at)}`;
}

/**
 * Generate Reenvíos block (internal forwarding log)
 */
export function generateReenviosBlock(ticket, forwardingLog) {
  if (!forwardingLog || forwardingLog.length === 0) {
    return `═══════════════════════
📤 REENVÍOS #${ticket.k_number}
═══════════════════════

Sin reenvíos registrados.`;
  }

  const logLines = forwardingLog.map(entry => {
    return `📌 ${entry.target_type === 'supplier' ? 'Proveedor' : 'Grupo'}: ${entry.target_name || entry.target_code}
   Fecha: ${formatDate(entry.forwarded_at)}
   Por: ${entry.forwarded_by_name || 'Usuario'}
   ${entry.notes ? `Notas: ${entry.notes}` : ''}`;
  }).join('\n\n');

  return `═══════════════════════
📤 REENVÍOS #${ticket.k_number}
═══════════════════════

${logLines}`;
}

/**
 * Generate Proveedor block (supplier-facing)
 * Field per line format, no prices
 */
export function generateProveedorBlock(ticket, items, supplierCode = null) {
  // Filter items for specific supplier if provided
  const filteredItems = supplierCode 
    ? items.filter(i => i.supplier_code === supplierCode)
    : items;

  // Group by model if different
  const itemLines = filteredItems.map(item => {
    return `───────────────────
Artículo: ${item.parsed_description || item.raw_line}
Cantidad: ${item.quantity || 1}
Código OEM: ${item.codigo_oem || 'N/A'}
Código Fábrica: ${item.codigo_fabrica || 'N/A'}
───────────────────`;
  }).join('\n');

  return `╔════════════════════════════════╗
║      CONSULTA A PROVEEDOR      ║
╚════════════════════════════════╝
Ref: #${ticket.k_number}
${supplierCode ? `Proveedor: ${supplierCode}` : ''}

${itemLines}

Por favor confirmar:
- Disponibilidad
- Tiempo de entrega
- Precio`;
}

/**
 * Generate Despachos/Retiros block by supplier
 */
export function generateDespachosBlock(ticket, items, supplierCode) {
  const supplierItems = items.filter(i => i.supplier_code === supplierCode);
  
  const itemLines = supplierItems.map(item => {
    return `* ${item.parsed_description || item.raw_line}
  Cantidad: ${item.quantity || 1}
  Código: ${item.codigo_distrimia || item.codigo_oem || 'N/A'}`;
  }).join('\n\n');

  return `╔════════════════════════════════╗
║    DESPACHO/RETIRO - ${supplierCode}    ║
╚════════════════════════════════╝
#${ticket.k_number}

${itemLines}

───────────────────────────────
Total artículos: ${supplierItems.length}`;
}

/**
 * Generate Interno block (with prices)
 */
export function generateInternoBlock(ticket, items) {
  const vehicleLine = formatVehicleInfo(ticket.vehicle_info);

  const itemLines = items.map((item, idx) => {
    const cost = item.cost_price ? formatPrice(item.cost_price) : '---';
    const sell = item.selling_price ? formatPrice(item.selling_price) : '---';
    const internalNote = item.internal_note ? `\n   📝 Nota interna: ${item.internal_note}` : '';
    return `${idx + 1}. ${item.parsed_description || item.raw_line}
   Costo: ${cost} | Venta: ${sell}
   Proveedor: ${item.supplier_code || 'N/A'}
   Código Distrimia: ${item.codigo_distrimia || '---'}
   Código OEM: ${item.codigo_oem || '---'}
   Código Fábrica: ${item.codigo_fabrica || '---'}${internalNote}`;
  }).join('\n\n');

  const totalCost = items.reduce((sum, i) => 
    sum + (parseFloat(i.cost_price || 0) * (i.quantity || 1)), 0
  );
  const totalSell = items.reduce((sum, i) => 
    sum + (parseFloat(i.selling_price || 0) * (i.quantity || 1)), 0
  );

  return `╔════════════════════════════════╗
║       CONTROL INTERNO          ║
╚════════════════════════════════╝
#${ticket.k_number} | IT: ${ticket.item_count}
Grupo: ${ticket.group_code}
${vehicleLine ? `🚗 ${vehicleLine}` : ''}

${itemLines}

═══════════════════════════════
Costo Total: ${formatPrice(totalCost)}
Venta Total: ${formatPrice(totalSell)}
Margen: ${formatPrice(totalSell - totalCost)}
═══════════════════════════════`;
}

/**
 * Generate per-supplier blocks
 * Groups items by supplier_code and generates a separate copyable block per supplier
 */
export function generatePerSupplierBlocks(ticket, items) {
  const vehicleLine = formatVehicleInfo(ticket.vehicle_info);

  // Group items by supplier_code
  const supplierGroups = {};
  items.forEach(item => {
    const supplier = item.supplier_code || 'Sin proveedor';
    if (!supplierGroups[supplier]) supplierGroups[supplier] = [];
    supplierGroups[supplier].push(item);
  });

  const suppliers = Object.keys(supplierGroups);
  if (suppliers.length === 0) return 'No hay items con proveedor asignado.';

  return suppliers.map(supplier => {
    const sItems = supplierGroups[supplier];
    const itemLines = sItems.map((item, idx) => {
      const cost = item.cost_price ? formatPrice(item.cost_price) : '---';
      const sell = item.selling_price ? formatPrice(item.selling_price) : '---';
      const internalNote = item.internal_note ? `\n   📝 ${item.internal_note}` : '';
      return `${idx + 1}. ${item.parsed_description || item.raw_line}
   Costo: ${cost} | Venta: ${sell}
   Código Distrimia: ${item.codigo_distrimia || '---'}
   Código OEM: ${item.codigo_oem || '---'}
   Código Fábrica: ${item.codigo_fabrica || '---'}${internalNote}`;
    }).join('\n\n');

    const groupCost = sItems.reduce((sum, i) => sum + (parseFloat(i.cost_price || 0) * (i.quantity || 1)), 0);
    const groupSell = sItems.reduce((sum, i) => sum + (parseFloat(i.selling_price || 0) * (i.quantity || 1)), 0);

    return {
      supplier,
      item_count: sItems.length,
      content: `╔════════════════════════════════╗
║  PROVEEDOR: ${supplier.toUpperCase().padEnd(18)} ║
╚════════════════════════════════╝
#${ticket.k_number} | IT: ${sItems.length}
Grupo: ${ticket.group_code}
${vehicleLine ? `🚗 ${vehicleLine}` : ''}

${itemLines}

───────────────────────────────
Costo: ${formatPrice(groupCost)} | Venta: ${formatPrice(groupSell)}${ticket.assigned_to_user ? `\n🤝 ${ticket.assigned_to_user.full_name}` : ''}`
    };
  });
}

/**
 * Generate Auditoría block (per item)
 */
export function generateAuditoriaBlock(item) {
  const auditTypeLabels = {
    'codigo_distrimia_con_oem': 'Código Distrimia con OEM',
    'sin_oem': 'Sin OEM',
    'sin_oem_referencial': 'Sin OEM (solo referencial)',
    'sin_codigo': 'Sin código'
  };

  return `═══════════════════════
🔍 AUDITORÍA DE ITEM
═══════════════════════
Descripción: ${item.parsed_description || item.raw_line}
Estado: ${item.status}
Clasificación: ${auditTypeLabels[item.audit_code_type] || 'Sin clasificar'}

Códigos:
- Distrimia: ${item.codigo_distrimia || '---'}
- OEM: ${item.codigo_oem || '---'}
- Fábrica: ${item.codigo_fabrica || '---'}
═══════════════════════`;
}

// Helper functions
function formatPrice(amount) {
  if (!amount) return '$0.00';
  return new Intl.NumberFormat('es-VE', {
    style: 'currency',
    currency: 'USD'
  }).format(amount);
}

function formatPriceShort(amount) {
  if (!amount) return '$0';
  const num = parseFloat(amount);
  if (num % 1 === 0) return '$' + num.toLocaleString('es-VE');
  return '$' + num.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr) {
  if (!dateStr) return '---';
  return new Date(dateStr).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short'
  });
}

function formatStatus(status) {
  const statusLabels = {
    'pending': '📋 Pendiente',
    'pending_review': '⏳ Pendiente Revisión',
    'in_progress': '🔄 En Proceso',
    'ready': '✅ Listo',
    'pedido': '📦 Pedido',
    'closed': '📁 Cerrado',
    'cancelled': '❌ Cancelado',
    'en_revision': '🔍 En Revisión',
    'reenviado': '📤 Reenviado'
  };
  return statusLabels[status] || status;
}

function formatVehicleInfo(vehicleInfo) {
  if (!vehicleInfo) return null;
  const parts = [];
  if (vehicleInfo.marca) parts.push(vehicleInfo.marca);
  if (vehicleInfo.modelo) parts.push(vehicleInfo.modelo);
  if (vehicleInfo.motor) parts.push(`Motor: ${vehicleInfo.motor}`);
  if (vehicleInfo.cilindraje) parts.push(`Cilindraje: ${vehicleInfo.cilindraje}`);
  if (vehicleInfo.anio) parts.push(vehicleInfo.anio);
  if (vehicleInfo.placa) parts.push(`Placa: ${vehicleInfo.placa}`);
  if (vehicleInfo.chasis) parts.push(`Chasis: ${vehicleInfo.chasis}`);
  return parts.length > 0 ? parts.join(' | ') : null;
}

function getStatusEmoji(status) {
  const emojis = {
    'positive': '✅',
    'negative': '❌',
    'pending_info': '⏳',
    'no_registra': '🚫',
    'no_registra_verificar': '🔍'
  };
  return emojis[status] || '❓';
}

export default {
  generateControlBlock,
  generateCustomerProformaBlock,
  generateAuxSeguimientoBlock,
  generateReenviosBlock,
  generateProveedorBlock,
  generateDespachosBlock,
  generateInternoBlock,
  generatePerSupplierBlocks,
  generateAuditoriaBlock
};
