const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-06-30" -> "Jun 30, 2026". Parsed as a plain calendar date, no time zones. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** 48200000 -> "$48.2M" */
export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${trim(abs / 1e12)}T`;
  if (abs >= 1e9) return `${sign}$${trim(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}$${trim(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}$${trim(abs / 1e3)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function trim(n: number): string {
  // Two decimals below 10, otherwise one, with trailing zeros dropped: 1.23, 48.2, 152.4, 44
  if (n < 10) return n.toFixed(2).replace(/\.?0+$/, '');
  return n.toFixed(1).replace(/\.0$/, '');
}

/** 30.98 -> "31.0%", 300 -> "300%". No sign. */
export function formatPercentMagnitude(percent: number): string {
  const abs = Math.abs(percent);
  return abs >= 100 ? `${abs.toFixed(0)}%` : `${abs.toFixed(1)}%`;
}

/** 30.98 -> "+31.0%", -4.2 -> "-4.2%" */
export function formatSignedPercent(percent: number): string {
  return `${percent >= 0 ? '+' : '-'}${formatPercentMagnitude(percent)}`;
}

/** 1.254 -> "$1.25", -0.12 -> "-$0.12" (per-share amounts). */
export function formatPerShare(value: number): string {
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
}

/** 182.456 -> "$182.46" (a share price). */
export function formatPrice(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** An ISO timestamp -> "Nov 3, 2026, 12:47 PM ET". Market hours are New York hours. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${text} ET`;
}

/** 30.98 -> "up 31.0%", -4.2 -> "down 4.2%" */
export function describeChange(percent: number): string {
  return `${percent >= 0 ? 'up' : 'down'} ${formatPercentMagnitude(percent)}`;
}
