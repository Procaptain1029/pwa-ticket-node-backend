import openai, { OPENAI_MODEL } from '../config/openai.js';
import { consolidateMatriculaAnio } from './mediaProcessor.js';
import { mergeVehicleInfoWithModelBase } from './modelBaseMatcher.js';

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
- Also detect when vehicle info appears with "Modelo:", "Marca:", "Cilindraje:" labels (from image extraction):
  Example: "Modelo: SAIL 1500\nMarca: CHEVROLET\nCilindraje: 1500\nBomba de agua" → extract vehicle_info from labeled fields, items=[Bomba de agua]
- ECUADOR MATRÍCULA / DOCUMENTO VEHICULAR: If the text has BOTH "Año modelo" / "AÑO MODELO" and a separate "Año:" / "AÑO" (without "modelo"), vehicle_info.anio MUST be the value from AÑO MODELO / año modelo (technical model year), NEVER the registration-only year. Example: "Año: 2023" and "Año modelo: 2011" → anio="2011".
- Look for car brands: Toyota, Hyundai, Kia, Chevrolet, Nissan, Ford, Honda, Mazda, Suzuki, Mitsubishi, Chery, etc.
- Look for models: Corolla, Hilux, Sportage, Accent, Tucson, Sail, Captiva, Spark, Aveo, Onix, Maxima, Civic, Mazda3, etc.
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

/**
 * Parse raw WhatsApp text into structured ticket data
 * @param {string} rawText - The raw pasted text
 * @param {string} groupCode - The WhatsApp group code
 * @returns {Promise<Object>} Parsed ticket data
 */
export async function parseTicketText(rawText, groupCode) {
  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: PARSER_SYSTEM_PROMPT },
        { 
          role: 'user', 
          content: `Parse the following WhatsApp message for auto parts requests:\n\n${rawText}` 
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1, // Low temperature for consistent parsing
      max_tokens: 4000
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    
    // Validate and enhance parsed data
    return enhanceParsedTickets(parsed, groupCode, rawText);
    
  } catch (error) {
    console.error('AI parsing error:', error);
    
    // Fallback: create single ticket with unparsed content
    return createFallbackTicket(rawText, groupCode);
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
      if (model.includes('SAIL') || model.includes('CAPTIVA') || model.includes('SPARK') || model.includes('AVEO') || model.includes('ONIX')) normalized.marca = 'CHEVROLET';
      else if (model.includes('COROLLA') || model.includes('HILUX') || model.includes('RAV4')) normalized.marca = 'TOYOTA';
      else if (model.includes('MAZDA3') || model.includes('MAZDA')) normalized.marca = 'MAZDA';
      else if (model.includes('MAXIMA') || model.includes('SENTRA') || model.includes('FRONTIER')) normalized.marca = 'NISSAN';
      else if (model.includes('CIVIC') || model.includes('CR-V') || model.includes('ACCORD')) normalized.marca = 'HONDA';
      else if (model.includes('ACCENT') || model.includes('TUCSON') || model.includes('ELANTRA')) normalized.marca = 'HYUNDAI';
      else if (model.includes('SPORTAGE') || model.includes('RIO') || model.includes('CERATO')) normalized.marca = 'KIA';
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
 * Enhance parsed tickets with additional computed fields
 */
function enhanceParsedTickets(parsed, groupCode, originalRawText) {
  const tickets = parsed.tickets.map((ticket, index) => {
    // Recalculate item count
    const itemCount = ticket.items?.length || 0;
    
    // Normalize vehicle info (fix Ecuador matrícula: año modelo vs año registro)
    let vehicleForNorm = ticket.vehicle_info ? { ...ticket.vehicle_info } : {};
    vehicleForNorm = mergeVehicleInfoWithModelBase(vehicleForNorm, [originalRawText, ticket.raw_text || '']);
    consolidateMatriculaAnio(vehicleForNorm, [originalRawText, ticket.raw_text || '']);
    const normalizedVehicle = normalizeVehicleInfo(vehicleForNorm);
    
    // Determine length class
    let lengthClass = 'short';
    if (itemCount >= 4 && itemCount <= 7) lengthClass = 'medium';
    else if (itemCount >= 8) lengthClass = 'long';
    
    // Validate priority
    const validPriorities = ['low', 'normal', 'high', 'urgent'];
    const priority = validPriorities.includes(ticket.priority) 
      ? ticket.priority 
      : 'normal';
    
    // Mark low confidence tickets for review
    const needsReview = ticket.confidence < 0.7 || !ticket.items?.length;
    
    return {
      ...ticket,
      group_code: groupCode,
      item_count: itemCount,
      length_class: lengthClass,
      priority: priority,
      status: needsReview ? 'pending_review' : 'in_progress',
      possible_grouping: ticket.possible_grouping || false,
      vehicle_info: normalizedVehicle,
      items: (ticket.items || []).map((item, itemIndex) => ({
        ...item,
        item_order: itemIndex + 1,
        quantity: item.quantity || 1,
        status: 'pending_info'
      }))
    };
  });

  return {
    tickets,
    total_tickets: tickets.length,
    parse_notes: parsed.parse_notes,
    original_raw_text: originalRawText
  };
}

/**
 * Create fallback ticket when AI parsing fails
 */
function createFallbackTicket(rawText, groupCode) {
  // Simple line-based parsing
  const lines = rawText.split('\n').filter(line => line.trim());
  
  const items = lines.map((line, index) => ({
    raw_line: line.trim(),
    description: line.trim(),
    quantity: 1,
    item_order: index + 1,
    status: 'pending_info'
  }));

  return {
    tickets: [{
      raw_text: rawText,
      group_code: groupCode,
      items,
      item_count: items.length,
      length_class: items.length <= 3 ? 'short' : items.length <= 7 ? 'medium' : 'long',
      priority: 'normal',
      status: 'pending_review',
      possible_grouping: true,
      vin: extractVIN(rawText)
    }],
    total_tickets: 1,
    parse_notes: 'Fallback parsing used - AI parsing failed',
    original_raw_text: rawText
  };
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

export default { parseTicketText, extractVIN, extractPlate };
