// src/agent/logger.ts
//
// File + console logger for the Wathiq agent. Writes every debug line to
// ./logs/agent-debug.log, which is TRUNCATED on each server start so each
// run has a clean, self-contained log — exactly what you want when chasing
// a specific session's behaviour without wading through yesterday's noise.
//
// Enable/disable with AGENT_DEBUG=false in .env (defaults to enabled).
//
// Nothing here is async — all writes are fire-and-forget stream writes so
// logging never adds latency to the LLM path. If the write fails (disk full,
// permissions), the error is swallowed and console output still works.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DEBUG = process.env.AGENT_DEBUG !== 'false';
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'agent-debug.log');

let fileStream: fs.WriteStream | null = null;

function initLogFile(): fs.WriteStream | null {
    if (!DEBUG) return null;
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

        // Truncate on startup — this is the "reset when the server restarts"
        // behaviour. 'w' creates-or-truncates; the header line marks the session.
        const header =
            `=== Wathiq Agent debug log — session started at ${new Date().toISOString()} ===\n` +
            `=== Log file: ${LOG_FILE}\n` +
            `=== Process PID: ${process.pid}\n` +
            `=== Node: ${process.version}\n` +
            `===\n\n`;
        fs.writeFileSync(LOG_FILE, header, { encoding: 'utf8' });

        const stream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });
        stream.on('error', (err) => {
            // Don't crash the app if the file becomes unwritable mid-session.
            console.error('[AGENT][LOGGER] file write error:', err.message);
        });
        console.log(`[AGENT][LOGGER] Debug log file ready → ${LOG_FILE}`);
        return stream;
    } catch (e: any) {
        console.error('[AGENT][LOGGER] Failed to init log file:', e.message);
        return null;
    }
}

fileStream = initLogFile();

// Flush the stream on shutdown so the last lines aren't lost.
function flushAndClose() {
    try { fileStream?.end(); } catch { /* ignore */ }
}
process.once('SIGINT', flushAndClose);
process.once('SIGTERM', flushAndClose);
process.once('beforeExit', flushAndClose);

function writeLine(line: string) {
    if (!DEBUG) return;
    console.log(line);
    if (fileStream) {
        try { fileStream.write(line + '\n'); } catch { /* ignore */ }
    }
}

// ── Public API ────────────────────────────────────────────────────────────

let __reqCounter = 0;
export function newReqId(): number { return ++__reqCounter; }

export function nowMs(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
}

export function logReq(reqId: number, tag: string, msg: string, data?: any) {
    if (!DEBUG) return;
    const prefix = `[AGENT][#${reqId}][${tag}]`;
    let line: string;
    if (data === undefined) {
        line = `${prefix} ${msg}`;
    } else if (typeof data === 'object') {
        try {
            line = `${prefix} ${msg} ${JSON.stringify(data, null, 2)}`;
        } catch {
            line = `${prefix} ${msg} [unserializable]`;
        }
    } else {
        line = `${prefix} ${msg} ${data}`;
    }
    writeLine(line);
}

export function logSection(reqId: number, title: string) {
    if (!DEBUG) return;
    const line = '─'.repeat(72);
    writeLine(`\n${line}\n[AGENT][#${reqId}] ${title}\n${line}`);
}

export function logDone(reqId: number, title: string) {
    if (!DEBUG) return;
    writeLine(`[AGENT][#${reqId}] ✔ ${title}`);
}

export function logRaw(line: string) {
    writeLine(line);
}

export function isDebugEnabled(): boolean { return DEBUG; }
export function getLogFilePath(): string { return LOG_FILE; }

/**
 * Fingerprint a string — used to prove the system prompt is being sent
 * identically on every turn (or to detect when it isn't).
 */
export function fingerprint(s: string): { length: number; sha256: string; head: string } {
    const sha256 = crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
    return { length: s.length, sha256, head: s.slice(0, 60).replace(/\n/g, '⏎') };
}