/**
 * Agent-side overlay for signed-in users.
 *
 * The app's Firestore is READ-ONLY for the agent. Everything the agent adds on top
 * of it lives here, keyed by a salted hash of the uid, never in the app's data:
 *   • notes   – status / verdict / note / "hidden" per shelf doc id ("this didn't suit me")
 *   • added   – items the user told the agent about in chat (wishlist / manual)
 *   • prefs   – register (Darija/MSA) and detected city/climate zone
 * Atomic JSON file, mode 0600, mtime-cached. Deletable per user (privacy).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { CabinetItem, CabinetStatus, CabinetVerdict } from '../agent/cabinet';

export interface ShelfNote { status?: CabinetStatus; verdict?: CabinetVerdict; note?: string; reason?: string; hidden?: boolean; updatedAt: string }
export interface UserPrefs { register?: 'darija' | 'msa'; city?: string; climateZone?: string }
export interface UserOverlay { notes: Record<string, ShelfNote>; added: CabinetItem[]; prefs: UserPrefs }

const empty = (): UserOverlay => ({ notes: {}, added: [], prefs: {} });
const MAX_NOTES = 300;
const MAX_ADDED = 40;

export class OverlayStore {
    private cache: { users: Record<string, UserOverlay> } | null = null;
    private mtime = -1;

    constructor(private file = process.env.OVERLAY_FILE || path.join(process.cwd(), 'data', 'user_overlay.json'),
                private salt = process.env.OVERLAY_SALT || 'wathiq-overlay-v1') {}

    private key(uid: string) { return crypto.createHash('sha256').update(`${this.salt}:${uid}`).digest('hex').slice(0, 32); }

    private read(): { users: Record<string, UserOverlay> } {
        try {
            if (!fs.existsSync(this.file)) return this.cache = { users: {} };
            const m = fs.statSync(this.file).mtimeMs;
            if (this.cache && this.mtime === m) return this.cache;
            const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
            this.cache = parsed?.users ? parsed : { users: {} };
            this.mtime = m;
            return this.cache!;
        } catch (e: any) {
            console.warn('[OVERLAY] read failed:', e.message);
            return this.cache || { users: {} };
        }
    }

    private write(db: { users: Record<string, UserOverlay> }) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
        this.cache = db;
        try { this.mtime = fs.statSync(this.file).mtimeMs; } catch { this.mtime = -1; }
    }

    get(uid: string): UserOverlay {
        const o = this.read().users[this.key(uid)];
        return o ? { notes: o.notes || {}, added: o.added || [], prefs: o.prefs || {} } : empty();
    }

    mutate(uid: string, fn: (o: UserOverlay) => void): UserOverlay {
        const db = this.read();
        const cur = this.get(uid);
        fn(cur);
        // caps keep a hostile/buggy client from growing the file without bound
        const noteKeys = Object.keys(cur.notes);
        if (noteKeys.length > MAX_NOTES) for (const k of noteKeys.slice(0, noteKeys.length - MAX_NOTES)) delete cur.notes[k];
        cur.added = cur.added.slice(-MAX_ADDED);
        this.write({ users: { ...db.users, [this.key(uid)]: cur } });
        return cur;
    }

    /** privacy: erase everything the agent stored for this user */
    delete(uid: string): boolean {
        const db = this.read();
        const k = this.key(uid);
        if (!db.users[k]) return false;
        const users = { ...db.users }; delete users[k];
        this.write({ users });
        return true;
    }
}
