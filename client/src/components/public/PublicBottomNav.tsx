import { Link } from 'react-router-dom';
import { Home, LayoutGrid, ReceiptText, UserRound } from 'lucide-react';
import {
    PUBLIC_BOTTOM_TABS,
    activePublicBottomTab,
    pathForPublicBottomTab,
    type PublicBottomTabId,
} from '../../lib/publicBottomNav';

const ICONS: Record<PublicBottomTabId, typeof Home> = {
    home: Home,
    products: LayoutGrid,
    check: ReceiptText,
    account: UserRound,
};

type PublicBottomNavProps = {
    pathname: string;
    isAuthenticated: boolean;
};

/**
 * Mobile-only primary navigation for the public MainLayout shell.
 * Desktop keeps the existing top nav; order/full-screen branches never mount this bar.
 */
export function PublicBottomNav({ pathname, isAuthenticated }: PublicBottomNavProps) {
    const active = activePublicBottomTab(pathname);

    return (
        <nav
            aria-label="Navigasi utama publik"
            className="fixed inset-x-0 bottom-0 z-40 border-t ui-border bg-[color-mix(in_srgb,var(--ui-body-bg)_92%,transparent)] backdrop-blur-xl sm:hidden"
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
            <ul className="mx-auto grid max-w-lg grid-cols-4 gap-1 px-2 pt-1">
                {PUBLIC_BOTTOM_TABS.map((tab) => {
                    const href = pathForPublicBottomTab(tab.id, isAuthenticated);
                    const isActive = active === tab.id;
                    const Icon = ICONS[tab.id];
                    return (
                        <li key={tab.id}>
                            <Link
                                to={href}
                                aria-current={isActive ? 'page' : undefined}
                                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 py-1.5 text-[11px] font-semibold transition-colors ${
                                    isActive
                                        ? 'ui-accent-chip'
                                        : 'ui-text-muted hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]'
                                }`}
                            >
                                <Icon className="h-5 w-5" aria-hidden="true" />
                                <span>{tab.label}</span>
                            </Link>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
