import openai, { OPENAI_MODEL } from '../config/openai.js';
import { consolidateMatriculaAnio } from './mediaProcessor.js';
import { mergeVehicleInfoWithModelBase, detectVehicleFromModelBase } from './modelBaseMatcher.js';

/**
 * AI-powered ticket parser service
 * Parses raw WhatsApp text and extracts structured ticket data
 */

const PARSER_SYSTEM_PROMPT = `You are a specialized parser for auto parts requests from WhatsApp messages.
Your task is to analyze raw text and extract part requests.

LANGUAGE RULE:
- NEVER translate item descriptions. Keep them EXACTLY as written in the original message (usually Spanish).
- "Rotula" must stay "Rotula", NOT "Patella". "Bomba de agua" must stay "Bomba de agua", NOT "Water pump".
- "Terminales" must stay "Terminales", NOT "Terminals".

CRITICAL RULES:
1. A single message from one person is ALWAYS ONE ticket with multiple items. Do NOT split numbered items into separate tickets.
2. Only create MULTIPLE tickets if the text clearly contains requests from DIFFERENT people or completely unrelated contexts.
3. Each numbered line (e.g. "1 filtro de aceite", "2 pastillas de freno") is an ITEM within the SAME ticket.
4. Greetings, signatures, and filler text (e.g. "Buenas tardes", "Gracias") should be ignored as items.
5. Extract VIN/plate numbers if present (they look like license plates or 17-character VINs)
6. Set priority based on urgency keywords
7. ALWAYS extract vehicle information if present: marca (brand), modelo (model), año (year), placa (license plate), chasis (chassis/VIN), motor (engine type), cilindraje (engine displacement cc/L)
8. The FIRST LINE is almost always the VEHICLE, not a part. Analyze it carefully before treating it as an item.

VEHICLE DETECTION RULES:
- CRITICAL: The FIRST LINE of the message is very often the vehicle model/brand, NOT a part item. DO NOT treat it as an item.
  Example: "SAIL 1500\nRotula\nTerminales" → vehicle_info.modelo="SAIL 1500", items=[Rotula, Terminales]
  Example: "COROLLA 1.8 XEI 2020\nBomba de aceite\nFiltro" → vehicle_info.modelo="COROLLA 1.8 XEI", vehicle_info.anio="2020", items=[Bomba de aceite, Filtro]
  Example: "NUEVO MAZDA3 AC 2.0 4P 4X2 TM\nRotula\nBomba de agua" → vehicle_info.modelo="NUEVO MAZDA3 AC 2.0 4P 4X2 TM", items=[Rotula, Bomba de agua]
  Example: "LUV 2.5 2004\nCIGÜEÑAL\nCAMISAS\nPISTONES" → vehicle_info.marca="CHEVROLET", vehicle_info.modelo="LUV", vehicle_info.cilindraje="2500cc", vehicle_info.anio="2004", items=[CIGÜEÑAL, CAMISAS, PISTONES]
  Example: "santa fe 2.4 2015\njuego de chaquetas biela y de bancada" → vehicle_info.marca="HYUNDAI", vehicle_info.modelo="SANTA FE", vehicle_info.cilindraje="2400cc", vehicle_info.anio="2015", items=[juego de chaquetas biela y de bancada]
  Example: "montero 3.0 2008 Kit completo de distribución\nBomba de agua" → vehicle_info.marca="MITSUBISHI", vehicle_info.modelo="MONTERO", vehicle_info.cilindraje="3000cc", vehicle_info.anio="2008", items=[Kit completo de distribución, Bomba de agua] — the vehicle prefix on line 1 is NOT an item
- CRITICAL: Scan the ENTIRE text for vehicle info, not just the first line. Vehicle info can be embedded in sentences.
  Example: "TAL VEZ PARA EL PICANTO G4LA 2018 PISTONES +20" → vehicle_info.marca="KIA", vehicle_info.modelo="PICANTO G4LA", vehicle_info.anio="2018", items=[PISTONES +20]
  Example: "para el CIVIC 2019 bomba de agua" → vehicle_info.marca="HONDA", vehicle_info.modelo="CIVIC", vehicle_info.anio="2019", items=[bomba de agua]
- Also detect when vehicle info appears with "Modelo:", "Marca:", "Cilindraje:" labels (from image extraction):
  Example: "Modelo: SAIL 1500\nMarca: CHEVROLET\nCilindraje: 1500\nBomba de agua" → extract vehicle_info from labeled fields, items=[Bomba de agua]
- CRITICAL: Ecuador "Revisión Técnica Vehicular" and matrícula documents use NUMBERED FIELDS like:
  "01 Placa Actual GPZ0404", "02 Marca MAZDA", "03 Modelo MAZDA3 SEDAN 1.6 MT FL", "04 Año Fabricación 2008", "06 Cilindraje 1600", "12 Motor N° Z6567167", "16 Chasis PFCBK26880103575"
  → When you see numbered field labels (01, 02, 03, etc.) followed by field names (Marca, Modelo, Año, Cilindraje, Motor, Chasis, Placa), these are ALL vehicle information, NOT product items. Extract them into vehicle_info.
  Example: "02 Marca MAZDA\n03 Modelo MAZDA3 SEDAN 1.6 MT FL\n04 Año Fabricación 2008\n06 Cilindraje 1600" → vehicle_info.marca="MAZDA", vehicle_info.modelo="MAZDA3 SEDAN 1.6 MT FL", vehicle_info.anio="2008", vehicle_info.cilindraje="1600cc"
- CRITICAL: "Año Fabricación" in Ecuador documents = the vehicle year. Use this for vehicle_info.anio.
- ECUADOR MATRÍCULA / DOCUMENTO VEHICULAR: If the text has BOTH "Año modelo" / "AÑO MODELO" and a separate "Año:" / "AÑO" (without "modelo"), vehicle_info.anio MUST be the value from AÑO MODELO / año modelo (technical model year), NEVER the registration-only year. Example: "Año: 2023" and "Año modelo: 2011" → anio="2011".
- Look for car brands: Toyota, Hyundai, Kia, Chevrolet, Nissan, Ford, Honda, Mazda, Suzuki, Mitsubishi, Chery, Renault, Subaru, etc.
- Look for models: Corolla, Hilux, Sportage, Accent, Tucson, Santa Fe, Sail, Captiva, Spark, Aveo, Onix, LUV, D-Max, Maxima, Civic, Mazda3, Picanto, Grand Vitara, Vitara, Fortuner, Tracker, Cruze, Sentra, Frontier, Kicks, Duster, etc.
- CRITICAL: "LUV" is a vehicle model (Chevrolet LUV pickup truck), NOT a part. "LUV 2.5 2004" → vehicle_info.marca="CHEVROLET", vehicle_info.modelo="LUV", vehicle_info.cilindraje="2500cc", vehicle_info.anio="2004"
- CRITICAL: "SANTA FE" is a vehicle model (Hyundai Santa Fe SUV), NOT a product/part. "santa fe 2.4 2015" → vehicle_info.marca="HYUNDAI", vehicle_info.modelo="SANTA FE", vehicle_info.cilindraje="2400cc", vehicle_info.anio="2015"
- CRITICAL: "D-MAX" / "DMAX" is a vehicle model (Chevrolet D-Max pickup), NOT a part.
- CRITICAL: "GRAND VITARA" is a vehicle model (Suzuki/Chevrolet Grand Vitara), NOT a part.
- Look for years: 2015, 2018, 2019, 2020, etc.
- Look for cilindraje: "1400", "1500", "1600", "1800", "1998", "2000", "2997", "1.4", "1.5", "1.6", "1.8", "2.0", "3.5" — always extract if present
- Look for motor codes: alphanumeric codes like PE40628613, 2ZR-FE, F15S, G4EH, etc.
- Look for plates: ABC1234, ABI8523, etc. (Ecuadorian/Latin American formats)
- Look for chassis/VIN: 17-character alphanumeric codes like 3MZBN4276KM212308
- CRITICAL: Distinguish between "Sail 1400" and "Sail 1500" — they are DIFFERENT vehicles
- CRITICAL: Extract full model names like "NUEVO MAZDA3 AC 2.0 4P 4X2 TM" as single modelo field
- CRITICAL: "SAIL 1500" is vehicle info (modelo=SAIL, cilindraje=1500), NOT a part item
- CRITICAL: "MAXIMA 3.5 SV 2019" is vehicle info (modelo=MAXIMA 3.5 SV, anio=2019), NOT a part item
- CRITICAL: "CIVIC 1.5 TURBO EX 2020" is vehicle info (modelo=CIVIC 1.5 TURBO EX, anio=2020), NOT a part item
- CRITICAL: "PICANTO G4LA 2018" is vehicle info (marca=KIA, modelo=PICANTO G4LA, anio=2018), NOT a part item
- CRITICAL: "LUV 2.5 2004" is vehicle info (marca=CHEVROLET, modelo=LUV, cilindraje=2500cc, anio=2004), NOT a part item
- CRITICAL: "santa fe 2.4 2015" is vehicle info (marca=HYUNDAI, modelo=SANTA FE, cilindraje=2400cc, anio=2015), NOT a part item
- CRITICAL: "D-MAX 3.0 2018" is vehicle info (marca=CHEVROLET, modelo=D-MAX, cilindraje=3000cc, anio=2018), NOT a part item
- CRITICAL: "GRAND VITARA SZ 2.0 2014" is vehicle info (marca=CHEVROLET, modelo=GRAND VITARA SZ, cilindraje=2000cc, anio=2014), NOT a part item
- CRITICAL: "MONTERO" / "montero 3.0 2008" is vehicle info (marca=MITSUBISHI, modelo=MONTERO, cilindraje=3000cc, anio=2008), NOT a part item. When the first line mixes vehicle + part ("montero 3.0 2008 Kit completo de distribución"), split: vehicle in vehicle_info, only "Kit completo de distribución" as item

FIELDS TO EXTRACT:
- ALWAYS extract: marca, modelo, año, cilindraje, motor, placa (license plate)
- OPTIONAL: VIN (17-char code)
- IGNORE: combustible, color (not relevant for parts search)
- The modelo field should contain the FULL variant name (e.g. "NUEVO MAZDA3 AC 2.0 4P 4X2 TM", not just "MAZDA3")

ITEM EXTRACTION RULES:
- Each line describing a part is typically one item within the ticket
- Multiple quantities on same line = still 1 item with quantity
- "2 filtros de aceite" = 1 item, quantity 2
- Extract: part description, quantity (default 1), any codes/numbers

CLASSIFICATION (based on total items in the ticket):
- short: 1-3 items (IT <= 3)
- medium: 4-7 items (IT 4-7)  
- long: 8+ items (IT >= 8)

PRIORITY SIGNALS:
- urgent/urgente/asap/ya = urgent
- rapido/pronto = high
- normal = normal
- cuando pueda/sin prisa = low

OUTPUT FORMAT (JSON):
{
  "tickets": [
    {
      "raw_text": "original text for this ticket",
      "items": [
        {
          "raw_line": "original line",
          "description": "original description in same language as input, NEVER translated",
          "quantity": 1,
          "codes": ["any codes found"]
        }
      ],
      "item_count": 3,
      "length_class": "short|medium|long",
      "priority": "low|normal|high|urgent",
      "vin": "extracted VIN or null",
      "vehicle_info": {
        "marca": "Toyota or null",
        "modelo": "Corolla or null",
        "anio": "2020 or null",
        "placa": "ABC123 or null",
        "chasis": "17-char VIN or null",
        "motor": "2.0 DOHC or null",
        "cilindraje": "1600cc or null"
      },
      "possible_grouping": false,
      "confidence": 0.95
    }
  ],
  "parse_notes": "any notes about parsing decisions"
}`;

