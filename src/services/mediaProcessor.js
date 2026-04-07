import openai from '../config/openai.js';
import { supabaseAdmin } from '../config/supabase.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Media Processor Service
 * - Image: upload to Supabase Storage (no AI — just for manager reference)
 * - Audio: Whisper transcription
 */

const STORAGE_BUCKET = 'ticket-attachments';

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
 * @returns {Promise<{ vehicle_info: object|null, extracted_text: string, raw_analysis: string }>}
 */
export async function analyzeImage(imageBuffer, mimeType) {
  const base64Image = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64Image}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1000,
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
    "anio": "string o null",
    "chasis": "string o null (número de chasis/VIN)",
    "serie": "string o null (número de serie si aplica)",
    "placa": "string o null",
    "marca": "string o null (fabricante: Toyota, Honda, Hyundai, etc.)",
    "cilindraje": "string o null (cilindrada del motor, ej: '1600cc', '2.0L', '1500')"
  },
  "extracted_text": "texto extraído de la imagen, cada item en una línea separada",
  "description": "breve descripción de lo que se ve en la imagen"
}

Hay dos casos principales:

CASO 1 — Documento vehicular / matrícula / placa:
- Extrae: modelo, motor, año, chasis, serie, placa, marca, cilindraje
- Estos datos se usan para identificar el vehículo y buscar repuestos compatibles
- Busca estos datos en documentos de matrícula, tarjetas de propiedad, placas, etiquetas VIN, etc.
- IMPORTANTE: Los documentos ecuatorianos tienen campos con etiquetas como:
  MARCA → marca, MODELO → modelo, CILINDRAJE → cilindraje,
  MOTOR → motor, CHASIS → chasis, PLACA → placa, SERIE → serie, No. MOTOR → motor
- ⚠️⚠️⚠️ MÁXIMA PRIORIDAD — AÑO: Los documentos ecuatorianos tienen DOS campos de año DIFERENTES:
  * "AÑO" (esquina superior derecha, número grande) = año de MATRICULACIÓN/REGISTRO → ❌ NUNCA USAR ESTE
  * "AÑO MODELO" (lado derecho, número más pequeño, a veces parcialmente tapado por sellos) = año REAL del modelo → ✅ SIEMPRE USAR ESTE para "anio"
  * Ejemplo: Si "AÑO" dice 2023 y "AÑO MODELO" dice 2011, el valor correcto para "anio" es "2011" (NO "2023")
  * El campo "AÑO MODELO" suele estar en la parte derecha del documento, puede estar en texto pequeño o parcialmente cubierto por sellos/timbres
  * Si solo hay un campo "AÑO" sin "AÑO MODELO", entonces sí usar ese valor
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
- Ejemplo: "Bomba de aceite\\nFiltro de aire\\nPastillas de freno delanteras x2\\nCódigo OEM: 04465-0K090"

Reglas generales:
- Una imagen puede contener AMBOS tipos de info (vehículo + lista de partes)
- Si no hay info de vehículo, pon null en los campos de vehicle_info
- Si no hay texto de repuestos, pon string vacío en extracted_text
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
            text: 'Analiza esta imagen. Si es un documento vehicular o matrícula, extrae: modelo, motor, año, chasis, serie, placa, marca, cilindraje. Si es una lista de repuestos o autopartes, extrae todos los items.'
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
      extracted_text: parsed.extracted_text || '',
      description: parsed.description || '',
      raw_analysis: content
    };
  } catch {
    // If JSON parsing fails, return raw text
    return {
      vehicle_info: null,
      extracted_text: content,
      description: '',
      raw_analysis: content
    };
  }
}

/**
 * Analyze multiple images and merge results
 * @param {Array<{buffer: Buffer, mimeType: string}>} images
 * @returns {Promise<{ vehicle_info: object|null, extracted_texts: string[], descriptions: string[] }>}
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

  return {
    vehicle_info: mergedVehicle,
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
