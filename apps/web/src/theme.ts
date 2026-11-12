import { useSyncExternalStore } from 'react';

// Light or dark. With nothing saved the app follows the device setting, and keeps
// following it as it changes. The inline script in index.html applies this before
// first paint so the page never flashes the wrong theme.

export type Theme = 'light' | 'dark';

const THEME_KEY = 'verifi.theme.v1';
// Matches --color-surface (the top bar), so the phone's status bar blends in.
const BAR_COLOR: Record<Theme, string> = { light: '#ffffff', dark: '#131c2e' };

const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function saved(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function system(): Theme {
  return media.matches ? 'dark' : 'light';
}

function apply() {
  const theme = saved() ?? system();
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR_COLOR[theme]);
  listeners.forEach((l) => l());
}

media.addEventListener('change', apply);
apply();

export function setTheme(theme: Theme) {
  try {
    // Picking what the device already uses goes back to following the device.
    if (theme === system()) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked: the choice lasts until reload.
    document.documentElement.dataset.theme = theme;
  }
  apply();
}

function current(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function useTheme(): Theme {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, current);
}
