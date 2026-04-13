import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { parseTicketText } from '../services/ticketParser.js';
import { uploadAttachment, getAttachments, getAttachmentUrl, transcribeAudio, analyzeMultipleImages } from '../services/mediaProcessor.js';
import { 
  generateControlBlock, 
  generateCustomerProformaBlock,
  generateAuxSeguimientoBlock,
  generateReenviosBlock,
  generateProveedorBlock,
  generateDespachosBlock,
  generateInternoBlock,
  generatePerSupplierBlocks,
  generateAuditoriaBlock
} from '../services/blockGenerator.js';
import { startSlaTimer, completeSla, getSlaStatus, resetSlaTimer, getPendingAlerts, calculateSlaDeadline } from '../services/slaService.js';
import { splitBySender } from '../services/whatsappSplitter.js';
import { acquireLock, releaseLock, extendLock, getLockStatus } from '../services/lockService.js';

const router = Router();

// Apply authentication to all routes
router.use(authenticate);

// Validation schemas
const createTicketSchema = z.object({
  group_code: z.string().min(1, 'Group code is required'),
  raw_text: z.string().min(1, 'Raw text is required')
});

const createTicketWithImagesSchema = z.object({
  group_code: z.string().min(1, 'Group code is required'),
  raw_text: z.string().min(1, 'Raw text is required'),
  has_images: z.boolean().optional().default(false)
});

const updateTicketSchema = z.object({
  status: z.enum(['pending', 'pending_review', 'in_progress', 'ready', 'pedido', 'closed', 'cancelled', 'en_revision', 'reenviado']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  is_venta_concreta: z.boolean().optional(),
  seller_notes: z.string().optional().nullable(),
  vehicle_info: z.object({
    marca: z.string().optional().nullable(),
    modelo: z.string().optional().nullable(),
    anio: z.string().optional().nullable(),
    placa: z.string().optional().nullable(),
    chasis: z.string().optional().nullable(),
    motor: z.string().optional().nullable(),
    serie: z.string().optional().nullable(),
    cilindraje: z.string().optional().nullable()
  }).optional().nullable()
});

/**
 * Valid status transitions per client spec §2:
 *   Pendiente → En Proceso → Listo → Pedido → Cerrado
 *   En Revisión is a special state for duplicates
 * 
 * Role-based transition rules per client spec §1:
 *   Operador: cannot change status (generate only)
 *   Vendedor: can transition to in_progress (via Take), ready, pedido, closed (only own tickets)
 *   Dispatcher: can manage en_revision, validate pedido, cannot close
 *   Admin: full control, can also unmerge
 */
const VALID_TRANSITIONS = {
  pending:        ['in_progress', 'en_revision', 'cancelled'],
  pending_review: ['in_progress', 'en_revision', 'cancelled'],
  in_progress:    ['ready', 'en_revision', 'cancelled'],
  ready:          ['pedido', 'in_progress', 'cancelled'],
  pedido:         ['closed'],
  en_revision:    ['pending', 'in_progress', 'cancelled'],
  closed:         [], // terminal state
  cancelled:      ['pending'], // admin can reopen
  reenviado:      ['pending', 'in_progress'] // can be restored if forwarding was a mistake
};

/** Roles allowed to make specific transitions */
const TRANSITION_ROLES = {
  // Seller transitions
  'in_progress→ready': ['seller', 'admin'],
  'ready→pedido': ['seller', 'dispatcher', 'admin'],
  'pedido→closed': ['seller', 'admin'], // only the assigned seller or admin
  // Dispatcher transitions
  'pending→en_revision': ['dispatcher', 'admin'],
  'pending_review→en_revision': ['dispatcher', 'admin'],
  'en_revision→pending': ['dispatcher', 'admin'],
  'en_revision→in_progress': ['dispatcher', 'admin'],
  // General
  'pending→in_progress': ['seller', 'dispatcher', 'admin'],
  'pending_review→in_progress': ['seller', 'dispatcher', 'admin'],
  'in_progress→en_revision': ['dispatcher', 'admin'],
  'in_progress→cancelled': ['dispatcher', 'admin'],
  'pending→cancelled': ['dispatcher', 'admin'],
  'pending_review→cancelled': ['dispatcher', 'admin'],
  'ready→cancelled': ['dispatcher', 'admin'],
  'ready→in_progress': ['seller', 'dispatcher', 'admin'],
  'en_revision→cancelled': ['dispatcher', 'admin'],
  'cancelled→pending': ['admin'],
  'reenviado→pending': ['dispatcher', 'admin'],
  'reenviado→in_progress': ['dispatcher', 'admin'],
};

const updateItemSchema = z.object({
  status: z.enum(['positive', 'negative', 'pending_info', 'no_registra', 'no_registra_verificar']).optional(),
  parsed_description: z.string().min(1).optional(),
  raw_line: z.string().min(1).optional(),
  source: z.enum(['importadora', 'almacen', 'distrimia']).optional().nullable(),
  cost_price: z.number().positive().optional().nullable(),
  selling_price: z.number().positive().optional().nullable(),
  supplier_code: z.string().optional().nullable(),
  brand: z.string().optional().nullable(),
  codigo_distrimia: z.string().optional().nullable(),
  codigo_oem: z.string().optional().nullable(),
  codigo_fabrica: z.string().optional().nullable(),
  audit_code_type: z.enum(['codigo_distrimia_con_oem', 'sin_oem', 'sin_oem_referencial', 'sin_codigo']).optional().nullable(),
  estimated_delivery: z.string().optional().nullable(),
  seller_note: z.string().optional().nullable(),
  internal_note: z.string().optional().nullable(),
  pedido_excluded: z.boolean().optional(),
  quantity: z.number().int().min(1).optional()
});

// Multer config for file uploads (images + audio)
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `distrimia-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (req, file, cb) => {
    const allowedImage = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const allowedAudio = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/m4a', 'audio/mp4', 'audio/x-m4a', 'audio/webm', 'audio/opus'];
    if ([...allowedImage, ...allowedAudio].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no soportado: ${file.mimetype}`));
    }
  }
});

/**
 * POST /api/tickets/analyze-images
 * Send images to GPT-4o Vision to extract vehicle plate info and item text
 * Returns structured data that can populate the generate form
 */
router.post('/analyze-images',
  authorize(['operator', 'seller', 'dispatcher', 'admin']),
  upload.array('images', 10),
  asyncHandler(async (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No se subieron imágenes', code: 'NO_FILES' });
    }

    const images = req.files.map(file => ({
      buffer: fs.readFileSync(file.path),
      mimeType: file.mimetype
    }));

    // Analyze all images with GPT-4o Vision
    const analysis = await analyzeMultipleImages(images);

    // Clean up temp files
    for (const file of req.files) {
      try { fs.unlinkSync(file.path); } catch {}
    }

    res.json({
      vehicle_info: analysis.vehicle_info,
      products: analysis.products || [],
      extracted_texts: analysis.extracted_texts,
      descriptions: analysis.descriptions,
      image_count: req.files.length
    });
  })
);

/**
 * POST /api/tickets/generate-from-audio
 * ONE-STEP: Upload audio → Whisper transcription → AI parse → create tickets
 * Operator uploads audio + group_code → gets created tickets back immediately
 */
router.post('/generate-from-audio',
  authorize(['operator', 'admin']),
  upload.array('audios', 10),
  asyncHandler(async (req, res) => {
    // Support both single 'audio' field (legacy) and multiple 'audios' field
    const files = req.files || (req.file ? [req.file] : []);
    if (files.length === 0) {
      return res.status(400).json({ error: 'No se subió archivo de audio', code: 'NO_FILE' });
    }
    
    const groupCode = req.body.group_code;
    if (!groupCode) {
      for (const f of files) { try { fs.unlinkSync(f.path); } catch {} }
      return res.status(400).json({ error: 'Código de grupo requerido', code: 'MISSING_GROUP' });
    }
    
    const userId = req.user.id;
    const additionalText = req.body.raw_text?.trim() || '';
    
    // Step 1: Whisper transcription for each audio file
    const transcriptions = [];
    for (const file of files) {
      const text = await transcribeAudio(file.path);
      if (text && text.trim()) {
        transcriptions.push(text.trim());
      }
    }

    // Clean up temp audio files
    for (const file of files) {
      try { fs.unlinkSync(file.path); } catch {}
    }

    const transcribedText = transcriptions.join('\n\n');
    
    if (!transcribedText) {
      return res.status(400).json({ 
        error: 'No se pudo transcribir el audio o está vacío', 
        code: 'EMPTY_TRANSCRIPTION' 
      });
    }
    
    // Combine: additional text + transcription
    const combinedText = additionalText
      ? `${additionalText}\n\n${transcribedText}`
      : transcribedText;
    
    // Step 2: AI parse (same as text generate)
    const parsed = await parseTicketText(combinedText, groupCode);
    
    // Step 3: Create tickets (reuse generate logic)
    const createdTickets = [];
    
    const allDuplicates = [];
    
    for (const ticketData of parsed.tickets) {
      // --- Duplicate detection (same as text generate) ---
      const ticketDuplicates = await findDuplicates(ticketData, groupCode);

      // Generate K-number
      const { data: kNumberResult, error: kError } = await supabaseAdmin
        .rpc('generate_k_number');
      
      if (kError) throw kError;
      const kNumber = kNumberResult;
      
      let duplicateLabel = null;
      let initialStatus = 'pending';
      
      let revisionOriginSellerId = null;
      if (ticketDuplicates.length > 0) {
        const bestDup = ticketDuplicates[0];
        duplicateLabel = bestDup.label;
        if (bestDup.similarity >= 0.7) {
          initialStatus = 'en_revision';
          // Store origin seller from the best duplicate match
          if (bestDup.ticket?.assigned_to) {
            revisionOriginSellerId = bestDup.ticket.assigned_to;
          }
        }
      }
      
      const { data: ticket, error: ticketError } = await supabaseAdmin
        .from('tickets')
        .insert({
          k_number: kNumber,
          group_code: groupCode,
          raw_text: combinedText,
          item_count: ticketData.item_count,
          length_class: ticketData.length_class,
          priority: ticketData.priority,
          status: initialStatus,
          vin: ticketData.vin,
          vehicle_info: ticketData.vehicle_info || null,
          possible_grouping: ticketData.possible_grouping,
          duplicate_label: duplicateLabel,
          revision_origin_seller_id: revisionOriginSellerId,
          created_by: userId,
          updated_by: userId
        })
        .select()
        .single();
      
      if (ticketError) throw ticketError;
      
      // Create items
      if (ticketData.items && ticketData.items.length > 0) {
        const itemsToInsert = ticketData.items.map(item => ({
          ticket_id: ticket.id,
          item_order: item.item_order,
          raw_line: item.raw_line,
          parsed_description: item.description,
          quantity: item.quantity || 1,
          status: 'pending_info'
        }));
        
        await supabaseAdmin.from('ticket_items').insert(itemsToInsert);
      }
      
      // Store duplicate references
      if (ticketDuplicates.length > 0) {
        for (const dup of ticketDuplicates) {
          try {
            await supabaseAdmin.from('duplicate_references').insert({
              ticket_id: ticket.id,
              duplicate_ticket_id: dup.ticket.id,
              similarity_score: Math.round(dup.similarity * 100),
              label: dup.label
            });
          } catch { /* non-critical */ }
        }
        allDuplicates.push(...ticketDuplicates.map(d => ({ ...d, for_ticket: ticket.k_number })));
      }
      
      // Log
      await supabaseAdmin.from('audit_log').insert({
        entity_type: 'ticket',
        entity_id: ticket.id,
        action: 'create',
        new_values: { source: 'audio', k_number: kNumber, group_code: groupCode, duplicates_found: ticketDuplicates.length, initial_status: initialStatus },
        performed_by: userId
      });
      
      createdTickets.push(ticket);
    }
    
    res.json({
      tickets: createdTickets,
      transcribed_text: transcribedText,
      combined_text: combinedText,
      parse_notes: parsed.parse_notes,
      duplicates: allDuplicates,
      source: additionalText ? 'text+audio' : 'audio'
    });
  })
);

