import { ApifyClient } from 'apify-client';
import { processTikTokComments } from './tiktok_processor';
import dotenv from 'dotenv';
dotenv.config();

const client = new ApifyClient({
    token: process.env.APIFY_API_TOKEN, // Free tier token from apify.com
});

export async function harvestViaApify(productId: string, productName: string, videoUrls: string[]) {
    console.log(`[APIFY] Fetching comments for ${productName}...`);

    // Run the TikTok Comments Scraper Actor
    const run = await client.actor('clockworks/tiktok-comments-scraper').call({
        postURLs: videoUrls,
        commentsPerPost: 100,
        maxRepliesPerComment: 0
    });

    // Fetch scraped comments from Apify dataset
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    const formattedComments = items.map((item: any) => ({
        author: `@${item.user?.uniqueId || 'user'}`,
        text: item.text || ''
    }));

    console.log(`[APIFY] Retrieved ${formattedComments.length} real comments.`);
    
    // Process and synthesize directly into reviews_db.json
    await processTikTokComments(productId, productName, formattedComments);
}