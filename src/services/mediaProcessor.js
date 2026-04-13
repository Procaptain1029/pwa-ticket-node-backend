import openai from '../config/openai.js';
import { supabaseAdmin } from '../config/supabase.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { mergeVehicleInfoWithModelBase } from './modelBaseMatcher.js';

/**
 * Media Processor Service
 * - Image: upload to Supabase Storage (no AI — just for manager reference)
 * - Audio: Whisper transcription
 */

const STORAGE_BUCKET = 'ticket-attachments';

/** Model year on Ecuador matrícula — not the top-right registration "AÑO". */
const CAR_YEAR_MIN = 1980;
const CAR_YEAR_MAX = 2036;

function isPlausibleCarYear(y) {
  const n = parseInt(String(y), 10);
  return Number.isFinite(n) && n >= CAR_YEAR_MIN && n <= CAR_YEAR_MAX;
}

/**
 * Read model year from OCR-like text: value tied to "AÑO MODELO", ignoring standalone "AÑO".
 */
export function extractEcuadorAnioModeloFromText(blob) {
  if (!blob || typeof blob !== 'string') return null;
  const upper = blob
    .replace(/\r\n/g, '\n')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  const sameLine = upper.match(/(?:AÑO|ANO)\s*MODELO\s*[:\s.,|/-]*(\d{4})\b/);
  if (sameLine && isPlausibleCarYear(sameLine[1])) return sameLine[1];

  const labelRe = /(?:AÑO|ANO)\s*MODELO\b/g;
  let match;
  while ((match = labelRe.exec(upper)) !== null) {
    const after = upper.slice(match.index + match[0].length, match.index + match[0].length + 64);
    const y = after.match(/\b(19|20)\d{2}\b/);
    if (y && isPlausibleCarYear(y[0])) return y[0];
  }

  return null;
}

/**
 * Prefer AÑO MODELO (and regex from extracted text) over plain `anio` from the model.
 * Exported for ticket text parsing when raw text includes matrícula labels.
 */
export function consolidateMatriculaAnio(vehicleInfo, textSources) {
  if (!vehicleInfo) return;
  const blob = textSources.filter(Boolean).join('\n');

  const fromRegex = extractEcuadorAnioModeloFromText(blob);
  let fromModeloField = null;
  if (vehicleInfo.anio_modelo != null && vehicleInfo.anio_modelo !== '') {
    const m = String(vehicleInfo.anio_modelo).match(/\b(19|20)\d{2}\b/);
    if (m && isPlausibleCarYear(m[0])) fromModeloField = m[0];
  }

  let chosen = fromRegex || fromModeloField;
  if (fromRegex && fromModeloField && fromRegex !== fromModeloField) {
    chosen = fromRegex;
  }

  if (chosen) {
    vehicleInfo.anio = chosen;
  } else if (vehicleInfo.anio != null && vehicleInfo.anio !== '') {
    const m = String(vehicleInfo.anio).match(/\b(19|20)\d{2}\b/);
    if (m) vehicleInfo.anio = m[0];
  }

  delete vehicleInfo.anio_modelo;
}

function normalizeProducts(products) {
  if (!Array.isArray(products)) return [];
  const out = [];
  for (const p of products) {
    if (!p) continue;
    const name = String(p.name || p.descripcion || '').trim();
    if (!name) continue;
    const quantity = Number.isFinite(Number(p.quantity)) && Number(p.quantity) > 0 ? Number(p.quantity) : 1;
    const code = p.code ? String(p.code).trim() : null;
    out.push({ name, quantity, code });
  }
  return out;
}

/**
 * Upload an image to Supabase Storage and record it in ticket_attachments
 * @param {Buffer} fileBuffer - The file data
 * @param {string} fileName - Original file name
 * @param {string} mimeType - MIME type
 * @param {number} fileSize - File size in bytes
 * @param {string} ticketId - The ticket to attach to
 * @param {string} userId - Who uploaded it
 * @returns {Promise<object>} The attachment record
 */
