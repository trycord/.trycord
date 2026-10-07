// Theming.
//
// One file used to hold five jobs, including the one that decides what a user is allowed
// to put in a custom stylesheet. That decision is a security boundary and it was sitting
// between the palette maths and the sheet that installs the result, where nothing about
// its position suggested it:
//
//   theme/registry.js  the theme list, resolving and applying one, the OS watcher
//   theme/palette.js   custom token definitions and the palette, applied as inline
//                      properties on the document element
//   theme/css.js       validating a custom stylesheet - a pure function from text to
//                      verdict, holding the forbidden-property list and the protected
//                      selectors
//   theme/custom.js    installing a custom stylesheet, checking afterwards that it did
//                      not hide the composer, and the recovery path
//
// The dependency runs one way. css.js knows nothing but CSS. palette.js knows nothing
// about stylesheets. custom.js needs the palette, because a custom sheet sits on top of
// the custom tokens, and needs the recovery fallback, because applying a stylesheet is the
// one theming operation that can lock someone out of their own app. registry.js needs
// custom.js only to apply a custom theme, which is why setTheme can take one.
//
// The export surface below is the 23 names this file had before the split, exactly. A
// split that quietly narrowed or widened what callers can reach would be a different
// change from the one that was asked for.

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
