/**
 * Duplicate / coincidence detection service
 * Heavy analysis runs on-demand (Ver coincidencias, Comparar, Buscar referencias).
 */

import { supabaseAdmin } from '../config/supabase.js';

export const LINE_MATCH_THRESHOLD = 0.4;

const STOP_WORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'para', 'por', 'con', 'en', 'y', 'o', 'a', 'al', 'se', 'su', 'que',
  'es', 'lo', 'como', 'más', 'mas', 'no', 'si', 'me', 'mi', 'te',
  'necesito', 'necesita', 'busco', 'busca', 'requiero', 'requiere',
  'quiero', 'favor', 'por favor', 'urgente', 'rapido', 'rápido',
]);

/**
 * Equivalent terms collapsed to a single canonical form before comparison.
 * Each KEY (variant, already accent-stripped and lowercased) maps to a VALUE
 * (canonical token). Add equivalences as the client identifies them.
 *
 *   Example: "Chaquetas de bancada +10" and "Chapa bancada 010" describe
 *   the same crankshaft bearing — without this map only "bancada" matches
 *   and the line falls below the duplicate threshold.
 *
 * To extend: add `'variant': 'canonical'` entries. Variants must be
 * single tokens (no spaces); for multi-word equivalences pre-process the
 * raw text instead.
 */
const PART_SYNONYMS = {
  // Crankshaft / connecting-rod bearings
  'chaqueta': 'chapa',
  'chaquetas': 'chapa',
  'chapas': 'chapa',
  'chapeta': 'chapa',
  'chapetas': 'chapa',
};

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normalize a number token so that measure variants compare equal.
 * Examples: "+10" → "10", "010" → "10", "020" → "20", "0" → "0".
 * Years (19xx/20xx) are detected separately and bypass this normalization.
 */
function normalizeMeasureNumber(token) {
  const stripped = token.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

export function normalizeForComparison(text) {
  if (!text) return { allTokens: [], yearTokens: [], numberTokens: [], partTokens: [], oemTokens: [] };

  let normalized = stripAccents(text.toLowerCase().trim());
  const oemCodes = [];
  normalized = normalized.replace(/\b([a-z0-9]{2,}(?:-[a-z0-9]{2,})+)\b/g, (match) => {
    oemCodes.push(match);
    return ' ';
  });

  normalized = normalized
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const rawWords = normalized.split(' ').filter(w => w.length >= 2 && !STOP_WORDS.has(w));
  // Canonicalize known synonyms (chaqueta/chapa, etc.) before tokenizing.
  const words = rawWords.map(w => PART_SYNONYMS[w] || w);
  const yearTokens = [];
  const numberTokens = [];
  const partTokens = [];

  for (const w of words) {
    if (/^(19|20)\d{2}$/.test(w)) yearTokens.push(w);
    else if (/^\d+$/.test(w)) numberTokens.push(normalizeMeasureNumber(w));
    else partTokens.push(w);
  }

  return { allTokens: [...words, ...oemCodes], yearTokens, numberTokens, partTokens, oemTokens: oemCodes };
}

function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[b.length][a.length];
}

function fuzzyMatch(a, b) {
  if (a.length < 4 || b.length < 4) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  if (a.length >= 5 && b.length >= 5) return levenshteinDistance(a, b) <= 2;
  return false;
}

