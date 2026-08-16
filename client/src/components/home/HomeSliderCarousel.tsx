import { useEffect, useRef, useState, type FocusEvent, type MouseEvent, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Pause, Play, Sparkles } from 'lucide-react';
import { getAssetUrl } from '../../lib/assetUrl';
import {
    classifyPublicSliderLink,
    normalizeSlideIndex,
    shouldAutoRotate,
    swipeDirection,
    type DefaultSlider,
    type HomeSliderCarouselProps,
    type SliderData,
} from '../../lib/sliderCarousel';

const ROTATION_INTERVAL_MS = 5000;
const SWIPE_THRESHOLD = 40;

type PointerStart = { id: number; x: number; y: number };

type ApiSlideProps = {
    slide: SliderData;
    active: boolean;
    failed: boolean;
    onImageError: () => void;
};

const SliderFallback = ({ name }: { name: string }) => (
    <div
        role="img"
        aria-label={name}
        className="flex h-full w-full items-end bg-gradient-to-br from-orange-600 via-indigo-700 to-slate-950 p-6 object-cover"
    >
        <span className="max-w-[80%] text-xl font-black text-white drop-shadow-md sm:text-2xl">{name}</span>
    </div>
);

const ApiSlide = ({ slide, active, failed, onImageError }: ApiSlideProps) => {
    const link = classifyPublicSliderLink(slide.link);
    const image = failed || !slide.image ? (
        <SliderFallback name={slide.name} />
    ) : (
        <img
            src={getAssetUrl(slide.image)}
            alt={slide.name}
            onError={onImageError}
            className="h-full w-full bg-gradient-to-br from-orange-600 to-indigo-700 object-cover"
        />
    );

    const className = `absolute inset-0 transition-opacity duration-700 ease-in-out ${active ? 'z-[1] opacity-100' : 'pointer-events-none z-0 opacity-0'}`;

    if (active && link.href) {
        return (
            <a
                href={link.href}
                target={link.external ? '_blank' : undefined}
                rel={link.external ? 'noopener noreferrer' : undefined}
                className={`${className} pointer-events-auto`}
                aria-label={slide.name}
            >
                {image}
            </a>
        );
    }

    return (
        <div
            className={`${className} ${active ? 'pointer-events-none' : ''}`}
            inert={!active}
            aria-hidden={!active ? 'true' : undefined}
        >
            {image}
        </div>
    );
};

const DefaultSlide = ({ slide, active }: { slide: DefaultSlider; active: boolean }) => (
    <div
        className={`absolute inset-0 bg-gradient-to-br ${slide.bg} transition-opacity duration-700 ease-in-out ${active ? 'z-[1] opacity-100' : 'pointer-events-none z-0 opacity-0'}`}
        inert={!active}
        aria-hidden={!active ? 'true' : undefined}
    >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(255,255,255,0.22),_transparent_28%)]" />
        <div className="pointer-events-none absolute inset-0 opacity-70">
            {slide.icon}
        </div>
    </div>
);

