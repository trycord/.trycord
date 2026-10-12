// Tiny component base. No framework, no magic - just a pattern that keeps
// the renderer, the state and the lifecycle together so a surface can be
// tested in isolation and composed without surprises.
//
// Every component is a class with:
//
//   render()        -> HTMLElement (or string for text nodes)
//   mount(el?)      -> this, attaches to element or builds one
//   unmount()       -> void, cleans up listeners/intervals
//   update(props)   -> this, for when parent passes new data
//
// Components own their DOM. They do not share nodes with siblings or
// parents unless explicitly composed. A parent mounts children by calling
// child.mount(parentElement) and the child returns its root element.
//
// The pattern is deliberately minimal. If you need reactivity, computed
// values, or a virtual DOM, add it - this is the floor, not the ceiling.

export class Component {
  _root = null;
  #mounted = false;
  _cleanup = [];

  /** Override. Return an HTMLElement, DocumentFragment, or text string. */
  render() {
    return '';
  }

  /** Called after render(), before the element enters the DOM. */
  onBeforeMount() {}

  /** Called after the element is in the DOM. */
  onMount() {}

  /** Called before the element leaves the DOM. */
  onUnmount() {}

  /** Hook for derived classes to declare reactive updates. */
  update(props) {
    return this;
  }

  /** Build or reuse the root element. */
  mount(container) {
    if (this._mounted && this._root && this._root.isConnected) return this;

    const output = this.render();
    this._root = typeof output === 'string'
      ? document.createTextNode(output)
      : output instanceof Node
        ? output
        : document.createElement('div');

    this.onBeforeMount();

    if (container) {
      if (this._root instanceof DocumentFragment) {
        container.appendChild(this._root);
      } else if (this._root instanceof Text) {
        container.appendChild(this._root);
      } else {
        container.appendChild(this._root);
      }
    }

    this._mounted = true;
    this.onMount();
    return this;
  }

  /** Remove from DOM and run cleanup. */
  unmount() {
    if (!this._mounted) return;
    this.onUnmount();
    this._cleanup.forEach((fn) => fn());
    this._cleanup = [];
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    this._mounted = false;
  }

  /** Register a cleanup function (listener removal, interval clear, etc.). */
  onCleanup(fn) {
    this._cleanup.push(fn);
    return fn;
  }

  /** Add an event listener that is automatically removed on unmount. */
  on(element, event, handler, options) {
    element.addEventListener(event, handler, options);
    this.onCleanup(() => element.removeEventListener(event, handler, options));
    return handler;
  }

  /** Start an interval that is automatically cleared on unmount. */
  setInterval(fn, ms) {
    const id = setInterval(fn, ms);
    this.onCleanup(() => clearInterval(id));
    return id;
  }

  /** Start a timeout that is automatically cleared on unmount. */
  setTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    this.onCleanup(() => clearTimeout(id));
    return id;
  }

  /** Request an animation frame that is cancelled on unmount. */
  requestAnimationFrame(fn) {
    const id = requestAnimationFrame(fn);
    this.onCleanup(() => cancelAnimationFrame(id));
    return id;
  }

  get root() {
    return this._root;
  }

  get mounted() {
    return this._mounted;
  }
}

/** Compose multiple components into a single parent element. */
export function compose(parent, ...children) {
  const frag = document.createDocumentFragment();
  for (const child of children) {
    if (child instanceof Component) {
      child.mount(frag);
    } else if (child instanceof Node) {
      frag.appendChild(child);
    }
  }
  parent.appendChild(frag);
  return children;
}

/** A component that renders a list of children from an array. */
export class ListComponent extends Component {
  constructor(items = [], itemComponent, keyFn = (i) => i) {
    super();
    this.items = items;
    this.itemComponent = itemComponent;
    this.keyFn = keyFn;
    this._children = new Map();
  }

  render() {
    const frag = document.createDocumentFragment();
    const newChildren = new Map();

    for (const item of this.items) {
      const key = this.keyFn(item);
      let child = this._children.get(key);
      if (!child) {
        child = new this.itemComponent(item);
      }
      child.mount(frag);
      newChildren.set(key, child);
    }

    // Unmount children that are no longer in the list
    for (const [key, child] of this._children) {
      if (!newChildren.has(key)) child.unmount();
    }

    this._children = newChildren;
    return frag;
  }

  update(items) {
    this.items = items;
    if (this.mounted && this._root) {
      this._root.replaceChildren(this.render());
    }
    return this;
  }
}