import Groq from 'groq-sdk';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
    console.warn('GROQ_API_KEY is not set in the environment variables.');
}

export const groqClient = new Groq({ apiKey });
export const GROQ_AGENT_MODEL = process.env.GROQ_AGENT_MODEL || 'llama-3.1-8b-instant';
