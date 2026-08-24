#!/usr/bin/env node
/* ============================================================================
   Render the app icon and splash screen from the crest.

     node scripts/make-assets.mjs

   Writes assets/icon.png, assets/splash.png and assets/splash-dark.png, which
   `npx capacitor-assets generate` then fans out into every Android density and
   iOS size. Both steps run from `npm run assets`.

   The crest is defined here rather than read from www/logo.svg because the two
   have different jobs: the web mark sits on a dark page and can be small, while
   an app icon is cropped to a rounded square by the launcher and needs its own
   background and padding to survive that.
   ========================================================================= */

import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';

const GOLD_LIGHT = '#FFE04D';
const GOLD_DARK  = '#E6AC00';
const INK        = '#1A1400';
const BACKDROP   = '#0a0e14';

/** The crest on its own, sized to fill the given box. */
function crest(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${GOLD_LIGHT}"/>
        <stop offset="1" stop-color="${GOLD_DARK}"/>
      </linearGradient>
    </defs>
    <path d="M16 1.6 L28.4 5.2 V15.6 C28.4 22.6 23.2 28.2 16 30.4
             C8.8 28.2 3.6 22.6 3.6 15.6 V5.2 Z" fill="url(#g)"/>
    <g stroke="${INK}" stroke-width="1.7" fill="none" stroke-linecap="round">
      <path d="M6.2 16 H25.8"/>
      <circle cx="16" cy="16" r="4.3"/>
    </g>
    <circle cx="16" cy="16" r="1.25" fill="${INK}"/>
  </svg>`;
}

mkdirSync('assets', { recursive: true });

/* ---------- icon ----------
   1024x1024. Launchers crop icons to a circle or squircle and Android's
   adaptive icons trim ~25% from each edge, so the crest sits at 62% of the
   canvas - large enough to read, inset enough to survive the mask. */
const ICON = 1024;
const iconCrest = Math.round(ICON * 0.62);

await sharp({
  create: { width: ICON, height: ICON, channels: 4,
            background: BACKDROP }
})
  .composite([{ input: Buffer.from(crest(iconCrest)), gravity: 'centre' }])
  .png()
  .toFile('assets/icon.png');
console.log(`  assets/icon.png        ${ICON}x${ICON}`);

/* ---------- splash ----------
   2732x2732, square, because the generator crops it to whatever aspect each
   device needs and only the centre is guaranteed visible. The crest is kept
   small for that reason - anything large gets cut off on a narrow phone. */
const SPLASH = 2732;
const splashCrest = Math.round(SPLASH * 0.22);

for (const [name, bg] of [['splash', BACKDROP], ['splash-dark', BACKDROP]]) {
  await sharp({
    create: { width: SPLASH, height: SPLASH, channels: 4, background: bg }
  })
    .composite([{ input: Buffer.from(crest(splashCrest)), gravity: 'centre' }])
    .png()
    .toFile(`assets/${name}.png`);
  console.log(`  assets/${name}.png`.padEnd(25) + `${SPLASH}x${SPLASH}`);
}

console.log('\n  Now run: npx capacitor-assets generate');
