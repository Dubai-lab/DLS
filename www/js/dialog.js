/* ────────────────────────────────────────────────────────────────────────
   In-app dialogs

   confirm(), alert() and prompt() are the browser's, not the app's: they
   carry the site's URL, ignore the theme, and in the native shell they read
   as a web page interrupting an app. Worse, they block the whole thread, so
   nothing repaints behind them.

   These replacements return promises and look like the rest of the product.
   Everything is injected from here - markup and styles both - so a page only
   has to load the script, and nothing depends on that page's own CSS.
   -------------------------------------------------------------------- */

(function () {
'use strict';

const CSS = `
.dlg-back {
  position: fixed; inset: 0; z-index: 400;
  background: rgba(0,0,0,.78); backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center;
  padding: 24px 18px; overflow-y: auto;
  opacity: 0; transition: opacity .14s ease;
}
.dlg-back.on { opacity: 1; }
.dlg-box {
  background: var(--surface, #12171f);
  border: 1px solid var(--line-soft, #30363d);
  border-radius: 16px; width: 100%; max-width: 420px; padding: 22px;
  color: var(--text, #e6edf3);
  font: inherit;
  transform: translateY(6px); transition: transform .14s ease;
}
.dlg-back.on .dlg-box { transform: none; }
.dlg-title { font-size: 1.04rem; font-weight: 800; margin-bottom: 10px; }
.dlg-msg {
  color: var(--muted, #8b949e); font-size: .87rem; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
}
.dlg-msg + .dlg-msg { margin-top: 10px; }
.dlg-input {
  width: 100%; margin-top: 16px; padding: 12px 14px;
  background: var(--surface-2, #161b22);
  border: 1px solid var(--line-soft, #30363d); border-radius: 10px;
  color: var(--text, #e6edf3); font: inherit; font-size: .9rem;
}
.dlg-input:focus { outline: none; border-color: var(--gold, #FFD700); }
.dlg-actions {
  display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;
  flex-wrap: wrap;
}
.dlg-btn {
  padding: 11px 18px; border-radius: 10px; font: inherit; font-size: .84rem;
  font-weight: 700; cursor: pointer; border: 1px solid transparent;
  touch-action: manipulation;
}
.dlg-btn-cancel {
  background: transparent; border-color: var(--line-soft, #30363d);
  color: var(--text, #e6edf3);
}
.dlg-btn-ok {
  background: linear-gradient(135deg, var(--gold, #FFD700), var(--gold-dim, #E6AC00));
  color: #1a1400;
}
.dlg-btn-danger { background: var(--red, #f87171); color: #2a0a0a; }
.dlg-btn:active { transform: translateY(1px); }
@media (max-width: 380px) {
  .dlg-actions { flex-direction: column-reverse; }
  .dlg-btn { width: 100%; }
}
`;

let styled = false;
function ensureStyles() {
  if (styled) return;
  const el = document.createElement('style');
  el.textContent = CSS;
  document.head.appendChild(el);
  styled = true;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Blank lines separate paragraphs; single newlines are kept inside one. */
function messageHTML(message) {
  return String(message || '').split(/\n{2,}/)
    .filter(p => p.trim())
    .map(p => `<div class="dlg-msg">${esc(p)}</div>`).join('');
}

/**
 * The one dialog everything else is built from.
 * Resolves with the input's value for a prompt, true/false otherwise.
 */
function open({ title, message, confirmLabel, cancelLabel, danger, input }) {
  ensureStyles();

  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'dlg-back';
    back.innerHTML = `
      <div class="dlg-box" role="dialog" aria-modal="true">
        ${title ? `<div class="dlg-title">${esc(title)}</div>` : ''}
        ${messageHTML(message)}
        ${input ? `<input class="dlg-input" type="text"
             placeholder="${esc(input.placeholder || '')}"
             value="${esc(input.value || '')}">` : ''}
        <div class="dlg-actions">
          ${cancelLabel ? `<button class="dlg-btn dlg-btn-cancel">${esc(cancelLabel)}</button>` : ''}
          <button class="dlg-btn ${danger ? 'dlg-btn-danger' : 'dlg-btn-ok'}">${esc(confirmLabel)}</button>
        </div>
      </div>`;

    const field  = back.querySelector('.dlg-input');
    const cancel = back.querySelector('.dlg-btn-cancel');
    const ok     = back.querySelector('.dlg-btn-ok, .dlg-btn-danger');

    let done = false;
    function close(result) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      back.classList.remove('on');
      // Let the fade finish before the node goes, so dismissing does not blink.
      setTimeout(() => back.remove(), 150);
      resolve(result);
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(input ? null : false); }
      // Enter confirms, but not while the caret is in a multi-line field.
      else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        close(input ? field.value : true);
      }
    }

    if (cancel) cancel.addEventListener('click', () => close(input ? null : false));
    ok.addEventListener('click', () => close(input ? field.value : true));
    // Only the backdrop dismisses - a click inside the box must not.
    back.addEventListener('click', e => {
      if (e.target === back) close(input ? null : false);
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(back);
    requestAnimationFrame(() => {
      back.classList.add('on');
      (field || ok).focus();
      if (field) field.select();
    });
  });
}

window.Dialog = {
  /** Resolves true if the reader agrees. */
  confirm(message, opts = {}) {
    return open({
      title: opts.title || 'Are you sure?',
      message,
      confirmLabel: opts.confirmLabel || 'Continue',
      cancelLabel: opts.cancelLabel || 'Cancel',
      danger: !!opts.danger
    });
  },

  /** Resolves once the reader has acknowledged it. */
  alert(message, opts = {}) {
    return open({
      title: opts.title || 'Heads up',
      message,
      confirmLabel: opts.confirmLabel || 'OK',
      cancelLabel: null
    });
  },

  /** Resolves with the text typed, or null if the reader backed out. */
  prompt(message, opts = {}) {
    return open({
      title: opts.title || '',
      message,
      confirmLabel: opts.confirmLabel || 'Send',
      cancelLabel: opts.cancelLabel || 'Cancel',
      input: { placeholder: opts.placeholder || '', value: opts.value || '' }
    });
  }
};

})();
