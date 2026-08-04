import { useEffect, useMemo, useState } from 'react';
import { apiV2 } from '../api';
import { getAssetUrl } from '../lib/assetUrl';
import { Loader2, FileText, Calendar, ChevronRight, X, ArrowLeft } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';

interface Article {
    _id: string;
    title: string;
    slug: string;
    excerpt: string;
    content: string;
    image?: string;
    category: string;
    status: 'published' | 'draft';
    createdAt: string;
}

export default function Articles() {
    const navigate = useNavigate();
    const { slug } = useParams();
    const [articles, setArticles] = useState<Article[]>([]);
    const [loading, setLoading] = useState(true);
    const [listError, setListError] = useState('');
    const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [detailError, setDetailError] = useState('');
    const [categoryFilter, setCategoryFilter] = useState('');

    useEffect(() => {
        fetchArticles();
    }, []);

    const fetchArticles = async () => {
        setLoading(true);
        setListError('');
        try {
            const res = await apiV2.get('/articles');
            if (!Array.isArray(res.data)) throw new Error('Malformed articles response');
            setArticles(res.data);
        } catch (error) {
            console.error('Failed to fetch articles', error);
            setArticles([]);
            setListError('Artikel belum bisa dimuat. Coba refresh halaman.');
        } finally {
            setLoading(false);
        }
    };

    const formatDate = (date: string) => {
        return new Date(date).toLocaleDateString('id-ID', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });
    };

    const getImageUrl = (image?: string) => {
        if (!image) return '';
        if (/^https?:\/\//i.test(image)) return image;
        return getAssetUrl(image);
    };

    const sanitizeArticleHtml = (value: string) => value
        .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
        .replace(/<(iframe|object|embed|form|input|button|textarea|select|meta|link|base)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<(iframe|object|embed|form|input|button|textarea|select|meta|link|base)([^>]*)\/?>/gi, '')
        .replace(/\s(on[a-z]+)\s*=\s*(["']).*?\2/gi, '')
        .replace(/\s(on[a-z]+)\s*=\s*[^\s>]+/gi, '')
        .replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '')
        .replace(/\s(href|src)\s*=\s*(["'])\s*data:text\/html[^"']*\2/gi, '');

    const selectedArticleHtml = useMemo(
        () => (selectedArticle ? sanitizeArticleHtml(selectedArticle.content) : ''),
        [selectedArticle]
    );

    useEffect(() => {
        if (!slug) {
            setSelectedArticle(null);
            setLoadingDetail(false);
            setDetailError('');
            return;
        }

        let cancelled = false;

        const fetchArticleDetail = async () => {
            setLoadingDetail(true);
            setDetailError('');

            try {
                const res = await apiV2.get(`/articles/${slug}`);
                if (!cancelled) {
                    setSelectedArticle(res.data);
                }
            } catch (error: any) {
                if (!cancelled) {
                    setSelectedArticle(null);
                    setDetailError(error?.response?.data?.message || 'Artikel tidak ditemukan');
                }
            } finally {
                if (!cancelled) {
                    setLoadingDetail(false);
                }
            }
        };

        fetchArticleDetail();

        return () => {
            cancelled = true;
        };
    }, [slug]);

    const handleOpenArticle = (articleSlug: string) => {
        navigate(`/articles/${articleSlug}`);
    };

    const handleCloseArticle = () => {
        navigate('/articles');
    };

    const categories = [...new Set(articles.map(a => a.category || 'Umum'))];
    const filteredArticles = categoryFilter 
        ? articles.filter(a => (a.category || 'Umum') === categoryFilter)
        : articles;

    return (
        <div className="ui-shell min-h-screen p-4 ui-text md:p-6">
            <div className="max-w-6xl mx-auto space-y-6">
                {/* Header */}
                <div className="flex items-center gap-4">
                    <Link to="/" className="ui-muted-action rounded-lg p-2">
                        <ArrowLeft className="w-5 h-5" />
                    </Link>
                    <div>
                        <h1 className="text-2xl font-bold ui-text">Artikel & Berita</h1>
                        <p className="ui-text-muted mt-1">Informasi terbaru seputar game dan promo</p>
                    </div>
                </div>

                {/* Category Filter */}
                {categories.length > 1 && (
                    <div className="flex flex-wrap gap-2">
                        <button
                            onClick={() => setCategoryFilter('')}
                            className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
                                !categoryFilter 
                                    ? 'ui-accent-chip' 
                                    : 'ui-muted-action'
                            }`}
                        >
                            Semua
                        </button>
                        {categories.map(cat => (
                            <button
                                key={cat}
                                onClick={() => setCategoryFilter(cat)}
                                className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
                                    categoryFilter === cat 
                                        ? 'ui-accent-chip' 
                                        : 'ui-muted-action'
                                }`}
                            >
                                {cat}
                            </button>
                        ))}
                    </div>
                )}

                {/* Articles Grid */}
                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-8 h-8 animate-spin text-orange-500" />
                    </div>
                ) : listError ? (
                    <div className="ui-panel ui-border rounded-xl border py-16 text-center" role="alert">
                        <FileText className="ui-text-muted mx-auto mb-4 h-12 w-12" />
                        <p className="ui-text-muted">{listError}</p>
                    </div>
                ) : filteredArticles.length === 0 ? (
                    <div className="text-center py-20 ui-text-muted">
                        <FileText className="w-20 h-20 mx-auto mb-4 opacity-20" />
                        <p className="font-semibold text-lg">Belum ada artikel</p>
                        <p className="text-sm mt-1">Artikel akan ditampilkan di sini</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {filteredArticles.map((article) => (
                            <button
                                key={article._id}
                                type="button"
                                onClick={() => handleOpenArticle(article.slug)}
                                className="ui-panel ui-border group cursor-pointer overflow-hidden rounded-xl border text-left transition-all hover:scale-[1.02] hover:border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)]"
                            >
                                {article.image ? (
                                    <div className="h-48 overflow-hidden">
                                        <img 
                                            src={getImageUrl(article.image)} 
                                            alt={article.title}
                                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                        />
                                    </div>
                                ) : (
                                    <div className="flex h-48 items-center justify-center bg-[var(--ui-accent-soft)]">
                                        <FileText className="h-16 w-16 text-[var(--ui-accent)] opacity-60" />
                                    </div>
                                )}
                                <div className="p-5">
                                    <div className="flex items-center gap-2 text-xs ui-text-muted mb-3">
                                        <span className="px-2 py-1 rounded-full bg-orange-500/20 ui-accent-text">
                                            {article.category || 'Umum'}
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <Calendar className="w-3 h-3" />
                                            {formatDate(article.createdAt)}
                                        </span>
                                    </div>
                                    <h3 className="mb-2 line-clamp-2 font-semibold ui-text transition-colors group-hover:text-[var(--ui-accent-strong)]">
                                        {article.title}
                                    </h3>
                                    <p className="text-sm ui-text-muted line-clamp-2 mb-4">
                                        {article.excerpt}
                                    </p>
                                    <div className="flex items-center gap-1 ui-accent-text text-sm font-medium group-hover:gap-2 transition-all">
                                        Baca selengkapnya <ChevronRight className="w-4 h-4" />
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Article Detail Modal */}
            {(slug || selectedArticle || loadingDetail || detailError) && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div 
                        className="absolute inset-0 bg-black/70 backdrop-blur-sm" 
                        onClick={handleCloseArticle} 
                    />
                    <div className="relative w-full max-w-3xl max-h-[90vh] ui-panel border ui-border rounded-2xl overflow-hidden flex flex-col">
                        <div className="flex items-center justify-between px-6 py-4 border-b ui-border shrink-0">
                            {selectedArticle ? (
                                <div className="flex items-center gap-3 text-sm ui-text-muted">
                                    <span className="px-2.5 py-1 rounded-full bg-orange-500/20 ui-accent-text font-medium">
                                        {selectedArticle.category || 'Umum'}
                                    </span>
                                    <span className="flex items-center gap-1">
                                        <Calendar className="w-4 h-4" />
                                        {formatDate(selectedArticle.createdAt)}
                                    </span>
                                </div>
                            ) : (
                                <div className="text-sm ui-text-muted">Detail Artikel</div>
                            )}
                            <button 
                                onClick={handleCloseArticle} 
                                className="flex h-10 w-10 items-center justify-center rounded-full ui-panel-muted ui-text-muted transition-colors hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        
                        <div className="flex-1 overflow-y-auto">
                            {loadingDetail ? (
                                <div className="flex items-center justify-center py-20">
                                    <Loader2 className="w-8 h-8 animate-spin text-orange-500" />
                                </div>
                            ) : detailError ? (
                                <div className="px-6 py-16 text-center">
                                    <FileText className="mx-auto mb-4 h-12 w-12 ui-text-muted" />
                                    <h2 className="text-xl font-bold ui-text">Artikel tidak ditemukan</h2>
                                    <p className="mt-2 text-sm ui-text-muted">{detailError}</p>
                                </div>
                            ) : selectedArticle ? (
                                <>
                                    {selectedArticle.image && (
                                        <img 
                                            src={getImageUrl(selectedArticle.image)} 
                                            alt={selectedArticle.title}
                                            className="w-full h-64 object-cover"
                                        />
                                    )}
                                    <div className="p-6">
                                        <h2 className="text-2xl font-bold ui-text mb-6">
                                            {selectedArticle.title}
                                        </h2>
                                        <div 
                                            className="prose prose-invert prose-orange max-w-none text-[var(--ui-text)] prose-headings:text-[var(--ui-text)] prose-a:text-[var(--ui-accent-strong)]"
                                            dangerouslySetInnerHTML={{ __html: selectedArticleHtml }}
                                        />
                                    </div>
                                </>
                            ) : null}
                        </div>

                        <div className="px-6 py-4 border-t ui-border shrink-0">
                            <button 
                                onClick={handleCloseArticle} 
                                className="ui-accent-solid w-full rounded-xl px-4 py-3 font-semibold transition hover:brightness-105"
                            >
                                Tutup
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
