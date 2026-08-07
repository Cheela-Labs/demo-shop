/** Inline SVG icon set — no icon font, no image requests. */

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export const Search = (p) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>
);

export const Bag = (p) => (
  <svg {...base} {...p}>
    <path d="M6 8h12l-1 12H7L6 8Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" />
  </svg>
);

export const Trash = (p) => (
  <svg {...base} {...p}>
    <path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" /><path d="M10 11v6M14 11v6" />
  </svg>
);

export const Check = (p) => (
  <svg {...base} {...p}><path d="m5 13 4 4L19 7" /></svg>
);

export const Star = ({ filled = true, ...p }) => (
  <svg {...base} fill={filled ? 'currentColor' : 'none'} strokeWidth={filled ? 0 : 2} {...p}>
    <path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.4 9.4l6-.8L12 3Z" />
  </svg>
);

export const ArrowLeft = (p) => (
  <svg {...base} {...p}><path d="M19 12H5" /><path d="m11 6-6 6 6 6" /></svg>
);

export const ArrowRight = (p) => (
  <svg {...base} {...p}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
);

export const User = (p) => (
  <svg {...base} {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
);

export const Truck = (p) => (
  <svg {...base} {...p}>
    <path d="M3 7h11v9H3z" /><path d="M14 10h4l3 3v3h-7z" />
    <circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" />
  </svg>
);

export const Shield = (p) => (
  <svg {...base} {...p}><path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3Z" /><path d="m9 12 2 2 4-4" /></svg>
);

export const Leaf = (p) => (
  <svg {...base} {...p}><path d="M4 20c0-8 6-14 16-14 0 10-6 14-14 14H4Z" /><path d="M4 20c4-6 8-8 12-9" /></svg>
);

export const Logo = ({ size = 30 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Cheela">
    <defs>
      <linearGradient id="cl" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#6366f1" /><stop offset="100%" stopColor="#0891b2" />
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="16" fill="url(#cl)" />
    <path d="M20 24h24l-4 22c-.4 2.4-2 3.6-4.4 3.6h-7.2c-2.4 0-4-1.2-4.4-3.6Z" fill="#fff" opacity="0.95" />
    <path d="M25 26c0-9 14-9 14 0" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
    <circle cx="32" cy="37" r="5" fill="#14142b" />
  </svg>
);
