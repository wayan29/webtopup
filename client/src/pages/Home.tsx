import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    ChevronLeft,
    ChevronRight,
    Users,
    Shield,
    Clock,
    Headphones,
    Package,
    CreditCard,
    X,
    Loader2,
    Sparkles,
    Zap,
    Gift,
    TrendingUp,
    FileText,
    Calendar,
    Search,
    Copy,
    CheckCircle,
    XCircle,
    AlertCircle,
    ArrowRight,
    RefreshCw
} from 'lucide-react';
import { apiV2 } from '../api';
import OperatorIcon from '../components/OperatorIcon';
import HomeCountdown from '../components/HomeCountdown';
import { getAssetUrl } from '../lib/assetUrl';

interface Category {
    _id: string;
    name: string;
    slug: string;
    icon: string;
    sortOrder: number;
    productCount?: number;
}

interface Operator {
    _id: string;
    name: string;
    slug: string;
    icon?: string;
    categoryId: string | { _id: string; name: string; slug: string; icon?: string };
}

interface ProductType {
    _id: string;
    name: string;
    slug: string;
    operatorId: string | { _id: string; name: string };
    openTime: string;
    closeTime: string;
    status: boolean;
}

interface SliderData {
    _id: string;
    name: string;
    image: string;
    link?: string;
}

interface FlashSaleProduct {
    productId: {
        _id: string;
        name: string;
        code: string;
        price: { basic: number; gold: number; platinum: number };
        icon?: string;
        operatorId?: { _id: string; name: string; slug: string };
        productTypeId?: { _id: string; name: string; slug: string };
    };
    discountType: 'percentage' | 'fixed';
    discountValue: number;
    stock: number;
    soldCount: number;
}

interface FlashSale {
    _id: string;
    name: string;
    description?: string;
    startDate: string;
    endDate: string;
    products: FlashSaleProduct[];
    isActive: boolean;
    banner?: string;
}

interface Article {
    _id: string;
    title: string;
    slug: string;
    excerpt: string;
    image?: string;
    category: string;
    createdAt: string;
}

const defaultSlides = [
    {
        id: '1',
        title: 'Top Up Game Termurah',
        subtitle: 'Proses kilat detik, harga bersahabat.',
        bg: 'from-orange-600 to-amber-600',
        icon: <Zap className="w-12 h-12 text-white/20 absolute -right-2 -bottom-2" />
    },
    {
        id: '2',
        title: 'Join Reseller VIP',
        subtitle: 'Dapatkan harga spesial & prioritas.',
        bg: 'from-blue-600 to-indigo-600',
        icon: <Users className="w-12 h-12 text-white/20 absolute -right-2 -bottom-2" />
    },
    {
        id: '3',
        title: 'Promo Spesial',
        subtitle: 'Diskon hingga 50% hari ini.',
        bg: 'from-pink-600 to-rose-600',
        icon: <Gift className="w-12 h-12 text-white/20 absolute -right-2 -bottom-2" />
    },
];

