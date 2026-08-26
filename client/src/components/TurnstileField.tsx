import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { BOT_PROTECTION_UNAVAILABLE_MESSAGE } from '../lib/botProtection';

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TURNSTILE_SCRIPT_ID = 'cf-turnstile-api';

type TurnstileApi = {
    render: (container: HTMLElement, options: Record<string, unknown>) => string;
    reset: (widgetId?: string) => void;
    remove: (widgetId?: string) => void;
};

declare global {
    interface Window {
        turnstile?: TurnstileApi;
    }
}

function loadTurnstileScript(): Promise<TurnstileApi> {
    if (window.turnstile) return Promise.resolve(window.turnstile);

    return new Promise((resolve, reject) => {
        const settle = () => {
            if (window.turnstile) resolve(window.turnstile);
            else reject(new Error('Turnstile unavailable'));
        };
        const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
        if (existing) {
            if (window.turnstile) {
                resolve(window.turnstile);
                return;
            }
            existing.addEventListener('load', settle, { once: true });
            existing.addEventListener('error', () => reject(new Error('Turnstile unavailable')), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.id = TURNSTILE_SCRIPT_ID;
        script.src = TURNSTILE_SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        script.addEventListener('load', settle, { once: true });
        script.addEventListener('error', () => reject(new Error('Turnstile unavailable')), { once: true });
        document.head.appendChild(script);
    });
}

export type TurnstileFieldHandle = {
    reset: () => void;
};

type TurnstileFieldProps = {
    siteKey: string;
    onTokenChange: (token: string | null) => void;
};

const TurnstileField = forwardRef<TurnstileFieldHandle, TurnstileFieldProps>(function TurnstileField(
    { siteKey, onTokenChange },
    ref,
) {
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetIdRef = useRef<string | null>(null);
    const onTokenChangeRef = useRef(onTokenChange);
    const [unavailable, setUnavailable] = useState(false);
    onTokenChangeRef.current = onTokenChange;

    useImperativeHandle(ref, () => ({
        reset: () => {
            onTokenChangeRef.current(null);
            if (widgetIdRef.current && window.turnstile) {
                window.turnstile.reset(widgetIdRef.current);
            }
        },
    }));

    useEffect(() => {
        let cancelled = false;
        const container = containerRef.current;
        if (!container) return undefined;

        setUnavailable(false);
        onTokenChangeRef.current(null);

        loadTurnstileScript()
            .then((turnstile) => {
                if (cancelled || !containerRef.current) return;
                widgetIdRef.current = turnstile.render(containerRef.current, {
                    sitekey: siteKey,
                    callback: (token: string) => onTokenChangeRef.current(token),
                    'expired-callback': () => onTokenChangeRef.current(null),
                    'error-callback': () => onTokenChangeRef.current(null),
                    'timeout-callback': () => onTokenChangeRef.current(null),
                });
            })
            .catch(() => {
                if (cancelled) return;
                setUnavailable(true);
                onTokenChangeRef.current(null);
            });

        return () => {
            cancelled = true;
            if (widgetIdRef.current && window.turnstile) {
                window.turnstile.remove(widgetIdRef.current);
            }
            widgetIdRef.current = null;
        };
    }, [siteKey]);

    return (
        <div className="space-y-2">
            <div ref={containerRef} className="min-h-[65px]" />
            {unavailable ? (
                <p className="ui-text-muted text-sm">{BOT_PROTECTION_UNAVAILABLE_MESSAGE}</p>
            ) : null}
        </div>
    );
});

export default TurnstileField;
