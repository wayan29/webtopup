export type UIThemeId =
    | 'ember-premium'
    | 'ember-premium-light'
    | 'forest-trusted'
    | 'forest-trusted-light'
    | 'royal-plum-luxury'
    | 'royal-plum-luxury-light'
    | 'graphite-operational'
    | 'graphite-operational-light'
    | 'horizon-clean'
    | 'midnight-elegant'
    | 'neobrutal-bold';

export type UIThemeOption = {
    id: UIThemeId;
    label: string;
    tagline: string;
    description: string;
    audience: string;
};

export const DEFAULT_UI_THEME: UIThemeId = 'ember-premium';
export const GUEST_UI_THEME_STORAGE_KEY = 'guestUiTheme';
export const LIGHT_UI_THEME: UIThemeId = 'graphite-operational-light';
export const DARK_UI_THEME: UIThemeId = 'midnight-elegant';

export const UI_THEME_OPTIONS: UIThemeOption[] = [
    {
        id: 'ember-premium',
        label: 'Ember Premium',
        tagline: 'Warna global premium',
        description: 'Palet hangat dengan aksen menyala untuk tampilan utama yang kaya dan kuat.',
        audience: 'Cocok untuk user yang ingin tema default paling premium.'
    },
    {
        id: 'ember-premium-light',
        label: 'Ember Premium Light',
        tagline: 'Premium terang',
        description: 'Versi terang dari Ember dengan background hangat dan aksen oranye tetap kuat.',
        audience: 'Cocok untuk user yang ingin nuansa premium tanpa mode gelap.'
    },
    {
        id: 'forest-trusted',
        label: 'Forest Trusted',
        tagline: 'Hijau tepercaya',
        description: 'Nada hijau gelap yang stabil, aman, dan terasa kredibel untuk operasional harian.',
        audience: 'Cocok untuk tim yang ingin nuansa trust dan tenang.'
    },
    {
        id: 'forest-trusted-light',
        label: 'Forest Trusted Light',
        tagline: 'Hijau terang tepercaya',
        description: 'Versi terang dengan hijau lembut untuk dashboard yang lebih ringan dibaca.',
        audience: 'Cocok untuk operasional siang hari dengan nuansa trust.'
    },
    {
        id: 'royal-plum-luxury',
        label: 'Royal Plum Luxury',
        tagline: 'Ungu mewah',
        description: 'Warna plum pekat dengan aura eksklusif untuk dashboard yang lebih berkelas.',
        audience: 'Cocok untuk owner atau user yang suka sentuhan luxury.'
    },
    {
        id: 'royal-plum-luxury-light',
        label: 'Royal Plum Luxury Light',
        tagline: 'Ungu terang elegan',
        description: 'Versi terang dari royal plum dengan panel lavender lembut dan aksen mewah.',
        audience: 'Cocok untuk tampilan luxury yang tetap nyaman di ruang terang.'
    },
    {
        id: 'graphite-operational',
        label: 'Graphite Operational',
        tagline: 'Abu operasional',
        description: 'Netral, tajam, dan minim distraksi untuk layar kerja yang padat data.',
        audience: 'Cocok untuk CS dan admin yang aktif memproses banyak item.'
    },
    {
        id: 'graphite-operational-light',
        label: 'Graphite Operational Light',
        tagline: 'Netral terang operasional',
        description: 'Versi terang paling netral untuk kerja admin panjang tanpa kontras gelap berlebihan.',
        audience: 'Cocok sebagai Mode Terang default untuk admin dan CS.'
    },
    {
        id: 'horizon-clean',
        label: 'Horizon Clean',
        tagline: 'Bersih dan modern',
        description: 'Nuansa biru cerah yang terasa lapang, modern, dan ringan dipakai.',
        audience: 'Cocok untuk member yang suka tampilan bersih.'
    },
    {
        id: 'midnight-elegant',
        label: 'Midnight Elegant',
        tagline: 'Gelap elegan',
        description: 'Mode malam dengan kedalaman biru tua yang halus dan fokus.',
        audience: 'Cocok untuk penggunaan malam dan tampilan elegan.'
    },
    {
        id: 'neobrutal-bold',
        label: 'Neobrutal Bold',
        tagline: 'Tebal dan berani',
        description: 'Kontras tinggi dengan karakter visual tegas untuk UI yang paling standout.',
        audience: 'Cocok untuk user yang ingin tampilan paling ekspresif.'
    }
];

export const getUIThemeMeta = (themeId?: string | null) => (
    UI_THEME_OPTIONS.find((theme) => theme.id === themeId) || UI_THEME_OPTIONS[0]
);

export const isUIThemeId = (value: string | null | undefined): value is UIThemeId => (
    Boolean(value && UI_THEME_OPTIONS.some((theme) => theme.id === value))
);
