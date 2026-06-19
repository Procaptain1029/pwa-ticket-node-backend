import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // Vision calls with large base64 payloads can take >60s on Render.
  timeout: Number(process.env.OPENAI_TIMEOUT_MS) || 120_000,
  maxRetries: Number(process.env.OPENAI_MAX_RETRIES) || 2,
});

export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
export const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o';

export default openai;
