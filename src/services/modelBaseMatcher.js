import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modelBasePath = path.join(__dirname, '../data/modelBase.json');
const modelBase = JSON.parse(fs.readFileSync(modelBasePath, 'utf8'));

function normalizeText(value) {
  if (!value) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value).split(' ').filter(Boolean);
}

function normalizeCilindraje(value) {
  if (!value) return null;
  const raw = String(value).toLowerCase().replace(/[^\d.]/g, '');
  if (!raw) return null;
  if (raw.includes('.')) return `${Math.round(parseFloat(raw) * 1000)}cc`;
  if (raw.length === 4) return `${raw}cc`;
  if (raw.length === 3) return `${raw}0cc`;
  return null;
}

function entryCandidates(entry) {
  return [entry.modelo, ...(entry.aliases || [])].map(normalizeText).filter(Boolean);
}

export function detectVehicleFromModelBase(text) {
  const haystack = normalizeText(text);
  if (!haystack) return null;

  let best = null;
  for (const entry of modelBase) {
    const candidates = entryCandidates(entry);
    for (const candidate of candidates) {
      if (!candidate) continue;

      let score = 0;
      if (haystack.includes(candidate)) {
        score = 1;
      } else {
        const parts = tokenize(candidate);
        if (parts.length === 0) continue;
        const matched = parts.filter((p) => haystack.includes(p)).length;
        score = matched / parts.length;
      }

      // Prioritize exact cilindraje mentions (e.g. SAIL 1400 vs 1500).
      const cil = entry.cilindraje?.replace('cc', '');
      if (cil && new RegExp(`\\b${cil}\\b`).test(haystack)) score += 0.1;

      if (!best || score > best.score) {
        best = { entry, score };
      }
    }
  }

  if (!best || best.score < 0.75) return null;
  return {
    marca: best.entry.marca || null,
    modelo: best.entry.modelo || null,
    cilindraje: normalizeCilindraje(best.entry.cilindraje) || best.entry.cilindraje || null,
    source: 'model_base',
    confidence: Number(best.score.toFixed(2))
  };
}

export function mergeVehicleInfoWithModelBase(baseVehicle, textSources = []) {
  const merged = { ...(baseVehicle || {}) };
  const sourceBlob = textSources.filter(Boolean).join('\n');
  const detected = detectVehicleFromModelBase(sourceBlob);
  if (!detected) return merged;

  if (!merged.modelo || detected.confidence >= 0.9) merged.modelo = detected.modelo;
  if (!merged.marca || detected.confidence >= 0.9) merged.marca = detected.marca;
  if (!merged.cilindraje || detected.confidence >= 0.9) merged.cilindraje = detected.cilindraje;

  merged.model_detection_source = detected.source;
  merged.model_detection_confidence = detected.confidence;
  return merged;
}

export function getModelBaseSnapshot() {
  return modelBase;
}
