/* ============================================================
   INCREMENTAL READING — Icon set
   24x24 line icons (currentColor stroke). Shared by DS page + app.
   ============================================================ */
window.IR_ICONS = {
  // --- nav ---
  queue: '<path d="M3 5h13M3 10h13M3 15h8"/><path d="M19 13l2 2-2 2"/>',
  inbox: '<path d="M4 13h4l1.5 2.5h5L16 13h4"/><path d="M4 13l2-7h12l2 7v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>',
  library: '<path d="M5 4h4v16H5zM10 4h4v16h-4z"/><path d="M16.5 4.5l3 .8-3.5 14.5-3-.8z"/>',
  review: '<path d="M4 8a8 8 0 0 1 14-4l2 2"/><path d="M20 4v4h-4"/><path d="M20 16a8 8 0 0 1-14 4l-2-2"/><path d="M4 20v-4h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  concepts: '<circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="16" cy="17" r="2.2"/><circle cx="7" cy="17" r="2.2"/><path d="M8 8l8-1M8 16l6 0M7 9v6M16 8l0 7"/>',
  analytics: '<path d="M4 20V10M9 20V4M14 20v-6M19 20V8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 2.6 14H2.5a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 4 7.6l-.1-.2a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 5h.1A1.6 1.6 0 0 0 10 3.5V3.4a2 2 0 0 1 4 0v.1A1.6 1.6 0 0 0 17 5a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.1a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',

  // --- element types ---
  source: '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><path d="M8 12h7M8 16h7M8 9h3"/>',
  extract: '<path d="M7 8c-1.5 0-2.5 1-2.5 2.5S5.5 13 7 13c0 1.5-.5 2.5-2 3.2"/><path d="M16 8c-1.5 0-2.5 1-2.5 2.5S14.5 13 16 13c0 1.5-.5 2.5-2 3.2"/>',
  card: '<rect x="3" y="6" width="14" height="12" rx="1.5"/><path d="M7 3h12a1 1 0 0 1 1 1v11"/><path d="M6 10h8M6 13h5"/>',
  task: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8.5 12 2.2 2.2L16 9"/>',
  concept: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="4" r="1.6"/><circle cx="20" cy="16" r="1.6"/><circle cx="4" cy="16" r="1.6"/><path d="M12 7v2M14.4 13.4l3.2 1.8M9.6 13.4l-3.2 1.8"/>',
  media: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/>',

  // --- actions ---
  highlight: '<path d="M3 21h6"/><path d="M14 4l6 6-9 9-6 0 0-4z"/><path d="M11 7l6 6"/>',
  cloze: '<path d="M8 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3"/><path d="M16 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>',
  split: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3M12 3v18"/>',
  trim: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7l12 10M8 17 20 7"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  postpone: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.5M9 3h6M12 5.5V3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.5 2.5L16 9"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  bookmark: '<path d="M6 4h12v16l-6-4-6 4z"/>',
  edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="m14 6 4 4"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  leech: '<path d="M12 8a4 4 0 0 1 4 4v3a4 4 0 0 1-8 0v-3a4 4 0 0 1 4-4z"/><path d="M9 9 7 7M15 9l2-2M8 13H4M20 13h-4M8.5 17l-2.5 2M15.5 17l2.5 2M10 6.5 12 4l2 2.5"/>',
  context: '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2z"/><path d="M12 8v6M9 11h6"/>',
  merge: '<path d="M7 21V9a4 4 0 0 0 4 4h2a4 4 0 0 1 4 4v4M7 3v2M17 17v4M5 7l2-2 2 2"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  star: '<path d="m12 3 2.6 5.7 6.4.7-4.8 4.3 1.3 6.3-5.5-3.2-5.5 3.2 1.3-6.3L3 9.4l6.4-.7z"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
  return: '<path d="M9 10 5 14l4 4"/><path d="M5 14h11a3 3 0 0 0 3-3V6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
  moon: '<path d="M20 14a8 8 0 1 1-9-11 6 6 0 0 0 9 11z"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/>',
  link: '<path d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 2.5 14 0 17M12 3.5c-2.5 2.5-2.5 14 0 17"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  warning: '<path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17.5v.1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.1"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3"/>',
  paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1H9z"/><path d="M9 11h6M9 15h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sparkle: '<path d="M12 3v4M12 17v4M5 12H3M21 12h-2M6 6l1.5 1.5M16.5 16.5 18 18M18 6l-1.5 1.5M7.5 16.5 6 18"/><circle cx="12" cy="12" r="3"/>',
  grip: '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
  text: '<path d="M5 6h14M5 6V4h14v2M12 6v14M9 20h6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5M3 17l9 5 9-5"/>',
  flame: '<path d="M12 3s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3 1-3s0 2 1.5 2C12 11 10 8 12 3z"/>',
  zap: '<path d="M13 3 4 14h6l-1 7 9-11h-6z"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/><path d="m9.5 12 2 2 3.5-4"/>',
  pin: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v5"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
  hourglass: '<path d="M7 3h10M7 21h10M8 3c0 4 8 5 8 9s-8 5-8 9M16 3c0 4-8 5-8 9"/>',
  dup: '<rect x="4" y="4" width="11" height="11" rx="1.5"/><path d="M9 19h9a1 1 0 0 0 1-1V9" stroke-dasharray="2.5 2.5"/>',
  topic: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  synthesis: '<path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v5h5"/><path d="M8 13l2 2 4-4" stroke-dasharray="0"/><path d="M8 17h5"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10h-3"/>',
  restore: '<path d="M3 8a9 9 0 1 1-1 4"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-5"/><circle cx="12" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  brain: '<path d="M9 4a2.5 2.5 0 0 0-2.5 2.5A2.5 2.5 0 0 0 5 11a2.5 2.5 0 0 0 1.5 4.5A2.5 2.5 0 0 0 9 20c1.4 0 2.5-1 2.5-2.5V6.5C11.5 5 10.4 4 9 4z"/><path d="M15 4a2.5 2.5 0 0 1 2.5 2.5A2.5 2.5 0 0 1 19 11a2.5 2.5 0 0 1-1.5 4.5A2.5 2.5 0 0 1 15 20c-1.4 0-2.5-1-2.5-2.5"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  pause2: '<circle cx="12" cy="12" r="8.5"/><path d="M10 9.5v5M14 9.5v5"/>',
  download: '<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19h14"/>',
  treeBranch: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M8 6h6a2 2 0 0 1 2 2v2M8 18h6a2 2 0 0 0 2-2v-2"/>',
};

// React helper (only used when React present)
window.Icon = function Icon(props) {
  var name = props.name, size = props.size || 16, cls = props.className || '', style = props.style || {};
  var inner = window.IR_ICONS[name] || '';
  return React.createElement('svg', {
    className: 'icn ' + cls, width: size, height: size, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
    strokeLinejoin: 'round', style: style, dangerouslySetInnerHTML: { __html: inner }
  });
};

// Vanilla helper for the design-system page
window.iconSvg = function (name, size) {
  size = size || 16;
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (window.IR_ICONS[name] || '') + '</svg>';
};
