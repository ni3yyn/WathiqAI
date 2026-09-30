import { getProduct } from './getProduct';

export interface GetProductsDetailsArgs {
    productIds: string[];
}

export interface GetProductsDetailsResult {
    count: number;
    products: Array<{
        id: string;
        brand: string;
        name: string;
        price: string;
        ingredients: string;
    }>;
    notFound?: string[];
}

/**
 * Bulk variant of getProduct: resolves a full ingredient list (and basic
 * details) for several product IDs in one call, instead of the model having
 * to spend one tool-call step per product. Pure catalog lookup — it takes
 * no opinion on WHERE the IDs came from; that's the caller's job (in
 * agent.ts, the tool wrapper resolves IDs from the conversation's
 * [Context: ...] hint or, failing that, from the session's own memory of
 * the last routine/search shown).
 */
export async function getProductsDetails(args: GetProductsDetailsArgs): Promise<GetProductsDetailsResult> {
    const ids = (args.productIds || []).filter(Boolean);

    const lookups = await Promise.all(
        ids.map(id => getProduct({ productId: id }))
    );

    const found = lookups
        .map((r, i) => ({ r, id: ids[i] }))
        .filter(({ r }) => r.found && r.product);

    const notFound = ids.filter((id, i) => !(lookups[i].found && lookups[i].product));

    return {
        count: found.length,
        products: found.map(({ r }) => ({
            id: r.product!.id,
            brand: r.product!.brand,
            name: r.product!.name,
            price: `${r.product!.price} ${r.product!.currency}`,
            // Full list, not sliced — when the user asks to see ingredients
            // in plain text, that list IS the deliverable.
            ingredients: r.product!.ingredientList.join('، ')
        })),
        notFound: notFound.length > 0 ? notFound : undefined
    };
}