/**
 * POST /api/tickets/generate
 * Generate tickets from raw WhatsApp text
 * Main entry point - "GENERAR TICKETS" button
 */
router.post('/generate', 
  authorize(['operator', 'admin']),
  asyncHandler(async (req, res) => {
    const validated = createTicketSchema.parse(req.body);
    const userId = req.user.id;
    
    // NOTE: Images are analyzed separately via /analyze-images endpoint.
    // The frontend appends vehicle info + extracted text to rawText before calling /generate.
    
    // --- STEP 1: Split WhatsApp group messages by sender ---
    const { detected: hasSenders, senderBlocks } = splitBySender(validated.raw_text);
    
    if (hasSenders) {
      console.log(`[GENERATE] WhatsApp sender split: ${senderBlocks.length} senders detected`);
    }
    
    const createdTickets = [];
    const allDuplicates = [];
    let allParseNotes = [];
    let consolidatedInto = null;
    
    // Process each sender block (1 block if no senders detected)
    for (const senderBlock of senderBlocks) {
      const blockRawText = senderBlock.rawText;
      
      // --- Time-window consolidation per client spec §3 ---
      const THREE_MINUTES_AGO = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      const consolidationQuery = supabaseAdmin
        .from('tickets')
        .select('id, k_number, item_count, raw_text')
        .eq('group_code', validated.group_code)
        .eq('created_by', userId)
        .gte('created_at', THREE_MINUTES_AGO)
        .in('status', ['pending', 'pending_review'])
        .order('created_at', { ascending: false })
        .limit(1);
      
      // If sender detected, also match by sender for consolidation
      if (senderBlock.sender) {
        consolidationQuery.eq('sender_name', senderBlock.sender);
      } else if (senderBlock.phone) {
        consolidationQuery.eq('sender_phone', senderBlock.phone);
      }
      
      const { data: recentSameGroup } = await consolidationQuery;
      
      // Parse this sender's text using AI
      const parsed = await parseTicketText(blockRawText, validated.group_code);
      if (parsed.parse_notes) allParseNotes.push(parsed.parse_notes);
      
      // If there's a recent ticket from the same sender within 3 min, consolidate
      if (recentSameGroup && recentSameGroup.length > 0) {
        const existingTicket = recentSameGroup[0];
        
        let maxOrder = 0;
        const { data: existingItems } = await supabaseAdmin
          .from('ticket_items')
          .select('item_order')
          .eq('ticket_id', existingTicket.id)
          .order('item_order', { ascending: false })
          .limit(1);
        
        if (existingItems && existingItems.length > 0) {
          maxOrder = existingItems[0].item_order;
        }
        
        for (const ticketData of parsed.tickets) {
          if (ticketData.items && ticketData.items.length > 0) {
            const itemsToInsert = ticketData.items.map((item, idx) => ({
              ticket_id: existingTicket.id,
              item_order: maxOrder + idx + 1,
              raw_line: item.raw_line,
              parsed_description: item.description,
              quantity: item.quantity || 1,
              status: item.status || 'pending_info'
            }));
            
            await supabaseAdmin.from('ticket_items').insert(itemsToInsert);
            maxOrder += ticketData.items.length;
          }
        }
        
        const { data: updatedTicket } = await supabaseAdmin
          .from('tickets')
          .update({
            item_count: maxOrder,
            raw_text: existingTicket.raw_text + '\n---\n' + blockRawText,
            updated_by: userId
          })
          .eq('id', existingTicket.id)
          .select()
          .single();
        
        consolidatedInto = updatedTicket || existingTicket;
        
        await supabaseAdmin.from('audit_log').insert({
          entity_type: 'ticket',
          entity_id: existingTicket.id,
          action: 'consolidate',
          new_values: { new_items_added: maxOrder - (existingTicket.item_count || 0), sender: senderBlock.sender },
          performed_by: userId
        });
        
        createdTickets.push(consolidatedInto);
        continue; // Next sender block
      }
      
      // --- Create new tickets for this sender ---
      for (const ticketData of parsed.tickets) {
        const ticketDuplicates = await findDuplicates(ticketData, validated.group_code);
        
        const { data: kNumberResult, error: kError } = await supabaseAdmin
          .rpc('generate_k_number');
        if (kError) throw kError;
        
        let duplicateLabel = null;
        let initialStatus = 'pending';
        let revisionOriginSellerId = null;
        
        if (ticketDuplicates.length > 0) {
          const bestDup = ticketDuplicates[0];
          duplicateLabel = bestDup.label;
          if (bestDup.similarity >= 0.7) {
            initialStatus = 'en_revision';
            if (bestDup.ticket?.assigned_to) {
              revisionOriginSellerId = bestDup.ticket.assigned_to;
            }
          }
        }
        
        const { data: ticket, error: ticketError } = await supabaseAdmin
          .from('tickets')
          .insert({
            k_number: kNumberResult,
            group_code: validated.group_code,
            raw_text: ticketData.raw_text,
            item_count: ticketData.item_count,
            length_class: ticketData.length_class,
            priority: ticketData.priority,
            status: initialStatus,
            vin: ticketData.vin,
            vehicle_info: ticketData.vehicle_info || null,
            possible_grouping: ticketData.possible_grouping,
            duplicate_label: duplicateLabel,
            revision_origin_seller_id: revisionOriginSellerId,
            sender_name: senderBlock.sender || null,
            sender_phone: senderBlock.phone || null,
            created_by: userId,
            updated_by: userId
          })
          .select()
          .single();
        
        if (ticketError) throw ticketError;
        
        if (ticketData.items && ticketData.items.length > 0) {
          const itemsToInsert = ticketData.items.map(item => ({
            ticket_id: ticket.id,
            item_order: item.item_order,
            raw_line: item.raw_line,
            parsed_description: item.description,
            quantity: item.quantity || 1,
            status: item.status || 'pending_info'
          }));
          
          const { error: itemsError } = await supabaseAdmin
            .from('ticket_items')
            .insert(itemsToInsert);
          if (itemsError) throw itemsError;
        }
        
        if (ticketDuplicates.length > 0) {
          for (const dup of ticketDuplicates) {
            try {
              await supabaseAdmin.from('duplicate_references').insert({
                ticket_id: ticket.id,
                duplicate_ticket_id: dup.ticket.id,
                similarity_score: Math.round(dup.similarity * 100),
                label: dup.label
              });
            } catch (err) {
              console.error('Failed to store duplicate reference:', err.message);
            }
          }
          allDuplicates.push(...ticketDuplicates.map(d => ({ ...d, for_ticket: ticket.k_number })));
        }
        
        await supabaseAdmin.from('audit_log').insert({
          entity_type: 'ticket',
          entity_id: ticket.id,
          action: 'create',
          new_values: { k_number: kNumberResult, item_count: ticketData.item_count, duplicates_found: ticketDuplicates.length, initial_status: initialStatus, sender: senderBlock.sender },
          performed_by: userId
        });
        
        createdTickets.push(ticket);
      }
    }
    
    // Build response
    const hasConsolidation = consolidatedInto !== null && createdTickets.length === 1;
    const parseNotes = allParseNotes.filter(Boolean).join(' | ');
    const senderNote = hasSenders ? `${senderBlocks.length} remitentes detectados en el grupo` : '';
    const combinedNotes = [senderNote, parseNotes].filter(Boolean).join(' — ');
    
    if (hasConsolidation) {
      return res.status(200).json({
        message: `\u2705 Consolidado en ticket existente #${consolidatedInto.k_number} (ventana de 3 min)`,
        tickets_created: 0,
        tickets: [consolidatedInto],
        consolidated: true,
        consolidated_into: consolidatedInto.k_number,
        parse_notes: combinedNotes,
        duplicates: [],
        senders_detected: hasSenders ? senderBlocks.length : 0
      });
    }
    
    res.status(201).json({
      message: `\u2705 Se crearon ${createdTickets.length} tickets`,
      tickets_created: createdTickets.length,
      tickets: createdTickets,
      parse_notes: combinedNotes,
      duplicates: allDuplicates,
      senders_detected: hasSenders ? senderBlocks.length : 0
    });
  })
);

