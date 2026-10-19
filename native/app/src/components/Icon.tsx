/**
 * The icon set.
 *
 * Every icon is a 24 by 24 stroke drawing that takes its colour from the
 * control that holds it, so a button colours its icon by setting its own
 * colour and nothing else. The shapes are the ones the web client draws -
 * the same Lucide-style vocabulary - so the two applications speak the same
 * iconography.
 *
 * The icons are decorative. A control that carries an icon also carries a
 * label, and the label is what a screen reader reads.
 */

import React from 'react';
import Svg, {Circle, Path, Rect} from 'react-native-svg';

import {useTheme} from '../theme';

export type IconShape =
  | {kind: 'path'; d: string}
  | {kind: 'circle'; cx: number; cy: number; r: number}
  | {kind: 'rect'; x: number; y: number; width: number; height: number; rx: number};

const circle = (cx: number, cy: number, r: number): IconShape => ({
  kind: 'circle',
  cx,
  cy,
  r,
});
const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
  rx: number,
): IconShape => ({kind: 'rect', x, y, width, height, rx});
const path = (d: string): IconShape => ({kind: 'path', d});

export const ICONS: Record<string, IconShape[]> = {
  home: [
    path('M3 10.8 12 4l9 6.8'),
    path('M5.5 9.6V20h13V9.6'),
    path('M10 20v-5h4v5'),
  ],
  message: [path('M20 12a8 8 0 0 1-8 8H8l-4 3v-3.6A8 8 0 1 1 20 12z')],
  bell: [
    path('M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9'),
    path('M13.7 21a2 2 0 1 1-3.4 0'),
  ],
  users: [
    path('M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'),
    circle(9.5, 7, 4),
    path('M22 21v-2a4 4 0 0 0-3-3.87'),
    path('M15.5 3.13a4 4 0 0 1 0 7.75'),
  ],
  hash: [
    path('M4 9h16'),
    path('M4 15h16'),
    path('M10.5 3 8.5 21'),
    path('M15.5 3l-2 18'),
  ],
  settings: [
    path(
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    ),
    path(
      'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z',
    ),
  ],
  plus: [path('M12 5v14'), path('M5 12h14')],
  search: [
    path('M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z'),
    path('M21 21l-4.35-4.35'),
  ],
  x: [path('M18 6 6 18'), path('M6 6l12 12')],
  check: [path('M20 6 9 17l-5-5')],
  'chevron-down': [path('M6 9l6 6 6-6')],
  'chevron-up': [path('M6 15l6-6 6 6')],
  'chevron-left': [path('M15 6l-6 6 6 6')],
  'chevron-right': [path('M9 6l6 6-6 6')],
  send: [path('M22 2 11 13'), path('M22 2l-7 20-4-9-9-4 20-7z')],
  smile: [
    circle(12, 12, 9),
    path('M8 14s1.5 2 4 2 4-2 4-2'),
    path('M9 9h.01'),
    path('M15 9h.01'),
  ],
  paperclip: [
    path(
      'M21.44 11.05 12.25 20.24a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 1 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 1 1-2.12-2.12l8.49-8.49',
    ),
  ],
  reply: [path('M9 17l-5-5 5-5'), path('M20 18v-2a4 4 0 0 0-4-4H4')],
  pin: [
    path('M12 17v5'),
    path(
      'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 0 15 10.76V7a2 2 0 0 0-1-1 2 2 0 0 1 1-2 2 2 0 0 0-2-2H8a2 2 0 0 0-2 2 2 2 0 0 0 1 2 2 2 0 0 0-1 1v3.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 2 15.24V16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 0 12 10.76z',
    ),
  ],
  'more-vertical': [circle(12, 5, 1.6), circle(12, 12, 1.6), circle(12, 19, 1.6)],
  edit: [
    path('M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7'),
    path('M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z'),
  ],
  trash: [
    path('M3 6h18'),
    path('M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2'),
    path('M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'),
    path('M10 11v6'),
    path('M14 11v6'),
  ],
  shield: [path('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z')],
  mail: [rect(2, 4, 20, 16, 2), path('M22 6l-10 7L2 6')],
  lock: [rect(4, 11, 16, 10, 2), path('M8 11V7a4 4 0 0 1 8 0v4')],
  unlock: [rect(4, 11, 16, 10, 2), path('M8 11V7a4 4 0 0 1 7.6-1.8')],
  globe: [circle(12, 12, 9), path('M3 12h18'), path('M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z')],
  user: [path('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'), circle(12, 7, 4)],
  'user-plus': [
    path('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'),
    circle(9, 7, 4),
    path('M19 8v6'),
    path('M22 11h-6'),
  ],
  'user-cog': [
    path('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'),
    circle(12, 7, 4),
    circle(19, 17, 2),
  ],
  logout: [path('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), path('M16 17l5-5-5-5'), path('M21 12H9')],
  moon: [path('M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z')],
  sun: [
    circle(12, 12, 4),
    path('M12 2v2'),
    path('M12 20v2'),
    path('M4.93 4.93l1.41 1.41'),
    path('M17.66 17.66l1.41 1.41'),
    path('M2 12h2'),
    path('M20 12h2'),
    path('M6.34 17.66l-1.41 1.41'),
    path('M19.07 4.93l-1.41 1.41'),
  ],
  info: [circle(12, 12, 9), path('M12 16v-4'), path('M12 8h.01')],
  alert: [
    path(
      'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
    ),
    path('M12 9v4'),
    path('M12 17h.01'),
  ],
  help: [circle(12, 12, 9), path('M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3'), path('M12 17h.01')],
  link: [
    path('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'),
    path('M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'),
  ],
  copy: [rect(9, 9, 12, 12, 2), path('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')],
  server: [rect(2, 2, 20, 8, 2), rect(2, 14, 20, 8, 2), path('M6 6h.01'), path('M6 18h.01')],
  layers: [
    path('M12 2 2 7l10 5 10-5-10-5z'),
    path('M2 17l10 5 10-5'),
    path('M2 12l10 5 10-5'),
  ],
  eye: [path('M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z'), circle(12, 12, 3)],
  'eye-off': [
    path('M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94'),
    path('M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19'),
    path('M1 1l22 22'),
    path('M14.12 14.12a3 3 0 1 1-4.24-4.24'),
  ],
  clock: [circle(12, 12, 9), path('M12 7v5l3 2')],
  star: [
    path('M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2z'),
  ],
  at: [circle(12, 12, 4), path('M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94')],
  thread: [path('M21 11.5a8.5 8.5 0 0 1-8.5 8.5H8l-5 3 1.2-5.2A8.5 8.5 0 1 1 21 11.5z')],
  file: [path('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'), path('M14 2v6h6')],
  image: [rect(3, 3, 18, 18, 2), circle(8.5, 8.5, 1.5), path('M21 15l-5-5L5 21')],
  refresh: [
    path('M21 2v6h-6'),
    path('M3 12a9 9 0 0 1 15-6.7L21 8'),
    path('M3 22v-6h6'),
    path('M21 12a9 9 0 0 1-15 6.7L3 16'),
  ],
  'wifi-off': [
    path('M2 2l20 20'),
    path('M8.5 16.5a5 5 0 0 1 7 0'),
    path('M5 12.55a11 11 0 0 1 5.17-2.39'),
    path('M1.42 9a16 16 0 0 1 4.7-2.88'),
    path('M10.71 5.05A16 16 0 0 1 22.58 9'),
    path('M16.85 11.25a11 11 0 0 1 2.23 1.16'),
    path('M12 20h.01'),
  ],
  loader: [
    path('M12 2v4'),
    path('M12 18v4'),
    path('M4.93 4.93l2.83 2.83'),
    path('M16.24 16.24l2.83 2.83'),
    path('M2 12h4'),
    path('M18 12h4'),
    path('M4.93 19.07l2.83-2.83'),
    path('M16.24 7.76l2.83-2.83'),
  ],
  key: [circle(7.5, 15.5, 3.5), path('M10 13 20 3'), path('M17 6l2 2'), path('M14 9l2 2')],
  flame: [
    path('M12 2c2 4 5 5 5 9a5 5 0 0 1-10 0c0-1.5.6-2.4 1.4-3.3-.3 2 .8 3.3 2.1 3.3 1.5 0 2-1.7 1.5-3.3C11 5.5 12 3.5 12 2z'),
  ],
  crown: [
    path('M2 18h20'),
    path('M3 7l4 5 5-7 5 7 4-5-2 11H5L3 7z'),
  ],
  ban: [circle(12, 12, 9), path('M5.6 5.6l12.8 12.8')],
  activity: [path('M22 12h-4l-3 9L9 3l-3 9H2')],
  zap: [path('M13 2 3 14h9l-1 8 10-12h-9l1-8z')],
  gift: [
    path('M20 12v10H4V12'),
    rect(2, 7, 20, 5, 1),
    path('M12 22V7'),
    path('M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z'),
    path('M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z'),
  ],
};

/** The names the icon set answers to. */
export type IconName = keyof typeof ICONS | string;

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  weight?: number;
}

export function Icon({name, size = 24, color, weight = 1.75}: IconProps): React.JSX.Element {
  const theme = useTheme();
  const tint = color ?? theme.semantic.text1;
  const shapes = ICONS[name] ?? ICONS.info;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={tint}
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessible={false}
      importantForAccessibility="no">
      {shapes.map((shape, index) => {
        if (shape.kind === 'circle') {
          return (
            <Circle
              key={`c${index}`}
              cx={shape.cx}
              cy={shape.cy}
              r={shape.r}
            />
          );
        }
        if (shape.kind === 'rect') {
          return (
            <Rect
              key={`r${index}`}
              x={shape.x}
              y={shape.y}
              width={shape.width}
              height={shape.height}
              rx={shape.rx}
            />
          );
        }
        return <Path key={`p${index}`} d={shape.d} />;
      })}
    </Svg>
  );
}
