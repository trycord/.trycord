// Primitive UI components. These are the atoms - buttons, inputs, icons,
// avatars, badges - that compose into molecules and organisms.
//
// Each is a Component subclass that renders semantic, accessible HTML with
// the design tokens. No business logic, no data fetching - just presentation.

import { Component } from './base.js';
import { icon } from '../ui/dom.js';

/**
 * Button - the most used interactive element.
 *
 * Variants: primary, secondary, ghost, danger, link
 * Sizes: sm, md, lg
 * States: loading, disabled, pressed
 */
export class Button extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      variant: 'primary',
      size: 'md',
      disabled: false,
      loading: false,
      pressed: false,
      type: 'button',
      fullWidth: false,
      icon: null,
      iconOnly: false,
      'aria-label': null,
      ...props,
    };
  }

  render() {
    const { variant, size, disabled, loading, pressed, type, fullWidth, icon, iconOnly, children, 'aria-label': ariaLabel, ...rest } = this.props;

    const classes = [
      'btn',
      `btn--${variant}`,
      `btn--${size}`,
      disabled && 'btn--disabled',
      loading && 'btn--loading',
      pressed && 'btn--pressed',
      fullWidth && 'btn--full',
      iconOnly && 'btn--icon-only',
    ].filter(Boolean).join(' ');

    const btn = document.createElement('button');
    btn.type = type;
    btn.className = classes;
    btn.disabled = disabled || loading;
    if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);

    if (loading) {
      btn.appendChild(document.createElement('span')).className = 'btn__spinner';
      if (!iconOnly) btn.appendChild(document.createTextNode('Loading...'));
    } else {
      if (icon) {
        const iconEl = typeof icon === 'string' ? icon(icon) : icon;
        if (iconEl) btn.appendChild(iconEl);
      }
      if (!iconOnly && children) {
        const span = document.createElement('span');
        span.className = 'btn__text';
        span.textContent = children;
        btn.appendChild(span);
      }
    }

    // Forward remaining props
    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith('on') && typeof value === 'function') {
        this.on(btn, key.slice(2).toLowerCase(), value);
      } else if (key !== 'children') {
        btn.setAttribute(key, value);
      }
    }

    return btn;
  }
}

/**
 * Icon button - minimal chrome, just the icon.
 */
export class IconButton extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      icon: null,
      size: 'md',
      variant: 'ghost',
      disabled: false,
      'aria-label': null,
      ...props,
    };
  }

  render() {
    const { icon, size, variant, disabled, 'aria-label': ariaLabel, ...rest } = this.props;

    const btn = document.createElement('button');
    btn.className = `btn btn--${variant} btn--${size} btn--icon-only ${disabled ? 'btn--disabled' : ''}`;
    btn.disabled = disabled;
    if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);

    if (icon) {
      const iconEl = typeof icon === 'string' ? icon(icon) : icon;
      if (iconEl) btn.appendChild(iconEl);
    }

    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith('on') && typeof value === 'function') {
        this.on(btn, key.slice(2).toLowerCase(), value);
      }
    }

    return btn;
  }
}

/**
 * Input - text, email, password, search.
 */
