# Trycord Design System

A comprehensive, themeable design system built for the Trycord chat platform.

## Features

- **Themeable**: Dark, light, and high-contrast themes via CSS custom properties
- **Accessible**: visible focus indicators, keyboard support, and reduced-motion handling
- **Responsive**: Mobile-first design with breakpoints for all screen sizes
- **Component-based**: Modular CSS architecture for easy maintenance

## File Structure

```
trycord-client/styles/
├── tokens.css       # Design tokens (colors, typography, spacing, etc.)
├── theme.css        # Theme definitions (dark, light, high-contrast)
├── components.css   # Reusable UI components
├── utilities.css    # Utility classes
├── layout.css       # Entry point (imports all files below, then app shell)
└── showcase.css     # Design system showcase page styles
```

## Usage

### Import All Styles

```html
<link rel="stylesheet" href="styles/tokens.css" />
<link rel="stylesheet" href="styles/theme.css" />
<link rel="stylesheet" href="styles/components.css" />
<link rel="stylesheet" href="styles/utilities.css" />
<link rel="stylesheet" href="styles/layout.css" />
```

### Theme Switching

Switch themes by changing the `data-theme` attribute on `<html>`:

```html
<html data-theme="dark">
<html data-theme="light">
<html data-theme="high-contrast">
```

### Density Switching

Switch density by changing the `data-density` attribute on `<html>`:

```html
<html data-density="compact">
<html data-density="comfortable">
<html data-density="spacious">
```

## Design Tokens

### Colors

| Token | Description |
|-------|-------------|
| `--tc-accent` | Primary brand color |
| `--tc-bg` | Page background |
| `--tc-surface` | Card/panel background |
| `--tc-text` | Primary text |
| `--tc-text-muted` | Secondary text |
| `--tc-border` | Default border color |
| `--tc-success` | Success feedback |
| `--tc-warning` | Warning feedback |
| `--tc-danger` | Error/danger feedback |

### Typography

| Token | Description |
|-------|-------------|
| `--tc-text-xs` | 0.75rem |
| `--tc-text-sm` | 0.875rem |
| `--tc-text-base` | 1rem |
| `--tc-text-lg` | 1.125rem |
| `--tc-text-xl` | 1.25rem |
| `--tc-text-2xl` | 1.5rem |
| `--tc-text-3xl` | 1.875rem |
| `--tc-text-4xl` | 2.25rem |
| `--tc-text-5xl` | 3rem |

### Spacing

| Token | Value |
|-------|-------|
| `--tc-space-1` | 0.25rem |
| `--tc-space-2` | 0.5rem |
| `--tc-space-3` | 0.75rem |
| `--tc-space-4` | 1rem |
| `--tc-space-5` | 1.25rem |
| `--tc-space-6` | 1.5rem |
| `--tc-space-8` | 2rem |
| `--tc-space-10` | 2.5rem |
| `--tc-space-12` | 3rem |

### Border Radius

| Token | Value |
|-------|-------|
| `--tc-radius-sm` | 0.25rem |
| `--tc-radius-md` | 0.375rem |
| `--tc-radius-lg` | 0.5rem |
| `--tc-radius-xl` | 0.75rem |
| `--tc-radius-2xl` | 1rem |
| `--tc-radius-full` | 9999px |

### Shadows

| Token | Description |
|-------|-------------|
| `--tc-shadow-xs` | Subtle elevation |
| `--tc-shadow-sm` | Card hover |
| `--tc-shadow-md` | Dropdown menu |
| `--tc-shadow-lg` | Modal |
| `--tc-shadow-xl` | Toast |

## Components

### Buttons

```html
<button class="btn btn-primary">Primary</button>
<button class="btn btn-secondary">Secondary</button>
<button class="btn btn-danger">Danger</button>
<button class="btn btn-ghost">Ghost</button>
<button class="btn btn-success">Success</button>
<button class="btn btn-warning">Warning</button>

<!-- Sizes -->
<button class="btn btn-primary btn-sm">Small</button>
<button class="btn btn-primary">Default</button>
<button class="btn btn-primary btn-lg">Large</button>
<button class="btn btn-primary btn-block">Full Width</button>

<!-- States -->
<button class="btn btn-primary" disabled>Disabled</button>
<button class="btn btn-primary is-loading">Loading</button>
```

### Forms

```html
<div class="form-group">
  <label class="form-label">Email</label>
  <input type="email" class="form-input" placeholder="you@example.com" />
  <p class="form-hint">Helper text</p>
</div>

<div class="form-check">
  <input type="checkbox" class="form-check-input" id="check" />
  <label class="form-check-label" for="check">Label</label>
</div>
```

### Avatars

```html
<div class="avatar avatar-sm">S</div>
<div class="avatar avatar-md">M</div>
<div class="avatar avatar-lg avatar-status online">L</div>
```

### Badges

```html
<span class="badge badge-primary">Primary</span>
<span class="badge badge-success">Success</span>
<span class="badge badge-dot badge-dot-success">Online</span>
```

### Cards

```html
<div class="card">
  <div class="card-header">Header</div>
  <div class="card-body">Body</div>
  <div class="card-footer">Footer</div>
</div>
```

### Modals

```html
<dialog class="modal">
  <div class="modal-header">
    <h2 class="modal-title">Title</h2>
    <button class="modal-close">&times;</button>
  </div>
  <div class="modal-body">Content</div>
  <div class="modal-footer">Actions</div>
</dialog>
```

### Toasts

```html
<div class="toast toast-success">
  <div class="toast-content">
    <div class="toast-title">Success</div>
    <div class="toast-message">Action completed.</div>
  </div>
  <button class="toast-close">&times;</button>
</div>
```

## Accessibility

- All interactive elements have visible focus indicators
- Text/background contrast targets readable pairings in both themes
- Reduced motion is supported via `prefers-reduced-motion`
- Semantic HTML is used throughout
- ARIA attributes are included where needed

## View the Design System

Open `showcase.html` in a browser to see all components and tokens in action.