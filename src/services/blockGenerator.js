/**
 * Block Generator Service
 * Generates copy-ready text blocks for different purposes
 */

// Standard disclaimer texts (leyendas)
const LEYENDA_1 = '⚠️ Precios sujetos a cambio sin previo aviso';
const LEYENDA_2 = '📋 Disponibilidad sujeta a confirmación al momento del pedido';

/**
 * Phase 2 — resolve the effective brand + selling_price of an item
 * based on its alternative-confirmation state.
 *
 * Returns:
 *   - brand / selling_price: the confirmed alternative's values if a valid
 *     confirmed_alternative_id is present, otherwise the primary's.
 *   - isConfirmedAlternative: true when an alternative was used.
 *   - confirmedAltId: id of the alternative that was used (null otherwise).
 *
 * All downstream blocks (customer Proforma, Pedido Final, Pedido por
 * Proveedor, Interno, per-supplier, etc.) call this helper so the
 * seller's single click in Modo Rápido / Pedido Final propagates
 * consistently without rewriting any quote text.
 */
function resolveConfirmedItem(item) {
  if (item && item.confirmed_alternative_id && Array.isArray(item.alternatives)) {
    const alt = item.alternatives.find(a => a.id === item.confirmed_alternative_id);
    if (alt) {
      return {
        brand: alt.brand || null,
        selling_price: alt.selling_price ?? null,
        isConfirmedAlternative: true,
        confirmedAltId: alt.id,
      };
    }
  }
  return {
    brand: (item && item.brand) || null,
    selling_price: (item && item.selling_price) ?? null,
    isConfirmedAlternative: false,
    confirmedAltId: null,
  };
}

/**
 * Phase 2 — when a confirmation exists, downstream blocks must not also
 * leak the OTHER alternatives into the output. This helper returns the
 * alternatives that should be rendered as "additional options" in the
 * customer Proforma:
 *   - confirmed → no extra options (customer already chose)
 *   - not confirmed → all alternatives (current behaviour)
 *
 * Used only by the customer-facing Proforma. Internal and supplier
 * blocks never render alternatives.
 */
function visibleAlternatives(item) {
  if (!item || !Array.isArray(item.alternatives)) return [];
  if (item.confirmed_alternative_id) return [];
  return item.alternatives;
}

/**
 * Punto 19 — append an optional per-block observation to the end of a
 * generated block. The note is rendered on its own paragraph prefixed
 * with 📝 so it stands out in WhatsApp / email pastes.
 *
 * If `note` is empty / null / whitespace, the block is returned
 * unchanged and behaves exactly as before this feature existed.
 *
 * Used by: customer Proforma, Control A/B, Pedido Final, and Pedido
 * por Proveedor (each supplier block carries the same note).
 */
function appendBlockNote(block, note) {
  if (!note) return block;
  const trimmed = String(note).trim();
  if (trimmed.length === 0) return block;
  return `${block}\n\n📝 ${trimmed}`;
}

/**
 * Detect seller_note segments that look like Modo Rápido alternative echoes
 * (e.g. "$55 ART", "44 NPR"). These must not appear in Pedido Final output.
 */
function isAlternativeEchoSegment(segment) {
  const s = (segment || '').trim();
  if (!s) return false;
  return /^\$?\d+([.,]\d+)?(\s+\S.*)?$/.test(s);
}

/**
 * Return the seller_note that should appear on Pedido Final lines.
 * Alternative echoes are stripped — only genuine free-text notes remain.
 */
function sellerNoteForPedidoBlock(item) {
  const note = item.seller_note || '';
  if (!note.trim()) return '';

  const hasStructuredAlts = Array.isArray(item.alternatives) && item.alternatives.length > 0;
  const segments = note.split(' / ').map(s => s.trim()).filter(Boolean);
  const kept = segments.filter(seg => !isAlternativeEchoSegment(seg));

  if (hasStructuredAlts) {
    return kept.join(' / ');
  }

  if (segments.length > 0 && segments.every(isAlternativeEchoSegment)) {
    return '';
  }

  return kept.join(' / ');
}

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
 * Generate Control A / Control B block (Punto 18)
 * Filters items by control_group flag (set in Modo Rápido during proforma elaboration).
 * Output is a clean copy/paste with only the lines assigned to the requested group.
 *
 * Example output for group A:
 *   🔴 A | K000717 | 0162
 *
 *   DAEWOO TACUMA CDX 2000cc (2002)
 *
 *   PISTÓN STD
 *   RIN STD
 */
