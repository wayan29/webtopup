import { useEffect, useState } from 'react';

interface HomeCountdownProps {
  endDate: string;
}

function calculateCountdown(endDate: string) {
  const now = Date.now();
  const endTime = new Date(endDate).getTime();
  const distance = endTime - now;

  if (distance <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0 };
  }

  return {
    days: Math.floor(distance / (1000 * 60 * 60 * 24)),
    hours: Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
    minutes: Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60)),
    seconds: Math.floor((distance % (1000 * 60)) / 1000)
  };
}

export default function HomeCountdown({ endDate }: HomeCountdownProps) {
  const [countdown, setCountdown] = useState(() => calculateCountdown(endDate));

  useEffect(() => {
    const update = () => setCountdown(calculateCountdown(endDate));
    update();

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        update();
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [endDate]);

  return (
    <div className="flex items-center gap-1 font-mono text-xs font-bold ui-accent-text" aria-label="Sisa waktu flash sale">
      <span className="rounded-md border border-[var(--ui-accent)]/30 bg-[var(--ui-accent-soft)] px-2 py-1.5 ui-neon-pulse">{countdown.days}d</span>
      <span className="ui-text-muted">:</span>
      <span className="rounded-md border border-[var(--ui-accent)]/30 bg-[var(--ui-accent-soft)] px-2 py-1.5 ui-neon-pulse">{countdown.hours}j</span>
      <span className="ui-text-muted">:</span>
      <span className="rounded-md border border-[var(--ui-accent)]/30 bg-[var(--ui-accent-soft)] px-2 py-1.5 ui-neon-pulse">{countdown.minutes}m</span>
      <span className="ui-text-muted">:</span>
      <span className="rounded-md border border-[var(--ui-accent)]/30 bg-[var(--ui-accent-soft)] px-2 py-1.5 ui-neon-pulse text-red-400">{countdown.seconds}s</span>
    </div>
  );
}