/**
 * Find potential duplicate tickets by comparing item descriptions.
 * 
 * Strategy:
 *  1. Normalize item text (lowercase, strip accents, remove filler words)
 *  2. Extract key tokens: part name tokens, vehicle tokens, year, numbers
 *  3. Compare using weighted Jaccard: vehicle+year matches weigh more
 *  4. Classify label per spec §10.1
 */
async function findDuplicates(ticketData, groupCode) {
  try {
    // Look back 30 days for potential duplicates
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
    
    if (error || !recentTickets || recentTickets.length === 0) return [];
    
    // Fetch items for recent tickets (including price/brand for label logic)
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
    
    // Normalize new ticket item texts
    const newItemTokenSets = (ticketData.items || [])
      .map(i => normalizeForComparison(i.description || i.raw_line || ''))
      .filter(ts => ts.allTokens.length > 0);
    
    // Normalize the new ticket's raw_text for direct text comparison
    const newRawTokens = normalizeForComparison(ticketData.raw_text || '');
    
    if (newItemTokenSets.length === 0 && newRawTokens.allTokens.length === 0) return [];
    
    // New ticket's vehicle info for comparison
    const newVehicle = ticketData.vehicle_info || null;
    
    const duplicates = [];
    
    for (const existing of recentTickets) {
      // --- STEP 1: Vehicle must match first ---
      const vehicleResult = compareVehicles(newVehicle, existing.vehicle_info);
      
      // If vehicles are clearly different → NOT a duplicate, skip
      if (!vehicleResult.match) continue;

      // --- STEP 2: Only evaluate items if vehicle passed ---
      const existingItems = itemsByTicket[existing.id] || [];
      const existingTokenSets = existingItems
        .map(i => normalizeForComparison(i.parsed_description || i.raw_line || ''))
        .filter(ts => ts.allTokens.length > 0);
      
      // Item-level similarity
      let itemSimilarity = 0;
      if (newItemTokenSets.length > 0 && existingTokenSets.length > 0) {
        let totalScore = 0;
        for (const newTS of newItemTokenSets) {
          let bestMatch = 0;
          for (const existTS of existingTokenSets) {
            const sim = tokenSetSimilarity(newTS, existTS);
            bestMatch = Math.max(bestMatch, sim);
          }
          totalScore += bestMatch;
        }
        itemSimilarity = totalScore / newItemTokenSets.length;
      }
      
      // Raw text similarity (fallback for when items differ or don't exist yet)
      let rawTextSimilarity = 0;
      if (existing.raw_text && newRawTokens.allTokens.length > 0) {
        const existingRawTokens = normalizeForComparison(existing.raw_text);
        if (existingRawTokens.allTokens.length > 0) {
          rawTextSimilarity = tokenSetSimilarity(newRawTokens, existingRawTokens);
        }
      }
      
      // Use the higher of the two signals
      let similarity = Math.max(itemSimilarity, rawTextSimilarity);
      
      // --- STEP 3: Vehicle-aware scoring ---
      if (vehicleResult.confidence === 'same') {
        // Same vehicle confirmed (marca+modelo+cilindraje) → boost
        similarity = Math.min(1.0, similarity * 1.25 + 0.1);
      }
      // 'compatible' → no boost (same base model but different detail level)
      // 'unknown' (vehicle info missing) → require higher threshold
      const threshold = vehicleResult.confidence === 'unknown' ? 0.8 : 0.5;
      
      if (similarity >= threshold) {
        const label = classifyDuplicateLabel(existing, existingItems);
        
        console.log(`[DUP] New ticket vs #${existing.k_number} (grp:${existing.group_code}): itemSim=${itemSimilarity.toFixed(2)} rawSim=${rawTextSimilarity.toFixed(2)} final=${similarity.toFixed(2)} vehicle=${vehicleResult.confidence} threshold=${threshold} label=${label}`);
        
        duplicates.push({
          ticket: existing,
          similarity: Math.round(similarity * 100) / 100,
          label
        });
      }
    }
    
    // Sort per spec §10.2: positive first, then neutral, then negative
    // Within same label, sort by similarity desc
    const labelOrder = { dup_positive: 0, dup_neutral: 1, dup_negative: 2 };
    duplicates.sort((a, b) => {
      const orderDiff = (labelOrder[a.label] ?? 1) - (labelOrder[b.label] ?? 1);
      return orderDiff !== 0 ? orderDiff : b.similarity - a.similarity;
    });
    
    if (duplicates.length === 0) {
      console.log(`[DUP] No duplicates found. Checked ${recentTickets.length} tickets, newItems=${newItemTokenSets.length}, rawTokens=${newRawTokens.allTokens.length}, newVehicle=${JSON.stringify(newVehicle)}`);
    }
    
    return duplicates.slice(0, 10); // Max 10 duplicates
  } catch (err) {
    console.error('Duplicate detection error:', err);
    return [];
  }
}

/**
 * Compare vehicle info between two tickets.
 * Returns: { match: boolean, confidence: 'same'|'compatible'|'unknown'|'different' }
 *   - 'same': both have vehicle info and marca/modelo match → strong duplicate signal
 *   - 'compatible': partial info overlap, can't rule out match
 *   - 'unknown': one or both lack vehicle info entirely
 *   - 'different': both have vehicle info and they clearly differ → NOT a duplicate
 */
function compareVehicles(vehicleA, vehicleB) {
  const hasA = vehicleA && Object.values(vehicleA).some(Boolean);
  const hasB = vehicleB && Object.values(vehicleB).some(Boolean);

  // If neither has vehicle info, can't compare
  if (!hasA && !hasB) return { match: true, confidence: 'unknown' };
  // If only one has vehicle info, allow comparison but flag as unknown
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

  // If both have a distinguishing field and they differ → DIFFERENT vehicle
  if (marcaA && marcaB && marcaA !== marcaB) return { match: false, confidence: 'different' };
  if (anioA && anioB && anioA !== anioB) return { match: false, confidence: 'different' };
  if (motorA && motorB && motorA !== motorB) return { match: false, confidence: 'different' };
  if (placaA && placaB && placaA !== placaB) return { match: false, confidence: 'different' };
  if (chasisA && chasisB && chasisA !== chasisB) return { match: false, confidence: 'different' };
  
  // Special handling for model + cilindraje (e.g., Sail 1400 vs Sail 1500)
  if (modelA && modelB && modelA === modelB) {
    if (cilA && cilB && cilA !== cilB) {
      // Same model but different engine size → different vehicles
      return { match: false, confidence: 'different' };
    }
  }
  if (modelA && modelB && modelA !== modelB) return { match: false, confidence: 'different' };
  if (cilA && cilB && cilA !== cilB) return { match: false, confidence: 'different' };

  // If marca or modelo matches → check specificity gap
  const marcaMatch = marcaA && marcaB && marcaA === marcaB;
  const modelMatch = modelA && modelB && modelA === modelB;

  if (marcaMatch || modelMatch) {
    // If both have cilindraje and match → same vehicle
    if (cilA && cilB) {
      return { match: true, confidence: 'same' };
    }
    // Missing cilindraje on one side → compatible (not unknown)
    return { match: true, confidence: 'compatible' };
  }

  return { match: true, confidence: 'compatible' };
}

// Legacy wrapper used in other code paths
function vehicleModelsMatch(vehicleA, vehicleB) {
  return compareVehicles(vehicleA, vehicleB).match;
}

/**
 * Classify a duplicate label per spec §10.1:
 * 
 * 🟢 DUP_POSITIVE: at least one item with price/brand/confirmed availability OR ticket status Ready
 * 🔴 DUP_NEGATIVE: all items marked no disponible / no registra / not handled (closed negative)
 * 🟡 DUP_NEUTRAL:  exists but no clear positive/negative closure
 */
function classifyDuplicateLabel(existingTicket, existingItems) {
  // Check for positive indicators
  const hasPositiveItem = existingItems.some(i => 
    i.status === 'positive' && (i.selling_price || i.brand || i.validity_status === 'vigente')
  );
  const isTicketReady = existingTicket.status === 'ready';
  
  if (hasPositiveItem || isTicketReady) {
    return 'dup_positive';
  }
  
  // Check for negative indicators
  const allNegative = existingItems.length > 0 && existingItems.every(i => 
    i.status === 'negative' || i.status === 'no_registra'
  );
  const isTicketClosed = existingTicket.status === 'closed' || existingTicket.status === 'cancelled';
  
  if (allNegative || isTicketClosed) {
    return 'dup_negative';
  }
  
  return 'dup_neutral';
}

// ---- Text normalization & similarity for auto parts ----

/** Spanish stop/filler words to remove before comparison */
const STOP_WORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'para', 'por', 'con', 'en', 'y', 'o', 'a', 'al', 'se', 'su', 'que',
  'es', 'lo', 'como', 'más', 'mas', 'no', 'si', 'me', 'mi', 'te',
  'necesito', 'necesita', 'busco', 'busca', 'requiero', 'requiere',
  'quiero', 'favor', 'por favor', 'urgente', 'rapido', 'rápido',
]);

/** Strip accents/diacritics */
function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normalize a text string into token sets for comparison.
 * Returns { allTokens, yearTokens, numberTokens, partTokens, oemTokens }
 * 
 * Key: hyphenated alphanumeric codes (OEM part numbers like 26300-35503)
 * are preserved as single tokens, NOT split into separate numbers.
 */
function normalizeForComparison(text) {
  if (!text) return { allTokens: [], yearTokens: [], numberTokens: [], partTokens: [], oemTokens: [] };
  
  let normalized = stripAccents(text.toLowerCase().trim());
  
  // Step 1: Extract and preserve OEM part codes (alphanumeric-hyphen patterns like 26300-35503, 1KR-FE)
  const oemCodes = [];
  normalized = normalized.replace(/\b([a-z0-9]{2,}(?:-[a-z0-9]{2,})+)\b/g, (match) => {
    oemCodes.push(match);
    return ' '; // remove from text so it doesn't get double-counted
  });
  
  // Step 2: Strip remaining punctuation, normalize spaces
  normalized = normalized
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const words = normalized.split(' ').filter(w => w.length >= 2 && !STOP_WORDS.has(w));
  
  // Classify tokens
  const yearTokens = [];
  const numberTokens = [];
  const partTokens = [];
  const oemTokens = oemCodes; // full OEM codes preserved with hyphens
  
  for (const w of words) {
    if (/^(19|20)\d{2}$/.test(w)) {
      yearTokens.push(w); // Year like 2020
    } else if (/^\d+$/.test(w)) {
      numberTokens.push(w); // Pure number
    } else {
      partTokens.push(w); // Part/vehicle name token
    }
  }
  
  // allTokens includes everything for Jaccard calculation
  const allTokens = [...words, ...oemCodes];
  
  return { allTokens, yearTokens, numberTokens, partTokens, oemTokens };
}