export class Input extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      type: 'text',
      placeholder: '',
      value: '',
      disabled: false,
      readonly: false,
      required: false,
      error: null,
      label: null,
      helperText: null,
      icon: null,
      'aria-describedby': null,
      ...props,
    };
  }

  render() {
    const { type, placeholder, value, disabled, readonly, required, error, label, helperText, icon, 'aria-describedby': ariaDescribedBy, id, ...rest } = this.props;

    const wrapper = document.createElement('div');
    wrapper.className = `input-wrapper ${error ? 'input-wrapper--error' : ''} ${disabled ? 'input-wrapper--disabled' : ''}`;

    if (label) {
      const labelEl = document.createElement('label');
      labelEl.htmlFor = id || `input-${Math.random().toString(36).slice(2)}`;
      labelEl.className = 'input-label';
      labelEl.textContent = label;
      wrapper.appendChild(labelEl);
    }

    const inputGroup = document.createElement('div');
    inputGroup.className = 'input-group';

    if (icon) {
      const iconEl = typeof icon === 'string' ? icon(icon) : icon;
      if (iconEl) {
        iconEl.className = 'input-icon';
        inputGroup.appendChild(iconEl);
      }
    }

    const input = document.createElement('input');
    input.type = type;
    input.placeholder = placeholder;
    input.value = value;
    input.disabled = disabled;
    input.readOnly = readonly;
    input.required = required;
    input.className = 'input';
    if (id) input.id = id;
    if (ariaDescribedBy) input.setAttribute('aria-describedby', ariaDescribedBy);
    if (error) input.setAttribute('aria-invalid', 'true');

    this.on(input, 'input', (e) => {
      this.props.value = e.target.value;
      if (this.props.onChange) this.props.onChange(e.target.value, e);
    });
    this.on(input, 'change', (e) => {
      if (this.props.onBlur) this.props.onBlur(e.target.value, e);
    });
    this.on(input, 'keydown', (e) => {
      if (this.props.onKeyDown) this.props.onKeyDown(e);
    });

    inputGroup.appendChild(input);
    wrapper.appendChild(inputGroup);

    if (error || helperText) {
      const helper = document.createElement('div');
      helper.className = error ? 'input-error' : 'input-helper';
      helper.textContent = error || helperText;
      if (error) helper.setAttribute('role', 'alert');
      wrapper.appendChild(helper);
      if (error && !ariaDescribedBy) {
        helper.id = `error-${input.id}`;
        input.setAttribute('aria-describedby', helper.id);
      }
    }

    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith('on') && typeof value === 'function') {
        this.on(input, key.slice(2).toLowerCase(), value);
      }
    }

    return wrapper;
  }

  update(props) {
    this.props = { ...this.props, ...props };
    if (this.mounted && this.root) {
      this.root.replaceChildren(this.render());
    }
    return this;
  }
}

/**
 * Textarea - multi-line input.
 */
export class Textarea extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      placeholder: '',
      value: '',
      disabled: false,
      readonly: false,
      required: false,
      error: null,
      label: null,
      helperText: null,
      rows: 3,
      maxLength: null,
      ...props,
    };
  }

  render() {
    const { placeholder, value, disabled, readonly, required, error, label, helperText, rows, maxLength, id, ...rest } = this.props;

    const wrapper = document.createElement('div');
    wrapper.className = `input-wrapper ${error ? 'input-wrapper--error' : ''} ${disabled ? 'input-wrapper--disabled' : ''}`;

    if (label) {
      const labelEl = document.createElement('label');
      labelEl.htmlFor = id || `textarea-${Math.random().toString(36).slice(2)}`;
      labelEl.className = 'input-label';
      labelEl.textContent = label;
      wrapper.appendChild(labelEl);
    }

    const textarea = document.createElement('textarea');
    textarea.placeholder = placeholder;
    textarea.value = value;
    textarea.disabled = disabled;
    textarea.readOnly = readonly;
    textarea.required = required;
    textarea.rows = rows;
    textarea.className = 'textarea';
    if (id) textarea.id = id;
    if (maxLength) textarea.maxLength = maxLength;
    if (error) textarea.setAttribute('aria-invalid', 'true');

    this.on(textarea, 'input', (e) => {
      this.props.value = e.target.value;
      if (this.props.onChange) this.props.onChange(e.target.value, e);
    });

    wrapper.appendChild(textarea);

    if (error || helperText) {
      const helper = document.createElement('div');
      helper.className = error ? 'input-error' : 'input-helper';
      helper.textContent = error || helperText;
      if (error) helper.setAttribute('role', 'alert');
      wrapper.appendChild(helper);
      if (error) {
        helper.id = `error-${textarea.id}`;
        textarea.setAttribute('aria-describedby', helper.id);
      }
    }

    return wrapper;
  }
}

/**
 * Select - native select with styling.
 */
