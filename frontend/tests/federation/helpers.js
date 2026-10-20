// The federation checks' small helpers.
//
// The DOM stub is small enough to walk by hand: a node holds its children and
// its attributes, and a check asks a question and hears the answer.

export function find(node, predicate, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const entry of node) find(entry, predicate, found);
    return found;
  }
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

export function classed(word) {
  return (node) => {
    const value = node.getAttribute && node.getAttribute('class');
    return !!value && value.split(/\s+/).indexOf(word) !== -1;
  };
}

// A button whose own text says what it does.
export function buttonWithText(node, text) {
  return find(node, (candidate) => candidate.tagName === 'BUTTON'
    && String(candidate.textContent).indexOf(text) !== -1)[0] || null;
}

// The topmost dialog on the page: the one that was opened last.
export function lastDialog(scope) {
  const dialogs = find(scope, classed('dialog'));
  return dialogs[dialogs.length - 1] || null;
}

// The topmost sheet on the page: the phone's version of the same thing.
export function lastSheet(scope) {
  const sheets = find(scope, classed('m-sheet'));
  return sheets[sheets.length - 1] || null;
}

export function textOf(node) {
  return String((node && node.textContent) || '');
}