export function generateControlAB(ticket, items, group, note = null) {
  const emoji = group === 'A' ? '🔴' : '🟢';
  const groupItems = (items || []).filter(i => i.control_group === group);

  const vehicleLine = formatVehicleInfo(ticket.vehicle_info);
  const vehicleStr = vehicleLine ? vehicleLine.toUpperCase() : '';
  const groupCode = ticket.group_code || '';
  const header = `${emoji} ${group} | ${ticket.k_number} | ${groupCode}`;

  if (groupItems.length === 0) {
    return appendBlockNote(`${header}\n\n${vehicleStr}\n\n(Sin líneas asignadas al Control ${group})`, note);
  }

  const itemLines = groupItems.map(item => {
    const desc = (item.parsed_description || item.raw_line || '').trim();
    const qty = (item.quantity || 1) > 1 ? ` x${item.quantity}` : '';
    return `${desc.toUpperCase()}${qty}`;
  }).join('\n');

  return appendBlockNote(`${header}\n\n${vehicleStr}\n\n${itemLines}`, note);
}

/**
 * Generate Customer Proforma block
 * Customer-facing, compact WhatsApp-ready layout
 */
export function generateCustomerProformaBlock(ticket, items, note = null) {
  // Compact vehicle info
  const vi = ticket.vehicle_info || {};
  const vehicleParts = [vi.marca, vi.modelo, shouldAppendCilindraje(vi.modelo, vi.cilindraje) ? vi.cilindraje : null, vi.anio ? `(${vi.anio})` : null]
    .filter(Boolean).join(' ');

  // Format date as DD/MM/YYYY
  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

  if (!items || items.length === 0) {
    return appendBlockNote([
      '📄 PROFORMA – DISTRIMIA S.A.',
      `N° ${ticket.k_number} | 📅 ${dateStr}`,
      vehicleParts ? `🚗 ${vehicleParts}` : null,
      '',
      'No hay artículos en este ticket.',
      '⚠️ Valores sujetos a variación sin previo aviso',
    ].filter(s => s !== null && s !== undefined).join('\n'), note);
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
    // Phase 2 — use confirmed alternative when set, otherwise primary.
    const resolved = resolveConfirmedItem(item);
    const brandPart = resolved.brand ? ` (${resolved.brand.toUpperCase()})` : '';
    const note = item.seller_note || '';
    // When confirmed, the other alternatives are hidden so the customer
    // sees only the option they actually chose.
    const alts = visibleAlternatives(item);

    if (resolved.selling_price) {
      const priceLine = `🟢 ${desc}${qty} — ${formatLinePrice(resolved.selling_price, item.quantity)}${brandPart}`;
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

    // Alternatives on separate lines (only when not yet confirmed)
    if (alts.length > 0) {
      for (const alt of alts) {
        const altPrice = alt.selling_price ? `USD ${formatUSDAmount(alt.selling_price)}` : '';
        const altBrand = alt.brand ? alt.brand.toUpperCase() : '';
        itemLines.push(`  • ${altPrice}${altBrand ? ` (${altBrand})` : ''}`);
      }
    }
  }

  // Verification items: 🟡 Producto — En verificación (or "— Con muestra" if MUESTRA detected)
  for (const item of verificationItems) {
    const desc = normalizeProductName(item.parsed_description || item.raw_line);
    const qty = item.quantity > 1 ? ` x${item.quantity}` : '';
    // Phase 2 — use confirmed alternative when set, otherwise primary.
    const resolved = resolveConfirmedItem(item);
    const brandPart = resolved.brand ? ` (${resolved.brand.toUpperCase()})` : '';
    const note = item.seller_note || '';
    const isMuestra = isMuestraNote(note);
    const tag = isMuestra ? 'Con muestra' : 'En verificación';
    // When the only thing the seller wrote is "MUESTRA", don't echo it back in the inline note
    const cleanedNote = isMuestra ? note.replace(/\bmuestras?\b/gi, '').replace(/\s+·\s+/g, ' · ').replace(/^[\s·]+|[\s·]+$/g, '') : note;

    if (resolved.selling_price) {
      const priceLine = `🟡 ${desc}${qty} — ${formatLinePrice(resolved.selling_price, item.quantity)}${brandPart} — ${tag}`;
      if (cleanedNote && cleanedNote.length <= 40) {
        itemLines.push(`${priceLine} | ${cleanedNote}`);
      } else {
        itemLines.push(priceLine);
        if (cleanedNote) itemLines.push(`   ${cleanedNote}`);
      }
    } else {
      itemLines.push(`🟡 ${desc}${qty} — ${tag}`);
      if (cleanedNote) itemLines.push(`   ${cleanedNote}`);
    }

    // Alternatives (only when not yet confirmed)
    const alts = visibleAlternatives(item);
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


  // Total only from positive items with price (use confirmed alt price when applicable)
  const positiveWithPrice = items.filter(i => i.status === 'positive' && resolveConfirmedItem(i).selling_price);
  const total = positiveWithPrice.reduce((sum, item) =>
    sum + (parseFloat(resolveConfirmedItem(item).selling_price) * (item.quantity || 1)), 0
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

  return appendBlockNote(sections.filter(s => s !== null && s !== undefined).join('\n'), note);
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
    // Phase 2 — internal block also honours the confirmed alternative
    // price so the margin reflects what is actually being sold.
    const resolved = resolveConfirmedItem(item);
    const cost = item.cost_price ? formatPrice(item.cost_price) : '---';
    const sell = resolved.selling_price ? formatPrice(resolved.selling_price) : '---';
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
  const totalSell = items.reduce((sum, i) => {
    const resolved = resolveConfirmedItem(i);
    return sum + (parseFloat(resolved.selling_price || 0) * (i.quantity || 1));
  }, 0);

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
      // Phase 2 — use confirmed alternative's selling price when set.
      const resolved = resolveConfirmedItem(item);
      const cost = item.cost_price ? formatPrice(item.cost_price) : '---';
      const sell = resolved.selling_price ? formatPrice(resolved.selling_price) : '---';
      const internalNote = item.internal_note ? `\n   📝 ${item.internal_note}` : '';
      return `${idx + 1}. ${item.parsed_description || item.raw_line}
   Costo: ${cost} | Venta: ${sell}
   Código Distrimia: ${item.codigo_distrimia || '---'}
   Código OEM: ${item.codigo_oem || '---'}
   Código Fábrica: ${item.codigo_fabrica || '---'}${internalNote}`;
    }).join('\n\n');

    const groupCost = sItems.reduce((sum, i) => sum + (parseFloat(i.cost_price || 0) * (i.quantity || 1)), 0);
    const groupSell = sItems.reduce((sum, i) => {
      const resolved = resolveConfirmedItem(i);
      return sum + (parseFloat(resolved.selling_price || 0) * (i.quantity || 1));
    }, 0);

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

/**
 * Generate Pedido Final block (client-facing confirmed order)
 * Shows only confirmed items (not excluded) with total
 */
export function generatePedidoFinalBlock(ticket, items, note = null) {
  const vi = ticket.vehicle_info || {};
  const vehicleParts = [vi.marca, vi.modelo, shouldAppendCilindraje(vi.modelo, vi.cilindraje) ? vi.cilindraje : null, vi.anio ? `(${vi.anio})` : null]
    .filter(Boolean).join(' ');

  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

  // Only confirmed items (not excluded)
  const confirmedItems = items.filter(i => !i.pedido_excluded && i.status === 'positive');
  const excludedCount = items.filter(i => i.pedido_excluded).length;

  if (confirmedItems.length === 0) {
    return appendBlockNote('✅ PEDIDO FINAL – DISTRIMIA S.A.\nNo hay líneas confirmadas en este pedido.', note);
  }

  const itemLines = confirmedItems.map((item, idx) => {
    const desc = normalizeProductName(item.parsed_description || item.raw_line);
    const qty = item.quantity > 1 ? ` x${item.quantity}` : '';
    // Phase 2 — confirmed alternative (if any) overrides primary brand/price.
    const resolved = resolveConfirmedItem(item);
    const brandPart = resolved.brand ? ` (${resolved.brand.toUpperCase()})` : '';
    const price = resolved.selling_price ? formatLinePrice(resolved.selling_price, item.quantity) : '---';
    const supplierPart = item.supplier_code ? ` | ${item.supplier_code}` : '';
    const codePart = item.codigo_distrimia || item.codigo_oem || '';
    const codeStr = codePart ? ` | Cód: ${codePart}` : '';
    const inlineNote = sellerNoteForPedidoBlock(item);
    const noteSuffix = inlineNote ? ` | ${inlineNote}` : '';
    return `${idx + 1}. ${desc}${qty} — ${price}${brandPart}${supplierPart}${codeStr}${noteSuffix}`;
  });

  const total = confirmedItems.reduce((sum, i) => {
    const resolved = resolveConfirmedItem(i);
    return sum + (parseFloat(resolved.selling_price || 0) * (i.quantity || 1));
  }, 0);

  const sections = [];
  sections.push('✅ PEDIDO FINAL – DISTRIMIA S.A.');
  sections.push(`N° ${ticket.k_number} | 📅 ${dateStr}`);
  if (vehicleParts) sections.push(`🚗 ${vehicleParts}`);
  sections.push('');
  sections.push(itemLines.join('\n'));
  sections.push('');
  sections.push(`💰 TOTAL PEDIDO: USD ${formatUSDAmount(total)}`);
  sections.push(`📦 ${confirmedItems.length} línea(s) confirmada(s)${excludedCount > 0 ? ` | ${excludedCount} no incluida(s)` : ''}`);
  sections.push('');

  if (ticket.assigned_to_user) {
    const advisorName = formatAdvisorName(ticket.assigned_to_user.full_name);
    sections.push(`👤 ${advisorName}`);
    sections.push('Asesor comercial');
  }

  sections.push('');
  sections.push('🤝 Quedamos atentos');

  return appendBlockNote(sections.join('\n'), note);
}

/**
 * Generate per-supplier Pedido blocks (supplier-facing copy/paste).
 *
 * Format requested by the client:
 *   - One line per confirmed item, format: "DESCRIPCIÓN (QTY)"
 *   - No numbering, no brand, no internal codes, no seller notes
 *     (supplier quotes by description and uses their own catalog).
 *   - Alternatives are NOT included — only the confirmed line per item.
 *     This is naturally enforced because we only iterate over `items`,
 *     never `item.alternatives`.
 *   - Subtotal (price) is intentionally OMITTED — that's internal info,
 *     never sent to suppliers.
 *   - Total article count is KEPT so the supplier can validate the
 *     order arrived complete.
 *   - Closing courtesy line at the bottom.
 *
 * Example output:
 *   📦 PEDIDO — JCC
 *   #K000524
 *   🚗 CHEVROLET ONIX LTZ TURBO AC 1.0 4P 4X2 TM (2022)
 *
 *   BUJÍAS (4)
 *   TEMPLADOR CADENA (2)
 *   BOMBA DE AGUA (1)
 *
 *   📦 3 artículos
 *
 *   🤝 Favor ayudarnos con la revisión y despacho de los artículos solicitados. Gracias.
 *
 * The `total` field is still returned in the API response (for internal
 * use by the frontend if it ever wants a per-supplier price summary)
 * but is not surfaced in the supplier-facing text.
 */
export function generatePedidoSupplierBlocks(ticket, items, note = null) {
  const vi = ticket.vehicle_info || {};
  const vehicleParts = [vi.marca, vi.modelo, shouldAppendCilindraje(vi.modelo, vi.cilindraje) ? vi.cilindraje : null, vi.anio ? `(${vi.anio})` : null]
    .filter(Boolean).join(' ');

  // Only confirmed positive items (no excluded, no negatives, no pending)
  const confirmedItems = items.filter(i => !i.pedido_excluded && i.status === 'positive');

  // Group by supplier
  const supplierGroups = {};
  confirmedItems.forEach(item => {
    const supplier = item.supplier_code || 'Sin proveedor';
    if (!supplierGroups[supplier]) supplierGroups[supplier] = [];
    supplierGroups[supplier].push(item);
  });

  const suppliers = Object.keys(supplierGroups);
  if (suppliers.length === 0) return [];

  const SUPPLIER_CLOSING = '🤝 Favor ayudarnos con la revisión y despacho de los artículos solicitados. Gracias.';

  return suppliers.map(supplier => {
    const sItems = supplierGroups[supplier];

    const itemLines = sItems.map(item => {
      const desc = normalizeProductName(item.parsed_description || item.raw_line).toUpperCase();
      const qty = item.quantity || 1;
      return `${desc} (${qty})`;
    });

    // Subtotal kept in API response (unused by UI today, but available)
    // — intentionally NOT rendered into the supplier-facing text. Uses
    // the confirmed-alternative price when set (Phase 2).
    const groupTotal = sItems.reduce((sum, i) => {
      const resolved = resolveConfirmedItem(i);
      return sum + (parseFloat(resolved.selling_price || 0) * (i.quantity || 1));
    }, 0);

    const articulosLabel = `📦 ${sItems.length} artículo${sItems.length === 1 ? '' : 's'}`;

    const content = appendBlockNote([
      `📦 PEDIDO — ${supplier.toUpperCase()}`,
      `#${ticket.k_number}`,
      vehicleParts ? `🚗 ${vehicleParts.toUpperCase()}` : null,
      '',
      itemLines.join('\n'),
      '',
      articulosLabel,
      '',
      SUPPLIER_CLOSING,
    ].filter(s => s !== null).join('\n'), note);

    return {
      supplier,
      item_count: sItems.length,
      total: groupTotal,
      content
    };
  });
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
 * Format the price segment for a proforma line.
 * - quantity <= 1 → "USD 30"
 * - quantity  > 1 → "USD 30 c/u = USD 60"
 * Makes it clear to the customer whether the price is unit or total.
 */
function formatLinePrice(unitPrice, quantity) {
  const qty = parseInt(quantity, 10) || 1;
  const unitStr = `USD ${formatUSDAmount(unitPrice)}`;
  if (qty <= 1) return unitStr;
  const total = parseFloat(unitPrice) * qty;
  return `${unitStr} c/u = USD ${formatUSDAmount(total)}`;
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
    // 🟡 (yellow circle) is used consistently across the proforma and the
    // Modo Rápido status dot for the "verification" state. Keep this aligned
    // so any block that emits a status emoji shows the same icon.
    'no_registra_verificar': '🟡'
  };
  return emojis[status] || '❓';
}

/**
 * Detect whether a seller-note tag means "this item is being sent as a sample
 * for verification". When true, the proforma renders "— Con muestra" instead
 * of "— En verificación" while keeping the same yellow 🟡 icon.
 *
 * Matches the literal word MUESTRA / MUESTRAS in any casing, so the seller
 * can write things like:
 *   "MUESTRA"            → 🟡 Bujía STD — Con muestra
 *   "MUESTRA TBK"        → 🟡 Bujía STD (TBK) — Con muestra
 *   "100 TBK MUESTRA"    → 🟡 Bujía STD — USD 100 (TBK) — Con muestra
 */
function isMuestraNote(note) {
  if (!note) return false;
  return /\bmuestras?\b/i.test(note);
}

export default {
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
  generatePedidoSupplierBlocks
};
