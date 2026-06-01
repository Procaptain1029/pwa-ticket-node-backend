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
 * Customer-facing, compact WhatsApp-ready layout
 */
export function generateCustomerProformaBlock(ticket, items) {
  // Compact vehicle info
  const vi = ticket.vehicle_info || {};
  const vehicleParts = [vi.marca, vi.modelo, shouldAppendCilindraje(vi.modelo, vi.cilindraje) ? vi.cilindraje : null, vi.anio ? `(${vi.anio})` : null]
    .filter(Boolean).join(' ');

  // Format date as DD/MM/YYYY
  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

  if (!items || items.length === 0) {
    return [
      '📄 PROFORMA – DISTRIMIA S.A.',
      `N° ${ticket.k_number} | 📅 ${dateStr}`,
      vehicleParts ? `🚗 ${vehicleParts}` : null,
      '',
      'No hay artículos en este ticket.',
      '⚠️ Valores sujetos a variación sin previo aviso',
    ].filter(s => s !== null && s !== undefined).join('\n');
  }

  // Sort items by status: available first, then verification, then unavailable
  const statusOrder = { positive: 0, no_registra_verificar: 1, negative: 2, no_registra: 3, pending_info: 4 };
  const sortedItems = [...items].sort((a, b) =>
    (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4)
  );

  // Separate available/verification items from unavailable
  const availableItems = sortedItems.filter(i => i.status === 'positive');
  const verificationItems = sortedItems.filter(i => i.status === 'no_registra_verificar' || i.status === 'pending_info');
  const unavailableItems = sortedItems.filter(i => i.status === 'negative' || i.status === 'no_registra');

  // Build item lines
  const itemLines = [];

  // Available items: 🟢 Producto — USD xx (MARCA)
  for (const item of availableItems) {
    const desc = normalizeProductName(item.parsed_description || item.raw_line);
    const qty = item.quantity > 1 ? ` x${item.quantity}` : '';
    const brandPart = item.brand ? ` (${item.brand.toUpperCase()})` : '';
    const note = item.seller_note || '';
    const alts = item.alternatives || [];

    if (item.selling_price) {
      const priceLine = `🟢 ${desc}${qty} — USD ${formatUSDAmount(item.selling_price)}${brandPart}`;
      // Short note on same line, long note below
      if (note && note.length <= 40) {
        itemLines.push(`${priceLine} | ${note}`);
      } else {
        itemLines.push(priceLine);
        if (note) itemLines.push(`   ${note}`);
      }
    } else {
      itemLines.push(`🟢 ${desc}${qty} — Disponible${brandPart}`);
    }

    // Alternatives on separate lines
    if (alts.length > 0) {
      for (const alt of alts) {
        const altPrice = alt.selling_price ? `USD ${formatUSDAmount(alt.selling_price)}` : '';
        const altBrand = alt.brand ? alt.brand.toUpperCase() : '';
        itemLines.push(`  • ${altPrice}${altBrand ? ` (${altBrand})` : ''}`);
      }
    }
  }

  // Verification items: 🟡 Producto — En verificación
  for (const item of verificationItems) {
    const desc = normalizeProductName(item.parsed_description || item.raw_line);
    const qty = item.quantity > 1 ? ` x${item.quantity}` : '';
    const brandPart = item.brand ? ` (${item.brand.toUpperCase()})` : '';
    const note = item.seller_note || '';

    if (item.selling_price) {
      const priceLine = `🟡 ${desc}${qty} — USD ${formatUSDAmount(item.selling_price)}${brandPart} — En verificación`;
      if (note && note.length <= 40) {
        itemLines.push(`${priceLine} | ${note}`);
      } else {
        itemLines.push(priceLine);
        if (note) itemLines.push(`   ${note}`);
      }
    } else {
      itemLines.push(`� ${desc}${qty} — En verificación`);
    }

    // Alternatives
    const alts = item.alternatives || [];
    if (alts.length > 0) {
      for (const alt of alts) {
        const altPrice = alt.selling_price ? `USD ${formatUSDAmount(alt.selling_price)}` : '';
        const altBrand = alt.brand ? alt.brand.toUpperCase() : '';
        itemLines.push(`  • ${altPrice}${altBrand ? ` (${altBrand})` : ''}`);
      }
    }
  }

  // Unavailable items: group if many (>=3)
  if (unavailableItems.length >= 3) {
    itemLines.push('');
    itemLines.push('🔴 No disponible:');
    for (const item of unavailableItems) {
      const desc = normalizeProductName(item.parsed_description || item.raw_line);
      const qty = item.quantity > 1 ? ` x${item.quantity}` : '';
      itemLines.push(`  • ${desc}${qty}`);
    }
  } else {
    for (const item of unavailableItems) {
      const desc = normalizeProductName(item.parsed_description || item.raw_line);
      const qty = item.quantity > 1 ? ` x${item.quantity}` : '';
      itemLines.push(`🔴 ${desc}${qty} — No disponible`);
    }
  }


  // Total only from positive items with price
  const positiveWithPrice = items.filter(i => i.status === 'positive' && i.selling_price);
  const total = positiveWithPrice.reduce((sum, item) => 
    sum + (parseFloat(item.selling_price) * (item.quantity || 1)), 0
  );

  // Build output sections
  const sections = [];

  sections.push(`📄 PROFORMA – DISTRIMIA S.A.`);
  sections.push(`N° ${ticket.k_number} | 📅 ${dateStr}`);
  sections.push(`🚗 ${vehicleParts || 'Sin información de vehículo'}`);
  sections.push('');

  sections.push(itemLines.join('\n'));
  sections.push('');

  if (positiveWithPrice.length > 0) {
    sections.push(`💰 TOTAL CONFIRMADO: USD ${formatUSDAmount(total)}`);
    sections.push('');
  }

  // Legends
  sections.push('⚠️ Valores sujetos a variación sin previo aviso');
  sections.push('📦 Stock sujeto a verificación al confirmar pedido');
  sections.push('✅ IVA incluido | 🚚 Transporte no incluido');
  sections.push('');

  // Advisor
  if (ticket.assigned_to_user) {
    const advisorName = formatAdvisorName(ticket.assigned_to_user.full_name);
    sections.push(`👤 ${advisorName}`);
    sections.push('Asesor comercial');
  }

  sections.push('');
  sections.push('🤝 Quedamos atentos');

  return sections.filter(s => s !== null && s !== undefined).join('\n');
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
  if (!amount) return 'USD 0';
  return 'USD ' + formatUSDAmount(amount);
}