const VEHICLE_LABEL_MAP = {
  modelo: 'modelo',
  marca: 'marca',
  motor: 'motor',
  cilindraje: 'cilindraje',
  chasis: 'chasis',
  serie: 'serie',
  placa: 'placa',
  'año modelo': 'anio',
  'ano modelo': 'anio',
  año: 'anio',
  ano: 'anio',
};

const SKIP_LINE_PATTERNS = [
  /^---\s*.+\s*---$/,
  /^📄|^💰|^⚠️|^📦|^💬|^👤|^🚗\s/,
  /^PROFORMA/i,
  /^TOTAL/i,
  /Precios sujetos/i,
  /Disponibilidad sujeta/i,
  /Precios incluyen IVA/i,
  /Quedo atento/i,
  /^Asesor comercial/i,
  /^N°\s*K/i,
  /^Sin información de vehículo/i,
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableOpenAIError(error) {
  const status = error?.status || error?.response?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const code = error?.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') return true;
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('rate limit') || msg.includes('overloaded');
}

function parseAIJson(content) {
  if (!content) throw new Error('EMPTY_AI_RESPONSE');
  let cleaned = content.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('JSON_PARSE_FAILED');
  }
}

function estimateMaxTokens(text) {
  const lineCount = text.split('\n').filter(l => l.trim()).length;
  return Math.min(16000, Math.max(2500, 700 + lineCount * 120));
}