export default function HomeSliderCarousel({ sliders, defaultSlides, categoryCount = 0 }: HomeSliderCarouselProps) {
    const slides = sliders.length > 0 ? sliders : defaultSlides;
    const count = slides.length;
    const [currentSlide, setCurrentSlide] = useState(0);
    const [userPaused, setUserPaused] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [focusWithin, setFocusWithin] = useState(false);
    const [reducedMotion, setReducedMotion] = useState(false);
    const [announcement, setAnnouncement] = useState('');
    const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
    const [rotationReset, setRotationReset] = useState(0);
    const [motionOverride, setMotionOverride] = useState(false);
    const pointerStart = useRef<PointerStart | null>(null);
    const swipeSuppressClick = useRef(false);

    useEffect(() => {
        setCurrentSlide((previous) => normalizeSlideIndex(previous, count));
    }, [count]);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return undefined;
        }

        const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        const updateReducedMotion = () => setReducedMotion(mediaQuery.matches);
        updateReducedMotion();
        const supportsEventListener = typeof mediaQuery.addEventListener === 'function';
        if (supportsEventListener) {
            mediaQuery.addEventListener('change', updateReducedMotion);
        } else {
            mediaQuery.addListener(updateReducedMotion);
        }

        return () => {
            if (supportsEventListener) {
                mediaQuery.removeEventListener('change', updateReducedMotion);
            } else {
                mediaQuery.removeListener(updateReducedMotion);
            }
        };
    }, []);

    useEffect(() => {
        // Reduced motion pauses rotation by default, but an explicit Play press is an
        // informed opt-in and wins over the media query until the user chooses Pause.
        if (!shouldAutoRotate({ reducedMotion: reducedMotion && !motionOverride, userPaused, hovered, focusWithin, count })) {
            return undefined;
        }

        const timer = window.setInterval(() => {
            setCurrentSlide((previous) => normalizeSlideIndex(previous + 1, count));
        }, ROTATION_INTERVAL_MS);

        return () => window.clearInterval(timer);
    }, [count, focusWithin, hovered, motionOverride, reducedMotion, rotationReset, userPaused]);

    const announceManualSlide = (index: number) => {
        if (count > 0) {
            setAnnouncement(`Slide ${index + 1} dari ${count}`);
        }
        setRotationReset((previous) => previous + 1);
    };

    const goToSlide = (index: number) => {
        const next = normalizeSlideIndex(index, count);
        setCurrentSlide(next);
        announceManualSlide(next);
    };

    const activeIndex = normalizeSlideIndex(currentSlide, count);
    const nextSlide = () => goToSlide(activeIndex + 1);
    const previousSlide = () => goToSlide(activeIndex - 1);

    const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        pointerStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        swipeSuppressClick.current = false;
    };

    const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
        const start = pointerStart.current;
        pointerStart.current = null;
        if (!start || start.id !== event.pointerId || count < 2) {
            return;
        }

        const direction = swipeDirection(
            { x: start.x, y: start.y },
            { x: event.clientX, y: event.clientY },
            SWIPE_THRESHOLD,
        );
        if (direction !== 0) {
            // A swipe must never double as a banner click in the same gesture.
            swipeSuppressClick.current = true;
        }
        if (direction > 0) {
            previousSlide();
        } else if (direction < 0) {
            nextSlide();
        }
    };

    const handlePointerCancel = () => {
        pointerStart.current = null;
    };

    const handleClickCapture = (event: MouseEvent<HTMLDivElement>) => {
        if (!swipeSuppressClick.current) return;
        swipeSuppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
    };

    const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFocusWithin(true);
        }
    };

    const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFocusWithin(false);
        }
    };

    const markImageFailed = (key: string) => {
        setFailedImages((previous) => {
            if (previous.has(key)) {
                return previous;
            }
            const next = new Set(previous);
            next.add(key);
            return next;
        });
    };

    return (
        <div
            className="group touch-pan-y relative overflow-hidden rounded-[28px] border ui-border ui-panel-muted"
            role="region"
            aria-label="Carousel promo"
            aria-roledescription="carousel"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onClickCapture={handleClickCapture}
            style={{ touchAction: 'pan-y' }}
        >
            <div className="relative aspect-[16/9] min-h-[235px] md:min-h-[340px] xl:min-h-[390px]">
                {sliders.length > 0
                    ? sliders.map((slide, index) => {
                        const key = `${slide._id}:${slide.image}`;
                        return (
                            <ApiSlide
                                key={slide._id}
                                slide={slide}
                                active={index === activeIndex}
                                failed={failedImages.has(key)}
                                onImageError={() => markImageFailed(key)}
                            />
                        );
                    })
                    : defaultSlides.length > 0
                        ? defaultSlides.map((slide, index) => (
                            <DefaultSlide key={slide.id} slide={slide} active={index === activeIndex} />
                        ))
                        : <div className="absolute inset-0 z-[1]">
                            <SliderFallback name="Promo pilihan" />
                        </div>}

                <div className="pointer-events-none absolute inset-0 z-[2] bg-gradient-to-br from-orange-600/45 via-indigo-700/25 to-slate-950/20" />
                <div className="pointer-events-none absolute inset-0 z-[2] bg-gradient-to-t from-black/78 via-black/28 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 z-10 flex flex-wrap items-end justify-between gap-4 px-5 py-5 md:px-7 md:py-6">
                    <div>
                        <div className="pointer-events-none inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.34em] text-white/80 backdrop-blur-md max-sm:hidden">
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
                        <p className="mt-2 text-3xl font-black">{categoryCount}</p>
                        <p className="mt-1 text-xs ui-text-muted">Produk digital siap dipilih</p>
                    </div>
                </div>
            </div>

            <div className="absolute right-4 top-4 z-20">
                <button
                    type="button"
                    aria-label={userPaused ? 'Putar otomatis' : 'Jeda otomatis'}
                    aria-pressed={userPaused}
                    onClick={() => setUserPaused((previous) => {
                        if (previous) setMotionOverride(true);
                        return !previous;
                    })}
                    className="inline-flex min-h-10 items-center gap-2 rounded-full border border-white/20 bg-black/25 px-3 text-xs font-bold text-white backdrop-blur-md transition hover:bg-black/40"
                >
                    {userPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                    <span className="max-sm:hidden">{userPaused ? 'Putar' : 'Jeda'}</span>
                </button>
            </div>

            {count > 1 && (
                <>
                    <button
                        type="button"
                        aria-label="Slide sebelumnya"
                        onClick={previousSlide}
                        className="absolute left-4 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-white/15 text-white opacity-100 backdrop-blur-md transition-all hover:bg-white/25 md:opacity-0 md:group-hover:opacity-100"
                    >
                        <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                        type="button"
                        aria-label="Slide berikutnya"
                        onClick={nextSlide}
                        className="absolute right-4 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-white/15 text-white opacity-100 backdrop-blur-md transition-all hover:bg-white/25 md:opacity-0 md:group-hover:opacity-100"
                    >
                        <ChevronRight className="h-5 w-5" />
                    </button>
                    <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-2 rounded-full border border-white/15 bg-white/15 px-3 py-2 backdrop-blur-sm">
                        {Array.from({ length: count }).map((_, index) => (
                            <button
                                key={index}
                                type="button"
                                aria-label={`Tampilkan slide ${index + 1}`}
                                aria-current={index === activeIndex ? 'true' : undefined}
                                onClick={() => goToSlide(index)}
                                className={`min-h-6 rounded-full transition-all duration-300 ${index === activeIndex ? 'w-8 bg-white' : 'w-6 bg-white/40'}`}
                            />
                        ))}
                    </div>
                </>
            )}

            <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
        </div>
    );
}