export async function uploadAttachment(fileBuffer, fileName, mimeType, fileSize, ticketId, userId) {
  // Generate unique path: tickets/{ticketId}/{uuid}-{filename}
  const uniqueName = `${crypto.randomUUID()}-${fileName}`;
  const storagePath = `tickets/${ticketId}/${uniqueName}`;

  // Upload to Supabase Storage
  const { error: uploadError } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: mimeType,
      upsert: false
    });

  if (uploadError) throw new Error(`Error subiendo archivo: ${uploadError.message}`);

  // Save metadata in ticket_attachments table
  const { data: attachment, error: dbError } = await supabaseAdmin
    .from('ticket_attachments')
    .insert({
      ticket_id: ticketId,
      file_name: fileName,
      file_path: storagePath,
      mime_type: mimeType,
      file_size: fileSize,
      uploaded_by: userId
    })
    .select()
    .single();

  if (dbError) throw new Error(`Error guardando metadata: ${dbError.message}`);

  return attachment;
}

/**
 * Get all attachments for a ticket
 * @param {string} ticketId
 * @returns {Promise<Array>}
 */
export async function getAttachments(ticketId) {
  const { data, error } = await supabaseAdmin
    .from('ticket_attachments')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

/**
 * Get a signed URL for viewing an attachment
 * @param {string} filePath - Storage path
 * @returns {Promise<string>} Signed URL valid for 1 hour
 */
export async function getAttachmentUrl(filePath) {
  const { data, error } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(filePath, 3600); // 1 hour

  if (error) throw new Error(`Error generando URL: ${error.message}`);
  return data.signedUrl;
}

/**
 * Analyze an image using GPT-4o Vision
 * Extracts: vehicle plate info (marca, modelo, año, placa, chasis) and any part/item text
 * @param {Buffer} imageBuffer - The image data
 * @param {string} mimeType - MIME type (image/jpeg, image/png, etc.)
 * @returns {Promise<{ vehicle_info: object|null, extracted_text: string, description: string, products: Array<{name: string, quantity: number, code: string|null}>, raw_analysis: string }>}
 */
export async function analyzeImage(imageBuffer, mimeType) {
  const base64Image = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64Image}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.1,
    max_tokens: 1200,
    messages: [
      {
        role: 'system',
        content: `Eres un asistente experto en autopartes y vehículos en Ecuador/Latinoamérica.
Analiza la imagen y extrae toda la información relevante.

Responde SIEMPRE en este formato JSON exacto:
{
  "vehicle_info": {
    "modelo": "string o null",
    "motor": "string o null (tipo del motor, ej: '2.0 DOHC', '1.6 TDI')",
    "anio_modelo": "string o null — SOLO el número que aparece junto a la etiqueta AÑO MODELO (año de fabricación/modelo del vehículo según ficha técnica)",
    "anio": "string o null — DEBE ser IGUAL que anio_modelo cuando exista AÑO MODELO en el documento; nunca copies el AÑO de matriculación aquí",
    "chasis": "string o null (número de chasis/VIN)",
    "serie": "string o null (número de serie si aplica)",
    "placa": "string o null",
    "marca": "string o null (fabricante: Toyota, Honda, Hyundai, etc.)",
    "cilindraje": "string o null (cilindrada del motor, ej: '1600cc', '2.0L', '1500')"
  },
  "products": [
    { "name": "string", "quantity": 1, "code": "string o null" }
  ],
  "extracted_text": "texto extraído de la imagen, cada item en una línea separada",
  "description": "breve descripción de lo que se ve en la imagen"
}

Hay dos casos principales:

CASO 1 — Documento vehicular / matrícula / placa:
- Extrae: modelo, motor, anio_modelo, anio, chasis, serie, placa, marca, cilindraje
- En extracted_text incluye líneas etiquetadas tal como en el documento, por ejemplo:
  "AÑO: 2023" (solo referencia / matriculación) y en OTRA línea "AÑO MODELO: 2011" o equivalente
- Estos datos se usan para identificar el vehículo y buscar repuestos compatibles
- Busca estos datos en documentos de matrícula, tarjetas de propiedad, placas, etiquetas VIN, etc.
- IMPORTANTE: Los documentos ecuatorianos tienen campos con etiquetas como:
  MARCA → marca, MODELO → modelo, CILINDRAJE → cilindraje,
  MOTOR → motor, CHASIS → chasis, PLACA → placa, SERIE → serie, No. MOTOR → motor
- ⚠️ REGLA ABSOLUTA — DOS AÑOS EN MATRÍCULA ECUATORIANA:
  * Campo "AÑO" arriba/derecha (a menudo número grande y claro) = año de EMISIÓN o REGISTRO de la matrícula → NO es el año del vehículo. NO lo pongas en anio_modelo ni en anio.
  * Campo "AÑO MODELO" (suele estar a la derecha, texto más pequeño; a veces tapado por sellos azules) = año REAL del modelo del vehículo → anio_modelo Y anio deben ser ESTE número.
  * Ejemplo obligatorio: AÑO=2023 y AÑO MODELO=2011 → anio_modelo="2011", anio="2011" (NUNCA 2023).
  * Si el sello tapa parte del dígito, infiere con cuidado leyendo el contexto del MODELO del vehículo; prioriza AÑO MODELO aunque sea menos legible que AÑO.
  * Si en el documento NO existe la etiqueta AÑO MODELO y solo hay un año de vehículo, entonces anio_modelo y anio pueden ser ese único año (no matriculación si está claro que es solo registro).
- Lee TODOS los campos etiquetados del documento y mapéalos al JSON
- El campo CILINDRAJE suele tener un número como 1400, 1500, 1600, 1800, 1998, 2000 (en cc)
- MODELOS ESPECÍFICOS A DETECTAR:
  * SAIL (con cilindraje: 1400, 1500, 1.4, 1.5)
  * COROLLA (con variantes: 1.8 XEI, etc.)
  * MAXIMA (con variantes: 3.5 SV, etc.)
  * NUEVO MAZDA3 (con variantes: AC 2.0 4P 4X2 TM, etc.)
  * CIVIC (con variantes: 1.5 TURBO EX, etc.)
- CRÍTICO: Distingue "Sail 1400" vs "Sail 1500" — son vehículos diferentes
- CRÍTICO: Distingue "MAXIMA 3.5 SV" de otras variantes de Maxima
- CRÍTICO: Extrae nombres completos como "NUEVO MAZDA3 AC 2.0 4P 4X2 TM" como campo único de modelo

CASO 2 — Lista de repuestos / autopartes:
- La imagen puede ser una foto de una lista escrita a mano, un chat de WhatsApp, una etiqueta OEM, un código de barra, etc.
- Extrae TODOS los nombres de repuestos/autopartes, códigos, cantidades y números que veas
- Pon cada item en una línea separada en "extracted_text"
- Además llena "products" con objetos estructurados:
  * name: nombre normalizado del repuesto
  * quantity: entero (si no se ve, usa 1)
  * code: código OEM o referencia si existe
- Ejemplo: "Bomba de aceite\\nFiltro de aire\\nPastillas de freno delanteras x2\\nCódigo OEM: 04465-0K090"

Reglas generales:
- Una imagen puede contener AMBOS tipos de info (vehículo + lista de partes)
- Si no hay info de vehículo, pon null en los campos de vehicle_info
- Si no hay texto de repuestos, pon string vacío en extracted_text
- Si no hay productos, usa array vacío en "products"
- Solo devuelve JSON válido, nada más`
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: dataUrl, detail: 'high' }
          },
          {
            type: 'text',
            text: 'STEP 1 — If this is a República del Ecuador matrícula or similar: locate BOTH labels "AÑO" (registration) and "AÑO MODELO" (vehicle model year). Fill anio_modelo ONLY from the digits next to AÑO MODELO (even if partially covered by a stamp). Set anio to the SAME value as anio_modelo. Do NOT put registration year in anio or anio_modelo. Example: AÑO=2023, AÑO MODELO=2011 → anio_modelo="2011", anio="2011".\nSTEP 2 — In extracted_text, include separate lines like "AÑO MODELO: 2011" so the model year is unambiguous.\nSTEP 3 — If it is only parts list / no vehicle document, set anio and anio_modelo to null.\nNow output the JSON.'
          }
        ]
      }
    ]
  });

  const content = response.choices[0]?.message?.content || '{}';
  
  // Parse the JSON response
  try {
    // Strip markdown code fences if present
    const cleaned = content.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
  
    // Apply same normalization as text parsing
    let vehicleInfo = parsed.vehicle_info || null;
    console.log(`[IMAGE] AI raw vehicle_info:`, JSON.stringify(vehicleInfo));
    if (vehicleInfo) {
      consolidateMatriculaAnio(vehicleInfo, [
        parsed.extracted_text,
        parsed.description,
        cleaned
      ]);
      vehicleInfo = mergeVehicleInfoWithModelBase(vehicleInfo, [
        parsed.extracted_text,
        parsed.description,
        cleaned
      ]);
    }
    if (vehicleInfo) {
      // Normalize vehicle info (must match ticketParser.js normalizeVehicleInfo)
      const normalizeVehicle = (info) => {
        if (!info) return null;
        const normalized = { ...info };
        
        // Normalize cilindraje formats
        if (normalized.cilindraje) {
          const cil = normalized.cilindraje.toString().toLowerCase().replace(/[^\d.]/g, '');
          if (cil.includes('.')) {
            const num = parseFloat(cil) * 1000;
            normalized.cilindraje = Math.round(num).toString() + 'cc';
          } else if (cil.length === 4) {
            normalized.cilindraje = cil + 'cc';
          } else if (cil.length === 3) {
            normalized.cilindraje = cil + '0cc';
          }
        }
        
        // Normalize model names — keep full variant names, extract implicit cilindraje
        if (normalized.modelo) {
          const model = normalized.modelo.toUpperCase().trim();
          normalized.modelo = model;
          
          if (model.includes('SAIL') && !normalized.cilindraje) {
            const sailMatch = model.match(/SAIL\s*(\d{3,4})/);
            if (sailMatch) {
              normalized.cilindraje = sailMatch[1] + 'cc';
            }
          }
          
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
        
        return normalized;
      };
      
      vehicleInfo = normalizeVehicle(vehicleInfo);
    }
    
    return {
      vehicle_info: vehicleInfo,
      products: normalizeProducts(parsed.products),
      extracted_text: parsed.extracted_text || '',
      description: parsed.description || '',
      raw_analysis: content
    };
  } catch {
    // If JSON parsing fails, return raw text
    return {
      vehicle_info: null,
      products: [],
      extracted_text: content,
      description: '',
      raw_analysis: content
    };
  }
}