export function tokenSetSimilarity(ts1, ts2) {
  if (ts1.allTokens.length === 0 && ts2.allTokens.length === 0) return 1;
  if (ts1.allTokens.length === 0 || ts2.allTokens.length === 0) return 0;

  let weightedIntersection = 0;
  let weightedUnion = 0;

  const oemSet1 = new Set(ts1.oemTokens || []);
  const oemSet2 = new Set(ts2.oemTokens || []);
  const OEM_WEIGHT = 3.0;
  for (const code of oemSet1) {
    weightedUnion += OEM_WEIGHT;
    if (oemSet2.has(code)) weightedIntersection += OEM_WEIGHT;
  }
  for (const code of oemSet2) {
    if (!oemSet1.has(code)) weightedUnion += OEM_WEIGHT;
  }

  const partSet1 = new Set(ts1.partTokens || []);
  const partSet2 = new Set(ts2.partTokens || []);
  const PART_WEIGHT = 1.0;
  for (const t of partSet1) {
    weightedUnion += PART_WEIGHT;
    if (partSet2.has(t)) weightedIntersection += PART_WEIGHT;
  }
  for (const t of partSet2) {
    if (!partSet1.has(t)) weightedUnion += PART_WEIGHT;
  }

  const numSet1 = new Set(ts1.numberTokens || []);
  const numSet2 = new Set(ts2.numberTokens || []);
  const NUM_WEIGHT = 0.3;
  for (const t of numSet1) {
    weightedUnion += NUM_WEIGHT;
    if (numSet2.has(t)) weightedIntersection += NUM_WEIGHT;
  }
  for (const t of numSet2) {
    if (!numSet1.has(t)) weightedUnion += NUM_WEIGHT;
  }

  const baseScore = weightedUnion > 0 ? weightedIntersection / weightedUnion : 0;

  let fuzzyBonus = 0;
  const unmatchedParts1 = ts1.partTokens.filter(t => !partSet2.has(t));
  for (const token of unmatchedParts1) {
    for (const token2 of ts2.partTokens) {
      if (!partSet1.has(token2) && fuzzyMatch(token, token2)) {
        fuzzyBonus += 0.5;
        break;
      }
    }
  }
  const fuzzyScore = ts1.partTokens.length > 0
    ? fuzzyBonus / Math.max(ts1.partTokens.length, ts2.partTokens.length, 1)
    : 0;

  const yearMatch = ts1.yearTokens.length > 0 && ts2.yearTokens.length > 0 &&
    ts1.yearTokens.some(y => ts2.yearTokens.includes(y));

  return Math.min(1.0, baseScore + fuzzyScore * 0.15 + (yearMatch ? 0.1 : 0));
}

export function compareVehicles(vehicleA, vehicleB) {
  const hasA = vehicleA && Object.values(vehicleA).some(Boolean);
  const hasB = vehicleB && Object.values(vehicleB).some(Boolean);
  if (!hasA && !hasB) return { match: true, confidence: 'unknown' };
  if (!hasA || !hasB) return { match: true, confidence: 'unknown' };

  const norm = (s) => s ? stripAccents(s.toLowerCase().trim()) : '';
  const marcaA = norm(vehicleA.marca);
  const marcaB = norm(vehicleB.marca);
  const modelA = norm(vehicleA.modelo);
  const modelB = norm(vehicleB.modelo);
  const anioA = norm(vehicleA.anio);
  const anioB = norm(vehicleB.anio);
  const cilA = norm(vehicleA.cilindraje);
  const cilB = norm(vehicleB.cilindraje);
  const motorA = norm(vehicleA.motor);
  const motorB = norm(vehicleB.motor);
  const placaA = norm(vehicleA.placa);
  const placaB = norm(vehicleB.placa);
  const chasisA = norm(vehicleA.chasis);
  const chasisB = norm(vehicleB.chasis);

  if (marcaA && marcaB && marcaA !== marcaB) return { match: false, confidence: 'different' };
  if (anioA && anioB && anioA !== anioB) return { match: false, confidence: 'different' };
  if (motorA && motorB && motorA !== motorB) return { match: false, confidence: 'different' };
  if (placaA && placaB && placaA !== placaB) return { match: false, confidence: 'different' };
  if (chasisA && chasisB && chasisA !== chasisB) return { match: false, confidence: 'different' };

  if (modelA && modelB && modelA === modelB) {
    if (cilA && cilB && cilA !== cilB) return { match: false, confidence: 'different' };
  }
  if (modelA && modelB && modelA !== modelB) return { match: false, confidence: 'different' };
  if (cilA && cilB && cilA !== cilB) return { match: false, confidence: 'different' };

  const marcaMatch = marcaA && marcaB && marcaA === marcaB;
  const modelMatch = modelA && modelB && modelA === modelB;
  if (marcaMatch || modelMatch) {
    if (cilA && cilB) return { match: true, confidence: 'same' };
    return { match: true, confidence: 'compatible' };
  }
  return { match: true, confidence: 'compatible' };
}

function classifyDuplicateLabel(existingTicket, existingItems) {
  const hasPositiveItem = existingItems.some(i =>
    i.status === 'positive' && (i.selling_price || i.brand || i.validity_status === 'vigente')
  );
  if (hasPositiveItem || existingTicket.status === 'ready') return 'dup_positive';

  const allNegative = existingItems.length > 0 && existingItems.every(i =>
    i.status === 'negative' || i.status === 'no_registra'
  );
  if (allNegative || existingTicket.status === 'closed' || existingTicket.status === 'cancelled') {
    return 'dup_negative';
  }
  return 'dup_neutral';
}

