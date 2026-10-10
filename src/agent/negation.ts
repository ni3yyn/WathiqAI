/**
 * Negation guard.
 *
 * Keyword routers can't tell "give me a routine with sunscreen" from "give me
 * a routine, but I DON'T want sunscreen" (ماشي واقي شمس / ما رانيش حاب واقي
 * شمس / sans écran solaire). This module tokenizes a message into clauses,
 * finds negation anchors (Arabic/Darija, French, English) and marks the tokens
 * they govern, so the router can:
 *   • ignore negated category mentions when choosing tools/entities,
 *   • tell build_routine which steps to skip (exclude_categories),
 *   • drop an intent whose trigger word itself is negated ("ما نبغيش روتين").
 *
 * Windows are clause-bound (split on punctuation and on "but" words such as
 * بصح / لكن / mais / but) so a negation never leaks into the other half of the
 * sentence. Verbal negations ("don't want", "ما رانيش حاب") govern up to 4
 * tokens ahead / 3 behind; prepositional ones ("بدون", "sans", "without")
 * govern only the next 2, so "غسول بدون كحول وسيروم" keeps the serum.
 */
import { foldMessage } from './intents';
import { detectCategoryInText } from './taxonomy';

const PREP_ANCHORS = new Set([
    'بدون', 'دون', 'عدا', 'ماعدا', 'باستثناء',
    'without', 'sans', 'except', 'excluding', 'exclude', 'minus', 'hors',
]);
const VERB_ANCHORS = new Set([
    'مو', 'موش', 'مش', 'ماشي', 'لا', 'لست', 'لن', 'ليس', 'ليست',
    'not', 'no', 'dont', 'doesnt', 'cant', 'wont', 'never', 'cannot', 'isnt', 'arent', 'didnt',
    'pas', 'jamais', 'non', 'nope',
]);
const CONJUNCTIONS = new Set(['و', 'and', 'et', 'or', 'ou', 'او', 'أو', 'plus', 'avec', 'مع', 'with']);
const CLAUSE_BREAKERS = new Set(['بصح', 'لكن', 'ولكن', 'بس', 'mais', 'but', 'however', 'sauf', 'cependant']);

export interface NegationAnalysis {
    tokens: string[];
    negated: boolean[];
    anchors: number[];
    /** tokens governed by each anchor (same order as `anchors`) */
    governed: string[][];
    /** the message with negated tokens and anchors removed */
    positive: string;
}

function isDarijaNegationToken(tok: string, next?: string): boolean {
    if (tok === 'ما' && next && next.length > 3 && next.endsWith('ش')) return true;
    return tok.length >= 4 && tok.startsWith('ما') && tok.endsWith('ش');   // مارانيش، مانبغيش، مابغيتش
}

export function analyzeNegation(rawMessage: string): NegationAnalysis {
    const folded = foldMessage(rawMessage).replace(/[’‘`]/g, "'");
    const tokens: string[] = [];
    const clause: number[] = [];
    let c = 0;

    // Split into tokens, bumping the clause id on punctuation and "but" words.
    const parts = folded.split(/([،,.؟?!;:()"…]+)|\s+/).filter(p => p !== undefined && p !== '');
    for (const part of parts) {
        if (/^[،,.؟?!;:()"…]+$/.test(part)) { c++; continue; }
        const tok = part.replace(/'/g, '');
        if (!tok) continue;
        if (CLAUSE_BREAKERS.has(tok)) { c++; continue; }
        tokens.push(tok);
        clause.push(c);
    }

    const negated = new Array(tokens.length).fill(false);
    const anchors: number[] = [];
    const governed: string[][] = [];

    /** "وسيروم" = "and serum": a conjunction-led token ends a prepositional negation. */
    const isConjunctionLed = (tok: string) =>
        CONJUNCTIONS.has(tok) || (tok.length > 2 && tok[0] === 'و' && !!detectCategoryInText(tok.slice(1)));

    const mark = (i: number, fwd: number, back: number, prep = false) => {
        const marked: string[] = [];
        for (let j = Math.max(0, i - back); j <= Math.min(tokens.length - 1, i + fwd); j++) {
            if (j === i || clause[j] !== clause[i]) continue;
            if (prep && j > i && isConjunctionLed(tokens[j])) break;     // "بدون كحول وسيروم": serum is NOT negated
            negated[j] = true;
            marked.push(tokens[j]);
        }
        anchors.push(i);
        negated[i] = true;
        governed.push(marked);
    };

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const next = tokens[i + 1];
        if (PREP_ANCHORS.has(t)) { mark(i, 2, 0, true); continue; }
        if (t === 'من' && (next === 'غير' || next === 'دون')) { mark(i + 1, 2, 0, true); negated[i] = true; i++; continue; }
        if (VERB_ANCHORS.has(t) || isDarijaNegationToken(t, next)) {
            // Negation governs what FOLLOWS ("ما رانيش حاب واقي شمس", "الغسول مش السيروم").
            // Only a clause-final negation looks backwards (Darija verb-final:
            // "واقي شمس ما نبغيهاش", English "sunscreen? no").
            let following = 0;
            for (let j = i + 1; j < tokens.length && clause[j] === clause[i]; j++) following++;
            if (t === 'ما' && next && next.endsWith('ش')) following -= 1;     // the negated verb itself
            mark(i, 4, following <= 0 ? 3 : 0);
            continue;
        }
    }

    const positive = tokens.filter((_, i) => !negated[i]).join(' ');
    return { tokens, negated, anchors, governed, positive };
}

/** Categories the user explicitly does NOT want ("بدون واقي شمس", "no toner"). */
export function findNegatedCategories(rawMessage: string): string[] {
    const a = analyzeNegation(rawMessage);
    const out = new Set<string>();
    for (const g of a.governed) {
        if (g.length === 0) continue;
        const cat = detectCategoryInText(g.join(' '));
        if (cat) out.add(cat);
    }
    return [...out];
}

/** The message with every negated span removed — use for category/entity detection. */
export function positiveText(rawMessage: string): string {
    return analyzeNegation(rawMessage).positive;
}

/**
 * True when `re` matches ONLY inside negated spans ("ما نبغيش روتين").
 * A positive mention elsewhere in the message wins.
 */
export function isPhraseNegated(rawMessage: string, re: RegExp): boolean {
    const a = analyzeNegation(rawMessage);
    let negatedHit = false;
    let positiveHit = false;
    a.tokens.forEach((t, i) => {
        if (!re.test(t)) return;
        if (a.negated[i]) negatedHit = true; else positiveHit = true;
    });
    return negatedHit && !positiveHit;
}
