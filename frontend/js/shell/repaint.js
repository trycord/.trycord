// The chrome painter, registered by shell.js. Modules ask for a repaint here
// rather than importing the thing that repaints.

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