/** Spanish autopart words — suffix after vehicle prefix on the same line. */
const PART_WORD_PATTERN = /\b(kit|bomba|banda|templador|filtro|pastilla|rotula|piston|camisa|junta|empaque|polea|correa|rodamiento|amortiguador|disco|balancin|valvula|buje|terminal|cremallera|alternador|arranque|radiador|termostato|bujia|inyector|turbo|intercooler|completo|distribuci[oó]n|accesorio|hidraulico|delantero|trasero|superior|inferior|juego|tensor|reten|sello|soporte|biela|bancada|culata|anillo|casquete|cigueñal|cadena)\b/i;

function looksLikePartDescription(text) {
  if (!text || text.trim().length < 3) return false;
  return PART_WORD_PATTERN.test(text);
}

/**
 * When the first pasted line mixes vehicle + part on one row
 * (e.g. "montero 3.0 2008 Kit completo de distribución"), split them.
 */
export function splitVehicleAndPartFromLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // modelo + motor + año + parte
  let match = trimmed.match(/^(.+?\s+\d+(?:\.\d+)?\s+(?:19|20)\d{2})\s+(.+)$/i);
  if (match && looksLikePartDescription(match[2])) {
    return { vehicleText: match[1].trim(), partText: match[2].trim() };
  }

  // modelo + año + parte
  match = trimmed.match(/^(.+?\s+(?:19|20)\d{2})\s+(.+)$/i);
  if (match && looksLikePartDescription(match[2]) && match[1].trim().split(/\s+/).length <= 6) {
    return { vehicleText: match[1].trim(), partText: match[2].trim() };
  }

  // modelo + motor + parte (sin año)
  match = trimmed.match(/^(.+?\s+\d+\.\d+)\s+(.+)$/i);
  if (match && looksLikePartDescription(match[2])) {
    return { vehicleText: match[1].trim(), partText: match[2].trim() };
  }

  const tokens = trimmed.split(/\s+/);
  for (let i = tokens.length - 1; i >= 2; i--) {
    const vehicleText = tokens.slice(0, i).join(' ');
    const partText = tokens.slice(i).join(' ');
    if (!looksLikePartDescription(partText)) continue;
    const detected = detectVehicleFromModelBase(vehicleText);
    if (detected && detected.confidence >= 0.75) {
      return { vehicleText, partText };
    }
  }

  return null;
}