/**
 * Weighted token-set similarity for auto parts.
 * 
 * Scoring strategy:
 *  - OEM code exact match (e.g. "26300-35503"): very high weight (worth 3 normal tokens)
 *  - Part name tokens (e.g. "filtro", "aceite"): standard weight (1.0)
 *  - Year tokens: bonus if matching
 *  - Number-only tokens: reduced weight (0.3) — common prefixes like "26300" alone are weak signals
 *  - Fuzzy part matches: half credit
 */
function tokenSetSimilarity(ts1, ts2) {
  if (ts1.allTokens.length === 0 && ts2.allTokens.length === 0) return 1;
  if (ts1.allTokens.length === 0 || ts2.allTokens.length === 0) return 0;
  
  // --- Weighted scoring instead of simple Jaccard ---
  let weightedIntersection = 0;
  let weightedUnion = 0;
  
  // 1. OEM codes (highest value — full part number match is very specific)
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
  
  // 2. Part name tokens (standard value)
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
  
  // 3. Number-only tokens (low value — generic numbers like "26300" are weak signals)
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
  
  // 4. Fuzzy matching bonus for part tokens (e.g. "parabris" ≈ "parabrisas")
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
  
  // 5. Year match bonus
  const yearMatch = ts1.yearTokens.length > 0 && ts2.yearTokens.length > 0 &&
    ts1.yearTokens.some(y => ts2.yearTokens.includes(y));
  const yearBonus = yearMatch ? 0.1 : 0;
  
  return Math.min(1.0, baseScore + fuzzyScore * 0.15 + yearBonus);
}

/**
 * Fuzzy match: returns true if one token starts with the other (min 4 chars)
 * or if Levenshtein distance is <= 2 for tokens of length >= 5.
 */
function fuzzyMatch(a, b) {
  if (a.length < 4 || b.length < 4) return false;
  
  // Prefix match (e.g. "parabris" matches "parabrisas")
  if (a.startsWith(b) || b.startsWith(a)) return true;
  
  // Levenshtein for tokens >= 5 chars
  if (a.length >= 5 && b.length >= 5) {
    return levenshteinDistance(a, b) <= 2;
  }
  
  return false;
}

/**
 * Levenshtein distance between two strings
 */
function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,     // deletion
        matrix[i][j - 1] + 1,     // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return matrix[b.length][a.length];
}

/**
 * GET /api/tickets/alerts/pending
 * Get pending ticket alerts (tickets not taken after 5 and 10 minutes)
 * Per client spec §7: Only visible to Dispatcher and Admin
 * NOTE: Must be defined BEFORE /:id routes to avoid matching "alerts" as a ticket ID
 */
router.get('/alerts/pending',
  authorize(['dispatcher', 'admin']),
  asyncHandler(async (req, res) => {
    const alerts = await getPendingAlerts();
    res.json(alerts);
  })
);

/**
 * GET /api/tickets
 * List tickets with pagination and filters
 */
router.get('/', asyncHandler(async (req, res) => {
  const { 
    page = 1, 
    limit = 20, 
    status, 
    priority, 
    group_code,
    search,
    sort_by = 'created_at',
    sort_order = 'desc',
    assigned_to
  } = req.query;
  
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const userRole = req.user.role;
  const userId = req.user.id;
  
  let query = supabaseAdmin
    .from('tickets')
    .select(`
      *,
      created_by_user:users!tickets_created_by_fkey(id, full_name),
      locked_by_user:users!tickets_locked_by_fkey(id, full_name),
      assigned_to_user:users!tickets_assigned_to_fkey(id, full_name),
      revision_origin_seller:users!tickets_revision_origin_seller_id_fkey(id, full_name)
    `, { count: 'exact' });
  
  // Per client spec §1: Seller only sees their own assigned tickets
  // (except pending tickets which are available for anyone to take)
  // Also: sellers see en_revision tickets where they are the origin seller
  if (userRole === 'seller') {
    query = query.or(`status.eq.pending,status.eq.pending_review,assigned_to.eq.${userId},revision_origin_seller_id.eq.${userId}`);
  }
  
  // Per client spec §1: Operator cannot see ticket work queue (generate only)
  // They can still view the list for reference but won't see action buttons
  
  // Apply filters (support comma-separated statuses like 'pending,en_revision')
  if (status && status !== 'all') {
    if (status.includes(',')) {
      const statuses = status.split(',').map(s => s.trim());
      query = query.in('status', statuses);
    } else {
      query = query.eq('status', status);
    }
  } else if (!status) {
    // Default: exclude terminal statuses from the active work queue
    query = query.not('status', 'in', '("closed","cancelled","reenviado")');
  }
  // status === 'all' → no filter applied, returns everything
  if (priority) query = query.eq('priority', priority);
  if (group_code) query = query.eq('group_code', group_code);
  if (search) query = query.ilike('k_number', `%${search}%`);
  if (assigned_to) query = query.eq('assigned_to', assigned_to);
  
  // Exclude merged tickets by default
  query = query.eq('is_merged', false);
  
  // Apply sorting
  query = query.order(sort_by, { ascending: sort_order === 'asc' });
  
  // Apply pagination
  query = query.range(offset, offset + parseInt(limit) - 1);
  
  const { data, error, count } = await query;
  
  if (error) throw error;
  
  // Add SLA status to each ticket
  const ticketsWithSla = data.map(ticket => ({
    ...ticket,
    sla_status: getSlaStatus(ticket)
  }));
  
  res.json({
    tickets: ticketsWithSla,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: count,
      total_pages: Math.ceil(count / parseInt(limit))
    }
  });
}));

/**
 * GET /api/tickets/:id
 * Get single ticket with items and blocks (lazy loaded)
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  // Get ticket
  const { data: ticket, error: ticketError } = await supabaseAdmin
    .from('tickets')
    .select(`
      *,
      created_by_user:users!tickets_created_by_fkey(id, full_name, email),
      locked_by_user:users!tickets_locked_by_fkey(id, full_name, email),
      assigned_to_user:users!tickets_assigned_to_fkey(id, full_name),
      revision_origin_seller:users!tickets_revision_origin_seller_id_fkey(id, full_name)
    `)
    .eq('id', id)
    .single();
  
  if (ticketError) {
    if (ticketError.code === 'PGRST116') {
      return res.status(404).json({ error: 'Ticket not found', code: 'NOT_FOUND' });
    }
    throw ticketError;
  }
  
  // Get items
  const { data: items, error: itemsError } = await supabaseAdmin
    .from('ticket_items')
    .select('*')
    .eq('ticket_id', id)
    .order('item_order', { ascending: true });
  
  if (itemsError) throw itemsError;

  // Fetch alternatives for all items in this ticket
  const itemIds = (items || []).map(i => i.id);
  let alternatives = [];
  if (itemIds.length > 0) {
    const { data: alts } = await supabaseAdmin
      .from('ticket_item_alternatives')
      .select('*')
      .in('ticket_item_id', itemIds)
      .order('created_at', { ascending: true });
    alternatives = alts || [];
  }
  // Attach alternatives to their parent items
  const itemsWithAlts = (items || []).map(item => ({
    ...item,
    alternatives: alternatives.filter(a => a.ticket_item_id === item.id)
  }));
  
  // Generate blocks lazily (only when ticket is opened)
  const blocks = {
    control: generateControlBlock(ticket),
    proforma_cliente: generateCustomerProformaBlock(ticket, itemsWithAlts)
  };
  
  // Get lock status
  const lockStatus = await getLockStatus(id);
  
  // Get extensions
  const { data: extensions } = await supabaseAdmin
    .from('tickets')
    .select('id, k_number, group_code, status, created_at, extension_group_code')
    .eq('parent_ticket_id', id);
  
  // Load stored duplicates from DB first
  let duplicates = [];
  try {
    const { data: storedDups } = await supabaseAdmin
      .from('duplicate_references')
      .select(`
        id, similarity_score, label,
        duplicate_ticket:tickets!duplicate_references_duplicate_ticket_id_fkey(
          id, k_number, group_code, status, priority, item_count, created_at, sla_exceeded
        )
      `)
      .eq('ticket_id', id);
    
    if (storedDups && storedDups.length > 0) {
      duplicates = storedDups
        .filter(d => d.duplicate_ticket)
        .map(d => ({
          ticket: d.duplicate_ticket,
          similarity: (d.similarity_score || 0) / 100,
          label: d.label || 'dup_neutral'
        }));
    }
    
    // Also check reverse direction (this ticket might be a duplicate OF another)
    const { data: reverseDups } = await supabaseAdmin
      .from('duplicate_references')
      .select(`
        id, similarity_score, label,
        source_ticket:tickets!duplicate_references_ticket_id_fkey(
          id, k_number, group_code, status, priority, item_count, created_at, sla_exceeded
        )
      `)
      .eq('duplicate_ticket_id', id);
    
    if (reverseDups && reverseDups.length > 0) {
      const existingIds = new Set(duplicates.map(d => d.ticket.id));
      for (const rd of reverseDups) {
        if (rd.source_ticket && !existingIds.has(rd.source_ticket.id)) {
          duplicates.push({
            ticket: rd.source_ticket,
            similarity: (rd.similarity_score || 0) / 100,
            label: rd.label || 'dup_neutral'
          });
        }
      }
    }
    
    // If no stored duplicates, do live detection
    if (duplicates.length === 0) {
      const ticketData = {
        items: items.map(i => ({
          description: i.parsed_description,
          raw_line: i.raw_line
        }))
      };
      const liveDups = await findDuplicates(ticketData, ticket.group_code);
      duplicates = liveDups.filter(d => d.ticket.id !== id);
    }
  } catch (err) {
    console.error('Duplicate detection failed:', err);
  }
  
  res.json({
    ticket: {
      ...ticket,
      sla_status: getSlaStatus(ticket)
    },
    items: itemsWithAlts,
    blocks,
    lock_status: lockStatus,
    extensions: extensions || [],
    duplicates
  });
}));

/**
 * PUT /api/tickets/:id
 * Update ticket
 */
