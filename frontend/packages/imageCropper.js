// Choosing the part of a picture that is the picture.
//
// A face is a square, and a square cut out of the middle of a photograph is
// rarely the face in it. So the reader chooses: the picture is shown, a
// frame is dragged over the part of it they want, and that part is what is
// uploaded.
//
// The frame keeps the shape of the thing it is for - a square for a face, a
// wide shape for a cover - and it can be moved and made bigger with a
// finger or a mouse. Nothing here needs a library: the picture is drawn on
// a canvas at the end, and the frame is a div over the picture.

import { el } from './dom.js';

// The shapes a picture can be cut to.
const SHAPES = {
  square: { ratio: 1 },
  wide: { ratio: 16 / 9 },
  free: { ratio: 0 },
};

/**
 * A cropper over a picture.
 *
 * @param {File} file            The picture the reader chose.
 * @param {object} [options]
 * @param {'square'|'wide'|'free'} [options.shape] What the frame keeps.
 * @param {number} [options.size] How big the cropped picture is, in pixels.
 * @returns {Promise<object>} The cropper: its `node` to show, and a
 *   `result()` that gives the cropped picture.
 */
export async function createCropper(file, options = {}) {
  const shape = SHAPES[options.shape || 'square'] ? (options.shape || 'square') : 'square';
  const ratio = SHAPES[shape].ratio;
  const size = Number(options.size) > 0 ? Number(options.size) : 512;

  const bitmap = await loadBitmap(file);
  if (!bitmap) return null;

  // The picture as it is shown: as wide as the frame allows, as tall as it
  // needs to be, and never stretched.
  const frame = el('div', { class: 'cropper' });
  const picture = el('img', { class: 'cropper__image', src: URL.createObjectURL(file), alt: '' });
  const shade = el('div', { class: 'cropper__shade', 'aria-hidden': 'true' });
  const selection = el('div', {
    class: 'cropper__selection',
    role: 'application',
    'aria-label': 'The part of the picture to use',
  });
  const handle = el('span', { class: 'cropper__handle', 'aria-hidden': 'true' });
  selection.appendChild(handle);
  frame.append(picture, shade, selection);

  // The selection, in the picture's own pixels.
  let box = { x: 0, y: 0, width: 0, height: 0 };
  let shown = { width: 0, height: 0, left: 0, top: 0 };

  const layout = () => {
    const width = frame.clientWidth || 320;
    const scale = width / bitmap.width;
    const height = Math.round(bitmap.height * scale);
    shown = { width, height, left: 0, top: 0 };
    picture.style.width = width + 'px';
    picture.style.height = height + 'px';
    frame.style.height = height + 'px';
    draw();
  };

  const draw = () => {
    selection.style.left = box.x + 'px';
    selection.style.top = box.y + 'px';
    selection.style.width = box.width + 'px';
    selection.style.height = box.height + 'px';
    // The shade is the picture with the chosen part cut out of it, so the
    // reader can see what they are choosing.
    shade.style.clipPath = 'polygon('
      + `0% 0%, 100% 0%, 100% 100%, 0% 100%, `
      + `0% 0%, `
      + `${(box.x / Math.max(1, shown.width)) * 100}% ${(box.y / Math.max(1, shown.height)) * 100}%, `
      + `${((box.x + box.width) / Math.max(1, shown.width)) * 100}% ${(box.y / Math.max(1, shown.height)) * 100}%, `
      + `${((box.x + box.width) / Math.max(1, shown.width)) * 100}% ${((box.y + box.height) / Math.max(1, shown.height)) * 100}%, `
      + `${(box.x / Math.max(1, shown.width)) * 100}% ${((box.y + box.height) / Math.max(1, shown.height)) * 100}%`
      + ')';
  };

  // The biggest selection that fits, centred.
  const reset = () => {
    const width = shown.width || 1;
    const height = shown.height || 1;
    if (ratio) {
      const w = Math.min(width, height * ratio);
      box = { x: (width - w) / 2, y: (height - h(height, w, ratio)) / 2, width: w, height: h(height, w, ratio) };
    } else {
      box = { x: 0, y: 0, width, height };
    }
    draw();
  };
  const h = (height, width, wanted) => (wanted ? width / wanted : height);

  // Dragging the frame moves it; the handle makes it bigger.
  let drag = null;
  const pointOf = (event) => {
    const rect = frame.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onDown = (event) => {
    const point = pointOf(event);
    const onHandle = handle.getBoundingClientRect();
    const onCorner = point.x >= onHandle.left - 8 && point.x <= onHandle.right + 8
      && point.y >= onHandle.top - 8 && point.y <= onHandle.bottom + 8;
    drag = { onCorner, start: point, box: Object.assign({}, box) };
    selection.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onMove = (event) => {
    if (!drag) return;
    const point = pointOf(event);
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    if (drag.onCorner) {
      // Bigger, from the corner, and never past the picture.
      let width = Math.max(48, drag.box.width + dx);
      let height = ratio ? width / ratio : Math.max(48, drag.box.height + dy);
      width = Math.min(width, shown.width - drag.box.x);
      height = Math.min(height, shown.height - drag.box.y);
      if (ratio) width = Math.min(width, height * ratio);
      box = { x: drag.box.x, y: drag.box.y, width, height };
    } else {
      const width = drag.box.width;
      const height = drag.box.height;
      box = {
        x: Math.max(0, Math.min(shown.width - width, drag.box.x + dx)),
        y: Math.max(0, Math.min(shown.height - height, drag.box.y + dy)),
        width,
        height,
      };
    }
    draw();
    event.preventDefault();
  };
  const onUp = () => { drag = null; };

  selection.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  // The picture is shown as soon as it is measured.
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const width = frame.clientWidth || 0;
    if (width && Math.abs(width - shown.width) > 1) { layout(); reset(); }
  }) : null;
  if (observer) observer.observe(frame);

  layout();
  reset();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reset);

  /**
   * The cropped picture.
   *
   * @returns {Promise<Blob|null>} The picture, or null when the browser
   *   cannot draw it.
   */
  const result = async () => {
    const scale = bitmap.width / Math.max(1, shown.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(box.width * scale));
    canvas.height = Math.max(1, Math.round(box.height * scale));
    if (canvas.width > size || canvas.height > size) {
      const fit = Math.min(size / canvas.width, size / canvas.height);
      canvas.width = Math.max(1, Math.round(canvas.width * fit));
      canvas.height = Math.max(1, Math.round(canvas.height * fit));
    }
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(
      bitmap,
      Math.round(box.x * scale), Math.round(box.y * scale),
      Math.round(box.width * scale), Math.round(box.height * scale),
      0, 0, canvas.width, canvas.height,
    );
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  };

  const destroy = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (observer) observer.disconnect();
    URL.revokeObjectURL(picture.src);
    bitmap.close?.();
  };

  return { node: frame, result, destroy };
}

/** Read a picture the browser can draw. */
async function loadBitmap(file) {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

export default { createCropper };