function parseInlineVehicleText(text) {
  let working = text.trim();
  const info = {};

  const yearMatch = working.match(/\b((?:19|20)\d{2})\b/);
  if (yearMatch) {
    info.anio = yearMatch[1];
    working = working.replace(yearMatch[0], '').trim();
  }

  const engineMatch = working.match(/\b(\d\.\d)\b/);
  if (engineMatch) {
    info.cilindraje = `${Math.round(parseFloat(engineMatch[1]) * 1000)}cc`;
    working = working.replace(engineMatch[0], '').trim();
  } else {
    const ccMatch = working.match(/\b(\d{3,4})\b/);
    if (ccMatch) {
      const n = parseInt(ccMatch[1], 10);
      if (n >= 800 && n <= 6000 && ccMatch[1] !== info.anio) {
        info.cilindraje = `${ccMatch[1]}cc`;
        working = working.replace(ccMatch[0], '').trim();
      }
    }
  }

  info.modelo = working.toUpperCase().replace(/\s+/g, ' ').trim();
  const merged = mergeVehicleInfoWithModelBase(info, [text]);
  return normalizeVehicleInfo(merged) || {};
}

function mergeParsedVehicleFields(target, source) {
  if (!source) return target;
  for (const [key, val] of Object.entries(source)) {
    if (val != null && val !== '' && !target[key]) target[key] = val;
  }
  return target;
}

function stripVehiclePrefixFromItems(items, vehicleInfo) {
  if (!items?.length) return items;
  const first = items[0];
  const desc = (first.description || first.raw_line || '').trim();
  const split = splitVehicleAndPartFromLine(desc);
  if (split) {
    return [
      { ...first, description: split.partText, raw_line: split.partText },
      ...items.slice(1),
    ];
  }
  if (vehicleInfo?.modelo && vehicleInfo?.anio) {
    const modelo = vehicleInfo.modelo.toUpperCase();
    const re = new RegExp(
      `^${modelo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+\\d+(?:\\.\\d+)?)?\\s+${vehicleInfo.anio}\\s+`,
      'i'
    );
    const stripped = desc.replace(re, '').trim();
    if (stripped && stripped !== desc && looksLikePartDescription(stripped)) {
      return [{ ...first, description: stripped, raw_line: stripped }, ...items.slice(1)];
    }
  }
  return items;
}

/**
 * Clean pasted text before sending to OpenAI — removes proforma/footer noise,
 * extracts labeled vehicle block, keeps part request lines.
 */
export function preprocessRawText(rawText) {
  const vehicleInfo = {};
  const partLines = [];
  let inVehicleSection = false;
  let isFirstContentLine = true;

  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^---\s*(.+?)\s*---$/i.test(trimmed)) {
      inVehicleSection = /veh[ií]culo/i.test(trimmed);
      continue;
    }

    const labelMatch = trimmed.match(/^([A-Za-zÁÉÍÓÚáéíóúñÑ\s]+):\s*(.+)$/);
    if (labelMatch) {
      const key = labelMatch[1].trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const field = VEHICLE_LABEL_MAP[key];
      if (field) {
        vehicleInfo[field] = labelMatch[2].trim();
        continue;
      }
    }

    if (inVehicleSection && labelMatch) continue;

    if (SKIP_LINE_PATTERNS.some(p => p.test(trimmed))) continue;
    if (/\$\s*\d|USD\s*[\d,]+|TOTAL\s*:/i.test(trimmed)) continue;

    const proformaItem = trimmed.match(/^[✅❌⏳🚫🟢🔴🟡]\s*(.+?)(?:\s*[—–-]\s*\$|\s*🧩|\s*\(|$)/);
    if (proformaItem) {
      const name = proformaItem[1].replace(/\s+x\d+\s*$/i, '').trim();
      if (name && name.length > 1) partLines.push(name);
      continue;
    }

    if (/^[\d]{1,2}[\/.-][\d]{1,2}/.test(trimmed) && trimmed.includes(':') && trimmed.length < 80) {
      continue;
    }

    if (isFirstContentLine) {
      isFirstContentLine = false;
      const split = splitVehicleAndPartFromLine(trimmed);
      if (split) {
        mergeParsedVehicleFields(vehicleInfo, parseInlineVehicleText(split.vehicleText));
        partLines.push(split.partText);
        continue;
      }
    }

    partLines.push(trimmed);
  }

  const textForAI = partLines.join('\n').trim() || rawText.trim();
  return { vehicleInfo, partLines, textForAI };
}

