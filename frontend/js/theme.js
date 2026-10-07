// Theming. The engine is under theme/; this is the surface everything imports.
//
//   theme/registry.js  the theme list, resolving and applying one, the OS watcher
//   theme/palette.js   custom token definitions, applied as inline properties on <html>
//   theme/css.js       validating a custom stylesheet. The security boundary.
//   theme/custom.js    installing it, and the recovery path if it hides the composer

import {
  DEFAULT_THEME,
  THEMES,
  getTheme,
  resolveTheme,
  applyTheme,
  setTheme,
  watchSystemTheme,
} from './theme/registry.js';

import {
  CUSTOM_TOKEN_DEFS,
  DEFAULT_CUSTOM_TOKENS,
  applyCustomPalette,
  clearCustomInline,
  loadCustomTheme,
  loadPalette,
  parseCustomTheme,
  saveCustomTheme,
  savePalette,
  serializeCustomTheme,
} from './theme/palette.js';

import { validateCustomCss } from './theme/css.js';

import {
  applyCustomCss,
  applyCustomTheme,
  clearCustomCss,
  recoverToEmber,
  verifyCustomSafety,
} from './theme/custom.js';

export {
  DEFAULT_THEME,
  THEMES,
  getTheme,
  resolveTheme,
  applyTheme,
  setTheme,
  watchSystemTheme,
  CUSTOM_TOKEN_DEFS,
  DEFAULT_CUSTOM_TOKENS,
  applyCustomPalette,
  clearCustomInline,
  loadCustomTheme,
  loadPalette,
  parseCustomTheme,
  saveCustomTheme,
  savePalette,
  serializeCustomTheme,
  validateCustomCss,
  applyCustomCss,
  applyCustomTheme,
  clearCustomCss,
  recoverToEmber,
  verifyCustomSafety,
};

// The default export predates the split and is kept as it was, including the
// `buildCustom` alias for applyCustomPalette. Callers use both names for the same call.
export default {
  getTheme, applyTheme, setTheme, loadPalette, savePalette,
  buildCustom: applyCustomPalette, loadCustomTheme, saveCustomTheme,
  serializeCustomTheme, parseCustomTheme, validateCustomCss, applyCustomCss,
  clearCustomCss, verifyCustomSafety, recoverToEmber, applyCustomTheme,
  CUSTOM_TOKEN_DEFS, DEFAULT_CUSTOM_TOKENS,
};