router.put('/:id', 
  authorize(['dispatcher', 'seller', 'admin']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const validated = updateTicketSchema.parse(req.body);
    const userId = req.user.id;
    const userRole = req.user.role;
    
    // Single fetch: get current ticket + lock state in one query (replaces separate getLockStatus + fetch)
    const { data: currentTicket } = await supabaseAdmin
      .from('tickets')
      .select('status, priority, assigned_to, locked_by, lock_expires_at, sla_deadline')
      .eq('id', id)
      .single();
    
    if (!currentTicket) {
      return res.status(404).json({ error: 'Ticket not found', code: 'NOT_FOUND' });
    }
    
    // Check lock inline (skip separate getLockStatus call)
    // Skip lock check for pedido-related transitions (pedido→closed, ready→pedido)
    // Skip lock check for vehicle_info-only updates (metadata, not item work)
    const isPedidoFlow = currentTicket.status === 'pedido' || (validated.status === 'pedido' && currentTicket.status === 'ready');
    const isVehicleOnlyUpdate = validated.vehicle_info && !validated.status && !validated.priority;
    if (!isPedidoFlow && !isVehicleOnlyUpdate && currentTicket.locked_by && currentTicket.locked_by !== userId && userRole !== 'admin' && userRole !== 'dispatcher') {
      const lockExpiry = new Date(currentTicket.lock_expires_at);
      if (lockExpiry > new Date()) {
        return res.status(423).json({ error: 'Ticket is locked by another user', code: 'TICKET_LOCKED' });
      }
    }
    
    // Sellers cannot modify en_revision tickets (only dispatcher/admin can)
    if (userRole === 'seller' && currentTicket.status === 'en_revision') {
      return res.status(403).json({
        error: 'Este ticket está en revisión. Solo un Dispatcher o Admin puede gestionarlo.',
        code: 'EN_REVISION_BLOCKED'
      });
    }
    
    // --- Enforce status transition rules per client spec §1-§2 ---
    if (validated.status && validated.status !== currentTicket.status) {
      const fromStatus = currentTicket.status;
      const toStatus = validated.status;
      
      // Check if transition is valid
      const allowedTransitions = VALID_TRANSITIONS[fromStatus] || [];
      if (!allowedTransitions.includes(toStatus)) {
        return res.status(400).json({
          error: `Transición de estado no válida: ${fromStatus} → ${toStatus}`,
          code: 'INVALID_TRANSITION',
          allowed: allowedTransitions
        });
      }
      
      // Check if user's role is allowed for this transition
      const transitionKey = `${fromStatus}→${toStatus}`;
      const allowedRoles = TRANSITION_ROLES[transitionKey];
      if (allowedRoles && !allowedRoles.includes(userRole)) {
        return res.status(403).json({
          error: `Tu rol (${userRole}) no puede realizar esta transición: ${fromStatus} → ${toStatus}`,
          code: 'ROLE_FORBIDDEN'
        });
      }
      
      // Per client spec §8: Only the assigned seller can close (pedido → closed)
      if (toStatus === 'closed' && userRole === 'seller') {
        if (currentTicket.assigned_to !== userId) {
          return res.status(403).json({
            error: 'Solo el vendedor responsable puede cerrar este ticket',
            code: 'NOT_ASSIGNED_SELLER'
          });
        }
      }
      
      // Per client spec §8: Dispatcher cannot close tickets
      if (toStatus === 'closed' && userRole === 'dispatcher') {
        return res.status(403).json({
          error: 'El dispatcher no puede cerrar tickets',
          code: 'DISPATCHER_CANNOT_CLOSE'
        });
      }
    }
    
    // Build update data
    const updateData = {
      ...validated,
      updated_by: userId
    };
    
    // Track closed_at timestamp per client spec §8
    if (validated.status === 'closed' && currentTicket.status !== 'closed') {
      updateData.closed_at = new Date().toISOString();
    }
    
    // Auto-release lock when transitioning to ready/closed (saves a separate API call from frontend)
    if (validated.status && ['ready', 'closed'].includes(validated.status)) {
      updateData.locked_by = null;
      updateData.locked_at = null;
      updateData.lock_expires_at = null;
    }
    
    // If marking as ready, compute SLA completion inline (saves separate completeSla fetch+update)
    if (validated.status === 'ready' && currentTicket.status !== 'ready') {
      const completedAt = new Date();
      updateData.sla_completed_at = completedAt.toISOString();
      updateData.sla_exceeded = currentTicket.sla_deadline ? completedAt > new Date(currentTicket.sla_deadline) : false;
    }
    
    // Single update with all changes combined
    const { data: ticket, error } = await supabaseAdmin
      .from('tickets')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    // Per client spec §6: Reset SLA timer on activity (status change back to in_progress)
    if (validated.status && validated.status !== currentTicket.status && 
        validated.status === 'in_progress') {
      resetSlaTimer(id).catch(e => console.error('Failed to reset SLA timer:', e));
    }
    
    // Respond immediately
    res.json({ ticket });
    
    // Fire-and-forget: audit log (non-blocking)
    supabaseAdmin.from('audit_log').insert({
      entity_type: 'ticket',
      entity_id: id,
      action: 'update',
      old_values: { status: currentTicket.status, priority: currentTicket.priority },
      new_values: validated,
      performed_by: userId
    }).then(null, e => console.error('Audit log failed:', e));
  })
);

/**
 * POST /api/tickets/:id/take
 * Take ticket (acquire lock and start SLA)
 */
router.post('/:id/take',
  authorize(['seller', 'admin']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const now = new Date();
    const LOCK_TIMEOUT = parseInt(process.env.LOCK_TIMEOUT_MINUTES || '10');
    const expiresAt = new Date(now.getTime() + LOCK_TIMEOUT * 60 * 1000);
    
    // Single fetch: get ticket + lock state in one query
    const { data: currentTicket, error: fetchErr } = await supabaseAdmin
      .from('tickets')
      .select('id, assigned_to, status, item_count, locked_by, lock_expires_at')
      .eq('id', id)
      .single();
    
    if (fetchErr || !currentTicket) {
      return res.status(404).json({ error: 'Ticket not found', code: 'NOT_FOUND' });
    }
    
    // Validation checks (no extra DB calls needed)
    if (currentTicket.assigned_to && currentTicket.assigned_to !== userId) {
      return res.status(423).json({ error: 'Este ticket ya fue tomado por otro vendedor', code: 'ALREADY_TAKEN' });
    }
    if (req.user.role === 'seller' && currentTicket.status === 'en_revision') {
      return res.status(403).json({ error: 'Este ticket está en revisión y no puede ser tomado', code: 'EN_REVISION_BLOCKED' });
    }
    // Check lock inline (skip separate acquireLock fetch)
    if (currentTicket.locked_by && currentTicket.locked_by !== userId && new Date(currentTicket.lock_expires_at) > now) {
      return res.status(423).json({ error: 'Ticket is locked by another user', code: 'LOCKED_BY_OTHER' });
    }
    
    // Single combined update: lock + SLA + status + assignment
    const slaDeadline = calculateSlaDeadline(currentTicket.item_count, now);
    const updateData = {
      locked_by: userId,
      locked_at: now.toISOString(),
      lock_expires_at: expiresAt.toISOString(),
      sla_started_at: now.toISOString(),
      sla_deadline: slaDeadline.toISOString(),
      sla_exceeded: false,
      assigned_to: userId,
      assigned_at: now.toISOString(),
      updated_by: userId
    };
    if (currentTicket.status === 'pending' || currentTicket.status === 'pending_review') {
      updateData.status = 'in_progress';
    }
    
    const { data: updatedTicket, error: updateErr } = await supabaseAdmin
      .from('tickets')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    
    if (updateErr) throw updateErr;
    
    // Respond immediately — audit log in background (non-blocking)
    res.json({
      message: 'Ticket tomado exitosamente',
      ticket: updatedTicket,
      lock_expires_at: expiresAt.toISOString()
    });
    
    // Fire-and-forget: audit log
    supabaseAdmin.from('audit_log').insert({
      entity_type: 'ticket',
      entity_id: id,
      action: 'take',
      new_values: { assigned_to: userId, assigned_at: updateData.assigned_at },
      performed_by: userId
    }).then(null, e => console.error('Audit log failed:', e));
  })
);

/**
 * POST /api/tickets/:id/release
 * Release ticket (release lock)
 */
router.post('/:id/release',
  authorize(['seller', 'dispatcher', 'admin']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const { force } = req.body;
    
    // Only admin/dispatcher can force release
    if (force && !['admin', 'dispatcher'].includes(req.user.role)) {
      return res.status(403).json({
        error: 'Only admin or dispatcher can force release',
        code: 'FORBIDDEN'
      });
    }
    
    const result = await releaseLock(id, userId, force);
    
    if (!result.success) {
      return res.status(400).json(result);
    }
    
    // Per client spec: releasing a ticket sends it back to 'pending'
    // so another seller can pick it up (not left stuck in 'in_progress')
    const ticket = result.ticket;
    if (ticket.status === 'in_progress') {
      const { data: updatedTicket } = await supabaseAdmin
        .from('tickets')
        .update({
          status: 'pending',
          assigned_to: null,
          assigned_at: null,
          updated_by: userId
        })
        .eq('id', id)
        .select()
        .single();
      
      // Reset SLA since ticket goes back to queue
      await resetSlaTimer(id);
      
      await supabaseAdmin.from('audit_log').insert({
        entity_type: 'ticket',
        entity_id: id,
        action: 'release_to_pending',
        new_values: { previous_status: 'in_progress', new_status: 'pending' },
        performed_by: userId
      });
      
      return res.json({
        message: 'Ticket liberado y enviado a pendiente',
        ticket: updatedTicket || ticket
      });
    }
    
    res.json({
      message: 'Ticket released successfully',
      ticket: result.ticket
    });
  })
);

/**
 * POST /api/tickets/:id/extend-lock
 * Extend lock timeout
 */