async function callOpenAIParser(textForAI, rawText, attempt = 1) {
  const maxAttempts = 3;
  try {
    return await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: PARSER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Parse the following WhatsApp message for auto parts requests:\n\n${textForAI}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: estimateMaxTokens(rawText),
    });
  } catch (error) {
    if (attempt < maxAttempts && isRetryableOpenAIError(error)) {
      console.warn(`[PARSER] OpenAI retry ${attempt}/${maxAttempts - 1}:`, error.message);
      await sleep(1000 * attempt);
      return callOpenAIParser(textForAI, rawText, attempt + 1);
    }
    throw error;
  }
}

function mergeVehicleInfo(base, extracted) {
  const merged = { ...(base || {}) };
  for (const [key, val] of Object.entries(extracted || {})) {
    if (val && !merged[key]) merged[key] = val;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function buildTicketFromRuleBased(rawText, groupCode, preprocessed, reason) {
  let vehicleForNorm = preprocessed.vehicleInfo ? { ...preprocessed.vehicleInfo } : {};
  vehicleForNorm = mergeVehicleInfoWithModelBase(vehicleForNorm, [rawText]);
  consolidateMatriculaAnio(vehicleForNorm, [rawText]);
  const normalizedVehicle = normalizeVehicleInfo(vehicleForNorm);

  let itemLines = preprocessed.partLines.filter(line => {
    const t = line.trim();
    if (t.length < 2) return false;
    if (SKIP_LINE_PATTERNS.some(p => p.test(t))) return false;
    return true;
  });

  if (itemLines.length === 0) {
    itemLines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 1 && !SKIP_LINE_PATTERNS.some(p => p.test(l)));
  }

  const items = itemLines.map((line, index) => ({
    raw_line: line,
    description: line,
    quantity: 1,
    item_order: index + 1,
    status: 'pending_info',
  }));

  const expandedItems = splitCompoundItems(items.map(i => ({ ...i, description: i.description })));
  // Intra-batch dedup — same rationale as in enhanceParsedTickets().
  const { items: dedupedItems, dropped: droppedDuplicates } = dedupeItemsWithinBatch(expandedItems);
  if (droppedDuplicates > 0) {
    console.warn(`[PARSER:fallback] intra-batch dedup dropped ${droppedDuplicates} duplicate item(s) from a single paste`);
  }
  const itemCount = dedupedItems.length;

  const notes = {
    API_ERROR: 'Parser alternativo: error de conexión con OpenAI',
    EMPTY_AI_RESPONSE: 'Parser alternativo: respuesta vacía de OpenAI',
    JSON_PARSE_FAILED: 'Parser alternativo: respuesta JSON inválida (texto muy largo o truncado)',
    INVALID_AI_RESPONSE: 'Parser alternativo: estructura de respuesta incompleta',
    ENHANCE_FAILED: 'Parser alternativo: error al procesar respuesta de IA',
  };

  const baseNote = notes[reason] || 'Parser alternativo usado — revise items generados';
  const dedupeNote = droppedDuplicates > 0
    ? `Se eliminaron ${droppedDuplicates} línea${droppedDuplicates > 1 ? 's' : ''} duplicada${droppedDuplicates > 1 ? 's' : ''} (mismo producto repetido en el mensaje)`
    : null;

  return {
    tickets: [{
      raw_text: rawText,
      group_code: groupCode,
      items: dedupedItems.map((item, itemIndex) => ({
        ...item,
        item_order: itemIndex + 1,
        quantity: item.quantity || 1,
        status: 'pending_info',
      })),
      item_count: itemCount,
      length_class: itemCount <= 3 ? 'short' : itemCount <= 7 ? 'medium' : 'long',
      priority: 'normal',
      status: 'pending_review',
      possible_grouping: itemCount > 10,
      vehicle_info: normalizedVehicle,
      vin: extractVIN(rawText),
    }],
    total_tickets: 1,
    parse_notes: [baseNote, dedupeNote].filter(Boolean).join(' | '),
    original_raw_text: rawText,
    parse_method: 'fallback',
  };
}

/**
 * Parse raw WhatsApp text into structured ticket data
 * @param {string} rawText - The raw pasted text
 * @param {string} groupCode - The WhatsApp group code
 * @returns {Promise<Object>} Parsed ticket data
 */
export async function parseTicketText(rawText, groupCode) {
  const preprocessed = preprocessRawText(rawText);

  try {
    const response = await callOpenAIParser(preprocessed.textForAI, rawText);
    const content = response.choices[0]?.message?.content;
    const parsed = parseAIJson(content);

    if (!parsed?.tickets || !Array.isArray(parsed.tickets) || parsed.tickets.length === 0) {
      throw new Error('INVALID_AI_RESPONSE');
    }

    const result = enhanceParsedTickets(parsed, groupCode, rawText, preprocessed.vehicleInfo);
    return { ...result, parse_method: 'ai' };
  } catch (error) {
    const reason = error.message?.includes('INVALID') ? 'INVALID_AI_RESPONSE'
      : error.message?.includes('JSON') ? 'JSON_PARSE_FAILED'
      : error.message?.includes('EMPTY') ? 'EMPTY_AI_RESPONSE'
      : 'API_ERROR';

    console.error(`[PARSER] AI failed (${reason}):`, error.message || error);

    try {
      return buildTicketFromRuleBased(rawText, groupCode, preprocessed, reason);
    } catch (fallbackError) {
      console.error('[PARSER] Rule-based fallback failed:', fallbackError);
      return createFallbackTicket(rawText, groupCode, reason);
    }
  }
}

/**
 * Normalize vehicle info according to client specifications
 */
function normalizeVehicleInfo(vehicleInfo) {
  if (!vehicleInfo) return null;
  
  const normalized = { ...vehicleInfo };
  
  // Normalize cilindraje formats
  if (normalized.cilindraje) {
    const cil = normalized.cilindraje.toString().toLowerCase().replace(/[^\d.]/g, '');
    if (cil.includes('.')) {
      // 1.5 → 1500cc
      const num = parseFloat(cil) * 1000;
      normalized.cilindraje = Math.round(num).toString() + 'cc';
    } else if (cil.length === 4) {
      // 1998 → 1998cc
      normalized.cilindraje = cil + 'cc';
    } else if (cil.length === 3) {
      // 150 → 1500cc
      normalized.cilindraje = cil + '0cc';
    }
  }
  
  // Normalize model names — keep full variant names, extract implicit cilindraje
  if (normalized.modelo) {
    const model = normalized.modelo.toUpperCase().trim();
    normalized.modelo = model;
    
    // Extract cilindraje from SAIL model name if not already set
    if (model.includes('SAIL') && !normalized.cilindraje) {
      const sailMatch = model.match(/SAIL\s*(\d{3,4})/);
      if (sailMatch) {
        normalized.cilindraje = sailMatch[1] + 'cc';
      }
    }
    
    // Auto-detect marca from model name if not set
    if (!normalized.marca) {
      if (model.includes('SAIL') || model.includes('CAPTIVA') || model.includes('SPARK') || model.includes('AVEO') || model.includes('ONIX') || model.includes('CRUZE') || model.includes('TRACKER') || model === 'LUV' || model.startsWith('LUV ') || model.includes('D-MAX') || model.includes('DMAX')) normalized.marca = 'CHEVROLET';
      else if (model.includes('COROLLA') || model.includes('HILUX') || model.includes('RAV4') || model.includes('FORTUNER') || model.includes('YARIS') || model.includes('PRADO')) normalized.marca = 'TOYOTA';
      else if (model.includes('MAZDA3') || model.includes('MAZDA2') || model.includes('MAZDA6') || model.includes('CX-') || model.includes('BT-50') || model.includes('MAZDA')) normalized.marca = 'MAZDA';
      else if (model.includes('MAXIMA') || model.includes('SENTRA') || model.includes('FRONTIER') || model.includes('KICKS') || model.includes('QASHQAI') || model.includes('MARCH') || model.includes('VERSA') || model.includes('NP300')) normalized.marca = 'NISSAN';
      else if (model.includes('CIVIC') || model.includes('CR-V') || model.includes('ACCORD') || model.includes('FIT') || model.includes('HR-V') || model.includes('CITY')) normalized.marca = 'HONDA';
      else if (model.includes('ACCENT') || model.includes('TUCSON') || model.includes('ELANTRA') || model.includes('SANTA FE') || model.includes('CRETA')) normalized.marca = 'HYUNDAI';
      else if (model.includes('SPORTAGE') || model.includes('RIO') || model.includes('CERATO') || model.includes('PICANTO') || model.includes('SORENTO')) normalized.marca = 'KIA';
      else if (model.includes('GRAND VITARA') || model.includes('VITARA') || model.includes('SWIFT') || model.includes('JIMNY') || model.includes('SX4')) normalized.marca = 'SUZUKI';
      else if (model.includes('RANGER') || model.includes('ECOSPORT') || model.includes('ESCAPE') || model.includes('EXPLORER') || model.includes('F-150')) normalized.marca = 'FORD';
      else if (model.includes('DUSTER') || model.includes('SANDERO') || model.includes('LOGAN') || model.includes('KOLEOS')) normalized.marca = 'RENAULT';
      else if (model.includes('L200') || model.includes('MONTERO') || model.includes('OUTLANDER') || model.includes('LANCER')) normalized.marca = 'MITSUBISHI';
    }
  }
  
  // Filter out unwanted fields
  delete normalized.combustible;
  delete normalized.color;
  delete normalized.model_detection_source;
  delete normalized.model_detection_confidence;
  
  return normalized;
}

/**
 * Split compound items joined by conjunctions ("y", "e", "&")
 * E.g. "Pistones y rines +30" → ["Pistones +30", "Rines +30"]
 * Rules:
 * - Apply trailing measurement/qualifier to both split items
 * - If a standalone measurement line follows an item, merge it first then split
 * - Don't split if exclusion words present (kit, juego, combo, completo, set)
 * - Detect shared prefix pattern: "Chaquetas de biela y bancada" → both get "Chaquetas de"
 */
function splitCompoundItems(items) {
  if (!items || items.length === 0) return items;

  // Exclusion words — never split these
  const NO_SPLIT = /\b(kit|juego|combo|completo|set)\b/i;

  // Conjunction pattern (word-boundary " y ", " e ", " & ")
  const CONJUNCTION = /\s+(?:y|e|&)\s+/i;

  // Trailing measurement/qualifier at the end of a string
  // Matches: +20, +030, 020, 030, STD, LH, RH (with leading space)
  const TRAILING_MEASURE = /\s+(\+\d{2,3}|0[1-9]\d|STD|LH|RH)$/i;

  // A line that is ONLY a measurement (to merge with previous item)
  const STANDALONE_MEASURE = /^(\+\d{2,3}|0[1-9]\d|STD)$/i;

  // --- Pre-pass: merge standalone measurement lines with previous item ---
  const merged = [];
  for (let i = 0; i < items.length; i++) {
    const desc = (items[i].description || items[i].raw_line || '').trim();
    if (STANDALONE_MEASURE.test(desc) && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.description = `${prev.description} ${desc}`;
      prev.raw_line = `${prev.raw_line || prev.description}`;
    } else {
      merged.push({ ...items[i] });
    }
  }

  // --- Split pass ---
  const result = [];
  for (const item of merged) {
    const desc = (item.description || '').trim();

    // Skip if exclusion words present
    if (NO_SPLIT.test(desc)) {
      result.push(item);
      continue;
    }

    // Check for conjunction
    if (!CONJUNCTION.test(desc)) {
      result.push(item);
      continue;
    }

    // Split on first conjunction only
    const conjMatch = desc.match(CONJUNCTION);
    if (!conjMatch) { result.push(item); continue; }

    const splitIdx = conjMatch.index;
    let leftPart = desc.slice(0, splitIdx).trim();
    let rightPart = desc.slice(splitIdx + conjMatch[0].length).trim();

    // If split produced empty parts, skip
    if (!leftPart || !rightPart) {
      result.push(item);
      continue;
    }

    // Extract trailing measurement/qualifier from the rightmost part
    let trailingMeasure = '';
    const measureMatch = rightPart.match(TRAILING_MEASURE);
    if (measureMatch) {
      trailingMeasure = measureMatch[1];
      rightPart = rightPart.slice(0, measureMatch.index).trim();
    } else {
      // Check if measure is at end of left part (less common)
      const leftMeasure = leftPart.match(TRAILING_MEASURE);
      if (leftMeasure) {
        trailingMeasure = leftMeasure[1];
        leftPart = leftPart.slice(0, leftMeasure.index).trim();
      }
    }

    // Detect shared prefix pattern: "[PREFIX] de [SUBTYPE]" y [OTHER_SUBTYPE]
    // e.g. "Chaquetas de biela" y "bancada" → prefix = "Chaquetas de"
    const prefixMatch = leftPart.match(/^(.+\s+de)\s+(.+)$/i);
    let item1Desc, item2Desc;

    if (prefixMatch && rightPart.split(/\s+/).length <= 2) {
      // Shared prefix case
      const sharedPrefix = prefixMatch[1]; // e.g. "Chaquetas de"
      item1Desc = leftPart;
      item2Desc = `${sharedPrefix} ${rightPart}`;
    } else {
      // Simple split: both parts are standalone
      item1Desc = leftPart;
      item2Desc = rightPart;
    }

    // Apply trailing measurement to both items
    if (trailingMeasure) {
      item1Desc = `${item1Desc} ${trailingMeasure}`;
      item2Desc = `${item2Desc} ${trailingMeasure}`;
    }

    // Create two items from the original
    result.push({
      ...item,
      raw_line: item.raw_line || desc,
      description: item1Desc,
    });
    result.push({
      ...item,
      raw_line: item.raw_line || desc,
      description: item2Desc,
    });
  }

  // Re-number item_order
  return result.map((item, index) => ({
    ...item,
    item_order: index + 1
  }));
}

/**
 * Normalize an item description into a comparison key.
 * Used to detect identical items inside the SAME paste (e.g. when the seller
 * pastes a WhatsApp message that already contains the same list twice).
 *
 * Lower-cases, strips accents and punctuation, collapses whitespace.
 *   "AMORTIGUADOR DELT" === " amortiguador delt " === "Amortiguador  Delt"
 */
function normalizeItemKey(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Drop duplicate items inside a single parse batch.
 *
 * Many real WhatsApp pastes contain the same list twice (table headers, copy
 * from external systems, reply quoting). Without this pass the system creates
 * 2× ticket items for every duplicated line.
 *
 * The first occurrence wins (keeps its quantity). Subsequent occurrences with
 * the same normalized description are dropped silently. The number of dropped
 * lines is returned so the caller can surface a parse_note to the user.
 */
export function dedupeItemsWithinBatch(items) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const item of items || []) {
    const key = normalizeItemKey(item.description || item.parsed_description || item.raw_line);
    if (!key) {
      kept.push(item);
      continue;
    }
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    kept.push(item);
  }
  return { items: kept, dropped };
}

