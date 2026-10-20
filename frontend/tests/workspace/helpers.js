// The workspace checks, shared.
//
// The desk and the phone are driven against a stubbed server: the client asks
// for something, the stub answers, and the check asks what a reader would see
// on the screen. Nothing here reaches into a module's internals - a check that
// read the client's variables would pass when the screen was wrong.

export const BASE = 'http://localhost';
export const SERVER = 's1';

// The address of one of the workspace's routes.
export function api(path) {
  return BASE + '/api/servers/' + SERVER + path;
}

// Every node under another, the ones that answer a question.
export function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

// The nodes whose text holds a phrase.
export function byText(node, text) {
  return find(node, (candidate) => String(candidate.textContent || '').indexOf(text) !== -1);
}

// A button that says what it says.
export function buttonNamed(node, label) {
  const wanted = String(label).toLowerCase();
  return find(node, (candidate) => (
    candidate.tagName === 'BUTTON'
    && String(candidate.textContent || '').trim().toLowerCase() === wanted
  ))[0] || null;
}

// A control named by its label rather than by its text: an icon button, or a
// field.
export function controlNamed(node, label) {
  return find(node, (candidate) => (
    candidate.getAttribute && candidate.getAttribute('aria-label') === label
  ))[0] || null;
}

// A field named by its label.
export function fieldNamed(node, label) {
  return find(node, (candidate) => (
    candidate.tagName
    && (candidate.tagName === 'INPUT' || candidate.tagName === 'TEXTAREA' || candidate.tagName === 'SELECT')
    && candidate.getAttribute('aria-label') === label
  ))[0] || null;
}

// The dialog that is open, if one is.
export function openDialog() {
  const node = document.body.querySelector('.dialog');
  return node || null;
}

// The form of the dialog that is open.
export function openForm() {
  const dialog = openDialog();
  if (!dialog) return null;
  return find(dialog, (node) => node.tagName === 'FORM')[0] || null;
}

// The text of a screen.
export function textOf(node) {
  return String((node && node.textContent) || '');
}

// Wait for something to become true, rather than for a fixed time: a check
// that sleeps reports on the machine rather than on the client.
export async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  for (;;) {
    let value = null;
    try { value = predicate(); } catch { /* not true yet */ }
    if (value) return value;
    if (Date.now() - started > timeout) return null;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// The calls the client made, of one kind.
export function callsTo(calls, method, url) {
  return calls.filter((call) => call.options && call.options.method === method && call.url === url);
}

// The one call the client made, of one kind.
export function callTo(calls, method, url) {
  return callsTo(calls, method, url)[0] || null;
}
