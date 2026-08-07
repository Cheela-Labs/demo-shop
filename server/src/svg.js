/**
 * Procedural SVG product art.
 *
 * Every product image on the site is generated here — there are no binary
 * assets anywhere in this repo. `renderProduct()` returns a complete,
 * standalone SVG document served with `image/svg+xml`.
 *
 * All art is drawn against a 600x600 viewBox so pieces compose predictably.
 */

const PALETTES = {
  indigo: { bg1: '#eef2ff', bg2: '#c7d2fe', main: '#4f46e5', deep: '#312e81', soft: '#a5b4fc', accent: '#fbbf24' },
  ember: { bg1: '#fff1f2', bg2: '#fecdd3', main: '#e11d48', deep: '#881337', soft: '#fda4af', accent: '#fcd34d' },
  forest: { bg1: '#ecfdf5', bg2: '#a7f3d0', main: '#059669', deep: '#064e3b', soft: '#6ee7b7', accent: '#fbbf24' },
  slate: { bg1: '#f1f5f9', bg2: '#cbd5e1', main: '#475569', deep: '#1e293b', soft: '#94a3b8', accent: '#38bdf8' },
  sunset: { bg1: '#fff7ed', bg2: '#fed7aa', main: '#ea580c', deep: '#7c2d12', soft: '#fdba74', accent: '#0ea5e9' },
  ocean: { bg1: '#ecfeff', bg2: '#a5f3fc', main: '#0891b2', deep: '#164e63', soft: '#67e8f9', accent: '#f97316' },
  plum: { bg1: '#faf5ff', bg2: '#e9d5ff', main: '#9333ea', deep: '#4c1d95', soft: '#d8b4fe', accent: '#34d399' },
  sand: { bg1: '#fefce8', bg2: '#fef08a', main: '#ca8a04', deep: '#713f12', soft: '#fde047', accent: '#0d9488' },
};

const INK = '#1e293b';

/* ------------------------------------------------------------------ *
 * Individual product illustrations. Each takes the resolved palette
 * and returns markup positioned inside the 600x600 canvas.
 * ------------------------------------------------------------------ */

