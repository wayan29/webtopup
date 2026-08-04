import { useEffect, useState } from 'react';
import { apiV2 } from '../api';
import { useAuthStore } from '../store/useAuthStore';
import { ShoppingCart, Package } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface Category {
    _id: string;
    name: string;
    slug: string;
    icon: string;
    sortOrder: number;
    status: boolean;
}

interface Product {
    _id: string;
    name: string;
    code: string;
    category: string;
    categoryId?: { _id: string; name: string; icon: string };
    operatorId?: { _id: string; name: string };
    productTypeId?: { _id: string; name: string };
    brand: string;
    price: {
        basic: number;
        gold: number;
        platinum: number;
    };
    status: boolean;
    canPurchase?: boolean;
    visibilityIssues?: string[];
}

export default function Products() {
    const [products, setProducts] = useState<Product[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<string>('all');
    const { user } = useAuthStore();
    const navigate = useNavigate();

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            setError('');
            try {
                const [productsRes, categoriesRes] = await Promise.all([
                    apiV2.get('/products'),
                    apiV2.get('/categories') // Only returns active categories, sorted by sortOrder
                ]);
                if (!Array.isArray(productsRes.data) || !Array.isArray(categoriesRes.data)) {
                    throw new Error('Malformed catalog response');
                }
                setProducts(productsRes.data);
                setCategories(categoriesRes.data);
            } catch (error) {
                console.error('Failed to fetch data', error);
                setProducts([]);
                setCategories([]);
                setError('Katalog belum bisa dimuat. Coba refresh halaman.');
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, []);

    const handleBuy = (product: Product) => {
        const operatorId = product.operatorId?._id;
        const productTypeId = product.productTypeId?._id;

        if (!operatorId) {
            window.alert('Produk ini belum punya operator yang valid. Cek pengaturan produk di dashboard admin.');
            return;
        }

        const path = productTypeId
            ? `/order/${operatorId}/${productTypeId}`
            : `/order/${operatorId}`;

        navigate(`${path}?pvc=${encodeURIComponent(product.code)}`);
    };

    // Filter products by selected category
    const filteredProducts = selectedCategory === 'all'
        ? products
        : products.filter(p => 
            p.categoryId?._id === selectedCategory || 
            p.category === categories.find(c => c._id === selectedCategory)?.name
        );

    // Group products by category for display
    const groupedProducts = categories.reduce((acc, cat) => {
        const categoryProducts = products.filter(p => 
            p.categoryId?._id === cat._id || p.category === cat.name
        );
        if (categoryProducts.length > 0) {
            acc.push({ category: cat, products: categoryProducts });
        }
        return acc;
    }, [] as { category: Category; products: Product[] }[]);

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="ui-accent-solid rounded-2xl px-4 py-8 text-center shadow-lg">
                <h1 className="text-3xl font-bold">Katalog Produk</h1>
                <p className="mt-2 opacity-85">Pilih kategori dan produk yang Anda butuhkan</p>
            </div>

            {/* Category Filter */}
            <div className="flex flex-wrap gap-2 justify-center">
                <button
                    onClick={() => setSelectedCategory('all')}
                    className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                        selectedCategory === 'all'
                            ? 'ui-accent-chip'
                            : 'ui-muted-action'
                    }`}
                >
                    Semua
                </button>
                {categories.map((cat) => (
                    <button
                        key={cat._id}
                        onClick={() => setSelectedCategory(cat._id)}
                        className={`px-4 py-2 rounded-full text-sm font-medium transition-colors flex items-center gap-2 ${
                            selectedCategory === cat._id
                                ? 'ui-accent-chip'
                                : 'ui-muted-action'
                        }`}
                    >
                        <span>{cat.icon}</span>
                        {cat.name}
                    </button>
                ))}
            </div>

            {loading ? (
                <div className="text-center py-12">
                    <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-[var(--ui-accent)]"></div>
                    <p className="ui-text-muted mt-4">Memuat produk...</p>
                </div>
            ) : error ? (
                <div className="ui-panel ui-border rounded-xl border py-12 text-center" role="alert">
                    <Package className="ui-text-muted mx-auto mb-3 h-12 w-12 opacity-60" />
                    <p className="ui-text-muted">{error}</p>
                </div>
            ) : selectedCategory === 'all' ? (
                // Show grouped by category when "all" is selected
                <div className="space-y-8">
                    {groupedProducts.length === 0 ? (
                        <div className="ui-panel ui-border rounded-xl border py-12 text-center">
                            <Package className="ui-text-muted mx-auto mb-3 h-12 w-12 opacity-60" />
                            <p className="ui-text-muted">Belum ada produk tersedia.</p>
                        </div>
                    ) : (
                        groupedProducts.map(({ category, products: catProducts }) => (
                            <div key={category._id}>
                                <div className="flex items-center gap-3 mb-4">
                                    <span className="text-2xl">{category.icon}</span>
                                    <h2 className="ui-text text-xl font-bold">{category.name}</h2>
                                    <span className="ui-text-muted text-sm">({catProducts.length} produk)</span>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                                    {catProducts.map((product) => (
                                        <ProductCard
                                            key={product._id}
                                            product={product}
                                            userLevel={(user?.level || 'basic') as 'basic' | 'gold' | 'platinum'}
                                            onBuy={() => handleBuy(product)}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            ) : (
                // Show filtered products when a specific category is selected
                <div>
                    {filteredProducts.length === 0 ? (
                        <div className="ui-panel ui-border rounded-xl border py-12 text-center">
                            <Package className="ui-text-muted mx-auto mb-3 h-12 w-12 opacity-60" />
                            <p className="ui-text-muted">Tidak ada produk dalam kategori ini.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                            {filteredProducts.map((product) => (
                                <ProductCard
                                    key={product._id}
                                    product={product}
                                    userLevel={(user?.level || 'basic') as 'basic' | 'gold' | 'platinum'}
                                    onBuy={() => handleBuy(product)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}

        </div>
    );
}

function ProductCard({ product, userLevel, onBuy }: {
    product: Product;
    userLevel: 'basic' | 'gold' | 'platinum';
    onBuy: () => void;
}) {
    const price = product.price[userLevel];
    const canBuy = product.status !== false && product.canPurchase !== false && Boolean(product.operatorId?._id);

    return (
        <div className="ui-panel ui-border flex flex-col overflow-hidden rounded-2xl border shadow-[0_10px_28px_rgba(15,15,31,0.10)] transition duration-200 hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--ui-accent)_36%,transparent)] hover:shadow-[0_16px_36px_rgba(15,15,31,0.16)]">
            <div className="p-5 flex-grow">
                <div className="flex items-start justify-between gap-2 mb-2">
                    <span className="ui-accent-text text-xs font-semibold uppercase tracking-wide">
                        {product.brand}
                    </span>
                    <span className="text-lg">{product.categoryId?.icon || '📦'}</span>
                </div>
                <h3 className="ui-text mb-1 text-base font-bold">{product.name}</h3>
                <p className="ui-text-muted mb-3 text-xs">
                    {product.categoryId?.name || product.category}
                </p>
                <div className="flex items-baseline gap-1">
                    <span className="ui-text text-xl font-bold">
                        Rp{price.toLocaleString('id-ID')}
                    </span>
                    {userLevel !== 'basic' && (
                        <span className="ui-accent-chip rounded-full px-2 py-0.5 text-xs font-medium">
                            {userLevel}
                        </span>
                    )}
                </div>
                {product.canPurchase === false && product.visibilityIssues?.length ? (
                    <p className="mt-2 text-xs text-amber-600">
                        {product.visibilityIssues.join(', ')}
                    </p>
                ) : null}
            </div>
            <div className="ui-border border-t bg-[var(--ui-card-muted)] px-5 py-3">
                <button
                    onClick={onBuy}
                    disabled={!canBuy}
                    className="ui-accent-solid flex w-full items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-bold transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <ShoppingCart className="w-4 h-4" />
                    {canBuy ? 'Lanjut ke Order' : 'Tidak Tersedia'}
                </button>
            </div>
        </div>
    );
}
