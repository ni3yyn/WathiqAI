import fs from 'fs';
import path from 'path';
import { embedMany } from 'ai';
import { cohere } from '@ai-sdk/cohere';
import dotenv from 'dotenv';
dotenv.config();

const KNOWLEDGE_FILE = path.join(process.cwd(), 'src', 'knowledge_embeddings.json');

const clinicalGoldenRules = [
    {
        id: "safety_pregnancy_retinoids",
        category: "safety_contraindication",
        priority: 100, // HIGHEST PRIORITY
        triggers: ["حامل", "بالحمل", "رضاعة", "مرضع", "enceinte", "allaitement", "pregnancy", "retinol"],
        text: "يُمنع منعاً باتاً استخدام مشتقات فيتامين أ (الريتينول، التريتينوين، الأدابالين) أثناء فترة الحمل والرضاعة لكونها مواد مشوهة للجنين (Teratogenic). البديل الآمن والفعال لمكافحة التجاعيد هو الباكوتشيول (Bakuchiol) وحمض الببتيدات."
    },
    {
        id: "safety_pregnancy_high_salicylic",
        category: "safety_contraindication",
        priority: 95,
        triggers: ["حامل والساليسيليك", "حمض الساليسيليك للحامل", "salicylic enceinte"],
        text: "يجب تجنب مقشرات حمض الساليسيليك (BHA) بتركيزات تفوق 2% أثناء الحمل. يمكن الاستعاضة عنها بأحماض أكثر أماناً مثل حمض اللاكتيك أو حمض الأزيليك بتركيز 10% لعلاج الحبوب والتصبغات بأمان."
    },
    {
        id: "interaction_retinol_exfoliants",
        category: "ingredient_interaction",
        priority: 70,
        triggers: ["ريتينول مع مقشر", "خلط الريتينول و bha", "retinol peeling", "retinol aha"],
        text: "لا يُجمع بين الريتينول وأحماض التقشير الكيميائية القوية (AHA مثل الجليكوليك، أو BHA الساليسيليك) في نفس الجلسة الليلية تجنباً لتهيج حاجز البشرة والتهابها. يُفضل التناوب الليلي (Skin Cycling)."
    },
    {
        id: "climate_summer_storage",
        category: "climate_storage",
        priority: 50,
        triggers: ["السخانة", "الحرارة", "الصيف", "فسد السيروم", "أكسدة", "chaleur", "temperature"],
        text: "في مناخ الصيف الجزائري المرتفع (>30°C)، يجب حفظ سيرومات فيتامين ج النقي (L-Ascorbic Acid) والريتينول في باب الثلاجة أو خزانة مظلمة وباردة، لأن درجات الحرارة المرتفعة تسرّع تأكسدها وتغير لونها إلى البني مما يفقدها فعاليتها."
    },
    {
        id: "guideline_layering_order",
        category: "routine_guideline",
        priority: 40,
        triggers: ["ترتيب السيرومات", "واش ندير الاول", "ordre application"],
        text: "القاعدة الذهبية في ترتيب منتجات العناية هي التدرج من القوام الأخف مائياً إلى الأثقل زيتياً: غسول، ثم تونر مائي، ثم سيروم مائي (مثل الهيالورونيك)، ثم السيروم العلاجي، ثم المرطب لحبس الرطوبة، وينتهي الروتين الصباحي دائماً بواقي الشمس."
    }
];

async function seed() {
    console.log(`[SEED] 🚀 Generating 1024-dimension multilingual vectors via Cohere embed-multilingual-v3.0...`);

    const { embeddings } = await embedMany({
        model: cohere.textEmbeddingModel('embed-multilingual-v3.0'),
        values: clinicalGoldenRules.map(r => `${r.category}: ${r.text}`)
    });

    const dataset = clinicalGoldenRules.map((rule, idx) => ({
        ...rule,
        vector: embeddings[idx],
        updatedAt: new Date().toISOString()
    }));

    fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(dataset, null, 2));
    console.log(`✅ [SUCCESS] Knowledge base seeded with Cohere! Saved ${dataset.length} rules to src/knowledge_embeddings.json.`);
}

seed();