/**
 * Format amount as "xxx,xx" (comma as decimal sep, period as thousands)
 */
function formatUSDAmount(amount) {
  const num = parseFloat(amount);
  if (isNaN(num)) return '0,00';
  // Format with 2 decimals, using comma as decimal separator
  const parts = num.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]}`;
}

/**
 * Normalize product name: sentence case (not ALL CAPS), fix double spaces, fix "cc cc"
 */
function normalizeProductName(text) {
  if (!text) return '';
  let result = text.trim();
  // Fix "cc cc" → "cc"
  result = result.replace(/\bcc\s+cc\b/gi, 'cc');
  // Fix double/multiple spaces
  result = result.replace(/\s{2,}/g, ' ');
  // If text is ALL UPPERCASE (>= 4 chars), convert to sentence case
  if (result.length >= 4 && result === result.toUpperCase()) {
    result = result.charAt(0).toUpperCase() + result.slice(1).toLowerCase();
  }
  return result;
}

/**
 * Format advisor name: capitalize properly, show first name + one last name only.
 * Latin naming: [Nombre] [Segundo nombre] [Apellido paterno] [Apellido materno]
 * Output: Nombre + Apellido paterno
 */
function formatAdvisorName(fullName) {
  if (!fullName) return '';
  const parts = fullName.trim().split(/\s+/);
  let display;
  if (parts.length >= 4) {
    // First name + paternal last name (3rd part)
    display = [parts[0], parts[2]];
  } else if (parts.length === 3) {
    // First name + last name (3rd part)
    display = [parts[0], parts[2]];
  } else {
    // 2 or fewer: show all
    display = parts;
  }
  return display.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
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
  if (shouldAppendCilindraje(vehicleInfo.modelo, vehicleInfo.cilindraje)) parts.push(`Cilindraje: ${vehicleInfo.cilindraje}`);
  if (vehicleInfo.anio) parts.push(vehicleInfo.anio);
  if (vehicleInfo.placa) parts.push(`Placa: ${vehicleInfo.placa}`);
  if (vehicleInfo.chasis) parts.push(`Chasis: ${vehicleInfo.chasis}`);
  return parts.length > 0 ? parts.join(' | ') : null;
}

function shouldAppendCilindraje(modelo, cilindraje) {
  if (!cilindraje) return false;
  if (!modelo) return true;

  const modelNormalized = String(modelo).toLowerCase().replace(/\s+/g, '');
  const digits = String(cilindraje).match(/\d+/g);
  if (!digits || digits.length === 0) return true;

  return !modelNormalized.includes(digits.join(''));
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
