import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { apiV2 } from '../api';
import { createBrowserStaffActivityController, shouldStartStaffActivity, type IdleState } from '../auth/activity';
import { createBrowserAuthChannel } from '../auth/channel.ts';
import { getAuthCoordinator } from '../auth/sessionRuntime.ts';
import IdleLockScreen from '../components/auth/IdleLockScreen';
import { StaffAvatar } from '../components/admin/StaffAvatar';
import { useAuthStore } from '../store/useAuthStore';
import {
    ArrowLeft,
    Bell,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    GripVertical,
    LogOut,
    Menu,
    Moon,
    MoreHorizontal,
    Pin,
    RefreshCw,
    Search,
    Settings2,
    ShieldX,
    Sun,
    UserCog,
    X,
    type LucideIcon
} from 'lucide-react';
import {
    closestCenter,
    DndContext,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent
} from '@dnd-kit/core';
import {
    SortableContext,
    arrayMove,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DARK_UI_THEME, LIGHT_UI_THEME, UI_THEME_OPTIONS, getUIThemeMeta, type UIThemeId } from '../lib/uiTheme';
import {
    ADMIN_DEFAULT_EXPANDED_MENUS,
    ADMIN_DEFAULT_MENU_ORDER,
    ADMIN_LEGACY_DEFAULT_MENU_ORDER,
    ADMIN_NAV_BLUEPRINT,
    formatAdminBadgeCount,
    getAdminNotificationLabel,
    getAdminRoutePermission,
    getAdminRoutePresentation,
    getPreferredAdminLandingPath,
    isAdminRoutePathActive,
    normalizeAdminMenuOrder,
    normalizeAdminPinnedMenus,
    normalizeAdminBadgeCount,
    type AdminBadgeKey
} from '../lib/adminNav';

type BadgeKey = AdminBadgeKey;

type NavSubMenuItem = {
    name: string;
    path: string;
    permission?: string;
    subtitle?: string;
    badgeCount?: number;
};

type NavMenuItem = {
    name: string;
    path?: string;
    icon: LucideIcon;
    permission?: string;
    id?: string;
    subtitle?: string;
    section?: string;
    badgeCount?: number;
    submenu?: NavSubMenuItem[];
};

type SidebarBadgeCounts = {
    notifications: number;
    deposits: number;
    transactionsManual: number;
    transactionsGuest: number;
};

type RouteMeta = {
    eyebrow: string;
    title: string;
    subtitle: string;
};

type NavSectionGroup = {
    section: string;
    items: NavMenuItem[];
};

type SortableMenuItemProps = {
    item: NavMenuItem;
    isActive: boolean;
    isSubmenuActive: boolean;
    isExpanded: boolean;
    enableReorder: boolean;
    isCompact: boolean;
    isPinned?: boolean;
    showPinButton?: boolean;
    sortableId?: string;
    onToggle: (menuId: string) => void;
    onNavigate: () => void;
    onTogglePin?: (menuName: string) => void;
    locationPath: string;
};

const MENU_ORDER_STORAGE_KEY = 'adminMenuOrder';
const EXPANDED_MENU_STORAGE_KEY = 'adminExpandedMenus';
const COMPACT_SIDEBAR_STORAGE_KEY = 'adminCompactSidebar';
const PINNED_MENU_STORAGE_KEY = 'adminPinnedMenus';
const MAX_PINNED_MENUS = 6;
const DEFAULT_EXPANDED_MENUS = ADMIN_DEFAULT_EXPANDED_MENUS;


const isRoutePathActive = isAdminRoutePathActive;

const LEGACY_DEFAULT_MENU_ORDER = ADMIN_LEGACY_DEFAULT_MENU_ORDER;

const NAV_BLUEPRINT = ADMIN_NAV_BLUEPRINT;
const DEFAULT_MENU_ORDER = ADMIN_DEFAULT_MENU_ORDER;

const isSameMenuOrder = (left: string[], right: string[]) => (
    left.length === right.length && left.every((item, index) => item === right[index])
);

const routeMetaOverrides: Array<{
    match: (pathname: string) => boolean;
    meta: RouteMeta;
}> = [
    {
        match: (pathname) => pathname.startsWith('/admin/product-operators/create'),
        meta: { eyebrow: 'Produk', title: 'Tambah Operator', subtitle: 'Buat operator produk baru' }
    },
    {
        match: (pathname) => pathname.startsWith('/admin/product-operators/edit/'),
        meta: { eyebrow: 'Produk', title: 'Edit Operator', subtitle: 'Perbarui detail operator produk' }
    },
    {
        match: (pathname) => pathname.startsWith('/admin/product-types/create'),
        meta: { eyebrow: 'Produk', title: 'Tambah Jenis Produk', subtitle: 'Buat jenis produk baru' }
    },
    {
        match: (pathname) => pathname.startsWith('/admin/product-types/edit/'),
        meta: { eyebrow: 'Produk', title: 'Edit Jenis Produk', subtitle: 'Perbarui detail jenis produk' }
    },
    {
        match: (pathname) => pathname.startsWith('/admin/addons/digiflazz-seller'),
        meta: { eyebrow: 'Add Ons', title: 'Digiflazz Seller', subtitle: 'Konfigurasi seller API Digiflazz' }
    },
    {
        match: (pathname) => pathname.startsWith('/admin/addons/irs-seller'),
        meta: { eyebrow: 'Add Ons', title: 'IRS Seller', subtitle: 'Konfigurasi seller channel IRS' }
    },
    {
        match: (pathname) => pathname.startsWith('/admin/addons/digiflazz'),
        meta: { eyebrow: 'Add Ons', title: 'Digiflazz', subtitle: 'Konfigurasi integrasi Digiflazz' }
    },
    {
        match: (pathname) => pathname.startsWith('/admin/addons/tokovoucher'),
        meta: { eyebrow: 'Add Ons', title: 'Tokovoucher', subtitle: 'Konfigurasi integrasi Tokovoucher' }
    }
];

const formatBadgeCount = formatAdminBadgeCount;

const CountBadge = ({ count, label }: { count?: number; label?: string }) => {
    if (!count || count <= 0) {
        return null;
    }

    return (
        <span
            className="ui-accent-chip inline-flex min-w-[1.5rem] items-center justify-center rounded-full border px-1.5 py-0.5 text-[10px] font-bold"
            aria-label={label || `${count} item perlu perhatian`}
            title={label || `${count} item perlu perhatian`}
        >
            <span aria-hidden="true">{formatBadgeCount(count)}</span>
        </span>
    );
};

const buildFallbackRouteMeta = (pathname: string): RouteMeta => {
    const segments = pathname.split('/').filter(Boolean).slice(1);
    const titleSegment = segments[segments.length - 1] || 'dashboard';
    const formattedTitle = titleSegment
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');

    return {
        eyebrow: 'Admin',
        title: formattedTitle,
        subtitle: `Kelola ${formattedTitle.toLowerCase()}`
    };
};