/**
 * Enhance parsed tickets with additional computed fields
 */
function enhanceParsedTickets(parsed, groupCode, originalRawText, extractedVehicle = {}) {
  let totalDroppedDuplicates = 0;
  const tickets = parsed.tickets.map((ticket) => {
    let expandedItems = splitCompoundItems(ticket.items || []);
    expandedItems = stripVehiclePrefixFromItems(expandedItems, ticket.vehicle_info);
    // Intra-batch dedup: when the source paste contains the same line twice
    // (very common with WhatsApp tables being pasted twice) we keep only the
    // first occurrence so the seller doesn't get duplicated ticket items.
    const { items: dedupedItems, dropped } = dedupeItemsWithinBatch(expandedItems);
    totalDroppedDuplicates += dropped;
    if (dropped > 0) {
      console.warn(`[PARSER] intra-batch dedup dropped ${dropped} duplicate item(s) from a single paste`);
    }
    const itemCount = dedupedItems.length || 0;

    let vehicleForNorm = ticket.vehicle_info ? { ...ticket.vehicle_info } : {};
    vehicleForNorm = mergeVehicleInfo(vehicleForNorm, extractedVehicle);
    vehicleForNorm = mergeVehicleInfoWithModelBase(vehicleForNorm, [originalRawText, ticket.raw_text || '']);
    consolidateMatriculaAnio(vehicleForNorm, [originalRawText, ticket.raw_text || '']);
    const normalizedVehicle = normalizeVehicleInfo(vehicleForNorm);

    let lengthClass = 'short';
    if (itemCount >= 4 && itemCount <= 7) lengthClass = 'medium';
    else if (itemCount >= 8) lengthClass = 'long';

    const validPriorities = ['low', 'normal', 'high', 'urgent'];
    const priority = validPriorities.includes(ticket.priority) ? ticket.priority : 'normal';

    const confidence = typeof ticket.confidence === 'number' ? ticket.confidence : 1;
    const needsReview = confidence < 0.7 || !dedupedItems.length;

    return {
      ...ticket,
      group_code: groupCode,
      item_count: itemCount,
      length_class: lengthClass,
      priority,
      status: needsReview ? 'pending_review' : 'in_progress',
      possible_grouping: ticket.possible_grouping || false,
      vehicle_info: normalizedVehicle,
      items: dedupedItems.map((item, itemIndex) => ({
        ...item,
        item_order: itemIndex + 1,
        quantity: item.quantity || 1,
        status: 'pending_info',
      })),
    };
  });

  const dedupeNote = totalDroppedDuplicates > 0
    ? `Se eliminaron ${totalDroppedDuplicates} línea${totalDroppedDuplicates > 1 ? 's' : ''} duplicada${totalDroppedDuplicates > 1 ? 's' : ''} (mismo producto repetido en el mensaje)`
    : null;
  const combinedNotes = [parsed.parse_notes, dedupeNote].filter(Boolean).join(' | ');

  return {
    tickets,
    total_tickets: tickets.length,
    parse_notes: combinedNotes || null,
    original_raw_text: originalRawText,
  };
}

/**
 * Last-resort fallback when rule-based parsing also fails
 */
function createFallbackTicket(rawText, groupCode, reason = 'API_ERROR') {
  const preprocessed = preprocessRawText(rawText);
  return buildTicketFromRuleBased(rawText, groupCode, preprocessed, reason);
}

/**
 * Extract VIN from text using regex
 */
function extractVIN(text) {
  // Standard 17-character VIN pattern
  const vinRegex = /\b[A-HJ-NPR-Z0-9]{17}\b/gi;
  const match = text.match(vinRegex);
  return match ? match[0].toUpperCase() : null;
}

/**
 * Extract potential license plate from text
 */
export function extractPlate(text) {
  // Common Venezuelan plate patterns
  const platePatterns = [
    /\b[A-Z]{2,3}[0-9]{2,3}[A-Z]{2,3}\b/gi, // ABC123XY
    /\b[A-Z]{3}[0-9]{3}\b/gi, // ABC123
  ];
  
  for (const pattern of platePatterns) {
    const match = text.match(pattern);
    if (match) return match[0].toUpperCase();
  }
  
  return null;
}

export { splitCompoundItems };
export default { parseTicketText, extractVIN, extractPlate, splitCompoundItems, preprocessRawText };