const ART = {
  headphones: (p) => `
    <path d="M150 330 A150 150 0 0 1 450 330" fill="none" stroke="${p.deep}" stroke-width="30" stroke-linecap="round"/>
    <path d="M150 330 A150 150 0 0 1 450 330" fill="none" stroke="${p.main}" stroke-width="16" stroke-linecap="round"/>
    <rect x="112" y="312" width="84" height="152" rx="42" fill="${p.deep}"/>
    <rect x="404" y="312" width="84" height="152" rx="42" fill="${p.deep}"/>
    <rect x="128" y="330" width="52" height="116" rx="26" fill="${p.main}"/>
    <rect x="420" y="330" width="52" height="116" rx="26" fill="${p.main}"/>
    <ellipse cx="154" cy="388" rx="14" ry="34" fill="${p.soft}" opacity="0.85"/>
    <ellipse cx="446" cy="388" rx="14" ry="34" fill="${p.soft}" opacity="0.85"/>
    <circle cx="446" cy="470" r="9" fill="${p.accent}"/>`,

  sneaker: (p) => `
    <path d="M108 424 C108 350 152 300 214 300 L268 300 L322 352 L432 382 C476 394 492 410 492 434 L492 442 L108 442 Z" fill="${p.main}"/>
    <path d="M268 300 L322 352 L232 352 C232 320 246 302 268 300 Z" fill="${p.soft}"/>
    <path d="M100 442 L500 442 Q500 484 458 484 L142 484 Q100 484 100 442 Z" fill="${p.deep}"/>
    <rect x="100" y="440" width="400" height="12" rx="6" fill="${p.accent}"/>
    <path d="M340 382 C376 400 400 420 412 442" fill="none" stroke="${p.deep}" stroke-width="18" stroke-linecap="round" opacity="0.55"/>
    <g stroke="${p.bg1}" stroke-width="10" stroke-linecap="round">
      <path d="M196 336 L246 356"/>
      <path d="M186 366 L238 384"/>
      <path d="M180 396 L234 410"/>
    </g>
    <circle cx="150" cy="404" r="10" fill="${p.bg1}" opacity="0.7"/>`,

  watch: (p) => `
    <rect x="252" y="118" width="96" height="140" rx="26" fill="${p.deep}"/>
    <rect x="252" y="342" width="96" height="140" rx="26" fill="${p.deep}"/>
    <g stroke="${p.bg1}" stroke-width="4" opacity="0.35">
      <path d="M262 160 H338"/><path d="M262 190 H338"/><path d="M262 400 H338"/><path d="M262 430 H338"/>
    </g>
    <circle cx="300" cy="300" r="112" fill="${p.main}"/>
    <circle cx="300" cy="300" r="94" fill="${p.deep}"/>
    <circle cx="300" cy="300" r="80" fill="${p.bg1}"/>
    <rect x="408" y="284" width="18" height="32" rx="7" fill="${p.deep}"/>
    <g stroke="${p.deep}" stroke-width="7" stroke-linecap="round">
      <path d="M300 300 L300 246"/>
      <path d="M300 300 L342 322"/>
    </g>
    <circle cx="300" cy="300" r="9" fill="${p.accent}"/>
    <g fill="${p.soft}">
      <circle cx="300" cy="232" r="5"/><circle cx="368" cy="300" r="5"/>
      <circle cx="300" cy="368" r="5"/><circle cx="232" cy="300" r="5"/>
    </g>`,

  backpack: (p) => `
    <path d="M212 210 C212 150 388 150 388 210" fill="none" stroke="${p.deep}" stroke-width="26" stroke-linecap="round"/>
    <rect x="164" y="196" width="272" height="292" rx="66" fill="${p.main}"/>
    <path d="M164 262 C164 200 210 180 300 180 C390 180 436 200 436 262 L436 286 C436 300 420 306 300 306 C180 306 164 300 164 286 Z" fill="${p.deep}"/>
    <rect x="204" y="336" width="192" height="112" rx="30" fill="${p.soft}"/>
    <rect x="204" y="336" width="192" height="22" rx="11" fill="${p.deep}" opacity="0.75"/>
    <rect x="284" y="330" width="32" height="34" rx="10" fill="${p.accent}"/>
    <circle cx="300" cy="238" r="20" fill="${p.accent}"/>
    <circle cx="300" cy="238" r="9" fill="${p.deep}"/>
    <g fill="${p.deep}" opacity="0.55">
      <rect x="176" y="330" width="20" height="60" rx="10"/>
      <rect x="404" y="330" width="20" height="60" rx="10"/>
    </g>`,

  camera: (p) => `
    <rect x="232" y="176" width="112" height="46" rx="14" fill="${p.deep}"/>
    <rect x="138" y="208" width="324" height="216" rx="34" fill="${p.main}"/>
    <rect x="138" y="256" width="324" height="60" fill="${p.deep}" opacity="0.35"/>
    <circle cx="300" cy="318" r="86" fill="${p.deep}"/>
    <circle cx="300" cy="318" r="68" fill="${p.soft}"/>
    <circle cx="300" cy="318" r="46" fill="${p.deep}"/>
    <circle cx="282" cy="300" r="16" fill="${p.bg1}" opacity="0.8"/>
    <rect x="378" y="196" width="52" height="26" rx="9" fill="${p.accent}"/>
    <circle cx="182" cy="248" r="13" fill="${p.accent}"/>
    <rect x="392" y="352" width="46" height="14" rx="7" fill="${p.bg1}" opacity="0.6"/>`,

  mug: (p) => `
    <path d="M382 268 C452 268 462 380 382 396" fill="none" stroke="${p.deep}" stroke-width="26" stroke-linecap="round"/>
    <path d="M196 228 L392 228 L376 434 C374 458 356 470 332 470 L256 470 C232 470 214 458 212 434 Z" fill="${p.main}"/>
    <path d="M232 244 L246 452" fill="none" stroke="${p.bg1}" stroke-width="12" stroke-linecap="round" opacity="0.35"/>
    <ellipse cx="294" cy="228" rx="98" ry="26" fill="${p.deep}"/>
    <ellipse cx="294" cy="230" rx="80" ry="18" fill="${p.accent}"/>
    <g fill="none" stroke="${p.deep}" stroke-width="11" stroke-linecap="round" opacity="0.45">
      <path d="M258 176 C240 160 276 142 258 122"/>
      <path d="M330 176 C312 160 348 142 330 122"/>
    </g>`,

  chair: (p) => `
    <rect x="204" y="140" width="192" height="168" rx="52" fill="${p.main}"/>
    <path d="M232 176 H368" stroke="${p.bg1}" stroke-width="10" stroke-linecap="round" opacity="0.4"/>
    <path d="M232 214 H368" stroke="${p.bg1}" stroke-width="10" stroke-linecap="round" opacity="0.4"/>
    <rect x="168" y="308" width="264" height="60" rx="28" fill="${p.deep}"/>
    <rect x="180" y="300" width="240" height="26" rx="13" fill="${p.accent}"/>
    <g stroke="${p.deep}" stroke-width="20" stroke-linecap="round">
      <path d="M206 366 L172 476"/>
      <path d="M394 366 L428 476"/>
      <path d="M252 366 L242 470"/>
      <path d="M348 366 L358 470"/>
    </g>
    <path d="M242 424 H358" stroke="${p.soft}" stroke-width="14" stroke-linecap="round"/>`,

  lamp: (p) => `
    <path d="M206 274 L150 468 L424 468 L300 250 Z" fill="${p.accent}" opacity="0.18"/>
    <path d="M336 462 L300 360" stroke="${p.deep}" stroke-width="20" stroke-linecap="round"/>
    <path d="M300 360 L246 252" stroke="${p.deep}" stroke-width="20" stroke-linecap="round"/>
    <circle cx="300" cy="360" r="16" fill="${p.deep}"/>
    <g transform="rotate(-28 240 244)">
      <path d="M204 198 L276 198 L302 272 L178 272 Z" fill="${p.main}"/>
      <path d="M204 198 L276 198 L281 214 L199 214 Z" fill="${p.deep}" opacity="0.35"/>
      <ellipse cx="240" cy="272" rx="62" ry="15" fill="${p.accent}"/>
      <rect x="228" y="182" width="24" height="20" rx="8" fill="${p.deep}"/>
    </g>
    <ellipse cx="300" cy="470" rx="98" ry="24" fill="${p.deep}"/>
    <ellipse cx="300" cy="462" rx="98" ry="22" fill="${p.main}"/>
    <ellipse cx="300" cy="458" rx="60" ry="12" fill="${p.deep}" opacity="0.25"/>`,

  keyboard: (p) => {
    let keys = '';
    for (let row = 0; row < 4; row += 1) {
      const cols = row === 3 ? 5 : 11;
      const startX = row === 3 ? 210 : 138 + row * 8;
      for (let col = 0; col < cols; col += 1) {
        const w = row === 3 && col === 2 ? 96 : 30;
        const x = startX + (row === 3 && col > 2 ? 66 : 0) + col * 34;
        const y = 268 + row * 40;
        const fill = row === 3 && col === 2 ? p.accent : p.bg1;
        keys += `<rect x="${x}" y="${y}" width="${w}" height="30" rx="8" fill="${fill}" opacity="0.92"/>`;
      }
    }
    return `
    <rect x="112" y="232" width="376" height="196" rx="28" fill="${p.deep}"/>
    <rect x="112" y="232" width="376" height="176" rx="26" fill="${p.main}"/>
    ${keys}
    <rect x="150" y="244" width="34" height="10" rx="5" fill="${p.accent}"/>
    <circle cx="452" cy="250" r="7" fill="${p.accent}"/>`;
  },

  plant: (p) => `
    <g stroke="${p.deep}" stroke-width="9" stroke-linecap="round" fill="none">
      <path d="M300 358 L300 214"/><path d="M300 300 L232 226"/><path d="M300 288 L368 220"/>
    </g>
    <g fill="${p.main}">
      <ellipse cx="300" cy="182" rx="34" ry="58"/>
      <ellipse cx="214" cy="206" rx="54" ry="30" transform="rotate(-28 214 206)"/>
      <ellipse cx="386" cy="200" rx="54" ry="30" transform="rotate(28 386 200)"/>
    </g>
    <g fill="${p.soft}" opacity="0.75">
      <ellipse cx="254" cy="252" rx="42" ry="24" transform="rotate(-18 254 252)"/>
      <ellipse cx="348" cy="248" rx="42" ry="24" transform="rotate(18 348 248)"/>
    </g>
    <path d="M222 350 H378 L358 462 C356 474 348 480 336 480 L264 480 C252 480 244 474 242 462 Z" fill="${p.accent}"/>
    <rect x="212" y="336" width="176" height="34" rx="14" fill="${p.deep}"/>
    <path d="M264 396 H336" stroke="${p.deep}" stroke-width="10" stroke-linecap="round" opacity="0.4"/>`,

  sunglasses: (p) => `
    <path d="M146 272 C126 250 116 226 116 200" fill="none" stroke="${p.deep}" stroke-width="17" stroke-linecap="round"/>
    <path d="M454 272 C474 250 484 226 484 200" fill="none" stroke="${p.deep}" stroke-width="17" stroke-linecap="round"/>
    <path d="M276 262 C288 250 312 250 324 262" fill="none" stroke="${p.deep}" stroke-width="18" stroke-linecap="round"/>
    <rect x="130" y="248" width="152" height="112" rx="46" fill="${p.deep}"/>
    <rect x="318" y="248" width="152" height="112" rx="46" fill="${p.deep}"/>
    <rect x="144" y="260" width="124" height="88" rx="38" fill="${p.main}"/>
    <rect x="332" y="260" width="124" height="88" rx="38" fill="${p.main}"/>
    <path d="M164 330 L212 272" stroke="${p.bg1}" stroke-width="14" stroke-linecap="round" opacity="0.55"/>
    <path d="M352 330 L400 272" stroke="${p.bg1}" stroke-width="14" stroke-linecap="round" opacity="0.55"/>
    <circle cx="300" cy="262" r="8" fill="${p.accent}"/>`,

  bottle: (p) => `
    <rect x="262" y="104" width="76" height="48" rx="16" fill="${p.deep}"/>
    <rect x="272" y="146" width="56" height="52" rx="12" fill="${p.soft}"/>
    <rect x="228" y="188" width="144" height="298" rx="52" fill="${p.main}"/>
    <rect x="228" y="272" width="144" height="118" fill="${p.bg1}" opacity="0.92"/>
    <rect x="228" y="272" width="144" height="14" fill="${p.accent}"/>
    <circle cx="300" cy="332" r="30" fill="none" stroke="${p.deep}" stroke-width="9"/>
    <path d="M286 332 L296 344 L316 320" fill="none" stroke="${p.accent}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="248" y="206" width="16" height="56" rx="8" fill="${p.bg1}" opacity="0.45"/>`,

  speaker: (p) => {
    let mesh = '';
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 6; c += 1) {
        mesh += `<circle cx="${248 + c * 21}" cy="${230 + r * 21}" r="5" fill="${p.deep}" opacity="0.35"/>`;
      }
    }
    return `
    <ellipse cx="300" cy="196" rx="94" ry="30" fill="${p.soft}"/>
    <path d="M206 196 L206 424 C206 452 248 470 300 470 C352 470 394 452 394 424 L394 196 Z" fill="${p.main}"/>
    ${mesh}
    <ellipse cx="300" cy="424" rx="94" ry="30" fill="${p.deep}" opacity="0.45"/>
    <rect x="256" y="392" width="88" height="16" rx="8" fill="${p.deep}"/>
    <circle cx="300" cy="196" r="26" fill="${p.accent}"/>
    <circle cx="300" cy="196" r="11" fill="${p.deep}"/>`;
  },

  tote: (p) => `
    <path d="M244 232 C244 160 356 160 356 232" fill="none" stroke="${p.deep}" stroke-width="20" stroke-linecap="round"/>
    <path d="M176 218 L424 218 L452 462 C454 476 444 486 430 486 L170 486 C156 486 146 476 148 462 Z" fill="${p.main}"/>
    <path d="M176 218 L424 218 L430 268 L170 268 Z" fill="${p.deep}" opacity="0.35"/>
    <circle cx="300" cy="376" r="62" fill="${p.bg1}" opacity="0.9"/>
    <path d="M270 376 L292 400 L336 352" fill="none" stroke="${p.accent}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>`,

  earbuds: (p) => `
    <g>
      <rect x="202" y="196" width="38" height="126" rx="19" fill="${p.deep}"/>
      <circle cx="221" cy="192" r="47" fill="${p.deep}"/>
      <circle cx="221" cy="192" r="27" fill="${p.soft}"/>
      <circle cx="221" cy="192" r="12" fill="${p.deep}" opacity="0.55"/>
      <rect x="360" y="196" width="38" height="126" rx="19" fill="${p.deep}"/>
      <circle cx="379" cy="192" r="47" fill="${p.deep}"/>
      <circle cx="379" cy="192" r="27" fill="${p.soft}"/>
      <circle cx="379" cy="192" r="12" fill="${p.deep}" opacity="0.55"/>
    </g>
    <rect x="190" y="346" width="220" height="142" rx="54" fill="${p.main}"/>
    <path d="M190 392 H410" stroke="${p.deep}" stroke-width="7" opacity="0.4"/>
    <rect x="272" y="346" width="56" height="12" rx="6" fill="${p.deep}" opacity="0.35"/>
    <circle cx="300" cy="440" r="11" fill="${p.accent}"/>`,
};