export default function Home() {
    const [categories, setCategories] = useState<Category[]>([]);
    const [operators, setOperators] = useState<Operator[]>([]);
    const [sliders, setSliders] = useState<SliderData[]>([]);
    const [flashSales, setFlashSales] = useState<FlashSale[]>([]);
    const [articles, setArticles] = useState<Article[]>([]);
    const [loading, setLoading] = useState(true);
    const [currentSlide, setCurrentSlide] = useState(0);
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

    // Instant Search query
    const [searchQuery, setSearchQuery] = useState('');
    const [activeSearchIndex, setActiveSearchIndex] = useState(0);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const operatorDialogRef = useRef<HTMLDivElement>(null);
    const lastFocusedElementRef = useRef<HTMLElement | null>(null);

    // Quick Invoice status checker state
    const [invoiceNo, setInvoiceNo] = useState('');
    const [invoicePhone, setInvoicePhone] = useState('');
    const [invoiceLoading, setInvoiceLoading] = useState(false);
    const [invoiceResult, setInvoiceResult] = useState<any>(null);
    const [invoiceError, setInvoiceError] = useState('');
    const [invoiceCopied, setInvoiceCopied] = useState(false);

    const handleCheckInvoice = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmedInvoice = invoiceNo.trim().toUpperCase();
        const trimmedPhone = invoicePhone.trim();
        if (!trimmedInvoice || !trimmedPhone) return;

        setInvoiceLoading(true);
        setInvoiceError('');
        setInvoiceResult(null);

        try {
            const params = { whatsapp: trimmedPhone };
            const res = await apiV2.get(`/guest-transactions/check/${trimmedInvoice}`, { params });
            setInvoiceResult(res.data);
        } catch (err: any) {
            setInvoiceError(err.response?.data?.message || 'Transaksi tidak ditemukan');
        } finally {
            setInvoiceLoading(false);
        }
    };

    const handleCopyText = (text: string) => {
        navigator.clipboard.writeText(text);
        setInvoiceCopied(true);
        setTimeout(() => setInvoiceCopied(false), 2000);
    };

    // Popup state
    const [showPopup, setShowPopup] = useState(false);
    const [selectedOperator, setSelectedOperator] = useState<Operator | null>(null);
    const [productTypes, setProductTypes] = useState<ProductType[]>([]);
    const [loadingTypes, setLoadingTypes] = useState(false);
    const [hasDirectProducts, setHasDirectProducts] = useState(false);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const [catRes, opRes, sliderRes, flashSaleRes, articlesRes] = await Promise.all([
                    apiV2.get('/categories'),
                    apiV2.get('/operators'),
                    apiV2.get('/sliders').catch(() => ({ data: [] })),
                    apiV2.get('/flash-sales/active').catch(() => ({ data: [] })),
                    apiV2.get('/articles?status=published').catch(() => ({ data: [] }))
                ]);
                setCategories(catRes.data);
                setOperators(opRes.data);
                setSliders(sliderRes.data);
                setFlashSales(flashSaleRes.data);
                setArticles(articlesRes.data.slice(0, 3));
                if (catRes.data.length > 0) {
                    setSelectedCategory(catRes.data[0]._id);
                }
            } catch (error) {
                console.error('Failed to fetch data', error);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, []);

    const handleOperatorClick = async (operator: Operator) => {
        setSelectedOperator(operator);
        setShowPopup(true);
        setLoadingTypes(true);
        setHasDirectProducts(false);

        try {
            const path = `/product-types?operatorId=${operator._id}`;
            const res = await apiV2.get(path);
            setProductTypes(res.data);

            if (!Array.isArray(res.data) || res.data.length === 0) {
                try {
                    const productPath = `/products?operatorId=${operator._id}`;
                    const productRes = await apiV2.get(productPath);
                    setHasDirectProducts(Array.isArray(productRes.data) && productRes.data.length > 0);
                } catch {
                    setHasDirectProducts(false);
                }
            } else {
                setHasDirectProducts(false);
            }
        } catch (error) {
            console.error('Failed to fetch product types', error);
            setProductTypes([]);
            try {
                const productPath = `/products?operatorId=${operator._id}`;
                const productRes = await apiV2.get(productPath);
                setHasDirectProducts(Array.isArray(productRes.data) && productRes.data.length > 0);
            } catch {
                setHasDirectProducts(false);
            }
        } finally {
            setLoadingTypes(false);
        }
    };

    const closePopup = () => {
        setShowPopup(false);
        setSelectedOperator(null);
        setProductTypes([]);
        setHasDirectProducts(false);
    };

    const hasApiSliders = sliders.length > 0;
    const slidesCount = hasApiSliders ? sliders.length : defaultSlides.length;
    const activeFlashSales = flashSales.filter((flashSale) => flashSale.products.length > 0);
    const hasMultipleFlashSales = activeFlashSales.length > 1;
    const flashSaleEntries = activeFlashSales.flatMap((sale) => (
        sale.products.map((item) => ({ sale, item }))
    ));

    useEffect(() => {
        if (slidesCount === 0) return;
        const timer = setInterval(() => {
            setCurrentSlide((prev) => (prev + 1) % slidesCount);
        }, 5000);
        return () => clearInterval(timer);
    }, [slidesCount]);

    const calculateFlashPrice = (price: number, discountType: 'percentage' | 'fixed', discountValue: number) => {
        if (discountType === 'percentage') {
            return Math.round(price * (1 - discountValue / 100));
        }
        return Math.max(0, price - discountValue);
    };

    const formatPrice = (price: number) => {
        return new Intl.NumberFormat('id-ID').format(price);
    };

    const nextSlide = () => setCurrentSlide((prev) => (prev + 1) % slidesCount);
    const prevSlide = () => setCurrentSlide((prev) => (prev - 1 + slidesCount) % slidesCount);

    const getImageUrl = (image: string) => {
        if (image.startsWith('http')) return image;
        return getAssetUrl(image);
    };

    const getSafeSliderLink = (link?: string | null) => {
        const normalized = typeof link === 'string' ? link.trim() : '';

        if (!normalized) {
            return null;
        }

        if (normalized.startsWith('/')) {
            return normalized.startsWith('//') ? null : normalized;
        }

        try {
            const parsed = new URL(normalized);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:'
                ? parsed.toString()
                : null;
        } catch {
            return null;
        }
    };

    const filteredOperators = useMemo(() => operators.filter(op => {
        const catId = typeof op.categoryId === 'object' ? op.categoryId._id : op.categoryId;
        return catId === selectedCategory;
    }), [operators, selectedCategory]);
    const searchedOperators = useMemo(() => {
        const keyword = searchQuery.trim().toLowerCase();
        if (!keyword) return [];
        return operators.filter(op => op.name.toLowerCase().includes(keyword)).slice(0, 12);
    }, [operators, searchQuery]);
    const selectedCategoryInfo = useMemo(
        () => categories.find((cat) => cat._id === selectedCategory) || null,
        [categories, selectedCategory]
    );

    useEffect(() => {
        setActiveSearchIndex(0);
    }, [searchQuery]);

    const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!searchQuery || searchedOperators.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveSearchIndex((prev) => (prev + 1) % searchedOperators.length);
            return;
        }

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveSearchIndex((prev) => (prev - 1 + searchedOperators.length) % searchedOperators.length);
            return;
        }

        if (e.key === 'Enter') {
            e.preventDefault();
            const selected = searchedOperators[activeSearchIndex];
            if (selected) {
                handleOperatorClick(selected);
                setSearchQuery('');
            }
            return;
        }

        if (e.key === 'Escape') {
            setSearchQuery('');
        }
    };

    useEffect(() => {
        if (!showPopup) return;

        lastFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const dialog = operatorDialogRef.current;
        const focusableSelector = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
        const getFocusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(focusableSelector) || [])
            .filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);

        document.body.style.overflow = 'hidden';
        setTimeout(() => getFocusable()[0]?.focus(), 0);

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                closePopup();
                return;
            }

            if (event.key !== 'Tab' || !dialog) return;

            const focusable = getFocusable();
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];

            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = '';
            lastFocusedElementRef.current?.focus();
        };
    }, [showPopup]);

    return (
        <div className="min-h-screen ui-shell ui-text-muted selection:bg-[var(--ui-accent-soft)]">
            <div className="fixed inset-0 pointer-events-none overflow-hidden max-sm:hidden">
                <div className="absolute -top-24 left-1/4 h-80 w-80 rounded-full bg-orange-600/10 blur-[120px]" />
                <div className="absolute bottom-0 right-1/4 h-96 w-96 rounded-full bg-blue-600/10 blur-[130px]" />
            </div>

            <div className="relative mx-auto flex max-w-7xl flex-col gap-8 px-4 py-5 sm:gap-10 sm:py-8">
                {/* Instant Search Bar Premium */}
                <div className="relative z-20 order-2 rounded-[24px] border ui-border ui-panel p-4 shadow-lg ui-subtle-mesh-glow sm:rounded-[32px] sm:p-6 sm:shadow-2xl lg:order-2">
                    <div className="relative max-w-2xl mx-auto text-center space-y-3 sm:space-y-4">
                        <div className="inline-flex items-center gap-2 rounded-full border border-[var(--ui-accent-soft)] bg-[var(--ui-accent-soft)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] ui-accent-text sm:px-4 sm:py-1.5 sm:text-xs sm:tracking-[0.24em]">
                            <Sparkles className="h-3.5 w-3.5 text-orange-500 animate-pulse" />
                            Pencarian Cepat
                        </div>
                        <h1 className="text-2xl font-black tracking-tight ui-text sm:text-3xl md:text-4xl">
                            Top up & PPOB lebih cepat dalam satu portal
                        </h1>
                        <p className="mx-auto max-w-lg text-sm ui-text-muted max-sm:text-xs">
                            Cari game, e-wallet, atau operator favorit lalu lanjut order cepat.
                        </p>
                        <div className="flex flex-wrap justify-center gap-3 pt-1">
                            <a href="#kategori-produk" className="ui-accent-solid rounded-full px-5 py-2.5 text-sm font-bold shadow-lg transition hover:brightness-105">
                                Top Up Sekarang
                            </a>
                            <Link to="/check-transaction" className="ui-muted-action rounded-full border px-5 py-2.5 text-sm font-bold transition max-sm:hidden">
                                Cek Pesanan
                            </Link>
                        </div>
                        
                        <div className="relative mx-auto mt-4 max-w-lg sm:mt-6">
                            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                                <Search className="h-5 w-5 ui-text-muted" />
                            </div>
                            <input
                                ref={searchInputRef}
                                id="home-operator-search"
                                type="text"
                                role="combobox"
                                aria-expanded={Boolean(searchQuery)}
                                aria-controls="home-operator-search-results"
                                aria-activedescendant={searchQuery && searchedOperators[activeSearchIndex] ? `home-operator-option-${searchedOperators[activeSearchIndex]._id}` : undefined}
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={handleSearchKeyDown}
                                placeholder="Cari Mobile Legends, Free Fire, Telkomsel..."
                                className="ui-field w-full rounded-2xl border ui-border py-3.5 pl-12 pr-10 text-sm font-semibold shadow-lg transition-all focus:scale-[1.01] focus:shadow-[0_0_20px_rgba(var(--ui-accent),0.2)] sm:py-4"
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    aria-label="Bersihkan pencarian"
                                    onClick={() => setSearchQuery('')}
                                    className="absolute inset-y-0 right-4 flex items-center text-gray-400 hover:text-white"
                                >
                                    <X className="h-5 w-5" />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Instant Search Results Dropdown */}
                    {searchQuery && (
                        <div id="home-operator-search-results" role="listbox" className="mt-6 max-w-xl mx-auto rounded-2xl border ui-border bg-[var(--ui-panel-bg)]/95 shadow-2xl backdrop-blur-xl overflow-hidden divide-y ui-border animate-slide-up">
                            {searchedOperators.length === 0 ? (
                                <div className="p-6 text-center text-sm ui-text-muted">
                                    Operator "{searchQuery}" tidak ditemukan. Coba kata kunci lain.
                                </div>
                            ) : (
                                <div className="max-h-[300px] overflow-y-auto divide-y ui-border scrollbar-hide">
                                    {searchedOperators.map((op, index) => (
                                        <button
                                            key={op._id}
                                            id={`home-operator-option-${op._id}`}
                                            role="option"
                                            aria-selected={index === activeSearchIndex}
                                            type="button"
                                            aria-label={`Pilih ${op.name}`}
                                            onMouseEnter={() => setActiveSearchIndex(index)}
                                            onClick={() => {
                                                handleOperatorClick(op);
                                                setSearchQuery('');
                                            }}
                                            className={`w-full text-left flex items-center justify-between px-5 py-4 transition group cursor-pointer ${index === activeSearchIndex ? 'bg-[var(--ui-card-muted)]' : 'hover:bg-[var(--ui-card-muted)]'}`}
                                        >
                                            <div className="flex items-center gap-4">
                                                <div className="flex h-11 w-11 items-center justify-center rounded-[14px] border ui-border ui-panel-muted bg-[var(--ui-card-bg)] shadow-inner">
                                                    <OperatorIcon icon={op.icon} fallback="🎮" size="md" />
                                                </div>
                                                <div>
                                                    <p className="text-sm font-bold ui-text transition group-hover:text-[var(--ui-accent-strong)]">
                                                        {op.name}
                                                    </p>
                                                    <p className="text-[11px] uppercase tracking-wider ui-text-muted mt-0.5">
                                                        {typeof op.categoryId === 'object' ? op.categoryId.name : 'Operator'}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1 text-xs font-semibold ui-accent-text opacity-0 group-hover:opacity-100 transition-all transform translate-x-2 group-hover:translate-x-0">
                                                Order Sekarang
                                                <ArrowRight className="h-3.5 w-3.5" />
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="order-1 grid gap-5">
                    <div className="relative self-start overflow-hidden rounded-[28px] border ui-border ui-panel p-2 shadow-xl sm:rounded-[34px] sm:p-3 sm:shadow-2xl">
                        <div className="group relative overflow-hidden rounded-[28px] border ui-border ui-panel-muted">
                            <div className="relative aspect-[16/9] min-h-[235px] md:min-h-[340px] xl:min-h-[390px]">
                                {hasApiSliders ? (
                                    sliders.map((slide, index) => {
                                        const safeLink = getSafeSliderLink(slide.link);
                                        const isExternal = Boolean(safeLink && /^https?:\/\//i.test(safeLink));

                                        if (safeLink) {
                                            return (
                                                <a
                                                    key={slide._id}
                                                    href={safeLink}
                                                    target={isExternal ? '_blank' : undefined}
                                                    rel={isExternal ? 'noreferrer' : undefined}
                                                    className={`absolute inset-0 transition-opacity duration-700 ease-in-out ${index === currentSlide ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
                                                >
                                                    <img
                                                        src={getImageUrl(slide.image)}
                                                        alt={slide.name}
                                                        onError={(event) => { event.currentTarget.style.display = 'none'; }}
                                                        className="h-full w-full bg-gradient-to-br from-orange-600 to-indigo-700 object-cover"
                                                    />
                                                </a>
                                            );
                                        }

                                        return (
                                            <div
                                                key={slide._id}
                                                className={`absolute inset-0 transition-opacity duration-700 ease-in-out ${index === currentSlide ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
                                            >
                                                <img
                                                    src={getImageUrl(slide.image)}
                                                    alt={slide.name}
                                                    onError={(event) => { event.currentTarget.style.display = 'none'; }}
                                                    className="h-full w-full bg-gradient-to-br from-orange-600 to-indigo-700 object-cover"
                                                />
                                            </div>
                                        );
                                    })
                                ) : (
                                    defaultSlides.map((slide, index) => (
                                        <div
                                            key={slide.id}
                                            className={`absolute inset-0 transition-opacity duration-700 ease-in-out bg-gradient-to-br ${slide.bg} ${index === currentSlide ? 'opacity-100' : 'opacity-0'}`}
                                        >
                                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(255,255,255,0.22),_transparent_28%)]" />
                                            <div className="pointer-events-none absolute inset-0 opacity-70">
                                                {slide.icon}
                                            </div>
                                        </div>
                                    ))
                                )}

                                <div className="absolute inset-0 bg-gradient-to-br from-orange-600/45 via-indigo-700/25 to-slate-950/20" />
                                <div className="absolute inset-0 bg-gradient-to-t from-black/78 via-black/28 to-transparent" />
                                <div className="absolute bottom-0 left-0 right-0 flex flex-wrap items-end justify-between gap-4 px-5 py-5 md:px-7 md:py-6">
                                    <div>
                                        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.34em] text-white/80 backdrop-blur-md max-sm:hidden">
                                            <Sparkles className="h-3 w-3 ui-accent-text" />
                                            Promo Pilihan
                                        </div>
                                        <p className="mt-0 max-w-xl text-2xl font-black leading-tight text-white sm:mt-3 md:text-[2.65rem]">
                                            Top up voucher digital cepat.
                                        </p>
                                        <p className="mt-2 max-w-lg text-sm leading-6 text-white/82 md:text-[15px]">
                                            Pilih produk, bayar, lalu pantau status pesanan tanpa proses ribet.
                                        </p>
                                        <div className="mt-4 flex flex-wrap gap-2">
                                            <a href="#kategori-produk" className="rounded-full bg-white px-4 py-2 text-sm font-black text-slate-950 shadow-lg transition hover:scale-[1.02]">
                                                Lihat Produk
                                            </a>
                                            <Link to="/check-transaction" className="rounded-full border border-white/25 bg-white/15 px-4 py-2 text-sm font-bold text-white backdrop-blur-md transition hover:bg-white/25">
                                                Cek Pesanan
                                            </Link>
                                        </div>
                                    </div>
                                    <div className="hidden rounded-[24px] border border-white/10 bg-black/20 p-4 text-white backdrop-blur-md sm:block">
                                        <p className="text-[11px] font-semibold uppercase tracking-[0.3em] ui-text-muted">Kategori Aktif</p>
                                        <p className="mt-2 text-3xl font-black">{categories.length}</p>
                                        <p className="mt-1 text-xs ui-text-muted">Produk digital siap dipilih</p>
                                    </div>
                                </div>
                            </div>

                            {slidesCount > 1 && (
                                <>
                                    <button
                                        type="button"
                                        aria-label="Slide sebelumnya"
                                        onClick={prevSlide}
                                        className="absolute left-4 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-white/15 text-white opacity-100 backdrop-blur-md transition-all hover:bg-white/25 md:flex md:opacity-0 md:group-hover:opacity-100"
                                    >
                                        <ChevronLeft className="h-5 w-5" />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label="Slide berikutnya"
                                        onClick={nextSlide}
                                        className="absolute right-4 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-white/15 text-white opacity-100 backdrop-blur-md transition-all hover:bg-white/25 md:flex md:opacity-0 md:group-hover:opacity-100"
                                    >
                                        <ChevronRight className="h-5 w-5" />
                                    </button>
                                    <div className="absolute bottom-4 left-1/2 hidden -translate-x-1/2 gap-2 rounded-full border border-white/15 bg-white/15 px-3 py-2 backdrop-blur-sm md:flex">
                                        {Array.from({ length: slidesCount }).map((_, index) => (
                                            <button
                                                key={index}
                                                type="button"
                                                aria-label={`Tampilkan slide ${index + 1}`}
                                                aria-current={index === currentSlide ? 'true' : undefined}
                                                onClick={() => setCurrentSlide(index)}
                                                className={`min-h-6 rounded-full transition-all duration-300 ${index === currentSlide ? 'w-8 bg-white' : 'w-6 bg-white/40'}`}
                                            />
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>

                    <div className="hidden">
                        {/* Fokus Saat Ini */}
                        <div className="rounded-[30px] border ui-border ui-panel p-6 shadow-2xl relative overflow-hidden">
                            <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-bl from-[var(--ui-accent-soft)] to-transparent rounded-bl-full pointer-events-none opacity-40" />
                            <p className="text-[11px] font-semibold uppercase tracking-[0.35em] ui-text-muted">Fokus Saat Ini</p>
                            <h2 className="mt-3 text-3xl font-black leading-tight ui-text">
                                {selectedCategoryInfo ? selectedCategoryInfo.name : 'Semua kategori'}
                            </h2>
                            <p className="mt-3 text-sm leading-7 ui-text-muted">
                                Pilih kategori populer, lanjut ke operator, lalu masuk ke jenis produk yang paling sesuai.
                            </p>
                            <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                                <div className="rounded-[22px] border ui-border ui-panel-muted p-4 ui-text transition hover:border-[var(--ui-accent)]/30">
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.32em] ui-text-muted">Operator</p>
                                    <p className="mt-2 text-2xl font-black">{filteredOperators.length}</p>
                                    <p className="mt-1 text-xs ui-accent-text">Muncul pada kategori terpilih</p>
                                </div>
                                <div className="rounded-[22px] border ui-border ui-panel-muted p-4 ui-text transition hover:border-blue-500/30">
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.32em] ui-text-muted">Artikel</p>
                                    <p className="mt-2 text-2xl font-black">{articles.length}</p>
                                    <p className="mt-1 text-xs text-blue-400">Insight terbaru untuk user</p>
                                </div>
                            </div>
                        </div>

                        {/* Quick Invoice Checker Widget */}
                        <div id="cek-transaksi" className="scroll-mt-28 rounded-[30px] border ui-border ui-panel p-6 shadow-2xl relative overflow-hidden">
                            <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-bl from-blue-500/10 to-transparent rounded-bl-full pointer-events-none" />
                            <p className="text-[11px] font-semibold uppercase tracking-[0.32em] ui-text-muted">Status Pesanan</p>
                            <h3 className="mt-2 text-2xl font-black ui-text flex items-center gap-2">
                                <RefreshCw className="h-5 w-5 text-blue-400 animate-spin-slow" />
                                Cek Transaksi Cepat
                            </h3>
                            <p className="mt-2 text-xs ui-text-muted leading-relaxed">
                                Periksa status pembayaran dan pengiriman top-up Anda secara real-time di sini.
                            </p>

                            <form onSubmit={handleCheckInvoice} className="mt-5 space-y-3">
                                <div>
                                    <label className="text-[10px] font-bold uppercase tracking-wider ui-text-muted mb-1 block">No. Invoice</label>
                                    <input
                                        type="text"
                                        value={invoiceNo}
                                        onChange={(e) => setInvoiceNo(e.target.value.toUpperCase())}
                                        placeholder="INV-XXXXXX"
                                        className="ui-field w-full rounded-xl px-4 py-2.5 text-xs font-semibold"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-bold uppercase tracking-wider ui-text-muted mb-1 block">No. WhatsApp</label>
                                    <input
                                        type="tel"
                                        inputMode="numeric"
                                        autoComplete="tel"
                                        value={invoicePhone}
                                        onChange={(e) => setInvoicePhone(e.target.value)}
                                        placeholder="08XXXXXXXXXX"
                                        className="ui-field w-full rounded-xl px-4 py-2.5 text-xs font-semibold"
                                        required
                                    />
                                </div>
                                <button
                                    type="submit"
                                    disabled={invoiceLoading || !invoiceNo || !invoicePhone}
                                    className="w-full ui-accent-solid flex items-center justify-center gap-2 rounded-xl py-3 text-xs font-bold transition hover:brightness-105 disabled:opacity-50"
                                >
                                    {invoiceLoading ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <>
                                            <Search className="h-4 w-4" />
                                            Periksa Status
                                        </>
                                    )}
                                </button>
                            </form>

                            {/* Error State */}
                            {invoiceError && (
                                <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400 flex items-center gap-2 animate-slide-up">
                                    <AlertCircle className="h-4 w-4 shrink-0" />
                                    <span>{invoiceError}</span>
                                </div>
                            )}

                            {/* Result State */}
                            {invoiceResult && (
                                <div className="mt-4 rounded-xl border ui-border bg-[var(--ui-card-muted)] p-4 space-y-3 text-xs animate-slide-up">
                                    <div className="flex items-center justify-between border-b ui-border pb-2">
                                        <span className="font-bold ui-text truncate mr-2">{invoiceResult.product?.name || 'Produk'}</span>
                                        {invoiceResult.transactionStatus === 'success' ? (
                                            <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[10px] font-bold text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                                                <CheckCircle className="h-3 w-3" /> Sukses
                                            </span>
                                        ) : invoiceResult.transactionStatus === 'pending' || invoiceResult.transactionStatus === 'processing' ? (
                                            <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[10px] font-bold text-amber-400 border border-amber-500/30 flex items-center gap-1">
                                                <Clock className="h-3 w-3" /> Proses
                                            </span>
                                        ) : (
                                            <span className="rounded-full bg-red-500/20 px-2.5 py-0.5 text-[10px] font-bold text-red-400 border border-red-500/30 flex items-center gap-1">
                                                <XCircle className="h-3 w-3" /> Gagal
                                            </span>
                                        )}
                                    </div>
                                    <div className="space-y-1.5 ui-text-muted">
                                        <div className="flex justify-between">
                                            <span>Tujuan:</span>
                                            <span className="ui-text font-semibold">{invoiceResult.target}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span>Total Bayar:</span>
                                            <span className="ui-text font-bold text-emerald-400">Rp {new Intl.NumberFormat('id-ID').format(invoiceResult.totalAmount)}</span>
                                        </div>
                                        {invoiceResult.sn && (
                                            <div className="flex justify-between items-center bg-[var(--ui-panel-bg)] rounded-lg p-2 mt-2 border ui-border">
                                                <span className="truncate mr-2 font-mono text-[10px] text-green-400 select-all">{invoiceResult.sn}</span>
                                                <button
                                                    type="button"
                                                    aria-label="Salin nomor serial transaksi"
                                                    onClick={() => handleCopyText(invoiceResult.sn)}
                                                    className="min-h-10 min-w-10 p-1 hover:bg-[var(--ui-card-muted)] rounded transition shrink-0"
                                                    title="Copy SN"
                                                >
                                                    {invoiceCopied ? (
                                                        <span className="text-[9px] text-emerald-400 font-semibold">Copied!</span>
                                                    ) : (
                                                        <Copy className="h-3.5 w-3.5" />
                                                    )}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Quick Start */}
                        <div className="rounded-[30px] border border-orange-500/30 bg-gradient-to-br from-orange-600 to-amber-600 p-6 ui-text shadow-lg shadow-orange-500/20 relative overflow-hidden max-lg:hidden">
                            <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full filter blur-xl pointer-events-none" />
                            <p className="text-[11px] font-semibold uppercase tracking-[0.34em] text-orange-200">Mulai Cepat</p>
                            <div className="mt-4 space-y-3">
                                {[
                                    'Pilih kategori yang ingin dibeli.',
                                    'Buka operator atau brand yang sesuai.',
                                    'Lanjut ke halaman order yang sudah diprapilih.'
                                ].map((step, index) => (
                                    <div key={step} className="flex gap-3 rounded-[18px] border border-white/10 bg-black/20 p-3 backdrop-blur-sm transition hover:scale-[1.02]">
                                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-500 text-sm font-bold ui-text shadow-md">
                                            {index + 1}
                                        </span>
                                        <p className="text-sm leading-6 text-white/90">{step}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {flashSaleEntries.length > 0 && (
                    <section className="order-5 space-y-5">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div>
                                <p className="text-[11px] font-semibold uppercase tracking-[0.34em] ui-text-muted">Promo</p>
                                <h3 className="mt-2 flex items-center gap-2 text-2xl font-black ui-text">
                                    <Zap className="h-5 w-5 text-orange-500 animate-pulse" />
                                    {hasMultipleFlashSales ? 'Promo aktif sekarang' : 'Flash sale berjalan'}
                                </h3>
                                <p className="mt-2 text-sm ui-text-muted">
                                    {hasMultipleFlashSales
                                        ? 'Beberapa promo sedang hidup bersamaan. Pilih yang paling menarik.'
                                        : 'Harga terbatas dengan stok yang terus bergerak.'}
                                </p>
                            </div>
                            <div className="flex flex-col items-end gap-1.5">
                                {hasMultipleFlashSales ? (
                                    <div className="rounded-full border border-[var(--ui-accent)]/30 bg-[var(--ui-accent-soft)] px-4 py-2 text-sm font-semibold ui-accent-text ui-neon-pulse">
                                        {activeFlashSales.length} promo aktif
                                    </div>
                                ) : null}
                                {(() => {
                                    const nearestEnd = activeFlashSales
                                        .map((sale) => sale.endDate)
                                        .filter(Boolean)
                                        .sort()[0];
                                    return nearestEnd ? (
                                        <div className="flex items-center gap-2">
                                            <span className="text-[11px] ui-text-muted">Berakhir dalam</span>
                                            <HomeCountdown endDate={nearestEnd} />
                                        </div>
                                    ) : null;
                                })()}
                            </div>
                        </div>

                        <div className="overflow-x-auto pb-4 scrollbar-hide">
                            <div className="flex min-w-max gap-4">
                                {flashSaleEntries.map(({ sale, item }) => {
                                    const flashPrice = calculateFlashPrice(
                                        item.productId.price.basic,
                                        item.discountType,
                                        item.discountValue
                                    );
                                    const savings = item.productId.price.basic - flashPrice;
                                    const remaining = item.stock - item.soldCount;
                                    const progress = item.stock > 0 ? (item.soldCount / item.stock) * 100 : 0;
                                    const isOutOfStock = remaining <= 0;
                                    const operatorSlug = item.productId.operatorId?.slug || item.productId.operatorId?._id || '';
                                    const productTypeSlug = item.productId.productTypeId?.slug || item.productId.productTypeId?._id || '';

                                    return (
                                        <Link
                                            key={`${sale._id}-${item.productId._id}`}
                                            to={operatorSlug && productTypeSlug ? `/order/${operatorSlug}/${productTypeSlug}?pvc=${item.productId.code}` : '#'}
                                            className={`flex w-[240px] flex-col rounded-[28px] border p-4 shadow-xl transition cursor-pointer ui-hover-glow ui-glass ${isOutOfStock ? 'opacity-50' : 'border-[var(--ui-accent)]/30 shadow-[0_0_20px_rgba(var(--ui-accent),0.02)]'}`}
                                        >
                                            <div className="flex items-start gap-3">
                                                <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-[18px] border ui-border ui-panel-muted bg-[var(--ui-card-bg)] shadow-inner">
                                                    <OperatorIcon icon={item.productId.icon} fallback="🎮" size="lg" />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <p className="line-clamp-2 text-sm font-bold ui-text">
                                                        {item.productId.name}
                                                    </p>
                                                    <p className="mt-1 text-xs ui-text-muted">
                                                        {item.productId.operatorId?.name || 'Game'}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="mt-5">
                                                <p className="text-xl font-black ui-accent-text">Rp {formatPrice(flashPrice)}</p>
                                                <p className="mt-1 text-xs ui-text-muted line-through">Rp {formatPrice(item.productId.price.basic)}</p>
                                            </div>
                                            <div className="mt-4">
                                                <div className="mb-1.5 flex items-center justify-between text-[11px] ui-text-muted">
                                                    <span>{isOutOfStock ? 'Stok habis' : `${item.soldCount} / ${item.stock} terjual`}</span>
                                                    <span className="font-semibold text-emerald-400">-Rp {formatPrice(savings)}</span>
                                                </div>
                                                <div className="h-2 overflow-hidden rounded-full bg-[var(--ui-panel-muted)] border border-white/5">
                                                    <div
                                                        className="h-full rounded-full bg-gradient-to-r from-[var(--ui-accent)] to-[var(--ui-accent-strong)] animate-pulse"
                                                        style={{ width: `${Math.min(progress, 100)}%` }}
                                                    />
                                                </div>
                                            </div>
                                            {hasMultipleFlashSales && (
                                                <span className="mt-4 inline-flex w-fit rounded-full border border-[var(--ui-accent)]/20 bg-[var(--ui-accent-soft)] px-3 py-1 text-[11px] font-semibold ui-accent-text">
                                                    {sale.name}
                                                </span>
                                            )}
                                        </Link>
                                    );
                                })}
                            </div>
                        </div>
                    </section>
                )}

                <section id="kategori-produk" className="order-3 scroll-mt-28 rounded-[24px] border ui-border ui-panel p-4 shadow-lg md:rounded-[32px] md:p-6 md:shadow-2xl">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.34em] ui-text-muted">Kategori</p>
                            <h3 className="mt-2 flex items-center gap-2 text-2xl font-black ui-text">
                                <Package className="h-5 w-5 text-orange-500" />
                                Jelajah kategori produk
                            </h3>
                        </div>
                        <div className="rounded-full border ui-border ui-panel-muted px-4 py-2 text-sm ui-text-muted">
                            {categories.length} kategori tersedia
                        </div>
                    </div>

                    <div className="mt-6 overflow-x-auto pb-2">
                        <div className="flex min-w-max gap-3">
                            {categories.map((cat) => (
                                <button
                                    key={cat._id}
                                    type="button"
                                    aria-label={`Pilih kategori ${cat.name}`}
                                    aria-pressed={selectedCategory === cat._id}
                                    onClick={() => setSelectedCategory(cat._id)}
                                    className={`group rounded-[18px] border px-3 py-3 text-left transition-all sm:rounded-[24px] sm:px-4 sm:py-4 ${selectedCategory === cat._id
                                        ? 'border-orange-500 bg-orange-500/10 shadow-lg shadow-orange-500/20'
                                        : 'ui-border ui-panel-muted hover:border-gray-500 hover:bg-[var(--ui-card-muted)]'
                                        }`}
                                >
                                    <div className="flex min-w-[118px] items-center gap-3 sm:min-w-[130px]">
                                        <div className={`flex h-10 w-10 items-center justify-center rounded-[14px] text-xl sm:h-12 sm:w-12 sm:rounded-[18px] sm:text-2xl ${selectedCategory === cat._id ? 'bg-orange-500/20' : 'ui-panel'}`}>
                                            {cat.icon}
                                        </div>
                                        <div>
                                            <p className={`text-sm font-bold ${selectedCategory === cat._id ? 'ui-accent-text' : 'ui-text-muted'}`}>
                                                {cat.name}
                                            </p>
                                            <p className="mt-1 text-[11px] uppercase tracking-[0.24em] ui-text-muted">Kategori</p>
                                        </div>
                                    </div>
                                </button>
                            ))}
                            <Link
                                to="/register"
                                className="group rounded-[24px] border ui-border ui-panel-muted px-4 py-4 transition hover:border-[color-mix(in_srgb,var(--ui-accent)_38%,transparent)] hover:bg-[var(--ui-accent-soft)]"
                            >
                                <div className="flex min-w-[130px] items-center gap-3">
                                    <div className="flex h-12 w-12 items-center justify-center rounded-[18px] ui-panel ui-accent-text transition group-hover:bg-[var(--ui-accent)] group-hover:text-white">
                                        <Users className="h-6 w-6" />
                                    </div>
                                    <div>
                                        <p className="text-sm font-bold ui-text-muted transition group-hover:text-[var(--ui-text)]">Reseller</p>
                                        <p className="mt-1 text-[11px] uppercase tracking-[0.24em] ui-text-muted transition group-hover:text-[var(--ui-accent-strong)]">Join now</p>
                                    </div>
                                </div>
                            </Link>
                        </div>
                    </div>
                </section>

                <section className="order-4 space-y-4">
                    <div className="flex flex-wrap items-end justify-between gap-3">
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.34em] ui-text-muted">Operator</p>
                            <h3 className="mt-2 text-xl font-black ui-text sm:text-2xl">
                                {selectedCategoryInfo ? `Pilihan untuk ${selectedCategoryInfo.name}` : 'Pilih operator'}
                            </h3>
                            <p className="mt-2 max-w-md text-sm ui-text-muted">
                                Pilih operator untuk lanjut ke produk dan nominal yang tersedia.
                            </p>
                        </div>
                        {filteredOperators.length > 18 && (
                            <Link
                                to={`/products?category=${selectedCategory}`}
                                className="rounded-full border border-orange-500/30 bg-orange-500/10 px-4 py-2 text-sm font-semibold ui-accent-text hover:bg-orange-500 hover:text-[var(--ui-text)] transition"
                            >
                                Lihat Semua
                            </Link>
                        )}
                    </div>

                    {loading ? (
                        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                            {[...Array(12)].map((_, i) => (
                                <div key={i} className="aspect-square animate-pulse rounded-[26px] border ui-border ui-panel" />
                            ))}
                        </div>
                    ) : filteredOperators.length === 0 ? (
                        <div className="flex flex-col items-center justify-center rounded-[30px] border border-dashed ui-border ui-panel px-6 py-16 text-center">
                            <div className="flex h-16 w-16 items-center justify-center rounded-full ui-panel-muted ui-text-muted">
                                <Package className="h-8 w-8" />
                            </div>
                            <h3 className="mt-5 text-lg font-bold ui-text">Belum ada operator</h3>
                            <p className="mt-2 text-sm ui-text-muted">Coba pindah ke kategori lain.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-3 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                            {filteredOperators.slice(0, 18).map((op) => (
                                <button
                                    key={op._id}
                                    type="button"
                                    aria-label={`Pilih operator ${op.name}`}
                                    onClick={() => handleOperatorClick(op)}
                                    className="group rounded-[20px] border ui-border bg-[var(--ui-card-bg)]/90 p-3 text-left shadow-[0_10px_28px_rgba(15,15,31,0.12)] transition duration-200 cursor-pointer ui-hover-glow hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--ui-accent)_42%,transparent)] hover:shadow-[0_16px_36px_rgba(15,15,31,0.18)] active:translate-y-0 sm:rounded-[28px] sm:p-5 sm:shadow-xl"
                                >
                                    <div className="flex h-11 w-11 items-center justify-center rounded-[14px] border ui-border ui-panel-muted bg-[var(--ui-card-bg)] shadow-inner ring-1 ring-[color-mix(in_srgb,var(--ui-accent)_12%,transparent)] sm:h-16 sm:w-16 sm:rounded-[20px]">
                                        <OperatorIcon icon={op.icon} fallback="🎮" size="xl" />
                                    </div>
                                    <h3 className="mt-3 line-clamp-2 text-xs font-bold ui-text transition group-hover:text-[var(--ui-accent-strong)] sm:mt-4 sm:text-sm">{op.name}</h3>
                                    <p className="mt-1 text-[9px] uppercase tracking-[0.22em] ui-text-muted sm:mt-2 sm:text-[11px] sm:tracking-[0.26em]">
                                        {typeof op.categoryId === 'object' ? op.categoryId.name : 'Operator'}
                                    </p>
                                </button>
                            ))}
                        </div>
                    )}
                </section>

                <div className="order-6 grid gap-6 xl:grid-cols-[1.05fr_0.95fr] max-sm:hidden">
                    {false && operators.length > 0 && (
                        <section className="rounded-[32px] border ui-border ui-panel p-6 shadow-2xl">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.34em] ui-text-muted">Trending</p>
                                    <h3 className="mt-2 flex items-center gap-2 text-2xl font-black ui-text">
                                        <TrendingUp className="h-5 w-5 text-orange-500" />
                                        Operator populer
                                    </h3>
                                </div>
                                <Link to="/products" className="text-sm font-semibold ui-accent-text hover:text-[var(--ui-accent-strong)] transition">
                                    Lihat semua
                                </Link>
                            </div>
                            <div className="mt-6 space-y-3">
                                {operators.slice(0, 6).map((op, index) => (
                                    <button
                                        key={op._id}
                                        type="button"
                                        aria-label={`Pilih operator populer ${op.name}`}
                                        onClick={() => handleOperatorClick(op)}
                                        className="group flex w-full items-center gap-4 rounded-[22px] border px-4 py-3 text-left cursor-pointer ui-hover-glow ui-glass bg-[var(--ui-card-muted)]"
                                    >
                                        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-orange-500/10 text-sm font-bold ui-accent-text transition group-hover:bg-orange-500 group-hover:text-[var(--ui-text)]">
                                            {index + 1}
                                        </span>
                                        <div className="flex h-12 w-12 items-center justify-center rounded-[16px] border ui-border ui-panel">
                                            <OperatorIcon icon={op.icon} fallback="🎮" size="lg" />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-bold ui-text transition group-hover:text-[var(--ui-accent-strong)]">{op.name}</p>
                                            <p className="mt-1 text-xs ui-text-muted">
                                                {typeof op.categoryId === 'object' ? op.categoryId.name : 'Game'}
                                            </p>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}

                    {articles.length > 0 && (
                        <section className="rounded-[32px] border ui-border ui-panel p-6 shadow-2xl xl:col-span-2">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.34em] ui-text-muted">Artikel</p>
                                    <h3 className="mt-2 flex items-center gap-2 text-2xl font-black ui-text">
                                        <FileText className="h-5 w-5 text-blue-400" />
                                        Update & berita terbaru
                                    </h3>
                                </div>
                                <Link to="/articles" className="text-sm font-semibold ui-accent-text hover:text-[var(--ui-accent-strong)] transition">
                                    Lihat semua
                                </Link>
                            </div>
                            <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-1">
                                {articles.map((article) => (
                                    <Link
                                        key={article._id}
                                        to={`/articles/${article.slug}`}
                                        className="group overflow-hidden rounded-[24px] border ui-border ui-panel-muted transition hover:border-[color-mix(in_srgb,var(--ui-accent)_38%,transparent)]"
                                    >
                                        {article.image ? (
                                            <div className="h-40 overflow-hidden">
                                                <img
                                                    src={getImageUrl(article.image)}
                                                    alt={article.title}
                                                    loading="lazy"
                                                    className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                                                />
                                            </div>
                                        ) : (
                                            <div className="flex h-40 items-center justify-center ui-panel ui-accent-text">
                                                <FileText className="h-12 w-12" />
                                            </div>
                                        )}
                                        <div className="p-4">
                                            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] ui-text-muted">
                                                <span className="rounded-full border border-[color-mix(in_srgb,var(--ui-accent)_30%,transparent)] bg-[var(--ui-accent-soft)] px-2 py-1 ui-accent-text">
                                                    {article.category || 'Umum'}
                                                </span>
                                                <span className="flex items-center gap-1">
                                                    <Calendar className="h-3 w-3" />
                                                    {new Date(article.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}
                                                </span>
                                            </div>
                                            <h4 className="line-clamp-2 text-sm font-bold ui-text-muted transition group-hover:text-[var(--ui-text)]">
                                                {article.title}
                                            </h4>
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        </section>
                    )}
                </div>

                <div className="order-7 grid gap-6 md:grid-cols-2">
                    <div className="rounded-[32px] border ui-border ui-panel p-6 shadow-2xl">
                        <h3 className="flex items-center gap-2 text-2xl font-black ui-text">
                            <Shield className="h-6 w-6 text-emerald-500" />
                            Kenapa nyaman dipakai?
                        </h3>
                        <div className="mt-6 grid grid-cols-2 gap-4">
                            <div className="rounded-[22px] border ui-border ui-panel-muted p-4">
                                <Clock className="h-6 w-6 text-blue-400" />
                                <h4 className="mt-3 text-sm font-bold ui-text">Proses Kilat</h4>
                                <p className="mt-2 text-xs leading-6 ui-text-muted">Alur order dibuat sesingkat mungkin tanpa halaman membingungkan.</p>
                            </div>
                            <div className="rounded-[22px] border ui-border ui-panel-muted p-4">
                                <Headphones className="h-6 w-6 text-purple-400" />
                                <h4 className="mt-3 text-sm font-bold ui-text">Support Siap Bantu</h4>
                                <p className="mt-2 text-xs leading-6 ui-text-muted">Panduan dan status transaksi lebih mudah dipantau dari area member.</p>
                            </div>
                        </div>
                    </div>

                    <div className="rounded-[32px] border ui-border ui-panel p-6 shadow-2xl">
                        <h3 className="flex items-center gap-2 text-2xl font-black ui-text">
                            <CreditCard className="h-6 w-6 text-blue-400" />
                            Metode pembayaran umum
                        </h3>
                        <div className="mt-6 flex flex-wrap gap-2">
                            {['QRIS', 'BCA', 'Mandiri', 'BNI', 'BRI', 'DANA', 'OVO', 'Gopay', 'ShopeePay', 'LinkAja'].map((method) => (
                                <span
                                    key={method}
                                    className="rounded-full border ui-border ui-panel-muted px-4 py-2 text-xs font-semibold ui-text-muted"
                                >
                                    {method}
                                </span>
                            ))}
                        </div>
                    </div>
                </div>

                {showPopup && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="operator-product-title">
                        <div
                            className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
                            onClick={closePopup}
                        />

                        <div ref={operatorDialogRef} className="relative w-full max-w-lg overflow-hidden rounded-[32px] border ui-border ui-panel shadow-2xl">
                            <div className="relative border-b ui-border bg-[var(--ui-card-muted)] p-6">
                                <div className="flex items-center gap-4">
                                    <div className="flex h-14 w-14 items-center justify-center rounded-[20px] border ui-border ui-panel-muted shadow-sm">
                                        <OperatorIcon icon={selectedOperator?.icon} fallback="🎮" size="xl" />
                                    </div>
                                    <div>
                                        <h3 id="operator-product-title" className="text-xl font-black leading-tight ui-text">{selectedOperator?.name}</h3>
                                        <p className="mt-1 flex items-center gap-1.5 text-sm ui-text-muted">
                                            <Sparkles className="h-3.5 w-3.5 ui-accent-text" />
                                            Pilih jenis produk yang tersedia
                                        </p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    aria-label="Tutup pilihan produk"
                                    onClick={closePopup}
                                    className="absolute right-4 top-4 rounded-xl ui-panel-muted border ui-border p-2 ui-text-muted transition hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                                >
                                    <X className="h-5 w-5" />
                                </button>
                            </div>

                            <div className="max-h-[60vh] overflow-y-auto p-6">
                                {loadingTypes ? (
                                    <div className="flex flex-col items-center justify-center gap-3 py-12">
                                        <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
                                        <p className="text-sm ui-text-muted">Memuat produk...</p>
                                    </div>
                                ) : productTypes.length === 0 ? (
                                    <div className="py-12 text-center">
                                        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full ui-panel-muted ui-text-muted">
                                            <Package className="h-8 w-8" />
                                        </div>
                                        <h4 className="mt-4 font-bold ui-text">
                                            {hasDirectProducts ? 'Jenis produk belum diatur' : 'Produk tidak tersedia'}
                                        </h4>
                                        <p className="mt-2 text-sm ui-text-muted">
                                            {hasDirectProducts
                                                ? 'Produk operator ini masih bisa dibuka langsung dari halaman order.'
                                                : 'Silakan coba operator lain'}
                                        </p>
                                        {hasDirectProducts && (
                                            <Link
                                                to={`/order/${selectedOperator?.slug || selectedOperator?._id}`}
                                                onClick={closePopup}
                                                 className="mt-5 inline-flex items-center rounded-xl ui-accent-solid px-4 py-2.5 text-sm font-semibold transition hover:brightness-105"
                                            >
                                                Buka Semua Produk
                                            </Link>
                                        )}
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        {productTypes.map((type) => (
                                            <Link
                                                key={type._id}
                                                to={`/order/${selectedOperator?.slug || selectedOperator?._id}/${type.slug || type._id}`}
                                                onClick={closePopup}
                                                 className="group flex flex-col rounded-[22px] border ui-border ui-panel-muted p-4 transition hover:border-orange-500/50 hover:bg-[var(--ui-card-muted)]"
                                            >
                                                 <h4 className="font-bold capitalize ui-text transition group-hover:text-[var(--ui-accent-strong)]">
                                                    {type.name}
                                                </h4>
                                                <div className="mt-2 flex items-center gap-2 text-xs ui-text-muted">
                                                    <Clock className="h-3.5 w-3.5" />
                                                    <span>{type.openTime} - {type.closeTime}</span>
                                                </div>
                                            </Link>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