router.post('/:id/extend-lock',
  authorize(['seller', 'admin']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    
    const result = await extendLock(id, userId);
    
    if (!result.success) {
      return res.status(400).json(result);
    }
    
    res.json({
      message: 'Lock extended successfully',
      expires_at: result.expires_at
    });
  })
);

/**
 * PUT /api/tickets/:ticketId/items/bulk-status
 * Update all items in a ticket to a given status at once
 */
const bulkStatusSchema = z.object({
  status: z.enum(['positive', 'negative', 'pending_info', 'no_registra', 'no_registra_verificar'])
});

router.put('/:ticketId/items/bulk-status',
  authorize(['seller', 'dispatcher', 'admin']),
  asyncHandler(async (req, res) => {
    const { ticketId } = req.params;
    const validated = bulkStatusSchema.parse(req.body);
    const userId = req.user.id;

    // Check ticket exists and is not closed/cancelled
    const { data: ticket, error: ticketErr } = await supabaseAdmin
      .from('tickets')
      .select('id, status')
      .eq('id', ticketId)
      .single();

    if (ticketErr || !ticket) {
      return res.status(404).json({ error: 'Ticket no encontrado', code: 'NOT_FOUND' });
    }
    if (['closed', 'cancelled'].includes(ticket.status)) {
      return res.status(400).json({ error: 'No se pueden modificar ítems de un ticket cerrado o cancelado', code: 'TICKET_CLOSED' });
    }

    // Check ticket lock
    const lockStatus = await getLockStatus(ticketId);
    if (lockStatus.locked && lockStatus.locked_by !== userId) {
      return res.status(423).json({ error: 'Ticket is locked by another user', code: 'TICKET_LOCKED' });
    }

    // Update all items
    const { data: updatedItems, error: updateErr } = await supabaseAdmin
      .from('ticket_items')
      .update({ status: validated.status, updated_at: new Date().toISOString() })
      .eq('ticket_id', ticketId)
      .select();

    if (updateErr) throw updateErr;

    // Audit log
    await supabaseAdmin.from('audit_log').insert({
      entity_type: 'ticket',
      entity_id: ticketId,
      action: 'bulk_status_update',
      new_values: { status: validated.status, items_affected: updatedItems?.length || 0 },
      performed_by: userId
    });

    res.json({ message: `${updatedItems?.length || 0} items actualizados a ${validated.status}`, items: updatedItems });
  })
);

/**
 * POST /api/tickets/:ticketId/items/:itemId/alternatives
 * Add a brand/price alternative to an existing item
 */
const addAlternativeSchema = z.object({
  brand: z.string().min(1, 'Marca es requerida'),
  selling_price: z.number().positive().optional().nullable(),
  cost_price: z.number().positive().optional().nullable(),
  source: z.enum(['importadora', 'almacen', 'distrimia']).optional().nullable(),
  supplier_code: z.string().optional().nullable(),
  estimated_delivery: z.string().optional().nullable(),
  notes: z.string().optional().nullable()
});

router.post('/:ticketId/items/:itemId/alternatives',
  authorize(['seller', 'dispatcher', 'admin']),
  asyncHandler(async (req, res) => {
    const { ticketId, itemId } = req.params;
    const validated = addAlternativeSchema.parse(req.body);
    const userId = req.user.id;

    // Check ticket lock
    const lockStatus = await getLockStatus(ticketId);
    if (lockStatus.locked && lockStatus.locked_by !== userId) {
      return res.status(423).json({ error: 'Ticket is locked by another user', code: 'TICKET_LOCKED' });
    }

    // Verify item belongs to ticket
    const { data: item, error: itemErr } = await supabaseAdmin
      .from('ticket_items')
      .select('id')
      .eq('id', itemId)
      .eq('ticket_id', ticketId)
      .single();

    if (itemErr || !item) {
      return res.status(404).json({ error: 'Item no encontrado', code: 'NOT_FOUND' });
    }

    // Insert alternative
    const { data: alternative, error: insertErr } = await supabaseAdmin
      .from('ticket_item_alternatives')
      .insert({
        ticket_item_id: itemId,
        brand: validated.brand,
        selling_price: validated.selling_price || null,
        cost_price: validated.cost_price || null,
        source: validated.source || null,
        supplier_code: validated.supplier_code || null,
        estimated_delivery: validated.estimated_delivery || null,
        notes: validated.notes || null
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    res.status(201).json({ alternative });
  })
);

/**
 * DELETE /api/tickets/:ticketId/items/:itemId/alternatives/:altId
 * Remove a brand/price alternative
 */
router.delete('/:ticketId/items/:itemId/alternatives/:altId',
  authorize(['seller', 'dispatcher', 'admin']),
  asyncHandler(async (req, res) => {
    const { ticketId, itemId, altId } = req.params;
    const userId = req.user.id;

    // Check ticket lock
    const lockStatus = await getLockStatus(ticketId);
    if (lockStatus.locked && lockStatus.locked_by !== userId) {
      return res.status(423).json({ error: 'Ticket is locked by another user', code: 'TICKET_LOCKED' });
    }

    const { error: delErr } = await supabaseAdmin
      .from('ticket_item_alternatives')
      .delete()
      .eq('id', altId)
      .eq('ticket_item_id', itemId);

    if (delErr) throw delErr;

    res.json({ message: 'Alternativa eliminada' });
  })
);

/**
 * POST /api/tickets/:ticketId/items
 * Add a new item manually to an existing ticket
 */
const addItemSchema = z.object({
  description: z.string().min(1, 'Descripción es requerida'),
  quantity: z.number().int().positive().default(1)
});

router.post('/:ticketId/items',
  authorize(['seller', 'dispatcher', 'admin']),
  asyncHandler(async (req, res) => {
    const { ticketId } = req.params;
    const validated = addItemSchema.parse(req.body);
    const userId = req.user.id;

    // Check ticket exists and is not closed/cancelled
    const { data: ticket, error: ticketErr } = await supabaseAdmin
      .from('tickets')
      .select('id, status, item_count')
      .eq('id', ticketId)
      .single();

    if (ticketErr || !ticket) {
      return res.status(404).json({ error: 'Ticket no encontrado', code: 'NOT_FOUND' });
    }
    if (['closed', 'cancelled'].includes(ticket.status)) {
      return res.status(400).json({ error: 'No se pueden agregar ítems a un ticket cerrado o cancelado', code: 'TICKET_CLOSED' });
    }

    // Check ticket lock
    const lockStatus = await getLockStatus(ticketId);
    if (lockStatus.locked && lockStatus.locked_by !== userId) {
      return res.status(423).json({ error: 'Ticket is locked by another user', code: 'TICKET_LOCKED' });
    }

    // Get current max item_order
    const { data: lastItem } = await supabaseAdmin
      .from('ticket_items')
      .select('item_order')
      .eq('ticket_id', ticketId)
      .order('item_order', { ascending: false })
      .limit(1);

    const nextOrder = (lastItem && lastItem.length > 0) ? lastItem[0].item_order + 1 : 1;

    // Insert new item
    const { data: newItem, error: insertErr } = await supabaseAdmin
      .from('ticket_items')
      .insert({
        ticket_id: ticketId,
        item_order: nextOrder,
        raw_line: validated.description,
        parsed_description: validated.description,
        quantity: validated.quantity,
        status: 'pending_info'
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    // Update ticket item_count and length_class
    const newCount = (ticket.item_count || 0) + 1;
    const lengthClass = newCount <= 3 ? 'short' : newCount <= 8 ? 'medium' : 'long';

    await supabaseAdmin
      .from('tickets')
      .update({ item_count: newCount, length_class: lengthClass, updated_by: userId })
      .eq('id', ticketId);

    // Audit log
    await supabaseAdmin.from('audit_log').insert({
      entity_type: 'ticket',
      entity_id: ticketId,
      action: 'add_item',
      new_values: { description: validated.description, quantity: validated.quantity, item_order: nextOrder },
      performed_by: userId
    });

    res.status(201).json({ item: newItem });
  })
);

/**
 * PUT /api/tickets/:ticketId/items/:itemId
 * Update ticket item
 */
router.put('/:ticketId/items/:itemId',
  authorize(['seller', 'admin']),
  asyncHandler(async (req, res) => {
    const { ticketId, itemId } = req.params;
    const validated = updateItemSchema.parse(req.body);
    const userId = req.user.id;
    
    // Check ticket status
    const { data: parentTicket } = await supabaseAdmin
      .from('tickets')
      .select('status, assigned_to')
      .eq('id', ticketId)
      .single();
    
    if (parentTicket && parentTicket.status === 'en_revision' && req.user.role === 'seller') {
      return res.status(403).json({
        error: 'Este ticket está en revisión. Solo un Dispatcher o Admin puede gestionarlo.',
        code: 'EN_REVISION_BLOCKED'
      });
    }
    
    // In pedido status, allow editing without lock (seller fills supplier/cost before closing)
    const isPedido = parentTicket && parentTicket.status === 'pedido';
    if (!isPedido) {
      // Check ticket lock (not required for pedido)
      const lockStatus = await getLockStatus(ticketId);
      if (lockStatus.locked && lockStatus.locked_by !== userId) {
        return res.status(423).json({
          error: 'Ticket is locked by another user',
          code: 'TICKET_LOCKED'
        });
      }
    }
    
    // Calculate validity expiration if status is changing to positive/negative
    let validityData = {};
    if (validated.status === 'positive' || validated.status === 'negative') {
      const isPositive = validated.status === 'positive';
      const source = validated.source;
      
      // Calculate validity based on source and status
      let daysValid;
      if (!isPositive) {
        daysValid = 7;
      } else if (source === 'importadora') {
        daysValid = 5;
      } else if (source === 'distrimia') {
        daysValid = 4;
      } else if (source === 'almacen') {
        daysValid = 3;
      }
      
      if (daysValid) {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + daysValid);
        validityData = {
          validity_status: 'vigente',
          validity_expires_at: expiresAt.toISOString()
        };
      }
    }
    
    const { data: item, error } = await supabaseAdmin
      .from('ticket_items')
      .update({
        ...validated,
        ...validityData
      })
      .eq('id', itemId)
      .eq('ticket_id', ticketId)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ item });
  })
);

/**
 * DELETE /api/tickets/:ticketId/items/:itemId
 * Delete a single item from a ticket
 */
router.delete('/:ticketId/items/:itemId',
  authorize(['seller', 'dispatcher', 'admin']),
  asyncHandler(async (req, res) => {
    const { ticketId, itemId } = req.params;
    const userId = req.user.id;

    // Check ticket exists and get current state
    const { data: ticket } = await supabaseAdmin
      .from('tickets')
      .select('id, status, item_count, locked_by, lock_expires_at')
      .eq('id', ticketId)
      .single();

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found', code: 'NOT_FOUND' });
    }

    // Sellers cannot delete items on en_revision tickets
    if (ticket.status === 'en_revision' && req.user.role === 'seller') {
      return res.status(403).json({ error: 'Este ticket está en revisión.', code: 'EN_REVISION_BLOCKED' });
    }

    // Check lock
    if (ticket.locked_by && ticket.locked_by !== userId && req.user.role !== 'admin' && req.user.role !== 'dispatcher') {
      if (new Date(ticket.lock_expires_at) > new Date()) {
        return res.status(423).json({ error: 'Ticket is locked by another user', code: 'TICKET_LOCKED' });
      }
    }

    // Prevent deleting the last item
    if ((ticket.item_count || 1) <= 1) {
      return res.status(400).json({ error: 'No se puede eliminar el único item del ticket', code: 'LAST_ITEM' });
    }

    // Delete the item
    const { error: delErr } = await supabaseAdmin
      .from('ticket_items')
      .delete()
      .eq('id', itemId)
      .eq('ticket_id', ticketId);

    if (delErr) throw delErr;

    // Update ticket item_count and length_class
    const newCount = Math.max(1, (ticket.item_count || 1) - 1);
    const lengthClass = newCount <= 3 ? 'short' : newCount <= 8 ? 'medium' : 'long';

    await supabaseAdmin
      .from('tickets')
      .update({ item_count: newCount, length_class: lengthClass, updated_by: userId })
      .eq('id', ticketId);

    // Respond immediately
    res.json({ message: 'Item eliminado', item_count: newCount });

    // Audit log (fire-and-forget)
    supabaseAdmin.from('audit_log').insert({
      entity_type: 'ticket_item',
      entity_id: itemId,
      action: 'delete',
      old_values: { ticket_id: ticketId },
      performed_by: userId
    }).then(null, e => console.error('Audit log failed:', e));
  })
);