export function formatVehicleDisplay(vehicleInfo) {
  if (!vehicleInfo) return 'Sin información de vehículo';
  const parts = [
    vehicleInfo.marca,
    vehicleInfo.modelo,
    vehicleInfo.cilindraje,
    vehicleInfo.anio ? `(${vehicleInfo.anio})` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'Sin información de vehículo';
}

export function formatQuoteDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function findBestSourceMatch(targetItem, sourceItems, usedSourceIds = new Set()) {
  const targetTS = normalizeForComparison(targetItem.parsed_description || targetItem.raw_line || '');
  let bestMatch = null;
  let bestScore = 0;

  for (const srcItem of sourceItems) {
    if (usedSourceIds.has(srcItem.id)) continue;
    const srcTS = normalizeForComparison(srcItem.parsed_description || srcItem.raw_line || '');
    const score = tokenSetSimilarity(targetTS, srcTS);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = srcItem;
    }
  }

  return { sourceItem: bestMatch, score: bestScore };
}

export function computeLineMatchStats(targetItems, sourceItems) {
  const totalLines = targetItems.length;
  if (totalLines === 0) {
    return { matching_lines: 0, total_lines: 0, match_percent: 0 };
  }

  const usedSourceIds = new Set();
  let matchingLines = 0;

  for (const targetItem of targetItems) {
    const { sourceItem, score } = findBestSourceMatch(targetItem, sourceItems, usedSourceIds);
    if (sourceItem && score >= LINE_MATCH_THRESHOLD) {
      matchingLines++;
      usedSourceIds.add(sourceItem.id);
    }
  }

  return {
    matching_lines: matchingLines,
    total_lines: totalLines,
    match_percent: Math.round((matchingLines / totalLines) * 100),
  };
}

export function buildCompareLines(targetItems, sourceItems) {
  const usedSourceIds = new Set();

  return targetItems.map((targetItem) => {
    const description = targetItem.parsed_description || targetItem.raw_line || '';
    const { sourceItem, score } = findBestSourceMatch(targetItem, sourceItems, usedSourceIds);
    const matched = !!(sourceItem && score >= LINE_MATCH_THRESHOLD);

    if (matched && sourceItem) usedSourceIds.add(sourceItem.id);

    return {
      target_item_id: targetItem.id,
      target_description: description,
      source_item_id: matched ? sourceItem.id : null,
      source_description: matched ? (sourceItem.parsed_description || sourceItem.raw_line || '') : null,
      // Extra fields from the matched source line so the seller can validate
      // price / brand / status / quantity before clicking "Copiar seleccionadas"
      // without having to open the origin ticket.
      source_selling_price: matched ? (sourceItem.selling_price ?? null) : null,
      source_brand: matched ? (sourceItem.brand ?? null) : null,
      source_status: matched ? (sourceItem.status ?? null) : null,
      source_validity_status: matched ? (sourceItem.validity_status ?? null) : null,
      source_quantity: matched ? (sourceItem.quantity ?? null) : null,
      matched,
      score: Math.round(score * 100),
      selected: matched,
    };
  });
}

async function loadTicketWithItems(ticketId) {
  const { data: ticket, error } = await supabaseAdmin
    .from('tickets')
    .select('id, k_number, group_code, raw_text, status, priority, item_count, created_at, vehicle_info, assigned_to')
    .eq('id', ticketId)
    .single();
  if (error || !ticket) return null;

  const { data: items } = await supabaseAdmin
    .from('ticket_items')
    .select('id, item_order, parsed_description, raw_line, status, selling_price, brand, validity_status, quantity, cost_price, supplier_code, codigo_distrimia, codigo_oem, seller_note, estimated_delivery, source')
    .eq('ticket_id', ticketId)
    .order('item_order', { ascending: true });

  return { ticket, items: items || [] };
}