/**
 * Analyze multiple images and merge results
 * @param {Array<{buffer: Buffer, mimeType: string}>} images
 * @returns {Promise<{ vehicle_info: object|null, extracted_texts: string[], descriptions: string[], products: Array<{name: string, quantity: number, code: string|null}> }>}
 */
export async function analyzeMultipleImages(images) {
  const results = await Promise.all(
    images.map(img => analyzeImage(img.buffer, img.mimeType))
  );

  // Merge vehicle info (first non-null wins for each field)
  let mergedVehicle = null;
  for (const r of results) {
    if (r.vehicle_info) {
      if (!mergedVehicle) mergedVehicle = {};
      for (const [key, val] of Object.entries(r.vehicle_info)) {
        if (val && !mergedVehicle[key]) mergedVehicle[key] = val;
      }
    }
  }

  const mergedProducts = [];
  const seenProducts = new Set();
  for (const r of results) {
    for (const p of r.products || []) {
      const key = `${p.name.toUpperCase()}|${p.code || ''}`;
      if (seenProducts.has(key)) continue;
      seenProducts.add(key);
      mergedProducts.push(p);
    }
  }

  return {
    vehicle_info: mergedVehicle,
    products: mergedProducts,
    extracted_texts: results.map(r => r.extracted_text).filter(Boolean),
    descriptions: results.map(r => r.description).filter(Boolean),
    results
  };
}

/**
 * Transcribe audio using OpenAI Whisper API
 * @param {string} filePath - Path to the audio file on disk
 * @returns {Promise<string>} Transcribed text
 */
export async function transcribeAudio(filePath) {
  const fileStream = fs.createReadStream(filePath);
  
  const response = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file: fileStream,
    language: 'es',
    response_format: 'text',
    prompt: 'Transcripción de un mensaje de WhatsApp solicitando repuestos de vehículos. Puede contener marcas, modelos, años, placas y nombres de autopartes.'
  });

  return response; // returns the transcribed text string
}