export class Select extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      options: [],
      value: '',
      placeholder: '',
      disabled: false,
      required: false,
      error: null,
      label: null,
      helperText: null,
      ...props,
    };
  }

  render() {
    const { options, value, placeholder, disabled, required, error, label, helperText, id, ...rest } = this.props;

    const wrapper = document.createElement('div');
    wrapper.className = `input-wrapper ${error ? 'input-wrapper--error' : ''} ${disabled ? 'input-wrapper--disabled' : ''}`;

    if (label) {
      const labelEl = document.createElement('label');
      labelEl.htmlFor = id || `select-${Math.random().toString(36).slice(2)}`;
      labelEl.className = 'input-label';
      labelEl.textContent = label;
      wrapper.appendChild(labelEl);
    }

    const select = document.createElement('select');
    select.className = 'select';
    select.value = value;
    select.disabled = disabled;
    select.required = required;
    if (id) select.id = id;
    if (error) select.setAttribute('aria-invalid', 'true');

    if (placeholder) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.disabled = true;
      opt.selected = !value;
      opt.textContent = placeholder;
      select.appendChild(opt);
    }

    for (const opt of options) {
      const option = document.createElement('option');
      option.value = opt.value ?? opt;
      option.textContent = opt.label ?? opt;
      option.selected = option.value === value;
      select.appendChild(option);
    }

    this.on(select, 'change', (e) => {
      this.props.value = e.target.value;
      if (this.props.onChange) this.props.onChange(e.target.value, e);
    });

    wrapper.appendChild(select);

    if (error || helperText) {
      const helper = document.createElement('div');
      helper.className = error ? 'input-error' : 'input-helper';
      helper.textContent = error || helperText;
      if (error) helper.setAttribute('role', 'alert');
      wrapper.appendChild(helper);
    }

    return wrapper;
  }
}

/**
 * Checkbox - single toggle.
 */
export class Checkbox extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      checked: false,
      disabled: false,
      label: '',
      description: null,
      indeterminate: false,
      ...props,
    };
  }

  render() {
    const { checked, disabled, label, description, indeterminate, id, ...rest } = this.props;

    const wrapper = document.createElement('label');
    wrapper.className = `checkbox ${checked ? 'checkbox--checked' : ''} ${disabled ? 'checkbox--disabled' : ''} ${indeterminate ? 'checkbox--indeterminate' : ''}`;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.disabled = disabled;
    input.indeterminate = indeterminate;
    input.className = 'checkbox__input';
    if (id) input.id = id;

    this.on(input, 'change', (e) => {
      this.props.checked = e.target.checked;
      if (this.props.onChange) this.props.onChange(e.target.checked, e);
    });

    const box = document.createElement('span');
    box.className = 'checkbox__box';

    const checkIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    checkIcon.setAttribute('viewBox', '0 0 24 24');
    checkIcon.setAttribute('fill', 'none');
    checkIcon.setAttribute('stroke', 'currentColor');
    checkIcon.setAttribute('stroke-width', '3');
    checkIcon.className = 'checkbox__icon';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M20 6L9 17l-5-5');
    checkIcon.appendChild(path);
    box.appendChild(checkIcon);

    const labelEl = document.createElement('span');
    labelEl.className = 'checkbox__label';
    labelEl.textContent = label;
    if (description) {
      const desc = document.createElement('span');
      desc.className = 'checkbox__description';
      desc.textContent = description;
      labelEl.appendChild(desc);
    }

    wrapper.appendChild(input);
    wrapper.appendChild(box);
    wrapper.appendChild(labelEl);

    return wrapper;
  }
}

/**
 * Radio - single choice from a group.
 */
export class Radio extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      checked: false,
      disabled: false,
      label: '',
      description: null,
      name: '',
      value: '',
      ...props,
    };
  }

  render() {
    const { checked, disabled, label, description, name, value, id, ...rest } = this.props;

    const wrapper = document.createElement('label');
    wrapper.className = `radio ${checked ? 'radio--checked' : ''} ${disabled ? 'radio--disabled' : ''}`;

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = checked;
    input.disabled = disabled;
    input.className = 'radio__input';
    if (id) input.id = id;

    this.on(input, 'change', (e) => {
      this.props.checked = e.target.checked;
      if (this.props.onChange) this.props.onChange(e.target.checked, e);
    });

    const dot = document.createElement('span');
    dot.className = 'radio__dot';

    const labelEl = document.createElement('span');
    labelEl.className = 'radio__label';
    labelEl.textContent = label;
    if (description) {
      const desc = document.createElement('span');
      desc.className = 'radio__description';
      desc.textContent = description;
      labelEl.appendChild(desc);
    }

    wrapper.appendChild(input);
    wrapper.appendChild(dot);
    wrapper.appendChild(labelEl);

    return wrapper;
  }
}