function SortableMenuItem({
    item,
    isActive,
    isSubmenuActive,
    isExpanded,
    enableReorder,
    isCompact,
    isPinned = false,
    showPinButton = true,
    sortableId,
    onToggle,
    onNavigate,
    onTogglePin,
    locationPath
}: SortableMenuItemProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({
        id: sortableId || item.name,
        disabled: !enableReorder
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1
    };

    const Icon = item.icon;
    const hasSubmenu = Array.isArray(item.submenu) && item.submenu.length > 0;
    const iconShellClass = isCompact ? 'h-10 w-10' : 'h-10 w-10';
    const itemPaddingClass = isCompact ? 'px-2 py-2 justify-center' : 'px-3 py-2.5';
    const badgeLabel = item.badgeCount
        ? `${item.name}: ${item.badgeCount} item perlu perhatian`
        : undefined;

    if (hasSubmenu && item.id) {
        return (
            <div ref={setNodeRef} style={style} key={item.name} className={`group relative ${isCompact ? 'md:flex md:justify-center' : ''}`}>
                <div className={`flex items-center gap-2 ${isCompact ? 'md:w-full md:justify-center' : ''}`}>
                    {enableReorder ? (
                        <button
                            type="button"
                            {...attributes}
                            {...listeners}
                            aria-label={`Geser menu ${item.name}`}
                            className="ui-muted-action cursor-grab active:cursor-grabbing touch-none rounded-lg border px-2 py-1 transition-colors group-hover:border-[var(--ui-accent)]"
                        >
                            <GripVertical className="h-4 w-4" />
                        </button>
                    ) : null}
                    <button
                        type="button"
                        onClick={() => onToggle(item.id!)}
                        aria-expanded={isExpanded}
                        aria-controls={item.id ? `admin-submenu-${item.id}` : undefined}
                        title={item.name}
                        className={`
                            flex-1 flex items-center ${isCompact ? 'md:flex-none md:w-12 md:justify-center' : 'justify-between'} gap-3 ${itemPaddingClass} text-sm font-semibold rounded-2xl transition-all border
                            ${isSubmenuActive
                                ? 'ui-accent-chip shadow-[0_10px_40px_var(--ui-accent-soft)]'
                                : 'ui-muted-action hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)]'}
                        `}
                    >
                        <div className={`flex min-w-0 items-center gap-3 text-left ${isCompact ? 'md:gap-0' : ''}`}>
                            <span
                                className={`
                                    ${iconShellClass} shrink-0 flex items-center justify-center rounded-xl ring-1 ring-inset
                                    ${isSubmenuActive ? 'bg-[var(--ui-accent-soft)] ring-[var(--ui-accent)] text-[var(--ui-accent-strong)]' : 'bg-[var(--ui-card-muted)] ring-[var(--ui-border)] text-[var(--ui-text-muted)]'}
                                `}
                            >
                                <Icon className="h-5 w-5" />
                            </span>
                            <div className={`min-w-0 ${isCompact ? 'md:hidden' : ''}`}>
                                <span className="block truncate leading-tight">{item.name}</span>
                            </div>
                        </div>
                        <div className={`flex shrink-0 items-center gap-1.5 ${isCompact ? 'md:hidden' : ''}`}>
                            {!isExpanded ? <CountBadge count={item.badgeCount} label={badgeLabel} /> : null}
                            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </div>
                        {isCompact && !isExpanded ? (
                            <span className="pointer-events-none absolute -top-1 right-1 hidden md:inline-flex">
                                <CountBadge count={item.badgeCount} label={badgeLabel} />
                            </span>
                        ) : null}
                    </button>
                    {showPinButton && onTogglePin ? (
                        <button
                            type="button"
                            onClick={() => onTogglePin(item.name)}
                            aria-label={isPinned ? `Lepas pin ${item.name}` : `Pin ${item.name}`}
                            title={isPinned ? 'Lepas dari favorit' : 'Tambah ke favorit'}
                            className={`shrink-0 rounded-lg border px-1.5 py-1 transition-all ${isCompact ? 'md:hidden' : ''} ${
                                isPinned
                                    ? 'ui-accent-chip'
                                    : 'ui-muted-action opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                            }`}
                        >
                            <Pin className={`h-3.5 w-3.5 ${isPinned ? 'fill-current' : ''}`} />
                        </button>
                    ) : null}
                </div>
                {isExpanded ? (
                    <div
                        id={item.id ? `admin-submenu-${item.id}` : undefined}
                        className={`
                            mt-2 space-y-1 border-l ui-border pl-3
                            ${enableReorder ? 'ml-11' : 'ml-3'}
                            ${isCompact ? 'md:absolute md:left-full md:top-0 md:z-50 md:ml-2 md:mt-0 md:w-64 md:rounded-2xl md:border md:ui-border md:ui-panel md:p-2 md:pl-2 md:shadow-2xl md:border-l-0' : ''}
                        `}
                    >
                        {isCompact ? (
                            <div className="mb-1 hidden px-2 text-[10px] font-black uppercase tracking-[0.18em] ui-text-muted md:block">
                                {item.name}
                            </div>
                        ) : null}
                        {item.submenu!.map((subItem) => {
                            const isSubActive = isRoutePathActive(locationPath, subItem.path);
                            return (
                                <Link
                                    key={subItem.name}
                                    to={subItem.path}
                                    onClick={onNavigate}
                                    aria-current={isSubActive ? 'page' : undefined}
                                    className={`
                                        flex items-center justify-between gap-2 px-3 py-2 text-sm rounded-xl transition-all border
                                        ${isSubActive
                                            ? 'ui-accent-chip shadow-[0_8px_24px_var(--ui-accent-soft)]'
                                            : 'ui-text-muted border-transparent hover:border-[var(--ui-border)] hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]'}
                                    `}
                                >
                                    <div className="min-w-0 flex items-center gap-2">
                                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--ui-accent)] shrink-0" aria-hidden />
                                        <div className="min-w-0 truncate">{subItem.name}</div>
                                    </div>
                                    <CountBadge
                                        count={subItem.badgeCount}
                                        label={subItem.badgeCount ? `${subItem.name}: ${subItem.badgeCount} item perlu perhatian` : undefined}
                                    />
                                </Link>
                            );
                        })}
                    </div>
                ) : null}
            </div>
        );
    }

    return (
        <div ref={setNodeRef} style={style} className={`flex items-center gap-2 ${isCompact ? 'md:justify-center' : ''}`}>
            {enableReorder ? (
                <button
                    type="button"
                    {...attributes}
                    {...listeners}
                    aria-label={`Geser menu ${item.name}`}
                    className="ui-muted-action cursor-grab active:cursor-grabbing touch-none rounded-lg border px-2 py-1 transition-colors hover:border-[var(--ui-accent)]"
                >
                    <GripVertical className="h-4 w-4" />
                </button>
            ) : null}
            <Link
                to={item.path || '#'}
                onClick={onNavigate}
                aria-current={isActive ? 'page' : undefined}
                title={item.name}
                className={`
                    group flex-1 flex items-center ${isCompact ? 'md:flex-none md:w-12 md:justify-center' : 'justify-between'} gap-3 ${itemPaddingClass} text-sm font-semibold rounded-2xl transition-all border relative
                    ${isActive
                        ? 'ui-accent-chip shadow-[0_10px_40px_var(--ui-accent-soft)]'
                        : 'ui-muted-action hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)]'}
                `}
            >
                <div className={`min-w-0 flex items-center gap-3 ${isCompact ? 'md:gap-0' : ''}`}>
                    <span
                        className={`
                            ${iconShellClass} shrink-0 flex items-center justify-center rounded-xl ring-1 ring-inset
                            ${isActive ? 'bg-[var(--ui-accent-soft)] ring-[var(--ui-accent)] text-[var(--ui-accent-strong)]' : 'bg-[var(--ui-card-muted)] ring-[var(--ui-border)] text-[var(--ui-text-muted)]'}
                        `}
                    >
                        <Icon className="h-5 w-5" />
                    </span>
                    <div className={`min-w-0 ${isCompact ? 'md:hidden' : ''}`}>
                        <span className="block truncate">{item.name}</span>
                    </div>
                </div>
                <span className={`flex items-center gap-1.5 ${isCompact ? 'md:hidden' : ''}`}>
                    <CountBadge count={item.badgeCount} label={badgeLabel} />
                </span>
                {isCompact ? (
                    <span className="pointer-events-none absolute -top-1 -right-1 hidden md:inline-flex">
                        <CountBadge count={item.badgeCount} label={badgeLabel} />
                    </span>
                ) : null}
            </Link>
            {showPinButton && onTogglePin ? (
                <button
                    type="button"
                    onClick={() => onTogglePin(item.name)}
                    aria-label={isPinned ? `Lepas pin ${item.name}` : `Pin ${item.name}`}
                    title={isPinned ? 'Lepas dari favorit' : 'Tambah ke favorit'}
                    className={`shrink-0 rounded-lg border px-1.5 py-1 transition-all ${isCompact ? 'md:hidden' : ''} ${
                        isPinned
                            ? 'ui-accent-chip'
                            : 'ui-muted-action opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                    }`}
                >
                    <Pin className={`h-3.5 w-3.5 ${isPinned ? 'fill-current' : ''}`} />
                </button>
            ) : null}
        </div>
    );
}

