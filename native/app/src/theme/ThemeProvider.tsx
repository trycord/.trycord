/**
 * The theme.
 *
 * The token values are the ones the web client uses, so the two applications
 * look like one product. The native client has no stylesheet, so the theme
 * is a plain object a component reads, and the theme provider picks the
 * charcoal ground or the daylight one from the system setting.
 */

import React, {createContext, useContext, useMemo} from 'react';
import {useColorScheme} from 'react-native';

import {
  composerMaxHeight,
  darkTheme,
  fonts,
  fontWeights,
  iconSize,
  lightTheme,
  minTouchTarget,
  motion,
  radii,
  rowHeight,
  SemanticTheme,
  spacing,
  tracking,
  typeScale,
} from '../design';

export interface Theme {
  semantic: SemanticTheme;
  spacing: typeof spacing;
  radii: typeof radii;
  fonts: typeof fonts;
  typeScale: typeof typeScale;
  fontWeights: typeof fontWeights;
  tracking: typeof tracking;
  motion: typeof motion;
  iconSize: number;
  minTouchTarget: number;
  rowHeight: number;
  composerMaxHeight: number;
  isDark: boolean;
}

const dark: Theme = {
  semantic: darkTheme,
  spacing,
  radii,
  fonts,
  typeScale,
  fontWeights,
  tracking,
  motion,
  iconSize,
  minTouchTarget,
  rowHeight,
  composerMaxHeight,
  isDark: true,
};

const light: Theme = {
  ...dark,
  semantic: lightTheme,
  isDark: false,
};

const ThemeContext = createContext<Theme>(dark);

export function ThemeProvider({children}: {children: React.ReactNode}): React.JSX.Element {
  const scheme = useColorScheme();
  const theme = useMemo(() => (scheme === 'light' ? light : dark), [scheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
