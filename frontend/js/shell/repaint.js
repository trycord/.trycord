// Asking for the chrome to be repainted.
//
// The painter is registered by shell.js rather than imported, because every module that
// changes visible state needs this and the painter needs every module. Wiring it here
// means the dependency runs one way: a module knows that repaints exist, and shell.js
// knows how to do one.

let painter = null;

export function setChromePainter(fn) {
  painter = fn;
}

// A missing painter is not an error worth throwing over. Before the shell has finished
// wiring there is nothing to repaint, and a state change during boot is not a reason to
// take the page down.
export function repaintChrome() {
  if (painter) painter();
}
