// The icon set.
//
// Every icon is a 24x24 stroke drawing that inherits currentColor, so a control
// colours its icon by setting its own colour and nothing else. A name that does
// not exist renders a neutral placeholder rather than nothing, because a missing
// icon that renders nothing is a button that looks empty and reads as broken.

import { svgEl } from './dom.js';

// A string is a path `d`. The object forms cover the handful of primitives that
// are not naturally a path.
const I = {
  home: ['M3 10.8 12 4l9 6.8', 'M5.5 9.6V20h13V9.6', 'M10 20v-5h4v5'],
  message: ['M20 12a8 8 0 0 1-8 8H8l-4 3v-3.6A8 8 0 1 1 20 12z'],
  bell: ['M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'],
  compass: [{ c: [12, 12, 9] }, 'M16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88z'],
  users: ['M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', { c: [9.5, 7, 4] }, 'M22 21v-2a4 4 0 0 0-3-3.87', 'M15.5 3.13a4 4 0 0 1 0 7.75'],
  menu: ['M3 6h18', 'M3 12h18', 'M3 18h18'],
  hash: ['M4 9h16', 'M4 15h16', 'M10.5 3 8.5 21', 'M15.5 3l-2 18'],
  volume: ['M11 5 6 9H3v6h6l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18.5 5.5a9 9 0 0 1 0 13'],
  'volume-off': ['M11 5 6 9H3v6h6l5 4z', 'M22 9l-6 6', 'M16 9l6 6'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z'],
  plus: ['M12 5v14', 'M5 12h14'],
  'plus-circle': [{ c: [12, 12, 9] }, 'M12 8v8', 'M8 12h8'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.35-4.35'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  check: ['M20 6 9 17l-5-5'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  'chevron-up': ['M6 15l6-6 6 6'],
  send: ['M22 2 11 13', 'M22 2l-7 20-4-9-9-4 20-7z'],
  smile: [{ c: [12, 12, 9] }, 'M8 14s1.5 2 4 2 4-2 4-2', 'M9 9h.01', 'M15 9h.01'],
  paperclip: ['M21.44 11.05 12.25 20.24a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 1 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 1 1-2.12-2.12l8.49-8.49'],
  reply: ['M9 17l-5-5 5-5', 'M20 18v-2a4 4 0 0 0-4-4H4'],
  pin: ['M12 17v5', 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'],
  'pin-off': ['M12 17v5', 'M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89', 'M2 2l20 20', 'M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11'],
  more: [{ c: [5, 12, 1.6] }, { c: [12, 12, 1.6] }, { c: [19, 12, 1.6] }],
  'more-vertical': [{ c: [12, 5, 1.6] }, { c: [12, 12, 1.6] }, { c: [12, 19, 1.6] }],
  edit: ['M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7', 'M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z'],
  trash: ['M3 6h18', 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6', 'M10 11v6', 'M14 11v6'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  'shield-check': ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 12l2 2 4-4'],
  mail: [{ r: [2, 4, 20, 16, 2] }, 'M22 6l-10 7L2 6'],
  'mail-open': ['M3 9l9-6 9 6v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M1 12l11 8 11-8'],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  rocket: ['M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z', 'M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z', 'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0', 'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5'],
  image: [{ r: [3, 3, 18, 18, 2] }, { c: [8.5, 8.5, 1.5] }, 'M21 15l-5-5L5 21'],
  layers: ['M12 2 2 7l10 5 10-5-10-5z', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5'],
  alert: ['M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  info: [{ c: [12, 12, 9] }, 'M12 16v-4', 'M12 8h.01'],
  help: [{ c: [12, 12, 9] }, 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
  lock: [{ r: [4, 11, 16, 10, 2] }, 'M8 11V7a4 4 0 0 1 8 0v4'],
  unlock: [{ r: [4, 11, 16, 10, 2] }, 'M8 11V7a4 4 0 0 1 7.6-1.8'],
  globe: [{ c: [12, 12, 9] }, 'M3 12h18', 'M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', { c: [12, 7, 4] }],
  'user-plus': ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', { c: [9, 7, 4] }, 'M19 8v6', 'M22 11h-6'],
  'user-minus': ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', { c: [9, 7, 4] }, 'M22 11h-6'],
  'user-cog': ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', { c: [12, 7, 4] }, { c: [19, 17, 2] }],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  login: ['M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4', 'M10 17l5-5-5-5', 'M15 12H3'],
  sun: [{ c: [12, 12, 4] }, 'M12 2v2', 'M12 20v2', 'M4.93 4.93l1.41 1.41', 'M17.66 17.66l1.41 1.41', 'M2 12h2', 'M20 12h2', 'M6.34 17.66l-1.41 1.41', 'M19.07 4.93l-1.41 1.41'],
  moon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'],
  monitor: [{ r: [2, 3, 20, 14, 2] }, 'M8 21h8', 'M12 17v4'],
  mic: ['M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
  'mic-off': ['M2 2l20 20', 'M9 9v3a3 3 0 0 0 5.12 2.12', 'M15 9.34V5a3 3 0 0 0-5.94-.6', 'M19 10v2a7 7 0 0 1-.11 1.23', 'M12 19v3', 'M5 10v2a7 7 0 0 0 12 0'],
  headphones: ['M3 18v-6a9 9 0 0 1 18 0v6', 'M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z', 'M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z'],
  'headphones-off': ['M3 18v-6a9 9 0 0 1 14.5-7.2', 'M21 12.3V18', 'M2 2l20 20', 'M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3', 'M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3'],
  phone: ['M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z'],
  'phone-off': ['M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67', 'M5 10a16 16 0 0 1-2.88-5.82A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72', 'M2 2l20 20'],
  camera: ['M23 7l-7 5 7 5V7z', { r: [1, 5, 15, 14, 2] }],
  'camera-off': ['M2 2l20 20', 'M23 7l-7 5 3 2.14', 'M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2', 'M9.5 5H14a2 2 0 0 1 2 2v.5'],
  screen: [{ r: [2, 3, 20, 12, 2] }, 'M8 21h8', 'M12 15v6', 'M9 12l3-3 3 3'],
  sparkle: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z'],
  refresh: ['M21 2v6h-6', 'M3 12a9 9 0 0 1 15-6.7L21 8', 'M3 22v-6h6', 'M21 12a9 9 0 0 1-15 6.7L3 16'],
  copy: [{ r: [9, 9, 12, 12, 2] }, 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  eye: ['M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z', { c: [12, 12, 3] }],
  'eye-off': ['M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94', 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19', 'M1 1l22 22', 'M14.12 14.12a3 3 0 1 1-4.24-4.24'],
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
  code: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'],
  server: [{ r: [2, 2, 20, 8, 2] }, { r: [2, 14, 20, 8, 2] }, 'M6 6h.01', 'M6 18h.01'],
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  key: [{ c: [7.5, 15.5, 3.5] }, 'M10 13 20 3', 'M17 6l2 2', 'M14 9l2 2'],
  database: ['M12 7a8 3 0 1 0 0-6 8 3 0 0 0 0 6z', 'M4 4v16c0 1.66 3.58 3 8 3s8-1.34 8-3V4', 'M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3'],
  external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14 21 3'],
  filter: ['M22 3H2l8 9.46V19l4 2v-8.54L22 3z'],
  thread: ['M21 11.5a8.5 8.5 0 0 1-8.5 8.5H8l-5 3 1.2-5.2A8.5 8.5 0 1 1 21 11.5z'],
  at: [{ c: [12, 12, 4] }, 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94'],
  crown: ['M2 18h20', 'M3 7l4 5 5-7 5 7 4-5-2 11H5L3 7z'],
  ban: [{ c: [12, 12, 9] }, 'M5.6 5.6l12.8 12.8'],
  clock: [{ c: [12, 12, 9] }, 'M12 7v5l3 2'],
  calendar: [{ r: [3, 4, 18, 18, 2] }, 'M16 2v4', 'M8 2v4', 'M3 10h18'],
  star: ['M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2z'],
  heart: ['M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z'],
  'thumbs-up': ['M7 10v12', 'M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z'],
  sidebar: [{ r: [3, 3, 18, 18, 2] }, 'M9 3v18'],
  'arrow-left': ['M19 12H5', 'M12 19l-7-7 7-7'],
  'arrow-right': ['M5 12h14', 'M12 5l7 7-7 7'],
  'arrow-up': ['M12 19V5', 'M5 12l7-7 7 7'],
  'arrow-down': ['M12 5v14', 'M19 12l-7 7-7-7'],
  'wifi-off': ['M2 2l20 20', 'M8.5 16.5a5 5 0 0 1 7 0', 'M5 12.55a11 11 0 0 1 5.17-2.39', 'M1.42 9a16 16 0 0 1 4.7-2.88', 'M10.71 5.05A16 16 0 0 1 22.58 9', 'M16.85 11.25a11 11 0 0 1 2.23 1.16', 'M12 20h.01'],
  loader: ['M12 2v4', 'M12 18v4', 'M4.93 4.93l2.83 2.83', 'M16.24 16.24l2.83 2.83', 'M2 12h4', 'M18 12h4', 'M4.93 19.07l2.83-2.83', 'M16.24 7.76l2.83-2.83'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
  bot: [{ r: [4, 8, 16, 12, 2] }, { c: [9, 14, 1.4] }, { c: [15, 14, 1.4] }, 'M12 8V4', 'M8 4h8'],
  zap: ['M13 2 3 14h9l-1 8 10-12h-9l1-8z'],
  gift: ['M20 12v10H4V12', { r: [2, 7, 20, 5, 1] }, 'M12 22V7', 'M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z', 'M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z'],
  chart: ['M3 3v18h18', 'M7 15l3-4 3 3 5-7'],
  database2: ['M12 7a8 3 0 1 0 0-6 8 3 0 0 0 0 6z'],
  maximize: ['M8 3H5a2 2 0 0 0-2 2v3', 'M18 3h3a2 2 0 0 1 2 2v3', 'M8 21H5a2 2 0 0 1-2-2v-3', 'M18 21h3a2 2 0 0 0 2-2v-3'],
  minimize: ['M4 9h3a2 2 0 0 0 2-2V4', 'M20 9h-3a2 2 0 0 1-2-2V4', 'M4 15h3a2 2 0 0 1 2 2v3', 'M20 15h-3a2 2 0 0 0-2 2v3'],
  'shield-alert': ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M12 8v4', 'M12 16h.01'],
  'message-square': ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  spark: ['M12 2c2 4 5 5 5 9a5 5 0 0 1-10 0c0-1.5.6-2.4 1.4-3.3-.3 2 .8 3.3 2.1 3.3 1.5 0 2-1.7 1.5-3.3C11 5.5 12 3.5 12 2z'],
  flame: ['M12 2c2 4 5 5 5 9a5 5 0 0 1-10 0c0-1.5.6-2.4 1.4-3.3-.3 2 .8 3.3 2.1 3.3 1.5 0 2-1.7 1.5-3.3C11 5.5 12 3.5 12 2z'],
  grid: [{ r: [3, 3, 7, 7, 1.5] }, { r: [14, 3, 7, 7, 1.5] }, { r: [14, 14, 7, 7, 1.5] }, { r: [3, 14, 7, 7, 1.5] }],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  'chevrons-up-down': ['M7 15l5 5 5-5', 'M7 9l5-5 5 5'],
  edit3: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z'],
  slash: ['M4 20 20 4'],
  'circle-dot': [{ c: [12, 12, 9] }, { c: [12, 12, 3] }],
};

// Names that are aliases of another icon, so a view can ask for the word that
// reads best without the registry carrying two copies of the same shape.
const ALIASES = {
  chat: 'message',
  dm: 'message',
  warning: 'alert',
  warn: 'alert',
  cog: 'settings',
  gear: 'settings',
  close: 'x',
  search2: 'search',
  add: 'plus',
  check2: 'check',
  dots: 'more',
  'more-vertical-dots': 'more',
  pencil: 'edit',
  bin: 'trash',
  shield2: 'shield',
  mail2: 'mail',
  'external-link': 'external',
  'panel-left': 'sidebar',
  mic2: 'mic',
  speaker: 'volume',
  tag: 'hash',
  bookmark: 'pin',
};

// The registry is the shapes plus every alias, resolved once. A name that is
// only an alias still answers, which is what lets a view ask for the word that
// reads best at its call site.
const REGISTRY = new Map();
for (const key of Object.keys(I)) REGISTRY.set(key, I[key]);
for (const key of Object.keys(ALIASES)) {
  const target = I[ALIASES[key]];
  if (target) REGISTRY.set(key, target);
}

export function hasIcon(name) {
  return REGISTRY.has(name);
}

export function icon(name, options) {
  const opts = options || {};
  const size = opts.size || 20;
  const children = REGISTRY.get(name) || REGISTRY.get(opts.fallback || 'info') || I.info;
  const root = svgEl('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': opts.weight || 1.75,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: opts.class,
  });
  for (const item of children) {
    root.appendChild(shape(item));
  }
  return root;
}

function shape(item) {
  if (typeof item === 'string') return svgEl('path', { d: item });
  if (item.c) return svgEl('circle', { cx: item.c[0], cy: item.c[1], r: item.c[2] });
  if (item.r) return svgEl('rect', { x: item.r[0], y: item.r[1], width: item.r[2], height: item.r[3], rx: item.r[4] });
  if (item.l) return svgEl('line', { x1: item.l[0], y1: item.l[1], x2: item.l[2], y2: item.l[3] });
  return null;
}

export default icon;
