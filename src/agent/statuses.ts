/**
 * Canonical user-facing progress statuses for the Wathiq agent.
 * Keep all status copy here so the LLM and fast-lane paths cannot drift.
 */
export const STATUS = {
    ROUTING: '🧠 جاري فهم طلبك وتجهيز المسار المناسب...',
    MODEL_START: '🧠 جاري تحليل طلبك واختيار الخطوة المناسبة...',
    MODEL_WAITING: '🔎 جاري تحليل الطلب وتجهيز الخطوة التالية...',
    MODEL_CONTINUING: '⚙️ ما زلت أعمل على طلبك؛ يجري تجهيز الرد...',
    MODEL_FALLBACK: '🔄 أجرّب مسارًا بديلًا لإكمال الإجابة...',
    FORMULATING: '✨ جاري صياغة التقييم والنتيجة...',
    RETRYING: '🧠 تعذّر الحصول على رد، أعيد المحاولة...',
    WORKING: '⚙️ جاري تنفيذ الخطوة المطلوبة...',
    SEARCH_EVALUATING: '🧪 جاري تقييم أفضل المنتجات عبر محرك وثيق...',
    SEARCH_RANKING: '📊 انتهى التقييم؛ أرتّب أفضل النتائج حسب درجة وثيق...',
} as const;

export const TOOL_STATUS: Readonly<Record<string, string>> = {
    search_products: '🔍 جاري البحث في كتالوج المنتجات...',
    evaluate_product: '🧪 جاري فحص وتحليل التركيبة مع OilGuard...',
    evaluate_brand: '🏷️ جاري تحليل جميع منتجات الماركة...',
    get_product: '📋 جاري استرجاع تفاصيل المنتج ومكوناته...',
    build_routine: '🧴 جاري تكوين روتين عناية متكامل...',
    get_products_details: '📋 جاري استرجاع مكونات المنتجات...',
    list_unknown_ingredients: '🧪 جاري تحليل المكونات غير المفهرسة... قد يستغرق هذا بعض الوقت',
    get_community_reviews: '💬 جاري فحص تجارب وآراء المستخدمين في تيك توك...',
    compare_products: '⚖️ جاري المقارنة بين المنتجات بنفس المعايير...',
    check_ingredient_list: '🧫 جاري تحليل قائمة المكونات المُدخلة...',
    product_contains: '🔎 جاري فحص القائمة الكاملة للمكونات...',
    find_alternatives: '🔁 جاري البحث عن بدائل تشاركه المكونات الفعالة...',
    check_compatibility: '🧬 جاري فحص توافق المكونات...',
    modify_routine: '✏️ جاري تعديل الروتين...',
    find_actives_dupe: '🧬 جاري البحث عن بدائل محلية تشاركه المكونات الفعالة...',
    generate_usage_schedule: '🗓️ جاري إعداد جدول التدرج الآمن...',
    manage_cabinet: '🗄️ جاري تحديث خزانتك...',
    triage_reaction: '🩺 جاري تحليل ما تعانيه بشرتك...',
    routine_versions: '🕘 جاري استرجاع نسخ الروتين...',
    explain_pick: '🔎 جاري تحليل سبب الاختيار...',
    share_routine: '📤 جاري تجهيز الروتين للمشاركة...',
    build_shopping_list: '🛒 جاري إعداد قائمة التسوق...',
    build_gift_set: '🎁 جاري تكوين مجموعة الهدية...',
    suggest_learning: '💡 جاري تسجيل المعلومة الجديدة للتدقيق...',
};

/**
 * Deduplicate consecutive status events and provide one request-scoped emitter.
 * Every lane/tool receives this same function, so status progression is consistent.
 */
export function createStatusReporter(onStatus?: (status: string) => void): (status: string) => void {
    let lastStatus = '';
    return (status: string) => {
        const next = String(status || '').trim();
        if (!next || next === lastStatus) return;
        lastStatus = next;
        onStatus?.(next);
    };
}

export function emitToolStatus(toolName: string, emitStatus?: (status: string) => void): void {
    emitStatus?.(TOOL_STATUS[toolName] || STATUS.WORKING);
}
