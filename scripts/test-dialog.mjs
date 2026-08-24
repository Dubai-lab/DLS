// A minimal DOM, enough to run dialog.js for real: build the markup, click the
// buttons, and check what the promises resolve to.
import fs from 'node:fs';

function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(), children: [], _html: '', className: '',
    style: {}, _listeners: {}, parentNode: null, value: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    remove() { if (this.parentNode) this.parentNode.children =
      this.parentNode.children.filter(x => x !== this); },
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev = {}) { (this._listeners[t] || []).forEach(fn => fn({ target: this, ...ev })); },
    focus() {}, select() {},
    querySelector(sel) {
      // Answer from the markup actually produced, the way a browser would.
      // A comma list matches whichever alternative is present, the way a
      // browser does - the danger button and the OK button share a query.
      for (const part of sel.split(',')) {
        const cls = part.trim().replace('.', '');
        if (this._html.includes(cls)) return this._stubs[cls] ||= makeEl('button');
      }
      return null;
    },
    _stubs: {}
  };
  return el;
}

const head = makeEl('head'), body = makeEl('body');
globalThis.document = {
  head, body,
  createElement: makeEl,
  addEventListener() {}, removeEventListener() {}
};
globalThis.requestAnimationFrame = fn => fn();
globalThis.setTimeout = (fn) => fn();
globalThis.window = globalThis;

eval(fs.readFileSync('www/js/dialog.js', 'utf8'));

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { console.log('  ok    ' + name); pass++; }
  else { console.log('  FAIL  ' + name + ': got ' + JSON.stringify(got)); fail++; }
}

// --- confirm: the OK button resolves true -------------------------------
{
  const p = Dialog.confirm('body text', { title: 'T', confirmLabel: 'Go' });
  const back = body.children.at(-1);
  const html = back.innerHTML;
  check('confirm renders the title',   /class="dlg-title">T</.test(html), true);
  check('confirm renders the label',   />Go</.test(html), true);
  check('confirm renders cancel',      /dlg-btn-cancel">Cancel</.test(html), true);
  check('confirm has no input',        /dlg-input/.test(html), false);
  p.catch(() => {});
}

// --- alert: no cancel button --------------------------------------------
{
  Dialog.alert('mail failed\n\nline two', { title: 'Email did not send' }).catch(() => {});
  const html = body.children.at(-1).innerHTML;
  check('alert has no cancel',   /dlg-btn-cancel/.test(html), false);
  check('alert splits paragraphs', (html.match(/class="dlg-msg"/g) || []).length, 2);
}

// --- prompt: has an input, seeded with the value ------------------------
{
  Dialog.prompt('note', { title: 'Why?', value: 'seed', placeholder: 'ph' }).catch(() => {});
  const html = body.children.at(-1).innerHTML;
  check('prompt has an input',  /class="dlg-input"/.test(html), true);
  check('prompt seeds value',   /value="seed"/.test(html), true);
  check('prompt sets placeholder', /placeholder="ph"/.test(html), true);
}

// --- escaping: a league name with a quote must not break the markup -----
{
  Dialog.confirm('x', { title: 'Suspend "Africa & Co"?' }).catch(() => {});
  const html = body.children.at(-1).innerHTML;
  check('title is escaped', /Suspend &quot;Africa &amp; Co&quot;\?/.test(html), true);
}

// --- what the promises actually resolve to ------------------------------
async function resolves(name, start, click, want) {
  const p = start();
  const back = body.children.at(-1);
  const input = back.querySelector('.dlg-input');
  if (input) input.value = 'typed';
  back.querySelector(click).dispatch('click');
  check(name, await p, want);
}

await resolves('confirm OK resolves true',
  () => Dialog.confirm('x'), '.dlg-btn-ok, .dlg-btn-danger', true);
await resolves('confirm Cancel resolves false',
  () => Dialog.confirm('x'), '.dlg-btn-cancel', false);
await resolves('danger button still resolves true',
  () => Dialog.confirm('x', { danger: true }), '.dlg-btn-ok, .dlg-btn-danger', true);
await resolves('prompt Cancel resolves null',
  () => Dialog.prompt('x'), '.dlg-btn-cancel', null);
await resolves('prompt OK resolves the typed text',
  () => Dialog.prompt('x'), '.dlg-btn-ok, .dlg-btn-danger', 'typed');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
