// A component: its own DOM, its own lifecycle, its own listeners.
//
// This exists for the shell and for surfaces that outlive a single render. It is
// deliberately not a framework - there is no reactivity, no diffing and no
// virtual DOM here, because the application's surfaces are long-lived and few,
// and a discussion about a reconciler would be a worse file than this one.
//
// A component is a class that implements render() and gets mount(), unmount()
// and on() from here:
//
//   render()   -> Element, the root this component owns
//   onMount()  -> the element is in the document
//   onUnmount() -> the element is about to leave; run the rest of the teardown
//   on(target, 'click', fn) -> a listener that unmount() removes on its own
//
// The teardown guarantee is the reason this file exists rather than a
// convention: a listener registered without it outlives the surface it draws
// for, and the symptom is a handler that responds to a page the reader has
// left. `on()` puts the removal next to the registration, so the two cannot
// drift apart.

export class Component {
  /** The root element. Set by mount(); read through the getter. */
  _root = null;

  _cleanup = [];

  _mounted = false;

  /** Override. Return the element this component owns. */
  render() {
    return document.createElement('div');
  }

  /** The element is in the document. */
  onMount() {}

  /** The element is about to be removed. */
  onUnmount() {}

  /** Build the tree, put it in the container, and run onMount(). */
  mount(container) {
    this._root = this.render();
    container.appendChild(this._root);
    this._mounted = true;
    this.onMount();
    return this;
  }

  /** Take the tree out of the document and remove every listener. */
  unmount() {
    if (!this._mounted) return;
    this.onUnmount();
    this._cleanup.forEach((undo) => undo());
    this._cleanup = [];
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._mounted = false;
  }

  /** A listener that unmount() removes. */
  on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._cleanup.push(() => target.removeEventListener(type, handler, options));
    return handler;
  }

  get root() {
    return this._root;
  }

  get mounted() {
    return this._mounted;
  }
}
