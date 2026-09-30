import fastify from 'fastify';
import { processChat, streamChat } from './agent/agent';
import { getProducts } from './wathiq/backendClient';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { runAutonomousWorker } from './autonomous_worker';

dotenv.config();

const server = fastify({ logger: true });

server.get('/', async (request, reply) => {
    try {
        let htmlPath = path.join(__dirname, 'public', 'index.html');
        if (!fs.existsSync(htmlPath)) {
            htmlPath = path.join(__dirname, '..', 'src', 'public', 'index.html');
        }
        const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
        return reply.type('text/html').send(htmlContent);
    } catch (e) {
        return { status: 'ok', name: 'Wathiq Intelligence MVP Agent', endpoint: 'POST /api/chat' };
    }
});

server.post('/api/chat', async (request, reply) => {
    try {
        const body = request.body as any;
        if (!body || !body.message) {
            return reply.status(400).send({ type: 'error', message: 'Missing message in request body' });
        }

        console.log(`[AGENT] request received: ${body.message}`);

        const wantsStream = body.stream === true || request.headers.accept?.includes('text/event-stream');

        if (wantsStream) {
            reply.raw.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });

            const sendSSE = (eventData: any) => {
                reply.raw.write(`data: ${JSON.stringify(eventData)}\n\n`);
            };

            try {
                const finalResult = await streamChat(body, {
                    onStatus: (status: string) => {
                        sendSSE({ type: 'status', status });
                    },
                    onTextDelta: (delta: string) => {
                        sendSSE({ type: 'text-delta', delta });
                    },
                    // ADD THIS LINE: Send the card to the frontend immediately
    onCardReady: (cardType: string, data: any) => {
        sendSSE({ type: 'card', cardType, data });
    }
                });

                sendSSE({ type: 'finish', data: finalResult });
            } catch (err: any) {
                console.error('[AGENT] Stream error:', err);
                sendSSE({ type: 'error', message: err.message || 'Stream processing failed' });
            } finally {
                reply.raw.end();
            }

            return;
        }

        // Non-streaming fallback for curl / standard JSON
        const result = await processChat(body);
        return reply.status(200).send(result);
    } catch (error: any) {
        console.error('[AGENT] Error processing chat', error);
        return reply.status(500).send({
            type: 'error',
            message: 'An internal error occurred',
            details: error.message
        });
    }
});

// This schedules the worker to run autonomously every day at 3:00 AM
cron.schedule('0 3 * * *', async () => {
    try {
        await runAutonomousWorker();
    } catch (e) {
        console.error('[CRON] Autonomous worker failed:', e);
    }
});

const PORT = parseInt(process.env.PORT || '3001', 10);

const start = async () => {
    try {
        // Warm the product catalog cache before opening the port. Without this,
        // whichever user sends the first message after a cold start/deploy eats
        // the full catalog fetch latency inline with their chat request.
        try {
            const products = await getProducts();
            server.log.info(`[STARTUP] Catalog warmed: ${products.length} products cached`);
        } catch (warmErr) {
            server.log.warn({ err: warmErr }, '[STARTUP] Catalog warm-up failed, will retry lazily on first request');
        }

        await server.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`Wathiq Intelligence MVP Agent listening on http://localhost:${PORT}`);
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};

start();
runAutonomousWorker()