/**
 * POST /api/tickets/:id/use-as-base/:sourceId
 * Copy item data (prices, codes, status) from a source duplicate ticket
 * This does NOT edit the source — it copies results into the current ticket
 */
router.post('/:id/use-as-base/:sourceId',
  authorize(['seller', 'admin']),
  asyncHandler(async (req, res) => {
    const { id: targetId, sourceId } = req.params;
    const userId = req.user.id;
    
    // Verify lock on target ticket
    const lockStatus = await getLockStatus(targetId);
    if (lockStatus.locked && lockStatus.locked_by !== userId) {
      return res.status(423).json({
        error: 'Ticket is locked by another user',
        code: 'TICKET_LOCKED'
      });
    }
    
    // Get source ticket items (the duplicate we want to copy from)
    const { data: sourceItems, error: srcError } = await supabaseAdmin
      .from('ticket_items')
      .select('*')
      .eq('ticket_id', sourceId)
      .order('item_order', { ascending: true });
    
    if (srcError) throw srcError;
    if (!sourceItems || sourceItems.length === 0) {
      return res.status(404).json({ error: 'Source ticket has no items', code: 'NO_ITEMS' });
    }
    
    // Get target ticket items
    const { data: targetItems, error: tgtError } = await supabaseAdmin
      .from('ticket_items')
      .select('*')
      .eq('ticket_id', targetId)
      .order('item_order', { ascending: true });
    
    if (tgtError) throw tgtError;
    
    // Match items by similarity and copy enrichment data
    const updatedItems = [];
    for (const targetItem of targetItems) {
      const targetTS = normalizeForComparison(targetItem.parsed_description || targetItem.raw_line || '');
      
      let bestMatch = null;
      let bestScore = 0;
      
      for (const srcItem of sourceItems) {
        const srcTS = normalizeForComparison(srcItem.parsed_description || srcItem.raw_line || '');
        const score = tokenSetSimilarity(targetTS, srcTS);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = srcItem;
        }
      }
      
      // Only copy if similarity > 40%
      if (bestMatch && bestScore > 0.4) {
        const updateData = {};
        // Copy enrichment fields (only if source has them and target doesn't)
        if (bestMatch.status && bestMatch.status !== 'pending_info') updateData.status = bestMatch.status;
        if (bestMatch.source) updateData.source = bestMatch.source;
        if (bestMatch.selling_price && !targetItem.selling_price) updateData.selling_price = bestMatch.selling_price;
        if (bestMatch.cost_price && !targetItem.cost_price) updateData.cost_price = bestMatch.cost_price;
        if (bestMatch.supplier_code && !targetItem.supplier_code) updateData.supplier_code = bestMatch.supplier_code;
        if (bestMatch.brand && !targetItem.brand) updateData.brand = bestMatch.brand;
        if (bestMatch.codigo_distrimia && !targetItem.codigo_distrimia) updateData.codigo_distrimia = bestMatch.codigo_distrimia;
        if (bestMatch.codigo_oem && !targetItem.codigo_oem) updateData.codigo_oem = bestMatch.codigo_oem;
        if (bestMatch.codigo_fabrica && !targetItem.codigo_fabrica) updateData.codigo_fabrica = bestMatch.codigo_fabrica;
        if (bestMatch.seller_note && !targetItem.seller_note) updateData.seller_note = bestMatch.seller_note;
        if (bestMatch.estimated_delivery && !targetItem.estimated_delivery) updateData.estimated_delivery = bestMatch.estimated_delivery;
        
        if (Object.keys(updateData).length > 0) {
          const { data: updated } = await supabaseAdmin
            .from('ticket_items')
            .update(updateData)
            .eq('id', targetItem.id)
            .select()
            .single();
          
          if (updated) updatedItems.push(updated);
        }
        
        // Copy alternatives from source item to target item
        const { data: sourceAlts } = await supabaseAdmin
          .from('ticket_item_alternatives')
          .select('*')
          .eq('ticket_item_id', bestMatch.id)
          .order('created_at', { ascending: true });
        
        if (sourceAlts && sourceAlts.length > 0) {
          // Remove existing alternatives on target item first
          await supabaseAdmin
            .from('ticket_item_alternatives')
            .delete()
            .eq('ticket_item_id', targetItem.id);
          
          // Copy source alternatives to target item (must match ticket_item_alternatives schema)
          const newAlts = sourceAlts.map(alt => ({
            ticket_item_id: targetItem.id,
            brand: alt.brand,
            selling_price: alt.selling_price,
            cost_price: alt.cost_price,
            source: alt.source,
            supplier_code: alt.supplier_code,
            estimated_delivery: alt.estimated_delivery,
            notes: alt.notes
          }));
          const { error: altError } = await supabaseAdmin.from('ticket_item_alternatives').insert(newAlts);
          if (altError) console.error(`[USE-AS-BASE] Failed to copy alternatives for item ${targetItem.id}:`, altError.message);
        }
      }
    }
    
    // Auto-transition source ticket to 'reenviado'
    // Get target ticket info for the forwarding reference
    const { data: targetTicket } = await supabaseAdmin
      .from('tickets')
      .select('id, k_number, group_code')
      .eq('id', targetId)
      .single();
    
    const { data: sourceTicketData } = await supabaseAdmin
      .from('tickets')
      .select('status, k_number')
      .eq('id', sourceId)
      .single();
    
    // Only transition if source is not already closed/cancelled/reenviado
    if (sourceTicketData && !['closed', 'cancelled', 'reenviado'].includes(sourceTicketData.status)) {
      await supabaseAdmin
        .from('tickets')
        .update({
          status: 'reenviado',
          forwarded_to_ticket_id: targetId,
          forwarded_to_group: targetTicket?.group_code || null,
          updated_by: userId
        })
        .eq('id', sourceId);
    }
    
    // Log action
    await supabaseAdmin
      .from('audit_log')
      .insert({
        entity_type: 'ticket',
        entity_id: targetId,
        action: 'use_as_base',
        new_values: {
          source_ticket_id: sourceId,
          source_k_number: sourceTicketData?.k_number,
          items_updated: updatedItems.length,
          source_marked_reenviado: true,
          forwarded_to_group: targetTicket?.group_code
        },
        performed_by: userId
      });
    
    res.json({
      message: `Se copiaron datos de ${updatedItems.length} item(s). Ticket base #${sourceTicketData?.k_number || ''} marcado como reenviado.`,
      items_updated: updatedItems.length,
      items: updatedItems,
      source_reenviado: true
    });
  })
);

/**
 * POST /api/tickets/:id/attachments
 * Upload images to a ticket (for manager/admin reference, no AI processing)
 */
router.post('/:id/attachments',
  authorize(['operator', 'seller', 'dispatcher', 'admin']),
  upload.array('images', 10),
  asyncHandler(async (req, res) => {
    const { id: ticketId } = req.params;
    const userId = req.user.id;
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No se subieron archivos', code: 'NO_FILES' });
    }
    
    // Verify ticket exists
    const { data: ticket, error: tErr } = await supabaseAdmin
      .from('tickets')
      .select('id')
      .eq('id', ticketId)
      .single();
    
    if (tErr || !ticket) {
      // Clean up temp files
      for (const f of req.files) { try { fs.unlinkSync(f.path); } catch {} }
      return res.status(404).json({ error: 'Ticket no encontrado', code: 'NOT_FOUND' });
    }
    
    const attachments = [];
    for (const file of req.files) {
      const buffer = fs.readFileSync(file.path);
      const attachment = await uploadAttachment(
        buffer, file.originalname, file.mimetype, file.size, ticketId, userId
      );
      attachments.push(attachment);
      try { fs.unlinkSync(file.path); } catch {}
    }
    
    res.json({
      message: `${attachments.length} archivo(s) adjuntado(s)`,
      attachments
    });
  })
);