/**
 * Switch - toggle switch.
 */
export class Switch extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      checked: false,
      disabled: false,
      label: '',
      description: null,
      ...props,
    };
  }

  render() {
    const { checked, disabled, label, description, id, ...rest } = this.props;

    const wrapper = document.createElement('label');
    wrapper.className = `switch ${checked ? 'switch--on' : ''} ${disabled ? 'switch--disabled' : ''}`;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.disabled = disabled;
    input.className = 'switch__input';
    if (id) input.id = id;

    this.on(input, 'change', (e) => {
      this.props.checked = e.target.checked;
      if (this.props.onChange) this.props.onChange(e.target.checked, e);
    });

    const track = document.createElement('span');
    track.className = 'switch__track';
    const thumb = document.createElement('span');
    thumb.className = 'switch__thumb';
    track.appendChild(thumb);

    const labelEl = document.createElement('span');
    labelEl.className = 'switch__label';
    labelEl.textContent = label;
    if (description) {
      const desc = document.createElement('span');
      desc.className = 'switch__description';
      desc.textContent = description;
      labelEl.appendChild(desc);
    }

    wrapper.appendChild(input);
    wrapper.appendChild(track);
    wrapper.appendChild(labelEl);

    return wrapper;
  }
}

/**
 * Badge - small status/count indicator.
 */
export class Badge extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      children: '',
      variant: 'default', // default, success, warning, danger, brand
      size: 'md', // sm, md
      dot: false,
      clickable: false,
      ...props,
    };
  }

  render() {
    const { children, variant, size, dot, clickable, ...rest } = this.props;

    const classes = ['badge', `badge--${variant}`, `badge--${size}`];
    if (dot) classes.push('badge--dot');
    if (clickable) classes.push('badge--clickable');

    const el = document.createElement(clickable ? 'button' : 'span');
    el.className = classes.join(' ');
    if (clickable) {
      el.type = 'button';
      if (this.props.onClick) this.on(el, 'click', this.props.onClick);
    }

    if (dot) {
      const dotEl = document.createElement('span');
      dotEl.className = 'badge__dot';
      el.appendChild(dotEl);
    }
    el.appendChild(document.createTextNode(children));

    return el;
  }
}

/**
 * Tooltip - simple hover/focus tooltip.
 */
export class Tooltip extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      content: '',
      position: 'top', // top, bottom, left, right
      delay: 200,
      ...props,
    };
  }

  render() {
    const { content, position, children } = this.props;

    const wrapper = document.createElement('span');
    wrapper.className = `tooltip tooltip--${position}`;

    if (typeof children === 'string') {
      wrapper.textContent = children;
    } else if (children instanceof Node) {
      wrapper.appendChild(children);
    } else if (children && typeof children.render === 'function') {
      children.mount(wrapper);
    }

    const tip = document.createElement('span');
    tip.className = 'tooltip__content';
    tip.textContent = content;
    wrapper.appendChild(tip);

    let hideTimer = null;
    let showTimer = null;

    const show = () => {
      clearTimeout(hideTimer);
      showTimer = setTimeout(() => {
        wrapper.classList.add('tooltip--visible');
      }, this.props.delay);
    };

    const hide = () => {
      clearTimeout(showTimer);
      hideTimer = setTimeout(() => {
        wrapper.classList.remove('tooltip--visible');
      }, 100);
    };

    this.on(wrapper, 'mouseenter', show);
    this.on(wrapper, 'mouseleave', hide);
    this.on(wrapper, 'focusin', show);
    this.on(wrapper, 'focusout', hide);

    return wrapper;
  }
}

/**
 * Divider - horizontal or vertical rule.
 */
export class Divider extends Component {
  constructor(props = {}) {
    super();
    this.props = {
      orientation: 'horizontal', // horizontal, vertical
      variant: 'default', // default, subtle, strong
      ...props,
    };
  }

  render() {
    const { orientation, variant } = this.props;

    const hr = document.createElement(orientation === 'horizontal' ? 'hr' : 'div');
    hr.className = `divider divider--${orientation} divider--${variant}`;
    hr.setAttribute('role', 'separator');
    hr.setAttribute('aria-orientation', orientation);

    return hr;
  }
}

export { icon } from '../ui/dom.js';