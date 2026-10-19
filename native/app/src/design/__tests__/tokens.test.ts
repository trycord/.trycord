/**
 * The design tokens.
 *
 * The values are copied from the web client's stylesheets, so the two
 * applications look like one product. These tests hold the values in place:
 * a palette that drifts is a product that stops being one.
 */

import {
  composerMaxHeight,
  darkPalette,
  darkTheme,
  fonts,
  fontWeights,
  iconSize,
  lightPalette,
  lightTheme,
  minTouchTarget,
  motion,
  palette,
  radii,
  rowHeight,
  spacing,
  tracking,
  typeScale,
} from '../tokens';

describe('the design tokens', () => {
  it('carries the flame orange', () => {
    expect(palette.brand).toBe('#FF4D24');
    expect(palette.brandHover).toBe('#E9431D');
    expect(palette.brandStrong).toBe('#C93618');
  });

  it('carries the charcoal foundation', () => {
    expect(darkPalette.bg).toBe('#18191D');
    expect(darkPalette.bgDeep).toBe('#121317');
    expect(darkPalette.surface).toBe('#22242A');
    expect(darkPalette.surfaceHover).toBe('#2A2C33');
    expect(darkPalette.border).toBe('#30323A');
    expect(darkPalette.text).toBe('#F4F5F7');
    expect(darkPalette.textMuted).toBe('#A4A7B0');
  });

  it('carries the daylight palette', () => {
    expect(lightPalette.bg).toBe('#F5F6F8');
    expect(lightPalette.bgDeep).toBe('#FFFFFF');
    expect(lightPalette.surface).toBe('#FFFFFF');
    expect(lightPalette.border).toBe('#E7E9EE');
    expect(lightPalette.text).toBe('#202127');
    expect(lightPalette.textMuted).toBe('#666A75');
  });

  it('carries the state colours', () => {
    expect(palette.success).toBe('#35B875');
    expect(palette.warning).toBe('#F2B84B');
    expect(palette.danger).toBe('#EF5350');
    expect(palette.info).toBe('#5798F5');
  });

  it('uses Manrope', () => {
    expect(fonts.sans).toBe('Manrope');
    expect(fonts.mono).toBe('JetBrains Mono');
  });

  it('carries the spacing scale', () => {
    expect(spacing[1]).toBe(4);
    expect(spacing[2]).toBe(8);
    expect(spacing[3]).toBe(12);
    expect(spacing[4]).toBe(16);
    expect(spacing[5]).toBe(20);
    expect(spacing[6]).toBe(24);
    expect(spacing[8]).toBe(32);
    expect(spacing[10]).toBe(40);
    expect(spacing[12]).toBe(48);
  });

  it('carries the corner radii', () => {
    expect(radii.sm).toBe(4);
    expect(radii.md).toBe(8);
    expect(radii.lg).toBe(12);
    expect(radii.xl).toBe(16);
    expect(radii.pill).toBe(999);
  });

  it('carries the type scale and the weights', () => {
    expect(typeScale.body).toBe(15);
    expect(typeScale.meta).toBe(13);
    expect(fontWeights.body).toBe('450');
    expect(fontWeights.strong).toBe('650');
    expect(tracking.tight).toBe(-0.02);
  });

  it('draws the icons on a 24 point grid', () => {
    expect(iconSize).toBe(24);
  });

  it('keeps a control big enough to hit', () => {
    expect(minTouchTarget).toBeGreaterThanOrEqual(44);
    expect(rowHeight).toBeGreaterThanOrEqual(44);
  });

  it('carries the two durations the interface uses', () => {
    expect(motion.fast).toBe(140);
    expect(motion.normal).toBe(180);
    expect(composerMaxHeight).toBe(300);
  });

  it('paints the dark theme on charcoal with the ember accent', () => {
    expect(darkTheme.appBg).toBe('#121317');
    expect(darkTheme.panel).toBe('#18191D');
    expect(darkTheme.brand).toBe('#FF4D24');
    expect(darkTheme.brandFill).toBe('#C93618');
    expect(darkTheme.text1).toBe('#F4F5F7');
  });

  it('paints the light theme on daylight', () => {
    expect(lightTheme.appBg).toBe('#F1F2F5');
    expect(lightTheme.panel).toBe('#F7F8FA');
    expect(lightTheme.brand).toBe('#C93618');
    expect(lightTheme.text1).toBe('#1D1E23');
  });
});