/* ------------------------------------------------------------------ */

function decor(p, seed) {
  // A couple of deterministic background blobs so no two products look alike.
  const a = 120 + ((seed * 37) % 160);
  const b = 90 + ((seed * 61) % 180);
  return `
    <circle cx="${a}" cy="${b}" r="86" fill="${p.main}" opacity="0.10"/>
    <circle cx="${600 - a}" cy="${560 - b}" r="120" fill="${p.deep}" opacity="0.07"/>`;
}

function seedOf(text) {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) n = (n * 31 + text.charCodeAt(i)) % 997;
  return n;
}

/**
 * Full product image.
 * @param {{id:string,name:string,art:string,palette:string}} product
 * @param {{size?:number}} [opts]
 */
export function renderProduct(product, opts = {}) {
  const size = Math.min(Math.max(Number(opts.size) || 600, 64), 2000);
  const p = PALETTES[product.palette] || PALETTES.indigo;
  const draw = ART[product.art] || ART.mug;
  const seed = seedOf(product.id);
  const uid = `g${seed}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="${size}" height="${size}" role="img" aria-label="${escapeXml(product.name)}">
  <defs>
    <linearGradient id="${uid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${p.bg1}"/>
      <stop offset="100%" stop-color="${p.bg2}"/>
    </linearGradient>
    <filter id="s${uid}" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="${p.deep}" flood-opacity="0.22"/>
    </filter>
  </defs>
  <rect width="600" height="600" fill="url(#${uid})"/>
  ${decor(p, seed)}
  <ellipse cx="300" cy="512" rx="176" ry="26" fill="${p.deep}" opacity="0.12"/>
  <g filter="url(#s${uid})">${draw(p)}</g>
</svg>`;
}

/** Small square brand mark, used for the site logo / favicon. */
export function renderLogo(size = 64) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="Cheela Shop">
  <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#0891b2"/>
  </linearGradient></defs>
  <rect width="64" height="64" rx="16" fill="url(#lg)"/>
  <path d="M20 24 L44 24 L40 46 C39.6 48.4 38 49.6 35.6 49.6 L28.4 49.6 C26 49.6 24.4 48.4 24 46 Z" fill="#fff" opacity="0.95"/>
  <path d="M25 26 C25 17 39 17 39 26" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
  <circle cx="32" cy="37" r="5" fill="${INK}"/>
</svg>`;
}

function escapeXml(s = '') {
  return String(s).replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

export const artNames = Object.keys(ART);
export const paletteNames = Object.keys(PALETTES);
