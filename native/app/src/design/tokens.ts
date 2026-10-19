/**
 * The design tokens.
 *
 * These are the values the web client uses, copied from
 * frontend/assets/trycord-assets/tokens/trycord.css and frontend/css/tokens.css
 * rather than re-invented, so the two clients speak one design language
 * without sharing one interface.
 *
 * The native client has no stylesheet, so a token here is a plain value a
 * component reads. The names follow the stylesheet's: --tc-brand is brand,
 * --tc-bg-deep is bgDeep, and so on.
 */

export const palette = {
  brand: '#FF4D24',
  brandHover: '#E9431D',
  brandStrong: '#C93618',
  brandFocusDark: '#FF7A5A',
  success: '#35B875',
  warning: '#F2B84B',
  danger: '#EF5350',
  info: '#5798F5',
  textOnBrand: '#FFFFFF',
} as const;

export const darkPalette = {
  bg: '#18191D',
  bgDeep: '#121317',
  surface: '#22242A',
  surfaceHover: '#2A2C33',
  border: '#30323A',
  text: '#F4F5F7',
  textMuted: '#A4A7B0',
  brandFocus: '#FF7A5A',
} as const;

export const lightPalette = {
  bg: '#F5F6F8',
  bgDeep: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceHover: '#ECEEF2',
  border: '#E7E9EE',
  text: '#202127',
  textMuted: '#666A75',
  brandFocus: '#C93618',
} as const;

/**
 * The semantic layer, named the way frontend/css/tokens.css names it: the
 * surfaces a screen paints on, the lines between them, and the three steps of
 * text. --brand-soft, --brand-line and --selected are 13%, 42% and 16% of the
 * brand, which on the charcoal ground is the difference between an ember
 * accent and a page that shouts.
 */
export interface SemanticTheme {
  readonly appBg: string;
  readonly panel: string;
  readonly panel2: string;
  readonly panel3: string;
  readonly raised: string;
  readonly railBg: string;
  readonly line: string;
  readonly line2: string;
  readonly text1: string;
  readonly text2: string;
  readonly text3: string;
  readonly brand: string;
  readonly brandFill: string;
  readonly brandFillHover: string;
  readonly brandSoft: string;
  readonly brandLine: string;
  readonly selected: string;
  readonly hover: string;
  readonly active: string;
  readonly focus: string;
  readonly danger: string;
  readonly success: string;
  readonly warning: string;
  readonly info: string;
}

export const darkTheme: SemanticTheme = {
  appBg: '#121317',
  panel: '#18191D',
  panel2: '#1D1F24',
  panel3: '#22242A',
  raised: '#22242A',
  railBg: '#0E0F12',
  line: '#30323A',
  line2: '#3A3D46',
  text1: '#F4F5F7',
  text2: '#B9BDC7',
  text3: '#8F949F',
  brand: palette.brand,
  brandFill: palette.brandStrong,
  brandFillHover: palette.brand,
  brandSoft: 'rgba(255, 77, 36, 0.13)',
  brandLine: 'rgba(255, 77, 36, 0.42)',
  selected: 'rgba(255, 77, 36, 0.16)',
  hover: 'rgba(244, 245, 247, 0.06)',
  active: 'rgba(244, 245, 247, 0.10)',
  focus: palette.brandFocusDark,
  danger: palette.danger,
  success: palette.success,
  warning: palette.warning,
  info: palette.info,
};

export const lightTheme: SemanticTheme = {
  appBg: '#F1F2F5',
  panel: '#F7F8FA',
  panel2: '#FFFFFF',
  panel3: '#EDEFF3',
  raised: '#FFFFFF',
  railBg: '#E8EAEE',
  line: '#E4E6EB',
  line2: '#D3D6DD',
  text1: '#1D1E23',
  text2: '#4B5058',
  text3: '#666B78',
  brand: palette.brandStrong,
  brandFill: palette.brandStrong,
  brandFillHover: '#B02F14',
  brandSoft: 'rgba(201, 54, 24, 0.10)',
  brandLine: 'rgba(201, 54, 24, 0.38)',
  selected: 'rgba(201, 54, 24, 0.12)',
  hover: 'rgba(29, 30, 35, 0.05)',
  active: 'rgba(29, 30, 35, 0.09)',
  focus: '#B02F14',
  danger: '#B3261E',
  success: '#1B7A4E',
  warning: '#8A5A00',
  info: '#1F5FBF',
};

/** --tc-space-* : the spacing scale, in points. */
export const spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

/** --tc-radius-* : the corner radii, in points. */
export const radii = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  pill: 999,
} as const;

/**
 * --tc-font-sans and --tc-font-mono.
 *
 * Manrope is the product's typeface. On Android the system does not ship it,
 * so the name is the family and the platform falls back through
 * system-ui, and the app ships the file in assets/fonts on a release build.
 */
export const fonts = {
  sans: 'Manrope',
  sansFallback: 'System',
  mono: 'JetBrains Mono',
} as const;

/** The type scale, from frontend/css/tokens.css. */
export const typeScale = {
  h1: 23,
  h2: 18,
  h3: 16,
  body: 15,
  small: 14,
  meta: 13,
  micro: 12,
} as const;

export const fontWeights = {
  body: '450',
  medium: '550',
  strong: '650',
  bold: '750',
} as const;

export const tracking = {
  tight: -0.02,
  label: 0.11,
} as const;

/** --tc-motion-* : the two durations the interface uses. */
export const motion = {
  fast: 140,
  normal: 180,
} as const;

/**
 * The icon size, in points. The icon set is drawn on a 24 by 24 grid and
 * stroked, so one size reads correctly at every density.
 */
export const iconSize = 24;

/** The smallest comfortable touch target, in points. */
export const minTouchTarget = 44;

/** The height of a list row, matching the web client's --row-h for cozy. */
export const rowHeight = 44;

/** The width of the composer, matching --composer-max. */
export const composerMaxHeight = 300;