async function loadCandidateTickets(candidateIds) {
  if (!candidateIds.length) return [];

  const { data: tickets } = await supabaseAdmin
    .from('tickets')
    .select('id, k_number, group_code, raw_text, status, priority, item_count, created_at, vehicle_info, assigned_to')
    .in('id', candidateIds);

  const { data: allItems } = await supabaseAdmin
    .from('ticket_items')
    .select('ticket_id, id, item_order, parsed_description, raw_line, status, selling_price, brand, validity_status')
    .in('ticket_id', candidateIds);

  const itemsByTicket = {};
  (allItems || []).forEach(item => {
    if (!itemsByTicket[item.ticket_id]) itemsByTicket[item.ticket_id] = [];
    itemsByTicket[item.ticket_id].push(item);
  });

  return (tickets || []).map(t => ({
    ticket: t,
    items: itemsByTicket[t.id] || [],
  }));
}

function enrichCoincidenceEntry(targetItems, candidate, storedMeta = {}) {
  const stats = computeLineMatchStats(targetItems, candidate.items);
  return {
    ticket_id: candidate.ticket.id,
    k_number: candidate.ticket.k_number,
    group_code: candidate.ticket.group_code,
    status: candidate.ticket.status,
    vehicle_display: formatVehicleDisplay(candidate.ticket.vehicle_info),
    vehicle_info: candidate.ticket.vehicle_info,
    quote_date: formatQuoteDate(candidate.ticket.created_at),
    created_at: candidate.ticket.created_at,
    matching_lines: stats.matching_lines,
    total_lines: stats.total_lines,
    match_percent: stats.match_percent,
    similarity: storedMeta.similarity ?? stats.match_percent / 100,
    label: storedMeta.label || classifyDuplicateLabel(candidate.ticket, candidate.items),
  };
}

async function getStoredCandidateIds(ticketId) {
  const ids = new Set();

  const { data: forward } = await supabaseAdmin
    .from('duplicate_references')
    .select('duplicate_ticket_id, similarity_score, label')
    .eq('ticket_id', ticketId);

  const meta = {};
  (forward || []).forEach(row => {
    ids.add(row.duplicate_ticket_id);
    meta[row.duplicate_ticket_id] = {
      similarity: (row.similarity_score || 0) / 100,
      label: row.label,
    };
  });

  const { data: reverse } = await supabaseAdmin
    .from('duplicate_references')
    .select('ticket_id, similarity_score, label')
    .eq('duplicate_ticket_id', ticketId);

  (reverse || []).forEach(row => {
    if (!ids.has(row.ticket_id)) {
      ids.add(row.ticket_id);
      meta[row.ticket_id] = {
        similarity: (row.similarity_score || 0) / 100,
        label: row.label,
      };
    }
  });

  return { ids: [...ids], meta };
}

export async function getCoincidenceCountsForTickets(ticketIds) {
  if (!ticketIds.length) return {};

  const counts = {};
  ticketIds.forEach(id => { counts[id] = 0; });

  const { data: forward } = await supabaseAdmin
    .from('duplicate_references')
    .select('ticket_id')
    .in('ticket_id', ticketIds);

  (forward || []).forEach(row => {
    if (counts[row.ticket_id] !== undefined) counts[row.ticket_id]++;
  });

  const { data: reverse } = await supabaseAdmin
    .from('duplicate_references')
    .select('duplicate_ticket_id')
    .in('duplicate_ticket_id', ticketIds);

  (reverse || []).forEach(row => {
    if (counts[row.duplicate_ticket_id] !== undefined) counts[row.duplicate_ticket_id]++;
  });

  return counts;
}

export async function getCoincidencesDetail(ticketId) {
  const target = await loadTicketWithItems(ticketId);
  if (!target) return null;

  let { ids, meta } = await getStoredCandidateIds(ticketId);

  if (ids.length === 0) {
    const live = await findDuplicates({
      items: target.items.map(i => ({
        description: i.parsed_description,
        raw_line: i.raw_line,
      })),
      raw_text: target.ticket.raw_text,
      vehicle_info: target.ticket.vehicle_info,
    }, target.ticket.group_code);

    ids = live.map(d => d.ticket.id).filter(id => id !== ticketId);
    live.forEach(d => {
      meta[d.ticket.id] = { similarity: d.similarity, label: d.label };
    });
  }

  ids = ids.filter(id => id !== ticketId);
  const candidates = await loadCandidateTickets(ids);

  const coincidences = candidates
    .map(c => enrichCoincidenceEntry(target.items, c, meta[c.ticket.id] || {}))
    .sort((a, b) => b.match_percent - a.match_percent || b.matching_lines - a.matching_lines);

  return {
    ticket_id: ticketId,
    k_number: target.ticket.k_number,
    total_lines: target.items.length,
    count: coincidences.length,
    coincidences,
  };
}

