import fs from 'fs';
import path from 'path';
import { google } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

const REVIEWS_DB_FILE = path.join(process.cwd(), 'src', 'reviews_db.json');

interface CommunityComment {
    author: string;
    text: string;
    platform: string;
    score: number;
}

// ─── 1. REDDIT SCRAPER (USES REDDIT'S PUBLIC HIDDEN JSON API) ────────────────
export async function scrapeRedditDiscussions(searchQuery: string): Promise<CommunityComment[]> {
    console.log(`[COMMUNITY - REDDIT] 🔍 Searching r/algeria for: "${searchQuery}"...`);
    const comments: CommunityComment[] = [];

    try {
        // Search r/algeria via Reddit's native JSON endpoint
        const searchUrl = `https://www.reddit.com/r/algeria/search.json?q=${encodeURIComponent(searchQuery)}&restrict_sr=1&sort=relevance&limit=5`;
        
        const response = await fetch(searchUrl, {
            headers: { 'User-Agent': 'WathiqIntelligenceBot/1.0' }
        });

        if (!response.ok) {
            console.warn(`[REDDIT] Search failed with status: ${response.status}`);
            return [];
        }

        const data = await response.json();
        const posts = data?.data?.children || [];
        console.log(`[REDDIT] 🎯 Found ${posts.length} relevant discussion threads.`);

        for (const post of posts) {
            const permalink = post.data?.permalink;
            if (!permalink) continue;

            // Fetch comments inside this thread via .json endpoint
            const threadUrl = `https://www.reddit.com${permalink}.json`;
            const threadRes = await fetch(threadUrl, {
                headers: { 'User-Agent': 'WathiqIntelligenceBot/1.0' }
            });

            if (!threadRes.ok) continue;

            const threadData = await threadRes.json();
            const rawComments = threadData[1]?.data?.children || [];

            for (const c of rawComments) {
                const body = c.data?.body;
                const author = c.data?.author;
                const score = c.data?.score || 0;

                if (body && body.length > 15 && !body.includes('[deleted]')) {
                    comments.push({
                        author: `u/${author}`,
                        text: body.trim(),
                        platform: 'Reddit (r/algeria)',
                        score
                    });
                }
            }

            // Polite delay between Reddit calls
            await new Promise(r => setTimeout(r, 1000));
        }

    } catch (e: any) {
        console.error(`[REDDIT] Error fetching discussions:`, e.message);
    }

    console.log(`[REDDIT] ✅ Extracted ${comments.length} authentic community comments.`);
    return comments;
}

// ─── 2. SEARCH ENGINE FORUM HARVESTER (BING SITE:FACEBOOK.COM / DORKING) ─────
export async function scrapeForumMentions(productName: string): Promise<CommunityComment[]> {
    console.log(`[COMMUNITY - FORUMS] 🌐 Harvesting public forum & group mentions for: "${productName}"...`);
    const comments: CommunityComment[] = [];

    try {
        // Query public web discussions
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"تجربتي" OR "رايي" "${productName}" algerie`)}`;
        
        const res = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            }
        });

        if (res.ok) {
            const html = await res.text();
            // Extract snippet descriptions from search results
            const snippets = html.match(/<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/gi) || [];
            
            snippets.forEach((s, idx) => {
                const cleanText = s.replace(/<[^>]+>/g, '').trim();
                if (cleanText.length > 20) {
                    comments.push({
                        author: `Forum_User_${idx + 1}`,
                        text: cleanText,
                        platform: 'Public Beauty Forums',
                        score: 0
                    });
                }
            });
        }
    } catch (e: any) {
        console.warn(`[FORUMS] Error harvesting forum mentions: ${e.message}`);
    }

    console.log(`[FORUMS] ✅ Extracted ${comments.length} forum discussions.`);
    return comments;
}

// ─── 3. AI SYNTHESIS (GEMINI 3.5 FLASH) ──────────────────────────────────────
export async function synthesizeCommunityFeedback(
    productId: string, 
    productName: string, 
    allReviews: CommunityComment[]
) {
    if (allReviews.length === 0) {
        console.log(`⚠️ No reviews collected to synthesize.`);
        return;
    }

    console.log(`\n[SYNTHESIS] 🧠 Sending ${allReviews.length} community discussions to Gemini 3.5 Flash...`);

    const { object } = await generateObject({
        model: google('gemini-3.5-flash'),
        schema: z.object({
            satisfactionRate: z.number().min(0).max(100),
            summary: z.string().describe('A 1-sentence consensus summary in Arabic'),
            pros: z.array(z.string()).max(4),
            cons: z.array(z.string()).max(4),
            rawVerifiedQuotes: z.array(z.object({
                author: z.string(),
                verbatimText: z.string().describe('Original text, keep exact words/spelling'),
                skinProfile: z.string().describe('Skin type or "غير محدد"')
            })).min(2).max(8)
        }),
        prompt: `
        Analyze these authentic Algerian community reviews and discussions from Reddit and local beauty forums regarding "${productName}":
        ${JSON.stringify(allReviews.map(r => ({ author: r.author, text: r.text, platform: r.platform })))}

        Extract satisfaction rate, pros, cons, and select the top verbatim quotes.
        `
    });

    let reviewsDb: any = {};
    if (fs.existsSync(REVIEWS_DB_FILE)) {
        try {
            reviewsDb = JSON.parse(fs.readFileSync(REVIEWS_DB_FILE, 'utf-8'));
        } catch (e) {
            reviewsDb = {};
        }
    }

    reviewsDb[productId] = {
        productId,
        productName,
        sources: {
            reddit: allReviews.filter(r => r.platform.includes('Reddit')).length,
            forums: allReviews.filter(r => r.platform.includes('Forums')).length,
            totalHarvested: allReviews.length
        },
        updatedAt: new Date().toISOString(),
        ...object
    };

    fs.writeFileSync(REVIEWS_DB_FILE, JSON.stringify(reviewsDb, null, 2));
    console.log(`\n============================================================`);
    console.log(`✅ [SUCCESS] reviews_db.json updated from Community Discussions!`);
    console.log(`📦 Product: ${productName} (${productId})`);
    console.log(`📊 Score: ${object.satisfactionRate}% Satisfaction (${allReviews.length} discussions)`);
    console.log(`============================================================\n`);
}

// ─── 4. MASTER RUNNER ────────────────────────────────────────────────────────
async function run() {
    const productId = "DZ-CLE-BIO-001";
    const productName = "Biolila Cleansing Gel";
    const searchTerms = "biolila";

    // 1. Gather Reddit threads
    const redditReviews = await scrapeRedditDiscussions(searchTerms);

    // 2. Gather Public Forum discussions
    const forumReviews = await scrapeForumMentions("غسول بيوليلا");

    const combined = [...redditReviews, ...forumReviews];
    console.log(`\n🎉 Total Community Discussions Gathered: ${combined.length}`);

    // 3. Synthesize and write to reviews_db.json
    await synthesizeCommunityFeedback(productId, productName, combined);
}

run();