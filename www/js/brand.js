/* ============================================================================
   Platform branding, in one place.

   To rename the platform or change the mark, edit BRAND below. Every page reads
   from here rather than hardcoding the name, so nothing else needs touching.

   The <title> tags are the one exception: browsers and search engines read those
   before any script runs, so they carry the name literally. Search the repo for
   the old name when you rename.
   ========================================================================= */

(function () {
'use strict';

const BRAND = {
  NAME: 'Football League Hub',
  SHORT: 'FLH',
  TAGLINE: 'Run your football league properly',
  SUPPORT_EMAIL: 'eg8217178@gmail.com'
};

/* A club crest carrying pitch markings - halfway line, centre circle, centre
   spot. Inlined rather than loaded from logo.svg so it renders on the first
   paint with no extra request, and so it works inside the packaged app. */
const MARK = `
<svg viewBox="0 0 32 32" role="img" aria-label="${BRAND.NAME}" focusable="false">
  <defs>
    <linearGradient id="flh-crest" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFE04D"/>
      <stop offset="1" stop-color="#E6AC00"/>
    </linearGradient>
  </defs>
  <path d="M16 1.6 L28.4 5.2 V15.6 C28.4 22.6 23.2 28.2 16 30.4
           C8.8 28.2 3.6 22.6 3.6 15.6 V5.2 Z" fill="url(#flh-crest)"/>
  <g stroke="#1A1400" stroke-width="1.7" fill="none" stroke-linecap="round">
    <path d="M6.2 16 H25.8"/>
    <circle cx="16" cy="16" r="4.3"/>
  </g>
  <circle cx="16" cy="16" r="1.25" fill="#1A1400"/>
</svg>`;

BRAND.MARK_SVG = MARK;
window.BRAND = BRAND;

function apply() {
  const name = document.getElementById('brand-name');
  if (name) name.textContent = BRAND.NAME;

  // The crest replaces the old gold square with an "L" in it. Strip the square
  // styling so the artwork is the mark, rather than sitting inside a chip.
  document.querySelectorAll('#brand-mark, .brand-mark').forEach(el => {
    el.innerHTML = MARK;
    el.classList.add('brand-mark--svg');
  });

  document.querySelectorAll('[data-brand]').forEach(el => {
    const value = BRAND[el.dataset.brand];
    if (value) el.textContent = value;
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', apply);
} else {
  apply();
}

})();