export async function compareCoincidences(ticketId, sourceId) {
  const target = await loadTicketWithItems(ticketId);
  const source = await loadTicketWithItems(sourceId);
  if (!target || !source) return null;

  const lines = buildCompareLines(target.items, source.items);
  const stats = computeLineMatchStats(target.items, source.items);

  return {
    target: {
      ticket_id: target.ticket.id,
      k_number: target.ticket.k_number,
    },
    source: {
      ticket_id: source.ticket.id,
      k_number: source.ticket.k_number,
      vehicle_display: formatVehicleDisplay(source.ticket.vehicle_info),
      quote_date: formatQuoteDate(source.ticket.created_at),
    },
    matching_lines: stats.matching_lines,
    total_lines: stats.total_lines,
    match_percent: stats.match_percent,
    lines,
  };
}

/**
 * Tokenize a free-text string into searchable words.
 * Lower-cases, strips accents, splits on any non-alphanumeric.
 * Examples:
 *   "KIA RIO 1.4"         → ["kia", "rio", "1", "4"]
 *   "K000867"             → ["k000867"]
 *   "Hyundai-Elantra"     → ["hyundai", "elantra"]
 */
function tokenizeForSearch(text) {
  if (!text) return [];
  return stripAccents(String(text).toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Reference search.
 *
 * Searched fields (all vehicle identification + the ticket k_number):
 *   - k_number
 *   - vehicle_info.marca, modelo, anio, cilindraje
 *   - vehicle_info.placa, chasis, motor, serie
 *   - top-level ticket.vin
 *
 * Raw WhatsApp text, customer names and item descriptions are intentionally
 * excluded — searching "RIO" must NOT match tickets where the substring
 * appears in common words of the body (BARRIO, PRIORIDAD, PROPIETARIO).
 *
 * Two matching strategies are combined per query token:
 *
 *   1. WORD match (preferred): the token must equal a full word in one of
 *      the fields above. So "RIO" matches "KIA RIO" but not "BARRIO".
 *
 *   2. SERIAL substring match (for tokens of length ≥ 3): the token may
 *      appear anywhere inside a "serial-style" identifier field
 *      (motor, chasis, vin, placa, serie, k_number, group_code). This
 *      lets sellers search by partial engine/chassis codes:
 *        "HR16"        → matches motor "HR16842380M"
 *        "PDX"         → matches placa "PDX1148"
 *        "KLPGBB1A6"   → matches chasis "KLPGBB1A6JE048256"
 *
 * Multi-word queries are AND-combined: every query token must match by
 * one of the two strategies. So "versa hr16" requires both "versa" and
 * "hr16" to be found (in any field, by either word or serial-substring).
 */
export async function searchReferences(ticketId, query) {
  const target = await loadTicketWithItems(ticketId);
  if (!target) return null;

  const q = (query || '').trim();
  if (!q) return { query: q, count: 0, results: [] };

  const queryTokens = tokenizeForSearch(q);
  if (queryTokens.length === 0) return { query: q, count: 0, results: [] };

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const { data: tickets, error } = await supabaseAdmin
    .from('tickets')
    .select('id, k_number, group_code, status, created_at, vehicle_info, vin')
    .neq('id', ticketId)
    .eq('is_merged', false)
    .gte('created_at', ninetyDaysAgo.toISOString())
    .order('created_at', { ascending: false })
    .limit(400);

  if (error) throw error;

  const filtered = (tickets || []).filter(t => {
    const vi = t.vehicle_info || {};

    // Whole-word tokens from every identification field (descriptive
    // fields like marca/modelo/anio + serial fields like motor/chasis).
    // Lets exact-word queries like "VERSA" or "HR16842380M" match
    // immediately when typed in full.
    const wordTokens = new Set([
      ...tokenizeForSearch(t.k_number),
      ...tokenizeForSearch(t.group_code),
      ...tokenizeForSearch(vi.marca),
      ...tokenizeForSearch(vi.modelo),
      ...tokenizeForSearch(vi.anio),
      ...tokenizeForSearch(vi.cilindraje),
      ...tokenizeForSearch(vi.placa),
      ...tokenizeForSearch(vi.chasis),
      ...tokenizeForSearch(vi.motor),
      ...tokenizeForSearch(vi.serie),
      ...tokenizeForSearch(t.vin),
    ]);

    // Concatenated, lowercased, accent-stripped blob of ONLY the long
    // alphanumeric identifier fields. Used for partial / prefix matching
    // (e.g. "HR16" inside "HR16842380M") without re-introducing the
    // false positives we'd get from substring-matching the WhatsApp body.
    const serialBlob = stripAccents(
      [t.k_number, t.group_code, vi.placa, vi.chasis, vi.motor, vi.serie, t.vin]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
    );

    // Each query token must match SOMEWHERE: as a whole word in any
    // identification field, or (for tokens of length ≥ 3, to avoid
    // noisy 1–2 char matches) as a substring of the serial blob.
    return queryTokens.every(qt => {
      if (wordTokens.has(qt)) return true;
      if (qt.length >= 3 && serialBlob.includes(qt)) return true;
      return false;
    });
  }).slice(0, 50);

  const candidateIds = filtered.map(t => t.id);
  const candidates = await loadCandidateTickets(candidateIds);

  const results = candidates
    .map(c => enrichCoincidenceEntry(target.items, c))
    .sort((a, b) => b.match_percent - a.match_percent || new Date(b.created_at) - new Date(a.created_at));

  return {
    query: q,
    count: results.length,
    results,
  };
}

export async function copySelectedItems(targetId, sourceId, mappings, userId) {
  const target = await loadTicketWithItems(targetId);
  const source = await loadTicketWithItems(sourceId);
  if (!target || !source) {
    return { error: 'NOT_FOUND', message: 'Ticket no encontrado' };
  }

  const sourceById = Object.fromEntries(source.items.map(i => [i.id, i]));
  const targetById = Object.fromEntries(target.items.map(i => [i.id, i]));
  const updatedItems = [];

  for (const map of mappings) {
    const targetItem = targetById[map.target_item_id];
    const sourceItem = sourceById[map.source_item_id];
    if (!targetItem || !sourceItem) continue;

    const updateData = {};
    if (sourceItem.status && sourceItem.status !== 'pending_info') updateData.status = sourceItem.status;
    if (sourceItem.source) updateData.source = sourceItem.source;
    if (sourceItem.selling_price != null) updateData.selling_price = sourceItem.selling_price;
    if (sourceItem.cost_price != null) updateData.cost_price = sourceItem.cost_price;
    if (sourceItem.supplier_code) updateData.supplier_code = sourceItem.supplier_code;
    if (sourceItem.brand) updateData.brand = sourceItem.brand;
    if (sourceItem.codigo_distrimia) updateData.codigo_distrimia = sourceItem.codigo_distrimia;
    if (sourceItem.codigo_oem) updateData.codigo_oem = sourceItem.codigo_oem;
    if (sourceItem.seller_note) updateData.seller_note = sourceItem.seller_note;
    if (sourceItem.estimated_delivery) updateData.estimated_delivery = sourceItem.estimated_delivery;
    if (sourceItem.quantity != null) updateData.quantity = sourceItem.quantity;
    updateData.updated_at = new Date().toISOString();

    const { data: updated, error } = await supabaseAdmin
      .from('ticket_items')
      .update(updateData)
      .eq('id', targetItem.id)
      .eq('ticket_id', targetId)
      .select()
      .single();

    if (!error && updated) {
      updatedItems.push(updated);

      const { data: sourceAlts } = await supabaseAdmin
        .from('ticket_item_alternatives')
        .select('*')
        .eq('ticket_item_id', sourceItem.id);

      if (sourceAlts?.length) {
        await supabaseAdmin.from('ticket_item_alternatives').delete().eq('ticket_item_id', targetItem.id);
        await supabaseAdmin.from('ticket_item_alternatives').insert(
          sourceAlts.map(alt => ({
            ticket_item_id: targetItem.id,
            brand: alt.brand,
            selling_price: alt.selling_price,
            cost_price: alt.cost_price,
            source: alt.source,
            supplier_code: alt.supplier_code,
            estimated_delivery: alt.estimated_delivery,
            notes: alt.notes,
          }))
        );
      }
    }
  }

  await supabaseAdmin.from('audit_log').insert({
    entity_type: 'ticket',
    entity_id: targetId,
    action: 'copy_selected_coincidences',
    new_values: {
      source_ticket_id: sourceId,
      source_k_number: source.ticket.k_number,
      items_copied: updatedItems.length,
    },
    performed_by: userId,
  });

  return {
    items_updated: updatedItems.length,
    items: updatedItems,
    message: `Se copiaron ${updatedItems.length} línea(s) desde #${source.ticket.k_number}`,
  };
}

export async function findDuplicates(ticketData, groupCode) {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: recentTickets, error } = await supabaseAdmin
      .from('tickets')
      .select(`
        id, k_number, group_code, raw_text, status, priority, item_count,
        created_at, sla_exceeded, vehicle_info, assigned_to
      `)
      .gte('created_at', thirtyDaysAgo.toISOString())
      .not('status', 'eq', 'en_revision')
      .order('created_at', { ascending: false })
      .limit(300);

    if (error || !recentTickets?.length) return [];

    const recentIds = recentTickets.map(t => t.id);
    const { data: recentItems } = await supabaseAdmin
      .from('ticket_items')
      .select('ticket_id, parsed_description, raw_line, status, selling_price, brand, validity_status')
      .in('ticket_id', recentIds);

    const itemsByTicket = {};
    (recentItems || []).forEach(item => {
      if (!itemsByTicket[item.ticket_id]) itemsByTicket[item.ticket_id] = [];
      itemsByTicket[item.ticket_id].push(item);
    });

    const newItemTokenSets = (ticketData.items || [])
      .map(i => normalizeForComparison(i.description || i.raw_line || ''))
      .filter(ts => ts.allTokens.length > 0);

    const newRawTokens = normalizeForComparison(ticketData.raw_text || '');
    if (newItemTokenSets.length === 0 && newRawTokens.allTokens.length === 0) return [];

    const newVehicle = ticketData.vehicle_info || null;
    const duplicates = [];

    for (const existing of recentTickets) {
      const vehicleResult = compareVehicles(newVehicle, existing.vehicle_info);
      if (!vehicleResult.match) continue;

      const existingItems = itemsByTicket[existing.id] || [];
      const existingTokenSets = existingItems
        .map(i => normalizeForComparison(i.parsed_description || i.raw_line || ''))
        .filter(ts => ts.allTokens.length > 0);

      let itemSimilarity = 0;
      if (newItemTokenSets.length > 0 && existingTokenSets.length > 0) {
        let totalScore = 0;
        for (const newTS of newItemTokenSets) {
          let bestMatch = 0;
          for (const existTS of existingTokenSets) {
            bestMatch = Math.max(bestMatch, tokenSetSimilarity(newTS, existTS));
          }
          totalScore += bestMatch;
        }
        itemSimilarity = totalScore / newItemTokenSets.length;
      }

      let rawTextSimilarity = 0;
      if (existing.raw_text && newRawTokens.allTokens.length > 0) {
        const existingRawTokens = normalizeForComparison(existing.raw_text);
        if (existingRawTokens.allTokens.length > 0) {
          rawTextSimilarity = tokenSetSimilarity(newRawTokens, existingRawTokens);
        }
      }

      let similarity = Math.max(itemSimilarity, rawTextSimilarity);
      if (vehicleResult.confidence === 'same') {
        similarity = Math.min(1.0, similarity * 1.25 + 0.1);
      }

      const threshold = vehicleResult.confidence === 'unknown' ? 0.8 : 0.5;
      if (similarity >= threshold) {
        duplicates.push({
          ticket: existing,
          similarity: Math.round(similarity * 100) / 100,
          label: classifyDuplicateLabel(existing, existingItems),
        });
      }
    }

    const labelOrder = { dup_positive: 0, dup_neutral: 1, dup_negative: 2 };
    duplicates.sort((a, b) => {
      const orderDiff = (labelOrder[a.label] ?? 1) - (labelOrder[b.label] ?? 1);
      return orderDiff !== 0 ? orderDiff : b.similarity - a.similarity;
    });

    return duplicates.slice(0, 10);
  } catch (err) {
    console.error('Duplicate detection error:', err);
    return [];
  }
}

export default {
  findDuplicates,
  getCoincidenceCountsForTickets,
  getCoincidencesDetail,
  compareCoincidences,
  searchReferences,
  copySelectedItems,
  formatVehicleDisplay,
  computeLineMatchStats,
  buildCompareLines,
  compareVehicles,
  tokenSetSimilarity,
};
