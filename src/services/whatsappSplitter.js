/**
 * WhatsApp Message Splitter
 * Detects sender patterns in copied WhatsApp group chat text
 * and groups messages by sender for separate ticket creation.
 *
 * Supported formats:
 *   iOS:     [DD/MM/YY, HH:MM:SS] Contact Name: message
 *   Android: DD/MM/YY, HH:MM - Contact Name: message
 *   Web:     [DD/MM/YY, HH:MM] +593 99 123 4567: message
 *   Plain:   Contact Name: message (fallback, less reliable)
 */

// Regex patterns for WhatsApp timestamp + sender formats
const WA_PATTERNS = [
  // iOS: [31/03/26, 10:15:23] Name or Phone: message
  /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\]\s+(.+?):\s+(.*)$/,
  // Android: 31/03/26, 10:15 - Name or Phone: message
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\s*[-–]\s+(.+?):\s+(.*)$/,
  // Variation: 31/03/2026 10:15 - Name: message
  /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\s*[-–]\s+(.+?):\s+(.*)$/,
];

// Known internal names/keywords to skip (Distrimia staff)
const INTERNAL_KEYWORDS = [
  'distrimia', 'despacho', 'bodega', 'admin', 'sistema',
  'grupo', 'bienvenido', 'added', 'removed', 'left', 'joined',
  'cambió', 'changed', 'creó', 'created'
];

/**
 * Try to parse a line as a WhatsApp message with sender info.
 * Returns { sender, message, timestamp } or null.
 */
function parseWhatsAppLine(line) {
  for (const pattern of WA_PATTERNS) {
    const match = line.match(pattern);
    if (match) {
      // Groups: date, time, sender, message
      const sender = match[3].trim();
      const message = match[4].trim();
      const timestamp = `${match[1]} ${match[2]}`;
      return { sender, message, timestamp };
    }
  }
  return null;
}

/**
 * Check if a sender name looks like a system message (not a real person).
 */
function isSystemMessage(sender) {
  const lower = sender.toLowerCase();
  return INTERNAL_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Normalize sender identifier for grouping.
 * Strips whitespace, lowercases, removes common prefixes.
 */
function normalizeSender(sender) {
  return sender.trim().toLowerCase().replace(/^\+/, '').replace(/[\s\-()]/g, '');
}

/**
 * Detect if a sender string looks like a phone number.
 */
function isPhoneNumber(sender) {
  const digits = sender.replace(/[\s\-+()]/g, '');
  return /^\d{7,15}$/.test(digits);
}

/**
 * Split WhatsApp group chat text into blocks grouped by sender.
 *
 * @param {string} rawText - The pasted WhatsApp chat text
 * @returns {{ detected: boolean, senderBlocks: Array<{ sender: string, phone: string|null, messages: string[], rawText: string }> }}
 *   - detected: true if WhatsApp sender patterns were found
 *   - senderBlocks: one entry per unique sender, with their combined messages
 */
export function splitBySender(rawText) {
  const lines = rawText.split('\n');
  let parsedCount = 0;
  let currentSender = null;

  // First pass: parse all lines and assign senders
  const parsedLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = parseWhatsAppLine(trimmed);
    if (parsed) {
      parsedCount++;
      currentSender = parsed.sender;

      // Skip system messages
      if (isSystemMessage(parsed.sender) || !parsed.message) continue;

      parsedLines.push({
        sender: parsed.sender,
        message: parsed.message,
        timestamp: parsed.timestamp
      });
    } else if (currentSender) {
      // Continuation line (no timestamp) belongs to the current sender
      parsedLines.push({
        sender: currentSender,
        message: trimmed,
        timestamp: null
      });
    }
  }

  // Need at least 2 parsed lines with 2+ unique senders to activate splitting
  const uniqueSenders = new Set(parsedLines.map(l => normalizeSender(l.sender)));
  if (parsedCount < 2 || uniqueSenders.size < 2) {
    return {
      detected: false,
      senderBlocks: [{
        sender: null,
        phone: null,
        messages: [rawText],
        rawText: rawText
      }]
    };
  }

  // Group by sender
  const senderMap = new Map(); // normalizedSender → { sender, phone, messages[] }
  for (const line of parsedLines) {
    const key = normalizeSender(line.sender);
    if (!senderMap.has(key)) {
      const phone = isPhoneNumber(line.sender) ? line.sender.trim() : null;
      const name = isPhoneNumber(line.sender) ? null : line.sender.trim();
      senderMap.set(key, {
        sender: name || phone,
        phone,
        messages: []
      });
    }
    senderMap.get(key).messages.push(line.message);
  }

  // Build sender blocks — filter out blocks with no meaningful content
  const senderBlocks = [];
  for (const [, block] of senderMap) {
    const combined = block.messages.join('\n').trim();
    // Skip blocks that are just greetings or very short
    if (!combined || combined.length < 3) continue;

    senderBlocks.push({
      sender: block.sender,
      phone: block.phone,
      messages: block.messages,
      rawText: combined
    });
  }

  // If only 1 meaningful sender found after filtering, treat as single
  if (senderBlocks.length < 2) {
    return {
      detected: false,
      senderBlocks: [{
        sender: senderBlocks[0]?.sender || null,
        phone: senderBlocks[0]?.phone || null,
        messages: [rawText],
        rawText: rawText
      }]
    };
  }

  console.log(`[WA-SPLIT] Detected ${senderBlocks.length} senders from ${parsedCount} WhatsApp messages`);
  for (const b of senderBlocks) {
    console.log(`[WA-SPLIT]   ${b.sender || b.phone}: ${b.messages.length} message(s)`);
  }

  return {
    detected: true,
    senderBlocks
  };
}
