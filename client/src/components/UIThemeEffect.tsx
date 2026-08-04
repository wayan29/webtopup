import { useEffect } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { DEFAULT_UI_THEME, GUEST_UI_THEME_STORAGE_KEY, isUIThemeId } from '../lib/uiTheme';

export default function UIThemeEffect() {
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    const uiTheme = useAuthStore((state) => state.user?.preferences?.uiTheme);

    useEffect(() => {
        const guestTheme = localStorage.getItem(GUEST_UI_THEME_STORAGE_KEY);
        const nextTheme = isAuthenticated
            ? (uiTheme || DEFAULT_UI_THEME)
            : (isUIThemeId(guestTheme) ? guestTheme : DEFAULT_UI_THEME);

        document.documentElement.dataset.uiTheme = nextTheme;
    }, [isAuthenticated, uiTheme]);

    useEffect(() => {
        const handleGuestThemeChange = () => {
            if (useAuthStore.getState().isAuthenticated) return;

            const guestTheme = localStorage.getItem(GUEST_UI_THEME_STORAGE_KEY);
            document.documentElement.dataset.uiTheme = isUIThemeId(guestTheme) ? guestTheme : DEFAULT_UI_THEME;
        };

        window.addEventListener('guest-ui-theme-change', handleGuestThemeChange);
        window.addEventListener('storage', handleGuestThemeChange);
        return () => {
            window.removeEventListener('guest-ui-theme-change', handleGuestThemeChange);
            window.removeEventListener('storage', handleGuestThemeChange);
        };
    }, []);

    return null;
}
