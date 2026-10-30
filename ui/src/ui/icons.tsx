const PATHS: Record<string, string> = {
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  cube: 'M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5zM3.8 7.2L12 12l8.2-4.8M12 12v9.4',
  route: 'M6 19a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM18 10a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM8.5 16.5H15a3 3 0 000-6H9a3 3 0 010-6h6.5',
  flask: 'M9 3h6M10 3v6.2L4.6 18.4A1.7 1.7 0 006 21h12a1.7 1.7 0 001.4-2.6L14 9.2V3M7.5 14h9',
  spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  shield: 'M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z',
  shieldCheck: 'M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6zM8.8 12.2l2.2 2.2 4.4-4.6',
  building: 'M4 21V5.5L12 3v18M12 8.5l8 2.5v10M2.5 21h19M7 8h2M7 12h2M7 16h2M15 13.5h2M15 17h2',
  chevron: 'M7 10l5 5 5-5',
  logout: 'M15 4h3.5A1.5 1.5 0 0120 5.5v13a1.5 1.5 0 01-1.5 1.5H15M10 16l-4-4 4-4M6 12h10',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16a4 4 0 100-8 4 4 0 000 8zM12 12h.01',
  orbit: 'M12 14a2 2 0 100-4 2 2 0 000 4zM20.5 12c0 2.2-3.8 4-8.5 4s-8.5-1.8-8.5-4 3.8-4 8.5-4 8.5 1.8 8.5 4zM16.2 4.5c1.9 1.1.5 5.1-3 9s-7.6 5.6-9.5 4.5',
  play: 'M7 4.5v15l12.5-7.5z',
  stop: 'M6.5 6.5h11v11h-11z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.5h.01',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7.5V12l3 2',
  server: 'M4 4.5h16v6H4zM4 13.5h16v6H4zM7.5 7.5h.01M7.5 16.5h.01M11 7.5h5M11 16.5h5',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4.5V11h-6.5',
  plus: 'M12 5v14M5 12h14',
  download: 'M12 4v11M7 10.5l5 5 5-5M4.5 19.5h15',
  upload: 'M12 15.5V4.5M7 9l5-5 5 5M4.5 19.5h15',
  lock: 'M6 10.5h12v10H6zM8.5 10.5V7.5a3.5 3.5 0 017 0v3',
  x: 'M6 6l12 12M18 6L6 18',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  pulse: 'M3 12h4l2.5-6 5 12 2.5-6h4',
  bolt: 'M13 2.5L5 13.5h6l-1 8 8-11h-6z',
  wrench: 'M14.5 6.5a4 4 0 005.2 5.2l-8.4 8.4a2.1 2.1 0 01-3-3l8.4-8.4a4 4 0 00-2.2-2.2zM14.5 6.5L17 4',
  users: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.3a3.5 3.5 0 010 6.4M18 14.4c2.1.7 3.5 2.8 3.5 5.6',
  file: 'M6 2.5h8l4.5 4.5v14.5H6zM14 2.5V7h4.5M9 12h6M9 16h6',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
}

export function Icon({name, size = 18, className = ''}: {name: keyof typeof PATHS | string; size?: number; className?: string}) {
  return <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name] ?? PATHS.cube}/></svg>
}

export function Logo({size = 30}: {size?: number}) {
  return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#6366f1"/><stop offset="1" stopColor="#0ea5e9"/></linearGradient></defs>
    <rect width="32" height="32" rx="9" fill="url(#lg)"/>
    <path d="M16 6.5l8 4.6v9.8l-8 4.6-8-4.6v-9.8z" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round"/>
    <path d="M8.3 11.3L16 15.8l7.7-4.5M16 15.8v9.4" fill="none" stroke="#fff" strokeOpacity=".75" strokeWidth="1.6" strokeLinejoin="round"/>
    <circle cx="16" cy="15.8" r="2" fill="#fff"/>
  </svg>
}