export default function AdminLayout() {
    const { logout, user, token, hasPermission, syncProfile, authPhase, authFailureMessage, lockForIdle, unlockIdleSession, authSessionEpoch } = useAuthStore();
    const navigate = useNavigate();
    const location = useLocation();
    const [activityRuntimeReady, setActivityRuntimeReady] = useState(false);

    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [idleState, setIdleState] = useState<IdleState>({ phase: 'active' });
    const [isCompactSidebar, setIsCompactSidebar] = useState(() => localStorage.getItem(COMPACT_SIDEBAR_STORAGE_KEY) === '1');
    const [accountMenuOpen, setAccountMenuOpen] = useState(false);
    const accountMenuRef = useRef<HTMLDivElement | null>(null);
    const [isCustomizingMenu, setIsCustomizingMenu] = useState(false);
    const [isThemePickerOpen, setIsThemePickerOpen] = useState(false);
    const themeDialogRef = useRef<HTMLDivElement>(null);
    const themeTriggerRef = useRef<HTMLButtonElement>(null);
    /** "⋯ Sidebar" dropdown keeps compact/reorder/theme controls out of the header. */
    const [isSidebarOptionsOpen, setIsSidebarOptionsOpen] = useState(false);
    const sidebarOptionsRef = useRef<HTMLDivElement | null>(null);
    const [isFavoritesCollapsed, setIsFavoritesCollapsed] = useState(() => localStorage.getItem('adminFavoritesCollapsed') === '1');
    const [menuSearch, setMenuSearch] = useState('');
    const [accessDenied, setAccessDenied] = useState(false);
    const [themeSaving, setThemeSaving] = useState(false);
    const [themeError, setThemeError] = useState('');
    const [menuBadgeCounts, setMenuBadgeCounts] = useState<SidebarBadgeCounts>({
        notifications: 0,
        deposits: 0,
        transactionsManual: 0,
        transactionsGuest: 0
    });
    const [expandedMenus, setExpandedMenus] = useState<Record<string, boolean>>(() => {
        const saved = localStorage.getItem(EXPANDED_MENU_STORAGE_KEY);
        if (!saved) {
            return DEFAULT_EXPANDED_MENUS;
        }

        try {
            const parsed = JSON.parse(saved);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return DEFAULT_EXPANDED_MENUS;
            }

            const next: Record<string, boolean> = { ...DEFAULT_EXPANDED_MENUS };
            Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
                if (typeof value === 'boolean') {
                    next[key] = value;
                }
            });
            return next;
        } catch {
            return DEFAULT_EXPANDED_MENUS;
        }
    });
    const [menuOrder, setMenuOrder] = useState<string[]>(() => {
        const saved = localStorage.getItem(MENU_ORDER_STORAGE_KEY);
        if (!saved) {
            return DEFAULT_MENU_ORDER;
        }

        try {
            const parsed = JSON.parse(saved);
            if (!Array.isArray(parsed)) {
                return DEFAULT_MENU_ORDER;
            }

            const normalizedOrder = normalizeAdminMenuOrder(parsed);
            if (isSameMenuOrder(normalizedOrder, LEGACY_DEFAULT_MENU_ORDER)) {
                return DEFAULT_MENU_ORDER;
            }

            return normalizedOrder;
        } catch {
            return DEFAULT_MENU_ORDER;
        }
    });
    const [pinnedMenus, setPinnedMenus] = useState<string[]>(() => {
        const saved = localStorage.getItem(PINNED_MENU_STORAGE_KEY);
        if (!saved) {
            return [];
        }
        try {
            return normalizeAdminPinnedMenus(JSON.parse(saved), MAX_PINNED_MENUS);
        } catch {
            return [];
        }
    });
    const [pinMessage, setPinMessage] = useState('');

    // Enrollment guidance lives in the dashboard reminder dialog, not in a layout-wide banner.

    const isOwner = user?.role === 'owner';
    const canViewDashboard = isOwner || hasPermission('viewDashboard');
    const canViewDeposits = isOwner || hasPermission('viewDeposits');
    const canViewTransactions = isOwner || hasPermission('viewTransactions');
    const canProcessManualTransaction = isOwner || hasPermission('processManualTransaction');
    const activeTheme = getUIThemeMeta(user?.preferences?.uiTheme);
    const normalizedMenuSearch = menuSearch.trim().toLowerCase();
    const isSearchMode = normalizedMenuSearch.length > 0;

    const initials = useMemo(() => {
        if (!user?.name) return 'AD';
        const parts = user.name.split(' ').filter(Boolean);
        return parts.map((part) => part[0]).join('').slice(0, 2).toUpperCase();
    }, [user?.name]);

    const avatarUrl = user?.avatarUrl || '';

    const roleLabel = useMemo(() => {
        switch (user?.role) {
            case 'owner':
                return 'Owner';
            case 'admin':
                return 'Admin';
            case 'cs':
                return 'CS';
            case 'member':
                return 'Member';
            default:
                return 'User';
        }
    }, [user?.role]);

    const resolveBadgeCount = (badgeKey?: BadgeKey) => {
        switch (badgeKey) {
            case 'notifications':
                return menuBadgeCounts.notifications;
            case 'deposits':
            case 'payment':
                return menuBadgeCounts.deposits;
            case 'transactionsManual':
                return menuBadgeCounts.transactionsManual;
            case 'transactionsGuest':
                return menuBadgeCounts.transactionsGuest;
            case 'transactions':
                return menuBadgeCounts.transactionsManual + menuBadgeCounts.transactionsGuest;
            default:
                return 0;
        }
    };

    const canView = (permission?: string) => {
        if (isOwner) return true;
        if (!permission) return true;
        return hasPermission(permission as never);
    };

    const defaultNavItems = useMemo<NavMenuItem[]>(() => (
        NAV_BLUEPRINT.map((item) => ({
            ...item,
            badgeCount: resolveBadgeCount(item.badgeKey),
            submenu: item.submenu?.map((subItem) => ({
                ...subItem,
                badgeCount: resolveBadgeCount(subItem.badgeKey)
            }))
        }))
    ), [menuBadgeCounts]);

    const navItems = useMemo(() => {
        const itemsMap = new Map(defaultNavItems.map((item) => [item.name, item]));
        const orderedItems = menuOrder
            .map((name) => itemsMap.get(name))
            .filter((item): item is NavMenuItem => Boolean(item));

        defaultNavItems.forEach((item) => {
            if (!menuOrder.includes(item.name)) {
                orderedItems.push(item);
            }
        });

        return orderedItems;
    }, [defaultNavItems, menuOrder]);

    const visibleNavItems = useMemo(() => (
        navItems
            .map((item) => {
                const visibleSubmenu = item.submenu?.filter((subItem) => canView(subItem.permission));
                const hasVisibleSubmenu = Boolean(visibleSubmenu && visibleSubmenu.length > 0);
                const canSeeParent = canView(item.permission) || hasVisibleSubmenu;

                if (!canSeeParent) {
                    return null;
                }

                if (item.submenu) {
                    if (!hasVisibleSubmenu) {
                        return null;
                    }

                    return {
                        ...item,
                        submenu: visibleSubmenu
                    };
                }

                return item;
            })
            .filter((item): item is NavMenuItem => Boolean(item))
    ), [navItems, user, isOwner]);

    const pinnedNavItems = useMemo(() => {
        const byName = new Map(visibleNavItems.map((item) => [item.name, item]));
        return pinnedMenus
            .map((name) => byName.get(name))
            .filter((item): item is NavMenuItem => Boolean(item));
    }, [pinnedMenus, visibleNavItems]);

    const unpinnedNavItems = useMemo(() => {
        const pinnedSet = new Set(pinnedMenus);
        return visibleNavItems.filter((item) => !pinnedSet.has(item.name));
    }, [pinnedMenus, visibleNavItems]);

    const badgeAnnouncement = useMemo(() => {
        const total = menuBadgeCounts.notifications
            + menuBadgeCounts.deposits
            + menuBadgeCounts.transactionsManual
            + menuBadgeCounts.transactionsGuest;
        return total > 0 ? `${total} item admin perlu perhatian` : 'Tidak ada item admin yang perlu perhatian';
    }, [menuBadgeCounts]);

    const actionQueueItems = useMemo(() => {
        const items: Array<{
            key: string;
            label: string;
            path: string;
            count: number;
            helper: string;
        }> = [];

        if (canViewDashboard && menuBadgeCounts.notifications > 0) {
            items.push({
                key: 'notifications',
                label: 'Notifikasi',
                path: '/admin/notifications',
                count: menuBadgeCounts.notifications,
                helper: 'Alert admin belum dibaca'
            });
        }
        if (canViewDeposits && menuBadgeCounts.deposits > 0) {
            items.push({
                key: 'deposits',
                label: 'Deposit pending',
                path: '/admin/deposits',
                count: menuBadgeCounts.deposits,
                helper: 'Menunggu verifikasi'
            });
        }
        if (canProcessManualTransaction && menuBadgeCounts.transactionsManual > 0) {
            items.push({
                key: 'manual',
                label: 'Transaksi manual',
                path: '/admin/transactions/manual',
                count: menuBadgeCounts.transactionsManual,
                helper: 'Perlu tindakan operator'
            });
        }
        if (canViewTransactions && menuBadgeCounts.transactionsGuest > 0) {
            items.push({
                key: 'guest',
                label: 'Transaksi guest',
                path: '/admin/transactions/guest',
                count: menuBadgeCounts.transactionsGuest,
                helper: 'Pembayaran/fulfillment aktif'
            });
        }

        return items;
    }, [canProcessManualTransaction, canViewDashboard, canViewDeposits, canViewTransactions, menuBadgeCounts]);

    const displayNavItems = useMemo(() => {
        const sourceItems = isSearchMode || isCustomizingMenu ? visibleNavItems : unpinnedNavItems;

        if (!isSearchMode) {
            return sourceItems;
        }

        const matchText = (value?: string) => (
            typeof value === 'string' && value.toLowerCase().includes(normalizedMenuSearch)
        );

        return sourceItems
            .map((item) => {
                const directMatch = matchText(item.name) || matchText(item.subtitle) || matchText(item.section);

                if (!item.submenu?.length) {
                    return directMatch ? item : null;
                }

                if (directMatch) {
                    return item;
                }

                const matchedSubmenu = item.submenu.filter((subItem) => (
                    matchText(subItem.name) || matchText(subItem.subtitle)
                ));

                if (matchedSubmenu.length === 0) {
                    return null;
                }

                return {
                    ...item,
                    submenu: matchedSubmenu
                };
            })
            .filter((item): item is NavMenuItem => Boolean(item));
    }, [visibleNavItems, unpinnedNavItems, isSearchMode, isCustomizingMenu, normalizedMenuSearch]);

    const displayPinnedNavItems = useMemo(() => {
        if (isSearchMode || isCustomizingMenu) {
            return [] as NavMenuItem[];
        }
        return pinnedNavItems;
    }, [isCustomizingMenu, isSearchMode, pinnedNavItems]);

    const searchResultCount = useMemo(() => {
        if (!isSearchMode) {
            return 0;
        }
        return displayNavItems.reduce((total, item) => total + 1 + (item.submenu?.length || 0), 0);
    }, [displayNavItems, isSearchMode]);

    const navSections = useMemo<NavSectionGroup[]>(() => {
        if (isCustomizingMenu) {
            return [{ section: 'Customize', items: displayNavItems }];
        }

        const groups: NavSectionGroup[] = [];

        displayNavItems.forEach((item) => {
            const section = item.section || 'Admin';
            const currentGroup = groups[groups.length - 1];

            if (!currentGroup || currentGroup.section !== section) {
                groups.push({ section, items: [item] });
                return;
            }

            currentGroup.items.push(item);
        });

        return groups;
    }, [displayNavItems, isCustomizingMenu]);

    const routeEntries = useMemo(() => {
        const entries: Array<{ path: string; meta: RouteMeta }> = [];

        defaultNavItems.forEach((item) => {
            if (item.path) {
                entries.push({
                    path: item.path,
                    meta: {
                        eyebrow: item.section || 'Admin',
                        title: item.name,
                        subtitle: item.subtitle || `Kelola ${item.name.toLowerCase()}`
                    }
                });
            }

            item.submenu?.forEach((subItem) => {
                entries.push({
                    path: subItem.path,
                    meta: {
                        eyebrow: item.name,
                        title: subItem.name,
                        subtitle: subItem.subtitle || `Kelola ${subItem.name.toLowerCase()}`
                    }
                });
            });
        });

        return entries.sort((a, b) => b.path.length - a.path.length);
    }, [defaultNavItems]);

    const currentRouteMeta = useMemo(() => {
        const override = routeMetaOverrides.find((item) => item.match(location.pathname));
        if (override) {
            return override.meta;
        }

        // Header-only routes (notifications) keep their metadata outside the sidebar blueprint.
        const presentation = getAdminRoutePresentation(location.pathname);
        if (presentation) {
            return presentation;
        }

        const match = routeEntries.find(
            (item) => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`)
        );

        return match?.meta ?? buildFallbackRouteMeta(location.pathname);
    }, [location.pathname, routeEntries]);

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates
        })
    );

    const handleMenuOrderDragEnd = (event: DragEndEvent) => {
        if (!isCustomizingMenu || isSearchMode) {
            return;
        }

        const { active, over } = event;
        if (!over || active.id === over.id) {
            return;
        }

        const oldIndex = menuOrder.indexOf(active.id as string);
        const newIndex = menuOrder.indexOf(over.id as string);

        if (oldIndex < 0 || newIndex < 0) {
            return;
        }

        const nextOrder = arrayMove(menuOrder, oldIndex, newIndex);
        setMenuOrder(nextOrder);
        localStorage.setItem(MENU_ORDER_STORAGE_KEY, JSON.stringify(nextOrder));
    };


    const handleNavigate = () => {
        setIsSidebarOpen(false);
        setIsCustomizingMenu(false);
        setMenuSearch('');
    };

    const resetMenuOrder = () => {
        setMenuOrder(DEFAULT_MENU_ORDER);
        localStorage.setItem(MENU_ORDER_STORAGE_KEY, JSON.stringify(DEFAULT_MENU_ORDER));
    };

    const persistPinnedMenus = (next: string[]) => {
        const normalized = normalizeAdminPinnedMenus(next, MAX_PINNED_MENUS);
        setPinnedMenus(normalized);
        localStorage.setItem(PINNED_MENU_STORAGE_KEY, JSON.stringify(normalized));
        return normalized;
    };

    const handlePinnedDragEnd = (event: DragEndEvent) => {
        if (isCustomizingMenu || isSearchMode || isCompactSidebar) {
            return;
        }

        const { active, over } = event;
        if (!over || active.id === over.id) {
            return;
        }

        const activeName = String(active.id).replace(/^pinned:/, '');
        const overName = String(over.id).replace(/^pinned:/, '');
        const oldIndex = pinnedMenus.indexOf(activeName);
        const newIndex = pinnedMenus.indexOf(overName);

        if (oldIndex < 0 || newIndex < 0) {
            return;
        }

        persistPinnedMenus(arrayMove(pinnedMenus, oldIndex, newIndex));
        setPinMessage('Urutan favorit diperbarui');
    };

    const togglePinnedMenu = (menuName: string) => {
        setPinMessage('');
        if (pinnedMenus.includes(menuName)) {
            persistPinnedMenus(pinnedMenus.filter((name) => name !== menuName));
            setPinMessage(`${menuName} dilepas dari favorit`);
            return;
        }

        if (pinnedMenus.length >= MAX_PINNED_MENUS) {
            setPinMessage(`Maksimal ${MAX_PINNED_MENUS} menu favorit`);
            return;
        }

        persistPinnedMenus([...pinnedMenus, menuName]);
        setPinMessage(`${menuName} ditambahkan ke favorit`);
    };

    const clearPinnedMenus = () => {
        persistPinnedMenus([]);
        setPinMessage('Favorit dikosongkan');
    };

    const firstAccessibleAdminPath = useMemo(() => (
        getPreferredAdminLandingPath((permission) => canView(permission))
    ), [user, isOwner]);

    const toggleMenu = (menuId: string) => {
        setExpandedMenus((prev) => {
            const next = { ...prev, [menuId]: !prev[menuId] };
            localStorage.setItem(EXPANDED_MENU_STORAGE_KEY, JSON.stringify(next));
            return next;
        });
    };

    const toggleCompactSidebar = () => {
        setIsCompactSidebar((prev) => {
            const next = !prev;
            localStorage.setItem(COMPACT_SIDEBAR_STORAGE_KEY, next ? '1' : '0');
            return next;
        });
    };

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    // Close the account menu on outside click, on Escape, and whenever the route changes so a
    // stale menu never floats over the next page.
    useEffect(() => {
        if (!accountMenuOpen) return;
        const onPointerDown = (event: MouseEvent | TouchEvent) => {
            if (!accountMenuRef.current?.contains(event.target as Node)) {
                setAccountMenuOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setAccountMenuOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('touchstart', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('touchstart', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [accountMenuOpen]);

    useEffect(() => {
        setAccountMenuOpen(false);
    }, [location.pathname]);

    // Close the sidebar options dropdown on outside click / Escape, mirroring the account menu.
    useEffect(() => {
        if (!isSidebarOptionsOpen) return;
        const onPointerDown = (event: MouseEvent | TouchEvent) => {
            if (!sidebarOptionsRef.current?.contains(event.target as Node)) {
                setIsSidebarOptionsOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsSidebarOptionsOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('touchstart', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('touchstart', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [isSidebarOptionsOpen]);

    useEffect(() => {
        setIsSidebarOptionsOpen(false);
    }, [location.pathname]);

    useEffect(() => {
        // Options menu holds the reorder toggle; closing options should not leave customize mode on.
        if (isCompactSidebar && isCustomizingMenu) {
            setIsCustomizingMenu(false);
        }
    }, [isCompactSidebar, isCustomizingMenu]);

    const toggleFavoritesCollapsed = () => {
        setIsFavoritesCollapsed((prev) => {
            const next = !prev;
            localStorage.setItem('adminFavoritesCollapsed', next ? '1' : '0');
            return next;
        });
    };

    const handleAdminThemeChange = async (themeId: UIThemeId) => {
        if (themeId === user?.preferences?.uiTheme || themeSaving) {
            return;
        }

        try {
            setThemeSaving(true);
            setThemeError('');
            await apiV2
                .put('/users/me/preferences', { uiTheme: themeId });
            await syncProfile();
        } catch (error) {
            console.error('Failed to update admin UI theme', error);
            setThemeError('Gagal menyimpan tema. Coba lagi.');
        } finally {
            setThemeSaving(false);
        }
    };


    useEffect(() => {
        setActivityRuntimeReady(true);
    }, []);

    useEffect(() => {
        if (!activityRuntimeReady || !shouldStartStaffActivity(user?.role, authPhase)) return;
        const sid = getAuthCoordinator()?.getSessionSid() ?? undefined;
        const channel = sid ? createBrowserAuthChannel() : undefined;
        const controller = createBrowserStaffActivityController({
            sid,
            channel,
            getStatus: async () => {
                const response = await apiV2.get('/auth/activity-status');
                return response.data as { warningAt: number | string; idleExpiresAt: number | string };
            },
            postActivity: async () => {
                const response = await apiV2.post('/auth/activity', {});
                return response.data as { warningAt: number | string; idleExpiresAt: number | string };
            },
            onState: (state) => {
                setIdleState(state);
                if (state.phase === 'locked') lockForIdle();
            },
        });
        controller?.start();
        return () => {
            controller?.stop();
            channel?.close();
        };
    }, [user?.id, user?.role, token, authPhase, authSessionEpoch, activityRuntimeReady, lockForIdle]);

    useEffect(() => {
        if (authPhase === 'locked') setIdleState((state) => ({ ...state, phase: 'locked' }));
        else if (authPhase === 'authenticated' && idleState.phase === 'locked') setIdleState({ phase: 'active' });
    }, [authPhase, idleState.phase]);

    useEffect(() => {
        if (!pinMessage) return;
        const timer = window.setTimeout(() => setPinMessage(''), 2200);
        return () => window.clearTimeout(timer);
    }, [pinMessage]);

    useEffect(() => {
        if ((isSearchMode || isCompactSidebar) && isCustomizingMenu) {
            setIsCustomizingMenu(false);
        }
    }, [isSearchMode, isCompactSidebar, isCustomizingMenu]);

    useEffect(() => {
        for (const item of navItems) {
            if (item.id && item.submenu?.some((subItem) => isRoutePathActive(location.pathname, subItem.path))) {
                setExpandedMenus((prev) => {
                    if (prev[item.id!]) {
                        return prev;
                    }

                    const next = { ...prev, [item.id!]: true };
                    localStorage.setItem(EXPANDED_MENU_STORAGE_KEY, JSON.stringify(next));
                    return next;
                });
            }
        }
    }, [location.pathname, navItems]);

    useEffect(() => {
        if (isOwner) {
            setAccessDenied(false);
            return;
        }

        const routeRule = getAdminRoutePermission(location.pathname);
        if (routeRule?.teamMemberOnly) {
            setAccessDenied(false);
            return;
        }
        if (routeRule?.permission) {
            setAccessDenied(!canView(routeRule.permission));
            return;
        }

        // Fallback to menu metadata if route is not in the shared permission map.
        const matchedParent = navItems.find((item) => (
            (item.path && isRoutePathActive(location.pathname, item.path))
            || item.submenu?.some((subItem) => isRoutePathActive(location.pathname, subItem.path))
        ));

        if (!matchedParent) {
            setAccessDenied(false);
            return;
        }

        if (matchedParent.path && isRoutePathActive(location.pathname, matchedParent.path) && !matchedParent.submenu?.length) {
            setAccessDenied(!canView(matchedParent.permission));
            return;
        }

        const matchedSubItem = matchedParent.submenu?.find((subItem) => isRoutePathActive(location.pathname, subItem.path));
        if (matchedSubItem) {
            setAccessDenied(!canView(matchedSubItem.permission));
            return;
        }

        setAccessDenied(!canView(matchedParent.permission));
    }, [isOwner, location.pathname, navItems, user]);

    useEffect(() => {
        let cancelled = false;
        let requestId = 0;

        const loadSidebarBadges = async () => {
            const currentRequestId = ++requestId;
            const partial: Partial<SidebarBadgeCounts> = {};
            const tasks: Promise<void>[] = [];

            if (canViewDashboard) {
                tasks.push(
                    apiV2.get('/notifications/admin')
                        .then((response) => {
                            partial.notifications = normalizeAdminBadgeCount(response.data?.unread ?? response.data?.total);
                        })
                        .catch(() => {
                            // Keep last known value on transient failure.
                        })
                );
            } else {
                partial.notifications = 0;
            }

            if (canViewDeposits) {
                tasks.push(
                    apiV2.get('/deposits/admin/list', { params: { page: 1, limit: 1 } })
                        .then((response) => {
                            partial.deposits = normalizeAdminBadgeCount(response.data?.summary?.pending);
                        })
                        .catch(() => {
                            // Keep last known value on transient failure.
                        })
                );
            } else {
                partial.deposits = 0;
            }

            if (canProcessManualTransaction) {
                tasks.push(
                    apiV2.get('/transactions/manual', { params: { page: 1, limit: 1 } })
                        .then((response) => {
                            const summary = response.data?.summary;
                            partial.transactionsManual = normalizeAdminBadgeCount(
                                summary?.total ?? (
                                    normalizeAdminBadgeCount(summary?.pending)
                                    + normalizeAdminBadgeCount(summary?.processing)
                                    + normalizeAdminBadgeCount(summary?.failed)
                                )
                            );
                        })
                        .catch(() => {
                            // Keep last known value on transient failure.
                        })
                );
            } else {
                partial.transactionsManual = 0;
            }

            if (canViewTransactions) {
                tasks.push(
                    apiV2.get('/guest-transactions', { params: { page: 1, limit: 1, scope: 'actionable' } })
                        .then((response) => {
                            const summary = response.data?.summary;
                            partial.transactionsGuest = normalizeAdminBadgeCount(summary?.waitingPayment)
                                + normalizeAdminBadgeCount(summary?.processing)
                                + normalizeAdminBadgeCount(summary?.failed);
                        })
                        .catch(() => {
                            // Keep last known value on transient failure.
                        })
                );
            } else {
                partial.transactionsGuest = 0;
            }

            await Promise.all(tasks);

            if (!cancelled && currentRequestId === requestId) {
                setMenuBadgeCounts((prev) => ({
                    notifications: partial.notifications ?? prev.notifications,
                    deposits: partial.deposits ?? prev.deposits,
                    transactionsManual: partial.transactionsManual ?? prev.transactionsManual,
                    transactionsGuest: partial.transactionsGuest ?? prev.transactionsGuest
                }));
            }
        };

        loadSidebarBadges();
        window.addEventListener('admin:sidebar-badges-refresh', loadSidebarBadges);
        const intervalId = window.setInterval(loadSidebarBadges, 60000);

        return () => {
            cancelled = true;
            window.removeEventListener('admin:sidebar-badges-refresh', loadSidebarBadges);
            window.clearInterval(intervalId);
        };
    }, [canProcessManualTransaction, canViewDashboard, canViewDeposits, canViewTransactions, user?.id]);


    useEffect(() => {
        if (!isSidebarOpen && !isThemePickerOpen) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') {
                return;
            }
            if (isThemePickerOpen) {
                setIsThemePickerOpen(false);
                return;
            }
            if (isSidebarOpen) {
                setIsSidebarOpen(false);
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isSidebarOpen, isThemePickerOpen]);

    useEffect(() => {
        if (!isThemePickerOpen) return;
        const dialog = themeDialogRef.current;
        if (!dialog) return;
        const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
        (focusable()[0] || dialog).focus();

        const containFocus = (event: KeyboardEvent) => {
            if (event.key !== 'Tab') return;
            const items = focusable();
            if (items.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        dialog.addEventListener('keydown', containFocus);
        return () => {
            dialog.removeEventListener('keydown', containFocus);
            themeTriggerRef.current?.focus();
        };
    }, [isThemePickerOpen]);

    return (
        <div className="ui-shell h-screen overflow-hidden flex ui-text">
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{badgeAnnouncement}</span>
            <IdleLockScreen phase={idleState.phase} idleExpiresAt={idleState.idleExpiresAt} requiresOtp={Boolean(user?.twoFactorEnabled)} error={authFailureMessage} onUnlock={unlockIdleSession} />
            {isSidebarOpen ? (
                <button
                    type="button"
                    aria-label="Tutup menu admin"
                    className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px] md:hidden"
                    onClick={() => setIsSidebarOpen(false)}
                />
            ) : null}
            <aside
                id="admin-sidebar"
                aria-label="Menu navigasi admin"
                className={`
                    ui-panel fixed inset-y-0 left-0 z-50 h-screen w-64 overflow-hidden border-r ui-border
                    transform transition-all duration-200 ease-in-out
                    ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
                    ${isCompactSidebar ? 'md:w-[5.5rem]' : 'md:w-72'}
                    md:relative md:translate-x-0
                `}
            >
                <div className="pointer-events-none absolute inset-0">
                    <div className="ui-accent-glow absolute -left-24 top-0 h-80 w-80 rounded-full opacity-70 blur-[110px]" />
                    <div className="ui-subtle-grid absolute inset-0 opacity-20" />
                </div>

                <div className="relative z-10 flex h-full flex-col">
                    <div className="border-b ui-border px-4 py-4">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 space-y-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="ui-accent-chip rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.18em]">
                                        Admin
                                    </span>
                                    <span className="rounded-full border ui-border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ui-text-muted">
                                        {roleLabel}
                                    </span>
                                </div>
                                <div>
                                    <p className="truncate text-lg font-black leading-tight ui-text">Admin Panel</p>
                                    {!isCompactSidebar ? (
                                        <p className="mt-1 line-clamp-2 text-xs leading-5 ui-text-muted">
                                            Pusat kendali menu, antrian, tema, dan akses operasional.
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsSidebarOpen(false)}
                                aria-label="Tutup sidebar"
                                className="md:hidden rounded-xl border ui-border p-2 ui-text-muted hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                    </div>

                    <div className={`space-y-3 ${isCompactSidebar ? 'px-2 py-3 md:px-2' : 'px-4 py-4'}`}>
                        <div className={`flex items-center justify-between gap-2 ${isCompactSidebar ? 'md:flex-col md:items-stretch' : ''}`}>
                            <div className={isCompactSidebar ? 'md:hidden' : ''}>
                                <div className="text-[10px] font-black uppercase tracking-[0.28em] ui-text-muted">Navigasi</div>
                                <div className="mt-0.5 text-[11px] ui-text-muted">Cari dan atur urutan menu</div>
                            </div>
                            <div className={`relative flex items-center gap-2 ${isCompactSidebar ? 'md:flex-col' : ''}`} ref={sidebarOptionsRef}>
                                <button
                                    type="button"
                                    onClick={() => setIsSidebarOptionsOpen((open) => !open)}
                                    aria-label="Opsi sidebar"
                                    aria-haspopup="menu"
                                    aria-expanded={isSidebarOptionsOpen}
                                    title="Opsi sidebar"
                                    className={`ui-muted-action inline-flex h-9 w-9 items-center justify-center rounded-xl border transition-colors hover:border-[var(--ui-accent)] hover:text-[var(--ui-accent)] ${
                                        isSidebarOptionsOpen ? 'ui-accent-chip' : ''
                                    } ${isCompactSidebar ? 'md:w-full' : ''}`}
                                >
                                    <MoreHorizontal className="h-4 w-4" />
                                </button>
                                {isSidebarOptionsOpen ? (
                                    <div
                                        role="menu"
                                        aria-label="Opsi sidebar"
                                        className="ui-panel ui-border absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-2xl border shadow-2xl"
                                    >
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() => {
                                                toggleCompactSidebar();
                                                setIsSidebarOptionsOpen(false);
                                            }}
                                            className="ui-text flex w-full items-center gap-3 px-4 py-3 text-sm font-medium transition-colors hover:bg-[var(--ui-card-muted)]"
                                        >
                                            {isCompactSidebar ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                                            {isCompactSidebar ? 'Sidebar normal' : 'Mode ringkas'}
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() => {
                                                setIsCustomizingMenu((prev) => !prev);
                                                setIsSidebarOptionsOpen(false);
                                            }}
                                            disabled={isSearchMode || isCompactSidebar}
                                            className="ui-text ui-border flex w-full items-center gap-3 border-t px-4 py-3 text-sm font-medium transition-colors hover:bg-[var(--ui-card-muted)] disabled:cursor-not-allowed disabled:opacity-50"
                                            title={isCompactSidebar ? 'Atur urutan tersedia di sidebar normal' : undefined}
                                        >
                                            <GripVertical className="h-4 w-4" />
                                            {isCustomizingMenu ? 'Selesai atur menu' : 'Atur urutan menu'}
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() => {
                                                setIsThemePickerOpen(true);
                                                setIsSidebarOptionsOpen(false);
                                            }}
                                            className="ui-text ui-border flex w-full items-center gap-3 border-t px-4 py-3 text-sm font-medium transition-colors hover:bg-[var(--ui-card-muted)]"
                                        >
                                            <Settings2 className="h-4 w-4" />
                                            <span className="min-w-0 flex-1 truncate text-left">Tema UI</span>
                                            <span className="truncate text-xs ui-text-muted">{activeTheme.label}</span>
                                        </button>
                                    </div>
                                ) : null}
                            </div>
                        </div>

                        <label className={`relative block ${isCompactSidebar ? 'md:hidden' : ''}`}>
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ui-text-muted" />
                            <input
                                value={menuSearch}
                                onChange={(e) => setMenuSearch(e.target.value)}
                                placeholder="Cari menu admin..."
                                className="ui-field w-full rounded-2xl border py-2.5 pl-10 pr-10 text-sm outline-none"
                            />
                            {isSearchMode ? (
                                <button
                                    type="button"
                                    onClick={() => setMenuSearch('')}
                                    aria-label="Hapus pencarian menu"
                                    className="absolute right-3 top-1/2 -translate-y-1/2 ui-text-muted hover:text-[var(--ui-text)]"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            ) : null}
                        </label>

                        {isCustomizingMenu ? (
                            <div className="rounded-2xl border ui-accent-chip px-3 py-3 text-xs space-y-2">
                                <p>Seret handle untuk mengatur urutan. Perubahan tersimpan otomatis di browser ini.</p>
                                <button
                                    type="button"
                                    onClick={resetMenuOrder}
                                    className="ui-muted-action inline-flex rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold"
                                >
                                    Reset urutan default
                                </button>
                            </div>
                        ) : null}

                        {isSearchMode ? (
                            <div className={`ui-panel-muted rounded-2xl border px-3 py-2.5 text-xs ui-text-muted ${isCompactSidebar ? 'md:hidden' : ''}`}>
                                {searchResultCount} hasil untuk <span className="font-semibold ui-text">"{menuSearch.trim()}"</span>.
                            </div>
                        ) : null}

                        {!isSearchMode && !isCustomizingMenu && actionQueueItems.length > 0 ? (
                            <div className={`${isCompactSidebar ? 'md:hidden' : ''} space-y-2`}>
                                <div className="px-1 text-[10px] font-black uppercase tracking-[0.22em] ui-text-muted">
                                    Perlu tindakan
                                </div>
                                <div className="space-y-1.5">
                                    {actionQueueItems.map((queueItem) => (
                                        <Link
                                            key={queueItem.key}
                                            to={queueItem.path}
                                            onClick={handleNavigate}
                                            className="ui-panel-muted flex items-center justify-between gap-2 rounded-2xl border px-3 py-2.5 transition-colors hover:border-[var(--ui-accent)]"
                                        >
                                            <div className="min-w-0">
                                                <div className="truncate text-xs font-semibold ui-text">{queueItem.label}</div>
                                                <div className="truncate text-[11px] ui-text-muted">{queueItem.helper}</div>
                                            </div>
                                            <CountBadge
                                                count={queueItem.count}
                                                label={`${queueItem.label}: ${queueItem.count}`}
                                            />
                                        </Link>
                                    ))}
                                </div>
                            </div>
                        ) : null}

                        {pinMessage ? (
                            <div role="status" aria-live="polite" className={`ui-panel-muted rounded-2xl border px-3 py-2 text-[11px] ui-text-muted ${isCompactSidebar ? 'md:hidden' : ''}`}>
                                {pinMessage}
                            </div>
                        ) : null}
                    </div>

                    <nav className={`admin-sidebar-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4 pr-1 space-y-4 ${isCompactSidebar ? 'px-2 md:px-1.5' : 'px-3'}`}>
                        {displayPinnedNavItems.length > 0 ? (
                            <div className="space-y-2">
                                <div className={`flex items-center justify-between gap-2 px-2 ${isCompactSidebar ? 'md:hidden' : ''}`}>
                                    <button
                                        type="button"
                                        onClick={toggleFavoritesCollapsed}
                                        aria-expanded={!isFavoritesCollapsed}
                                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left ui-text-muted hover:text-[var(--ui-text)] transition-colors"
                                    >
                                        <ChevronRight
                                            className={`h-3.5 w-3.5 shrink-0 transition-transform ${isFavoritesCollapsed ? '' : 'rotate-90'}`}
                                            aria-hidden="true"
                                        />
                                        <span className="min-w-0">
                                            <span className="block text-[10px] uppercase tracking-[0.22em]">Favorit</span>
                                            {!isCompactSidebar && !isFavoritesCollapsed ? (
                                                <span className="mt-0.5 block text-[10px]">Seret handle untuk ubah urutan</span>
                                            ) : null}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={clearPinnedMenus}
                                        className="text-[10px] font-semibold ui-text-muted hover:text-[var(--ui-accent)]"
                                    >
                                        Kosongkan
                                    </button>
                                </div>
                                {!isFavoritesCollapsed ? (
                                <DndContext
                                    sensors={sensors}
                                    collisionDetection={closestCenter}
                                    onDragEnd={handlePinnedDragEnd}
                                >
                                    <SortableContext
                                        items={displayPinnedNavItems.map((item) => `pinned:${item.name}`)}
                                        strategy={verticalListSortingStrategy}
                                    >
                                        <div className="space-y-2">
                                            {displayPinnedNavItems.map((item) => {
                                                const hasSubmenu = Boolean(item.submenu?.length);
                                                const isExpanded = hasSubmenu ? Boolean(item.id && expandedMenus[item.id!]) : false;
                                                const isActive = Boolean(item.path && isRoutePathActive(location.pathname, item.path));
                                                const isSubmenuActive = Boolean(hasSubmenu && item.submenu?.some((subItem) => isRoutePathActive(location.pathname, subItem.path)));
                                                const canReorderPinned = !isCompactSidebar && !isSearchMode && !isCustomizingMenu;

                                                return (
                                                    <SortableMenuItem
                                                        key={`pinned-${item.name}`}
                                                        item={item}
                                                        sortableId={`pinned:${item.name}`}
                                                        isActive={isActive}
                                                        isSubmenuActive={isSubmenuActive}
                                                        isExpanded={isExpanded}
                                                        enableReorder={canReorderPinned}
                                                        isCompact={isCompactSidebar}
                                                        isPinned
                                                        showPinButton
                                                        onToggle={toggleMenu}
                                                        onNavigate={handleNavigate}
                                                        onTogglePin={togglePinnedMenu}
                                                        locationPath={location.pathname}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </SortableContext>
                                </DndContext>
                                ) : null}
                            </div>
                        ) : null}

                        {displayNavItems.length === 0 && displayPinnedNavItems.length === 0 ? (
                            <div className="ui-panel-muted mx-1 rounded-2xl border px-4 py-5 text-sm ui-text-muted">
                                Tidak ada menu yang cocok dengan pencarian ini.
                            </div>
                        ) : (
                            <DndContext
                                sensors={sensors}
                                collisionDetection={closestCenter}
                                onDragEnd={handleMenuOrderDragEnd}
                            >
                                <SortableContext
                                    items={displayNavItems.map((item) => item.name)}
                                    strategy={verticalListSortingStrategy}
                                >
                                    {navSections.map((group) => (
                                        <div key={group.section} className="space-y-2">
                                            {!isCustomizingMenu ? (
                                                <div className={`px-2 ${isCompactSidebar ? 'md:hidden' : ''}`}>
                                                    <p className="text-[10px] uppercase tracking-[0.22em] ui-text-muted">
                                                        {group.section}
                                                    </p>
                                                </div>
                                            ) : null}

                                            {group.items.map((item) => {
                                                const hasSubmenu = Boolean(item.submenu?.length);
                                                const isExpanded = hasSubmenu ? (isSearchMode ? true : Boolean(item.id && expandedMenus[item.id])) : false;
                                                const isActive = Boolean(item.path && isRoutePathActive(location.pathname, item.path));
                                                const isSubmenuActive = Boolean(hasSubmenu && item.submenu?.some((subItem) => isRoutePathActive(location.pathname, subItem.path)));

                                                return (
                                                    <SortableMenuItem
                                                        key={item.name}
                                                        item={item}
                                                        isActive={isActive}
                                                        isSubmenuActive={isSubmenuActive}
                                                        isExpanded={isExpanded}
                                                        enableReorder={isCustomizingMenu && !isSearchMode}
                                                        isCompact={isCompactSidebar}
                                                        isPinned={pinnedMenus.includes(item.name)}
                                                        showPinButton={!isCustomizingMenu}
                                                        onToggle={toggleMenu}
                                                        onNavigate={handleNavigate}
                                                        onTogglePin={togglePinnedMenu}
                                                        locationPath={location.pathname}
                                                    />
                                                );
                                            })}
                                        </div>
                                    ))}
                                </SortableContext>
                            </DndContext>
                        )}
                    </nav>

                    <div className={`shrink-0 border-t ui-border backdrop-blur ${isCompactSidebar ? 'p-2 md:p-2' : 'p-3'}`}>
                        <div className={`mb-3 rounded-2xl border ui-border bg-[var(--ui-card-bg)]/70 ${isCompactSidebar ? 'p-2 md:flex md:justify-center' : 'p-3'}`}>
                            <div className={`flex items-center gap-3 ${isCompactSidebar ? 'md:gap-0' : ''}`}>
                                <StaffAvatar
                                    avatarUrl={avatarUrl}
                                    initials={initials}
                                    className="ui-accent-solid relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl text-sm font-black"
                                    alt="Foto profil"
                                />
                                <div className={`min-w-0 ${isCompactSidebar ? 'md:hidden' : ''}`}>
                                    <p className="truncate text-sm font-bold ui-text">{user?.name || 'Admin'}</p>
                                    <p className="truncate text-xs ui-text-muted" title={user?.email || ''}>{user?.email || roleLabel}</p>
                                </div>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={handleLogout}
                            title="Keluar"
                            aria-label="Keluar dari admin"
                            className={`ui-danger-action flex w-full items-center rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors ${isCompactSidebar ? 'md:justify-center md:px-2' : ''}`}
                        >
                            <LogOut className={`h-5 w-5 ${isCompactSidebar ? 'md:mr-0' : 'mr-3'}`} />
                            <span className={isCompactSidebar ? 'md:hidden' : ''}>Keluar</span>
                        </button>
                    </div>
                </div>
            </aside>

            {isThemePickerOpen ? (
                <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
                    <button
                        type="button"
                        aria-label="Tutup pemilih tema"
                        className="absolute inset-0 cursor-default"
                        onClick={() => setIsThemePickerOpen(false)}
                    />
                    <div
                        ref={themeDialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="admin-theme-dialog-title"
                        tabIndex={-1}
                        className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border ui-border ui-panel shadow-2xl"
                    >
                        <div className="ui-card-gradient flex items-start justify-between gap-4 border-b ui-border p-5">
                            <div>
                                <p className="ui-accent-chip inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]">Tema personal</p>
                                <h2 id="admin-theme-dialog-title" className="mt-3 text-xl font-black ui-text">Tema UI Admin</h2>
                                <p className="mt-1 text-sm ui-text-muted">Perubahan hanya berlaku untuk akun ini.</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsThemePickerOpen(false)}
                                aria-label="Tutup dialog tema"
                                className="rounded-lg p-2 ui-text-muted hover:bg-[var(--ui-panel-muted)] hover:text-[var(--ui-text)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div className="space-y-4 p-5">
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => void handleAdminThemeChange(DARK_UI_THEME)}
                                    disabled={themeSaving}
                                    className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors disabled:cursor-wait disabled:opacity-60 ${
                                        user?.preferences?.uiTheme === DARK_UI_THEME
                                            ? 'ui-accent-chip'
                                            : 'ui-muted-action'
                                    }`}
                                >
                                    <Moon className="h-4 w-4" />
                                    Mode Malam
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleAdminThemeChange(LIGHT_UI_THEME)}
                                    disabled={themeSaving}
                                    className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors disabled:cursor-wait disabled:opacity-60 ${
                                        user?.preferences?.uiTheme === LIGHT_UI_THEME
                                            ? 'ui-accent-chip'
                                            : 'ui-muted-action'
                                    }`}
                                >
                                    <Sun className="h-4 w-4" />
                                    Mode Terang
                                </button>
                            </div>

                            <div>
                                <label className="mb-2 block text-sm font-semibold ui-text">Preset theme</label>
                                <select
                                    value={(user?.preferences?.uiTheme || activeTheme.id) as UIThemeId}
                                    onChange={(event) => void handleAdminThemeChange(event.target.value as UIThemeId)}
                                    disabled={themeSaving}
                                    className="w-full rounded-xl border border-[var(--ui-border)] bg-[var(--ui-panel-bg)] px-3 py-3 text-sm font-semibold text-[var(--ui-text)] outline-none disabled:cursor-wait disabled:opacity-60"
                                    title="Ganti UI theme akun admin ini"
                                >
                                    {UI_THEME_OPTIONS.map((theme) => (
                                        <option key={theme.id} value={theme.id}>{theme.label}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="rounded-xl border ui-border ui-panel-muted p-3 text-sm ui-text-muted">
                                Tema aktif: <span className="font-semibold ui-text">{activeTheme.label}</span>
                                {themeSaving ? <span className="ml-2 ui-accent-text">Menyimpan...</span> : null}
                                {themeError ? <p className="mt-2 text-sm ui-danger-text">{themeError}</p> : null}
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            <div className="min-w-0 flex-1 flex flex-col overflow-hidden">
                <header className="ui-panel-muted h-16 flex items-center justify-between border-b px-3 sm:px-4 md:px-6">
                    <div className="min-w-0 flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => setIsSidebarOpen(true)}
                            aria-label="Buka menu admin"
                            aria-expanded={isSidebarOpen}
                            aria-controls="admin-sidebar"
                            className="md:hidden ui-text-muted hover:text-[var(--ui-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)]"
                        >
                            <Menu className="w-6 h-6" />
                        </button>
                        <div className="min-w-0">
                            <p className="truncate text-xs uppercase tracking-wide ui-text-muted">{currentRouteMeta.eyebrow}</p>
                            <p className="truncate text-sm font-semibold ui-text">{currentRouteMeta.title}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 sm:gap-4">
                        <button
                            type="button"
                            onClick={() => window.dispatchEvent(new CustomEvent('admin:refresh-current-page'))}
                            className="ui-accent-chip inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border text-sm font-medium transition-colors hover:bg-[var(--ui-accent-soft)] sm:h-auto sm:w-auto sm:gap-2 sm:px-3 sm:py-2"
                            aria-label={`Segarkan ${currentRouteMeta.title}`}
                            title={`Segarkan ${currentRouteMeta.title}`}
                        >
                            <RefreshCw className="w-4 h-4" aria-hidden="true" />
                            <span className="hidden sm:inline">Segarkan</span>
                        </button>
                        {canViewDashboard ? (
                            <Link
                                to="/admin/notifications"
                                aria-label={getAdminNotificationLabel(menuBadgeCounts.notifications)}
                                title="Buka notifikasi admin"
                                aria-current={isRoutePathActive(location.pathname, '/admin/notifications') ? 'page' : undefined}
                                className={`relative shrink-0 overflow-visible flex h-11 w-11 items-center justify-center rounded-xl border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ui-accent)] ${
                                    isRoutePathActive(location.pathname, '/admin/notifications')
                                        ? 'ui-accent-chip'
                                        : 'ui-panel hover:bg-[var(--ui-card-muted)]'
                                }`}
                            >
                                <Bell className="h-5 w-5" aria-hidden="true" />
                                {menuBadgeCounts.notifications > 0 ? (
                                    <span
                                        aria-hidden="true"
                                        className="ui-accent-chip absolute -right-1.5 -top-1.5 min-w-5 rounded-full border px-1 text-center text-[10px] font-black leading-4"
                                    >
                                        {formatAdminBadgeCount(menuBadgeCounts.notifications)}
                                    </span>
                                ) : null}
                            </Link>
                        ) : null}
                        <div className="relative min-w-0" ref={accountMenuRef}>
                            <button
                                type="button"
                                onClick={() => setAccountMenuOpen((open) => !open)}
                                className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-1 transition-colors hover:bg-[var(--ui-card-muted)]"
                                aria-haspopup="menu"
                                aria-expanded={accountMenuOpen}
                                aria-label="Menu akun"
                            >
                                <div className="min-w-0 text-right">
                                    <p className="truncate text-sm font-semibold ui-text leading-tight">{user?.name || 'Admin'}</p>
                                    <p className="truncate text-xs ui-text-muted leading-tight" title={user?.email || ''}>{roleLabel}</p>
                                </div>
                                <StaffAvatar
                                    avatarUrl={avatarUrl}
                                    initials={initials}
                                    className="ui-accent-solid relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-full font-semibold"
                                    alt="Foto profil"
                                />
                                <ChevronDown
                                    className={`ui-text-muted h-4 w-4 shrink-0 transition-transform ${accountMenuOpen ? 'rotate-180' : ''}`}
                                    aria-hidden="true"
                                />
                            </button>
                            {accountMenuOpen ? (
                                <div
                                    role="menu"
                                    aria-label="Menu akun"
                                    className="ui-panel ui-border absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-2xl border shadow-2xl"
                                >
                                    <div className="ui-border border-b px-4 py-3">
                                        <p className="truncate text-sm font-bold ui-text">{user?.name || 'Admin'}</p>
                                        <p className="truncate text-xs ui-text-muted" title={user?.email || ''}>{user?.email || '-'}</p>
                                    </div>
                                    <Link
                                        to="/admin/profile"
                                        role="menuitem"
                                        onClick={() => setAccountMenuOpen(false)}
                                        className="ui-text flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors hover:bg-[var(--ui-card-muted)]"
                                    >
                                        <UserCog className="h-4 w-4 shrink-0" aria-hidden="true" />
                                        Akun Saya
                                    </Link>
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                            setAccountMenuOpen(false);
                                            handleLogout();
                                        }}
                                        className="ui-danger-text ui-border flex w-full items-center gap-3 border-t px-4 py-3 text-sm font-medium transition-colors hover:bg-[var(--ui-card-muted)]"
                                    >
                                        <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
                                        Keluar
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    </div>
                </header>

                <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6 xl:p-8">
                    {accessDenied ? (
                        <div className="min-h-[60vh] flex items-center justify-center">
                            <div className="text-center space-y-6">
                                <div className="inline-flex h-20 w-20 items-center justify-center rounded-full border ui-danger-chip">
                                    <ShieldX className="h-10 w-10 ui-danger-text" />
                                </div>
                                <div>
                                    <h1 className="text-2xl font-bold ui-text">Akses Ditolak</h1>
                                    <p className="ui-text-muted mt-2 max-w-md">
                                        Anda tidak memiliki izin untuk mengakses halaman ini.
                                        Hubungi owner untuk mendapatkan akses.
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => navigate(firstAccessibleAdminPath)}
                                    className="ui-accent-solid inline-flex items-center gap-2 px-4 py-2 rounded-xl font-semibold transition-colors"
                                >
                                    <ArrowLeft className="w-4 h-4" />
                                    Kembali ke menu yang diizinkan
                                </button>
                            </div>
                        </div>
                    ) : (
                        <Outlet />
                    )}
                </main>
            </div>
        </div>
    );
}