/**
 * GET /api/tickets/:id/attachments
 * List all attachments for a ticket
 */
router.get('/:id/attachments', asyncHandler(async (req, res) => {
  const { id: ticketId } = req.params;
  const attachments = await getAttachments(ticketId);
  
  // Generate signed URLs for each attachment
  const withUrls = await Promise.all(attachments.map(async (att) => {
    try {
      const url = await getAttachmentUrl(att.file_path);
      return { ...att, url };
    } catch {
      return { ...att, url: null };
    }
  }));
  
  res.json({ attachments: withUrls });
}));

/**
 * GET /api/tickets/:id/blocks/:blockType
 * Get specific block (generated on demand)
 */
router.get('/:id/blocks/:blockType', asyncHandler(async (req, res) => {
  const { id, blockType } = req.params;
  
  // Get ticket (join assigned user for block generation)
  const { data: ticket, error: ticketError } = await supabaseAdmin
    .from('tickets')
    .select('*, assigned_to_user:users!tickets_assigned_to_fkey(id, full_name)')
    .eq('id', id)
    .single();
  
  if (ticketError) throw ticketError;
  
  // Get items with alternatives
  const { data: rawItems, error: itemsError } = await supabaseAdmin
    .from('ticket_items')
    .select('*')
    .eq('ticket_id', id)
    .order('item_order', { ascending: true });
  
  if (itemsError) throw itemsError;

  const itemIds = (rawItems || []).map(i => i.id);
  let alternatives = [];
  if (itemIds.length > 0) {
    const { data: alts } = await supabaseAdmin
      .from('ticket_item_alternatives')
      .select('*')
      .in('ticket_item_id', itemIds)
      .order('created_at', { ascending: true });
    alternatives = alts || [];
  }
  const items = (rawItems || []).map(item => ({
    ...item,
    alternatives: alternatives.filter(a => a.ticket_item_id === item.id)
  }));
  
  // Get forwarding log if needed
  let forwardingLog = [];
  if (blockType === 'reenvios') {
    const { data: logs } = await supabaseAdmin
      .from('ticket_logs')
      .select('*')
      .eq('ticket_id', id)
      .eq('action', 'forwarded')
      .order('created_at', { ascending: false });
    forwardingLog = logs || [];
  }

  let block;
  const supplierCode = req.query.supplier_code;
  
  switch (blockType) {
    case 'control':
      block = generateControlBlock(ticket);
      break;
    case 'proforma_cliente':
      block = generateCustomerProformaBlock(ticket, items);
      break;
    case 'aux_seguimiento':
      block = generateAuxSeguimientoBlock(ticket, items);
      break;
    case 'reenvios':
      block = generateReenviosBlock(ticket, forwardingLog);
      break;
    case 'proveedor':
      block = generateProveedorBlock(ticket, items, supplierCode || null);
      break;
    case 'despachos':
      block = generateDespachosBlock(ticket, items, supplierCode || 'N/A');
      break;
    case 'interno': {
      const activeItems = items.filter(i => !i.pedido_excluded);
      block = generateInternoBlock(ticket, activeItems);
      break;
    }
    case 'per_supplier': {
      const activeItemsPS = items.filter(i => !i.pedido_excluded);
      const supplierBlocks = generatePerSupplierBlocks(ticket, activeItemsPS);
      return res.json({
        block_type: 'per_supplier',
        supplier_blocks: supplierBlocks
      });
    }
    case 'auditoria': {
      const itemId = req.query.item_id;
      const targetItem = itemId ? items.find(i => i.id === itemId) : items[0];
      block = targetItem ? generateAuditoriaBlock(targetItem) : 'No item found';
      break;
    }
    default:
      return res.status(400).json({ 
        error: 'Invalid block type',
        code: 'INVALID_BLOCK_TYPE',
        available: ['control', 'proforma_cliente', 'aux_seguimiento', 'reenvios', 'proveedor', 'despachos', 'interno', 'per_supplier', 'auditoria']
      });
  }
  
  res.json({ 
    block_type: blockType,
    content: block 
  });
}));

/**
 * POST /api/tickets/:id/merge/:sourceId
 * Merge source ticket into target ticket
 * Per client spec §4: Only Dispatcher and Admin can merge
 */
router.post('/:id/merge/:sourceId',
  authorize(['dispatcher', 'admin']),
  asyncHandler(async (req, res) => {
    const { id: targetId, sourceId } = req.params;
    const userId = req.user.id;
    const { notes } = req.body;
    
    // Get both tickets
    const { data: targetTicket } = await supabaseAdmin
      .from('tickets')
      .select('id, k_number, status, item_count')
      .eq('id', targetId)
      .single();
    
    const { data: sourceTicket } = await supabaseAdmin
      .from('tickets')
      .select('id, k_number, status, is_merged')
      .eq('id', sourceId)
      .single();
    
    if (!targetTicket || !sourceTicket) {
      return res.status(404).json({ error: 'Ticket not found', code: 'NOT_FOUND' });
    }
    
    if (sourceTicket.is_merged) {
      return res.status(400).json({ error: 'Source ticket is already merged', code: 'ALREADY_MERGED' });
    }
    
    // Move source items to target
    const { data: sourceItems } = await supabaseAdmin
      .from('ticket_items')
      .select('*')
      .eq('ticket_id', sourceId)
      .order('item_order', { ascending: true });
    
    if (sourceItems && sourceItems.length > 0) {
      // Get max order in target
      const { data: maxOrderResult } = await supabaseAdmin
        .from('ticket_items')
        .select('item_order')
        .eq('ticket_id', targetId)
        .order('item_order', { ascending: false })
        .limit(1);
      
      let maxOrder = maxOrderResult?.[0]?.item_order || 0;
      
      // Re-assign items to target ticket
      for (const item of sourceItems) {
        maxOrder++;
        await supabaseAdmin
          .from('ticket_items')
          .update({ ticket_id: targetId, item_order: maxOrder })
          .eq('id', item.id);
      }
      
      // Update target item count
      await supabaseAdmin
        .from('tickets')
        .update({ 
          item_count: targetTicket.item_count + sourceItems.length,
          updated_by: userId
        })
        .eq('id', targetId);
    }
    
    // Mark source as merged
    await supabaseAdmin
      .from('tickets')
      .update({ 
        is_merged: true, 
        merged_into_ticket_id: targetId,
        status: 'cancelled',
        updated_by: userId
      })
      .eq('id', sourceId);
    
    // Clean up duplicate_references involving the source ticket
    // so the target ticket doesn't inherit the source's duplicate badge
    await supabaseAdmin
      .from('duplicate_references')
      .delete()
      .or(`ticket_id.eq.${sourceId},duplicate_ticket_id.eq.${sourceId}`);
    
    // Clear source ticket's duplicate_label
    await supabaseAdmin
      .from('tickets')
      .update({ duplicate_label: null })
      .eq('id', sourceId);
    
    // Log merge
    await supabaseAdmin.from('merge_log').insert({
      action: 'merge',
      source_ticket_id: sourceId,
      target_ticket_id: targetId,
      performed_by: userId,
      notes: notes || null
    });
    
    await supabaseAdmin.from('audit_log').insert({
      entity_type: 'ticket',
      entity_id: targetId,
      action: 'merge',
      new_values: { source_ticket_id: sourceId, source_k_number: sourceTicket.k_number, items_moved: sourceItems?.length || 0 },
      performed_by: userId
    });
    
    res.json({
      message: `Ticket #${sourceTicket.k_number} fusionado en #${targetTicket.k_number}`,
      target_ticket_id: targetId,
      source_ticket_id: sourceId,
      items_moved: sourceItems?.length || 0
    });
  })
);

/**
 * POST /api/tickets/:id/unmerge
 * Unmerge a previously merged ticket
 * Per client spec §4: Only Admin can unmerge. Cannot unmerge if target is in 'pedido' status.
 */
router.post('/:id/unmerge',
  authorize(['admin']),
  asyncHandler(async (req, res) => {
    const { id: sourceId } = req.params;
    const userId = req.user.id;
    
    // Get the merged ticket
    const { data: sourceTicket } = await supabaseAdmin
      .from('tickets')
      .select('id, k_number, is_merged, merged_into_ticket_id')
      .eq('id', sourceId)
      .single();
    
    if (!sourceTicket) {
      return res.status(404).json({ error: 'Ticket not found', code: 'NOT_FOUND' });
    }
    
    if (!sourceTicket.is_merged) {
      return res.status(400).json({ error: 'Ticket is not merged', code: 'NOT_MERGED' });
    }
    
    // Check target ticket status - cannot unmerge if in 'pedido' per client spec §4
    const { data: targetTicket } = await supabaseAdmin
      .from('tickets')
      .select('id, k_number, status')
      .eq('id', sourceTicket.merged_into_ticket_id)
      .single();
    
    if (targetTicket && targetTicket.status === 'pedido') {
      return res.status(400).json({
        error: 'No se puede desfusionar: el ticket destino está en estado Pedido',
        code: 'CANNOT_UNMERGE_PEDIDO'
      });
    }
    
    // Find the merge log to know what was moved
    const { data: mergeLogEntry } = await supabaseAdmin
      .from('merge_log')
      .select('*')
      .eq('source_ticket_id', sourceId)
      .eq('action', 'merge')
      .order('performed_at', { ascending: false })
      .limit(1);
    
    // Restore source ticket
    await supabaseAdmin
      .from('tickets')
      .update({
        is_merged: false,
        merged_into_ticket_id: null,
        status: 'pending',
        updated_by: userId
      })
      .eq('id', sourceId);
    
    // Log unmerge
    await supabaseAdmin.from('merge_log').insert({
      action: 'unmerge',
      source_ticket_id: sourceId,
      target_ticket_id: sourceTicket.merged_into_ticket_id,
      performed_by: userId,
      notes: 'Admin unmerge'
    });
    
    await supabaseAdmin.from('audit_log').insert({
      entity_type: 'ticket',
      entity_id: sourceId,
      action: 'unmerge',
      new_values: { restored_from: sourceTicket.merged_into_ticket_id },
      performed_by: userId
    });
    
    res.json({
      message: `Ticket #${sourceTicket.k_number} desfusionado`,
      ticket_id: sourceId
    });
  })
);

export default router;
