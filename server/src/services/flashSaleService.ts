import FlashSale from '../models/FlashSale';

export interface FlashSalePriceResult {
    flashSaleId: string;
    flashPrice: number;
    discountType: 'percentage' | 'fixed';
    discountValue: number;
    remainingStock: number;
}

export const getFlashSalePriceForProduct = async (
    productId: string,
    basePrice: number
): Promise<FlashSalePriceResult | null> => {
    const now = new Date();
    const flashSale = await FlashSale.findOne({
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
        'products.productId': productId
    });

    if (!flashSale) return null;

    const flashProduct = flashSale.products.find(
        (item) => item.productId.toString() === productId.toString()
    );

    if (!flashProduct) return null;

    const remainingStock = flashProduct.stock - flashProduct.soldCount;
    if (remainingStock <= 0) return null;

    const flashPrice = flashProduct.discountType === 'percentage'
        ? Math.max(0, Math.round(basePrice - (basePrice * flashProduct.discountValue) / 100))
        : Math.max(0, basePrice - flashProduct.discountValue);

    return {
        flashSaleId: flashSale._id.toString(),
        flashPrice,
        discountType: flashProduct.discountType,
        discountValue: flashProduct.discountValue,
        remainingStock
    };
};

export const reserveFlashSaleStock = async (flashSaleId: string, productId: string) => {
    const now = new Date();
    const result = await FlashSale.updateOne(
        {
            _id: flashSaleId,
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
            'products.productId': productId,
            $expr: {
                $gt: [
                    {
                        $size: {
                            $filter: {
                                input: '$products',
                                as: 'product',
                                cond: {
                                    $and: [
                                        { $eq: ['$$product.productId', { $toObjectId: productId }] },
                                        { $gt: [{ $subtract: ['$$product.stock', '$$product.soldCount'] }, 0] }
                                    ]
                                }
                            }
                        }
                    },
                    0
                ]
            }
        },
        { $inc: { 'products.$.soldCount': 1 } }
    );

    if (result.modifiedCount !== 1) {
        throw new Error('Stok flash sale sudah habis atau promo tidak aktif');
    }

    return result;
};
