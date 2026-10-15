/**
 * Golden-set regression runner (offline, no keys): replays messages through the
 * router and checks the first tool it picks.
 *
 *   npx tsx scripts/evals.ts                  # run scripts/evals/golden.jsonl
 *   npx tsx scripts/evals.ts --feedback       # also print 👍/👎 stats from data/feedback.jsonl
 *
 * Add real cases (anonymized!) as one JSON object per line:
 *   {"id":"g99","message":"...","setup":{"lastProduct":true},"expectTool":"evaluate_product"}
 *   expectTool: "tool" = must be first, "!tool" = must NOT be first, null = router must stay silent.
 * setup flags: lastProduct, lastRoutine, userId, correction (prior evaluation of a Delta product).
 */
import fs from 'fs';
import path from 'path';

async function main() {
    const { classifyIntent } = await import('../src/agent/agent');
    const { sessionMemory } = await import('../src/agent/sessionMemory');
    const file = path.join(__dirname, 'evals', 'golden.jsonl');
    const cases = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));

    const routine: any = { routineId: 'r', title: 't', concern: 'x', routineType: 'skin', maxBudget: 5000, totalCost: 2000, savings: 3000, stepsCount: 2, usageTips: [], includedRequired: [], requiredNotPlaced: [],
        steps: [1, 2].map(n => ({ stepNumber: n, stepName: `s${n}`, category: n === 1 ? 'cleanser' : 'lotion_cream', usageTime: '', howToUse: '', whyChosen: '', product: { id: `P${n}`, brand: 'B', name: `N${n}`, price: 1000, currency: 'DZD' } })) };

    let pass = 0; const fails: string[] = []; const t0 = process.hrtime.bigint();
    for (const c of cases) {
        const st: any = sessionMemory.getOrCreate(`eval-${c.id}`);
        st.turnCount = 3;
        if (c.setup?.lastProduct) st.lastProduct = { id: 'P1', brand: 'B', name: 'N1' };
        if (c.setup?.lastRoutine) st.lastRoutine = routine;
        if (c.setup?.userId) st.userId = 'eval-user-0000';
        if (c.setup?.correction) {
            st.lastAnalysis = { brand: 'Delta', productId: 'P1', name: 'Delta Serum' };
            st.productHistory = [{ id: 'P1', brand: 'Delta', name: 'Delta Serum', turn: 2, source: 'analysis' }];
        }
        const top = classifyIntent(c.message, st).likelyTools[0] ?? null;
        const e: string | null = c.expectTool;
        const ok = e === null ? top === null : e.startsWith('!') ? top !== e.slice(1) : top === e;
        if (ok) pass++; else fails.push(`${c.id} "${c.message}" → expected ${e}, got ${top}`);
    }
    const us = Number((process.hrtime.bigint() - t0) / 1000n);
    console.log(`Golden set: ${pass}/${cases.length} passed (${Math.round((pass / cases.length) * 100)}%) · router ${(us / cases.length).toFixed(0)} µs/message`);
    fails.forEach(f => console.log('  ✗', f));

    if (process.argv.includes('--feedback')) {
        const { feedbackStats } = await import('../src/agent/feedback');
        console.log('Feedback:', JSON.stringify(feedbackStats(), null, 2));
    }
    process.exit(fails.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
