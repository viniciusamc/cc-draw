/*
 * cc-draw canvas — the real Excalidraw, running inside a transparent iframe laid
 * over the page. Talks to the overlay (parent page) via postMessage.
 *
 * Coordinates: Excalidraw scene == page document coordinates (CSS px).
 * Zoom is locked at 1 and Excalidraw's scroll is always -(page scroll).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  Excalidraw,
  MainMenu,
  Button,
  CaptureUpdateAction,
  exportToCanvas,
  getCommonBounds,
  hashElementsVersion,
  newElementWith,
  restoreElements,
  setCustomTextMetricsProvider,
  FONT_FAMILY,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import './canvas.css';

// Excalidraw's default text measurer reuses a single <canvas>; in Chrome that context keeps the
// fallback font it resolved before Excalifont loaded, so every text gets the wrong (too narrow,
// clipped) width. Here the context is recreated whenever a font finishes loading.
let measureCtx = null;
document.fonts.addEventListener('loadingdone', () => { measureCtx = null; });
setCustomTextMetricsProvider({
  getLineWidth(text, font) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  },
});

const SOURCE = 'cc-draw';
const STROKE = '#e03131';
const EXPORT_PADDING = 10;
const CHANGE_DEBOUNCE = 150;
const INSPECT_KEY = 'w';
const embedded = window.parent !== window;

const post = (type, data = {}) => {
  if (embedded) window.parent.postMessage({ source: SOURCE, type, ...data }, location.origin);
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const isField = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const newId = () => 'od-' + (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36));
const isInspectTool = (tool) => tool?.type === 'custom' && tool.customType === 'inspect';

// ---------------------------------------------------------------------------------------------
// Excalidraw features cc-draw doesn't use (frame, embed, laser, mermaid/AI, command palette,
// zoom, zen/view mode/grid/snap/stats/theme, save/open/export, library…).
// 0.18 has no API to remove them; the buttons are hidden via CSS and the shortcuts are swallowed here.
// This listener is registered BEFORE Excalidraw mounts, so it runs before Excalidraw's own listeners
// (including the command palette's, which is also a capture listener on window).
// ---------------------------------------------------------------------------------------------
function isBlockedShortcut(e) {
  const mod = e.ctrlKey || e.metaKey;
  const k = (e.key || '').toLowerCase();
  const c = e.code;
  if (!mod && !e.altKey) {
    if (k === 'f' || k === 'k') return true;                 // frame (F), laser (K), font picker (Shift+F)
    if (!e.shiftKey && k === 'g') return true;               // background color picker
    if (!e.shiftKey && (c === 'Digit9' || c === 'Numpad9')) return true; // image
    if (e.shiftKey && /^(Digit[0-3]|Equal|Minus|NumpadAdd|NumpadSubtract|Numpad0)$/.test(c)) return true; // zoom
    return false;
  }
  if (mod && !e.altKey) {
    if (k === '/' || c === 'Slash' || (e.shiftKey && k === 'p')) return true; // command palette
    if (!e.shiftKey && k === 'f') return true;               // search
    if (c === 'Quote') return true;                          // grid
    if (k === 's' || k === 'o') return true;                 // save / open
    if (e.shiftKey && k === 'e') return true;                // export image
    if (/^(Equal|Minus|Digit0|NumpadAdd|NumpadSubtract|Numpad0)$/.test(c)) return true; // zoom
    if (k === 'delete' || k === 'backspace') return true;    // clear canvas
    return false;
  }
  if (e.altKey && !mod) {
    if (!e.shiftKey && /^(KeyZ|KeyR|KeyS|Slash)$/.test(c)) return true; // zen, view mode, snap, stats
    if (e.shiftKey && c === 'KeyC') return true;             // copy as PNG
  }
  return false;
}
window.addEventListener('keydown', (e) => {
  if (isField(e.target) || isField(document.activeElement)) return; // typing: nothing is blocked
  if (!isBlockedShortcut(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

// context menu items (data-testid = action name) that make no sense here
const HIDDEN_ACTIONS = new Set([
  'gridMode', 'zenMode', 'viewMode', 'objectsSnapMode', 'stats', 'toggleTheme', 'changeViewBackgroundColor',
  'clearCanvas', 'copyAsPng', 'copyAsSvg', 'addToLibrary', 'wrapSelectionInFrame', 'selectAllElementsInFrame',
  'removeAllElementsFromFrame', 'updateFrameRendering', 'setFrameAsActiveTool', 'copyElementLink', 'linkToElement',
  'searchMenu', 'commandPalette', 'saveToActiveFile', 'saveFileToDisk', 'loadScene', 'cropEditor',
  'zoomIn', 'zoomOut', 'resetZoom', 'zoomToFit', 'zoomToFitSelection', 'zoomToFitSelectionInViewport',
]);
// help dialog rows of removed features, matched by their keys (key labels aren't translated)
const HIDDEN_HELP = new Set([
  'F', 'K', '9', 'G', 'Shift+F', 'Ctrl++', 'Ctrl+-', 'Ctrl+0', 'Shift+1', 'Shift+2', 'Shift+3', 'Alt+Z', 'Alt+S',
  "Ctrl+'", 'Alt+R', 'Alt+Shift+D', 'Alt+/', 'Ctrl+F', 'Ctrl+/+Ctrl+Shift+P', 'Shift+Alt+C', 'Ctrl+Delete',
]);
const hide = (el, on = true) => (on ? el.setAttribute('data-over-hidden', '') : el.removeAttribute('data-over-hidden'));

// "Interact with the page" mode (hand tool): the parent sets the iframe to pointer-events:none and only
// switches it back on while the pointer is over these Excalidraw UI "islands".
const HAND_LABEL = 'Interact with the page';
const HAND_TITLE = `${HAND_LABEL} — H`;
const UI_ISLANDS = [
  '.App-toolbar', '.App-toolbar-content', '.mobile-misc-tools-container', '.over-actions',
  '.App-menu__left', '.App-bottom-bar', '.undo-redo-buttons', '.help-icon',
  '.popover', '[data-radix-popper-content-wrapper]', '.dropdown-menu', '.context-menu',
  '.excalidraw-modal-container', '.Modal', '.color-picker-content',
].join(',');
const isUiTarget = (t) => t instanceof Element && !!t.closest(UI_ISLANDS);
function uiIslands() {
  return [...document.querySelectorAll(UI_ISLANDS)].filter((el) => !el.closest('[data-over-hidden]'));
}
function uiRects(islands = uiIslands()) {
  const rects = [];
  for (const el of islands) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === 'hidden') continue;
    const x = Math.floor(r.left);
    const y = Math.floor(r.top);
    rects.push({ x, y, w: Math.ceil(r.right) - x, h: Math.ceil(r.bottom) - y });
  }
  return rects;
}

function tidySeparators(menu) {
  let pending = null;
  let seenItem = false;
  for (const child of menu.children) {
    if (child.tagName === 'HR') {
      if (!seenItem || pending) hide(child);
      else { hide(child, false); pending = child; }
      continue;
    }
    if (child.hasAttribute('data-over-hidden')) continue;
    seenItem = true;
    pending = null;
  }
  if (pending) hide(pending);
}

function scrubUI() {
  for (const li of document.querySelectorAll('.context-menu li[data-testid]:not([data-over-seen])')) {
    li.setAttribute('data-over-seen', '');
    if (HIDDEN_ACTIONS.has(li.dataset.testid)) hide(li);
  }
  for (const menu of document.querySelectorAll('.context-menu')) tidySeparators(menu);
  for (const row of document.querySelectorAll('.HelpDialog__shortcut:not([data-over-seen])')) {
    row.setAttribute('data-over-seen', '');
    const keys = [...row.querySelectorAll('kbd')].map((k) => k.textContent.trim()).join('+')
      .replace(/⌘/g, 'Ctrl').replace(/⌥/g, 'Alt').replace(/⇧/g, 'Shift');
    if (HIDDEN_HELP.has(keys)) hide(row);
  }
  // hand tool = "interact with the page"
  const hand = document.querySelector('[data-testid="toolbar-hand"]');
  if (hand) {
    const label = hand.closest('label');
    if (label && label.title !== HAND_TITLE) label.title = HAND_TITLE;
    if (hand.getAttribute('aria-label') !== HAND_LABEL) hand.setAttribute('aria-label', HAND_LABEL);
  }
  // mobile bottom bar: remove duplicate/delete (the desktop panel's "actions" row).
  // The duplicate button's title always ends with its (untranslated) shortcut; delete comes right after.
  for (const bar of document.querySelectorAll('.App-bottom-bar')) {
    const dup = [...bar.querySelectorAll('button.ToolIcon[title]')].find((b) => /(Ctrl\+D|⌘D)$/.test(b.title.trim()));
    if (!dup) continue;
    hide(dup);
    const del = dup.nextElementSibling;
    if (del?.matches('button.ToolIcon')) hide(del);
  }
}

// ---------------------------------------------------------------------------------------------
const UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false,
    loadScene: false,
    saveToActiveFile: false,
    saveAsImage: false,
    toggleTheme: false,
  },
  tools: { image: false },
};

// The properties panel only shows the stroke color; everything else is fixed to these defaults.
const INITIAL_DATA = {
  elements: [],
  appState: {
    viewBackgroundColor: 'transparent',
    currentItemStrokeColor: STROKE,
    currentItemBackgroundColor: 'transparent',
    currentItemFillStyle: 'solid',
    currentItemStrokeWidth: 2,       // Excalidraw's "bold", clearly visible on the page
    currentItemStrokeStyle: 'solid',
    currentItemRoughness: 1,         // Excalidraw default
    currentItemOpacity: 100,
    currentItemFontFamily: FONT_FAMILY.Excalifont, // hand-drawn font
    currentItemFontSize: 20,         // M
    currentItemTextAlign: 'left',
    zoom: { value: 1 },
    scrollX: 0,
    scrollY: 0,
  },
  scrollToContent: false,
};

// Excalidraw only registers/downloads fonts when some text needs them; if the first text is measured
// before Excalifont arrives, it stores the wrong width and the text shows up clipped. Exporting a dummy
// text (including accented characters) forces the default font to load before the canvas is released.
async function preloadFonts() {
  try {
    const [probe] = restoreElements([{
      type: 'text', id: 'cc-draw-font-probe', x: 0, y: 0, width: 10, height: 25,
      text: 'Aa Çç ÃãÕõ ÁáÉéÍíÓóÚú ÂâÊêÔô Àà', fontSize: 20, fontFamily: FONT_FAMILY.Excalifont,
    }], null);
    await Promise.race([
      exportToCanvas({ elements: [probe], files: null, appState: { exportBackground: false } }),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
  } catch (err) {
    console.warn('[cc-draw] could not preload fonts', err);
  }
}

// Safety net for text widths: if a text was measured before its font loaded (a new font, a character
// from another subset, a scene restored from an older version…), its stored width is smaller than the
// text and it gets clipped in the exported PNG. Here each free text's font is actually loaded and its
// width recomputed; only wrong widths are touched.
const FAMILY_NAME = Object.fromEntries(Object.entries(FONT_FAMILY).map(([name, id]) => [id, name]));
const textFont = (el) => {
  const name = FAMILY_NAME[el.fontFamily] || 'Excalifont';
  return `${el.fontSize}px ${/\s/.test(name) ? `"${name}"` : name}, Xiaolai, "Segoe UI Emoji"`;
};
async function fixTextDimensions(api) {
  if (!api) return false;
  const editingId = api.getAppState().editingTextElement?.id;
  const texts = api.getSceneElements()
    .filter((el) => el.type === 'text' && !el.containerId && el.autoResize !== false && el.id !== editingId);
  if (!texts.length) return false;
  try {
    // exportToCanvas loads (through Excalidraw) the fonts/subsets these texts use
    await exportToCanvas({ elements: texts, files: null, appState: { exportBackground: false } });
    await document.fonts.ready;
  } catch { /* carry on with whatever has loaded */ }
  const ctx = document.createElement('canvas').getContext('2d');
  const fixes = new Map();
  for (const el of texts) {
    ctx.font = textFont(el);
    const width = Math.max(0, ...el.text.split('\n').map((line) => ctx.measureText(line).width));
    if (Math.abs(width - el.width) > 0.5) fixes.set(el.id, { width, from: el.width, version: el.version });
  }
  if (!fixes.size) return false;
  api.updateScene({
    elements: api.getSceneElementsIncludingDeleted().map((el) => {
      const fix = fixes.get(el.id);
      // skip if the text changed while the font was loading (Excalidraw has re-measured it already)
      if (!fix || el.isDeleted || el.version !== fix.version) return el;
      const dx = el.textAlign === 'center' ? (fix.width - el.width) / 2 : el.textAlign === 'right' ? fix.width - el.width : 0;
      return newElementWith(el, { width: fix.width, x: el.x - dx });
    }),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  return true;
}

const SendIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" />
  </svg>
);
const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6L6 18" /><path d="M6 6l12 12" />
  </svg>
);
// cursor inside a box, like DevTools' "select an element" icon
const InspectIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" role="img">
    <path d="M10 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4" />
    <path d="M13 13l8.5 3.2-3.6 1.3-1.4 3.7z" />
  </svg>
);

// The "inspect" tool button, using the same markup as Excalidraw's own tool buttons.
function InspectToolButton({ checked, onSelect }) {
  return (
    <label className="ToolIcon Shape" title="Select page element — W">
      <input
        className="ToolIcon_type_radio ToolIcon_size_medium"
        type="radio"
        name="cc-draw-inspect"
        aria-label="Select page element"
        aria-keyshortcuts="W"
        data-testid="toolbar-over-inspect"
        checked={checked}
        onChange={onSelect}
        onClick={onSelect}
      />
      <div className="ToolIcon__icon">
        <InspectIcon />
        <span className="ToolIcon__keybinding">W</span>
      </div>
    </label>
  );
}

// Keeps a node (display:contents) right after the selection tool in Excalidraw's toolbar, so the
// "inspect" button can be rendered there through a portal. Also scrubs menus/help on every DOM change.
function useToolbarHost() {
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.className = 'over-tool-host';
    el.style.display = 'contents';
    return el;
  });
  useEffect(() => {
    const place = () => {
      const sel = document.querySelector('[data-testid="toolbar-selection"]')?.closest('label');
      if (sel && sel.nextSibling !== host) sel.after(host);
      scrubUI();
    };
    const mo = new MutationObserver(place);
    mo.observe(document.body, { childList: true, subtree: true });
    place();
    return () => mo.disconnect();
  }, [host]);
  return host;
}

function App() {
  const apiRef = useRef(null);
  const [active, setActive] = useState(!embedded); // opened standalone (no parent page) = active, for testing
  const activeRef = useRef(active);
  const [inspecting, setInspecting] = useState(false);
  const inspectRef = useRef(false);
  const [handMode, setHandMode] = useState(false);
  const toolbarHost = useToolbarHost();

  // sync state (kept outside React: everything here must be cheap)
  const sync = useRef({
    view: { scrollX: 0, scrollY: 0 }, // page scroll, from the parent
    recent: [],                        // recently applied scrolls (so they aren't mistaken for user pans)
    resyncTimer: 0,
    zoomFix: 0,
    lastHash: hashElementsVersion([]), // the initial empty scene doesn't produce a "change"
    changeTimer: 0,
  }).current;
  // pending "inspect-move" (throttled to one per frame)
  const move = useRef({ raf: 0, last: null, lastSent: 0 }).current;
  const cancelMove = useCallback(() => {
    cancelAnimationFrame(move.raf);
    move.raf = 0;
    move.last = null;
  }, [move]);

  // "interact with the page" mode (hand tool): tells the parent and keeps the UI rects up to date
  const pass = useRef({ on: false, sent: '', timer: 0, ro: null, overUI: false, leaveAt: 0 }).current;
  const postPassthrough = useCallback((force = false) => {
    clearTimeout(pass.timer);
    pass.timer = 0;
    const islands = pass.on ? uiIslands() : [];
    const rects = uiRects(islands);
    if (pass.ro) {
      pass.ro.disconnect();
      islands.forEach((el) => pass.ro.observe(el));
    }
    const key = pass.on + JSON.stringify(rects);
    if (!force && key === pass.sent) return;
    pass.sent = key;
    post('passthrough', { on: pass.on, rects });
  }, [pass]);
  const setPassthrough = useCallback((on) => {
    if (on === pass.on) return;
    pass.on = on;
    pass.overUI = false;
    setHandMode(on);
    postPassthrough(true);
  }, [pass, postPassthrough]);
  useEffect(() => {
    const schedule = () => {
      if (pass.on && !pass.timer) pass.timer = setTimeout(() => postPassthrough(), 50);
    };
    pass.ro = new ResizeObserver(schedule);
    const mo = new MutationObserver(schedule); // islands/popovers appearing, disappearing or moving
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    window.addEventListener('resize', schedule);
    return () => {
      clearTimeout(pass.timer);
      pass.ro.disconnect();
      pass.ro = null;
      mo.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [pass, postPassthrough]);

  // ---------------------------------------------------------------- viewport
  const applyViewport = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const sx = -sync.view.scrollX;
    const sy = -sync.view.scrollY;
    const st = api.getAppState();
    if (st.scrollX === sx && st.scrollY === sy && st.zoom.value === 1) return;
    sync.recent.push(sx + ',' + sy);
    if (sync.recent.length > 8) sync.recent.shift();
    api.updateScene({ appState: { scrollX: sx, scrollY: sy, zoom: { value: 1 } }, captureUpdate: CaptureUpdateAction.NEVER });
  }, [sync]);

  const onScrollChange = useCallback((scrollX, scrollY, zoom) => {
    if (zoom.value !== 1) {
      // Excalidraw never zooms on its own: go back to 1 and to the page scroll
      cancelAnimationFrame(sync.zoomFix);
      sync.zoomFix = requestAnimationFrame(applyViewport);
      return;
    }
    const expectedX = -sync.view.scrollX;
    const expectedY = -sync.view.scrollY;
    if (Math.abs(scrollX - expectedX) < 0.5 && Math.abs(scrollY - expectedY) < 0.5) return;
    if (sync.recent.includes(scrollX + ',' + scrollY)) return;
    // pan done inside Excalidraw (space+drag, keyboard…): the page is what scrolls
    post('pan', { scrollX: -scrollX, scrollY: -scrollY });
    // if the page can't scroll that far (at its limit), snap back to its real scroll
    clearTimeout(sync.resyncTimer);
    sync.resyncTimer = setTimeout(applyViewport, 200);
  }, [sync, applyViewport]);

  // ---------------------------------------------------------------- elements
  const liveElements = useCallback(() => plain(apiRef.current?.getSceneElements() || []), []);

  const flushChange = useCallback(() => {
    if (!sync.changeTimer) return;
    clearTimeout(sync.changeTimer);
    sync.changeTimer = 0;
    post('change', { elements: liveElements() });
  }, [sync, liveElements]);

  const onChange = useCallback((elements, appState) => {
    // "inspect" tool turned on/off (button, W, Esc, switching tools…)
    const insp = isInspectTool(appState.activeTool);
    if (insp !== inspectRef.current) {
      inspectRef.current = insp;
      if (!insp) cancelMove(); // no "inspect-move" after "inspect-end"
      setInspecting(insp);
      document.documentElement.classList.toggle('over-inspecting', insp);
      post(insp ? 'inspect-start' : 'inspect-end');
    }
    setPassthrough(appState.activeTool.type === 'hand');
    const hash = hashElementsVersion(elements);
    if (hash === sync.lastHash) return;
    sync.lastHash = hash;
    clearTimeout(sync.changeTimer);
    sync.changeTimer = setTimeout(() => { sync.changeTimer = 1; flushChange(); }, CHANGE_DEBOUNCE);
  }, [sync, flushChange, cancelMove, setPassthrough]);

  const send = useCallback(() => {
    flushChange();
    post('send');
  }, [flushChange]);
  const exit = useCallback(() => post('exit'), []);

  const startInspect = useCallback(() => {
    if (!activeRef.current) return;
    apiRef.current?.setActiveTool({ type: 'custom', customType: 'inspect' });
  }, []);
  const stopInspect = useCallback(() => {
    if (inspectRef.current) apiRef.current?.setActiveTool({ type: 'selection' });
  }, []);

  const exportAnnotations = useCallback(async (id) => {
    const api = apiRef.current;
    if (!api || !api.getSceneElements().length) return post('exported', { id, dataUrl: null, bounds: null, elements: [] });
    try {
      // make sure fonts are loaded and text widths are right before exporting
      await fixTextDimensions(api);
      const elements = api.getSceneElements();
      const canvas = await exportToCanvas({
        elements,
        appState: {
          ...api.getAppState(),
          exportBackground: false,
          viewBackgroundColor: 'transparent',
          exportWithDarkMode: false,
          exportScale: 1,
        },
        files: api.getFiles(),
        exportPadding: EXPORT_PADDING,
        getDimensions: (width, height) => ({ width, height, scale: 1 }),
      });
      const [minX, minY] = getCommonBounds(elements);
      post('exported', {
        id,
        dataUrl: canvas.toDataURL('image/png'),
        bounds: { x: minX - EXPORT_PADDING, y: minY - EXPORT_PADDING, w: canvas.width, h: canvas.height },
        elements: plain(elements),
      });
    } catch (err) {
      console.error('[cc-draw] failed to export annotations', err);
      post('exported', { id, dataUrl: null, bounds: null, elements: liveElements(), error: String(err?.message || err) });
    }
  }, [liveElements]);

  // rectangle coming from "inspect" (document coords), carrying the page element's customData
  const addRect = useCallback((msg) => {
    const api = apiRef.current;
    if (!api) return;
    const st = api.getAppState();
    const [rect] = restoreElements([{
      type: 'rectangle',
      id: newId(),
      x: Number(msg.x) || 0,
      y: Number(msg.y) || 0,
      width: Math.max(1, Number(msg.width) || 0),
      height: Math.max(1, Number(msg.height) || 0),
      strokeColor: st.currentItemStrokeColor,
      strokeWidth: st.currentItemStrokeWidth,
      strokeStyle: st.currentItemStrokeStyle,
      roughness: st.currentItemRoughness,
      opacity: st.currentItemOpacity,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      roundness: null, // sharp corners
      ...(msg.customData !== undefined ? { customData: msg.customData } : {}),
    }], null);
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), rect],
      appState: { selectedElementIds: { [rect.id]: true }, selectedGroupIds: {}, editingGroupId: null },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    post('added', { requestId: msg.requestId, id: rect.id });
  }, []);

  // ---------------------------------------------------------------- active / inactive
  const applyActive = useCallback((on) => {
    activeRef.current = on;
    setActive(on);
    document.documentElement.classList.toggle('over-inactive', !on);
    const api = apiRef.current;
    if (on) {
      window.focus();
      // only focus the container if nothing inside already has focus (don't steal the text editor's focus)
      requestAnimationFrame(() => {
        const current = document.activeElement;
        if (current && current !== document.body) return;
        document.querySelector('.excalidraw-container')?.focus({ preventScroll: true });
      });
      return;
    }
    stopInspect();
    // leave text editing (commits it) and clear selection/menus so no UI is left on the canvas
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (api) {
      api.updateScene({
        appState: {
          selectedElementIds: {}, selectedGroupIds: {}, editingGroupId: null,
          openMenu: null, openPopup: null, openDialog: null, contextMenu: null,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  }, [stopInspect]);

  // ---------------------------------------------------------------- messages from the parent
  useEffect(() => {
    if (!embedded) return undefined;
    const onMessage = (event) => {
      if (event.source !== window.parent) return;
      const msg = event.data;
      if (!msg || msg.source !== SOURCE) return;
      const api = apiRef.current;
      switch (msg.type) {
        case 'viewport':
          sync.view.scrollX = Number(msg.scrollX) || 0;
          sync.view.scrollY = Number(msg.scrollY) || 0;
          applyViewport();
          break;
        case 'init': {
          if (!api) break;
          const elements = restoreElements(Array.isArray(msg.elements) ? msg.elements : [], null, { repairBindings: true });
          sync.lastHash = hashElementsVersion(elements);
          api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
          api.history.clear();
          applyViewport();
          applyActive(!!msg.active);
          fixTextDimensions(api); // saved texts with a wrong width (measured before the font loaded)
          pass.on = api.getAppState().activeTool.type === 'hand';
          postPassthrough(true);
          break;
        }
        case 'active':
          applyActive(!!msg.active);
          break;
        case 'clear': {
          if (!api) break;
          const elements = api.getSceneElementsIncludingDeleted()
            .map((el) => (el.isDeleted ? el : newElementWith(el, { isDeleted: true })));
          api.updateScene({
            elements,
            appState: { selectedElementIds: {}, selectedGroupIds: {}, editingGroupId: null },
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
          break;
        }
        case 'export':
          exportAnnotations(msg.id);
          break;
        case 'add-rect':
          addRect(msg);
          break;
        default:
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sync, pass, applyViewport, applyActive, exportAnnotations, addRect, postPassthrough]);

  // a new font finished loading: fix widths measured before it arrived
  useEffect(() => {
    let timer = 0;
    const onFonts = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fixTextDimensions(apiRef.current), 100);
    };
    document.fonts.addEventListener('loadingdone', onFonts);
    return () => { clearTimeout(timer); document.fonts.removeEventListener('loadingdone', onFonts); };
  }, []);

  // ---------------------------------------------------------------- mouse wheel: the page is what scrolls
  useEffect(() => {
    const onWheel = (e) => {
      const t = e.target;
      const overCanvas = t instanceof HTMLCanvasElement || (t instanceof HTMLTextAreaElement && t.classList.contains('excalidraw-wysiwyg'));
      // Excalidraw panels/menus with their own scrolling keep scrolling normally
      if (!overCanvas && !e.ctrlKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      post('wheel', { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey });
    };
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => window.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  // ---------------------------------------------------------------- pointer: "inspect" tool and hand mode
  useEffect(() => {
    const onCanvas = (e) => e.target instanceof HTMLCanvasElement;
    const flushMove = () => {
      move.raf = 0;
      if (!move.last || !inspectRef.current) { move.last = null; return; }
      move.lastSent = performance.now();
      post('inspect-move', move.last);
      move.last = null;
    };
    // at most one "inspect-move" per frame: send right away if ~1 frame has passed, otherwise on the next rAF
    const onMove = (e) => {
      if (pass.on) {
        // hand mode: the pointer left the UI for the transparent canvas → the parent hands events back to the page
        const overUI = isUiTarget(e.target);
        const now = performance.now();
        if (!overUI && (pass.overUI || now - pass.leaveAt > 250)) {
          pass.leaveAt = now;
          post('ui-leave');
        }
        pass.overUI = overUI;
      }
      if (!inspectRef.current || !onCanvas(e)) return;
      move.last = { x: e.clientX, y: e.clientY };
      if (move.raf) return;
      if (performance.now() - move.lastSent >= 16) flushMove();
      else move.raf = requestAnimationFrame(flushMove);
    };
    // Excalidraw doesn't get the clicks while the tool is active (nothing is created on the canvas)
    const onDown = (e) => {
      if (pass.on && onCanvas(e)) {
        // hand mode: no Excalidraw drag-to-pan (the page scrolls natively)
        e.preventDefault();
        e.stopImmediatePropagation();
        post('ui-leave');
        return;
      }
      if (!inspectRef.current || !onCanvas(e) || e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onUp = (e) => {
      if (!inspectRef.current || !onCanvas(e) || e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancelMove(); // no late "inspect-move" after the pick
      post('inspect-pick', { x: e.clientX, y: e.clientY, shiftKey: e.shiftKey });
      const api = apiRef.current;
      // like Excalidraw's own tools: back to selection, unless the tool lock is on or Shift is held
      if (api && !e.shiftKey && !api.getAppState().activeTool.locked) api.setActiveTool({ type: 'selection' });
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    return () => {
      cancelMove();
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
    };
  }, [move, pass, cancelMove]);

  // ---------------------------------------------------------------- shortcuts
  useEffect(() => {
    const idle = (st) => (
      !st.editingTextElement && !st.newElement && !st.multiElement && !st.editingLinearElement
      && !st.openMenu && !st.openPopup && !st.openDialog && !st.contextMenu && !st.openSidebar
      && Object.keys(st.selectedElementIds || {}).length === 0
    );
    const onKeyDown = (e) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyD') {
        e.preventDefault();
        e.stopImmediatePropagation();
        post('toggle');
        return;
      }
      if (!activeRef.current) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        const t = e.target;
        if (t instanceof HTMLTextAreaElement && t.classList.contains('excalidraw-wysiwyg')) {
          // let Excalidraw commit the text first, then send
          setTimeout(send, 0);
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        send();
        return;
      }
      const plainKey = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (plainKey && (e.key || '').toLowerCase() === INSPECT_KEY && !isField(e.target) && !isField(document.activeElement)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        startInspect();
        return;
      }
      if (e.key === 'Escape' && plainKey) {
        const api = apiRef.current;
        if (!api || isField(e.target) || isField(document.activeElement)) return;
        if (inspectRef.current) {
          // Esc while inspecting only turns the tool off
          e.preventDefault();
          e.stopImmediatePropagation();
          stopInspect();
          return;
        }
        const before = api.getAppState();
        if (!idle(before) || document.querySelector('.excalidraw-modal-container, .Modal')) return;
        const tool = before.activeTool.type;
        // Excalidraw's Esc switches back to the selection tool; if it changed nothing, it means "exit"
        setTimeout(() => {
          const after = api.getAppState();
          if (after.activeTool.type === tool && idle(after)) post('exit');
        }, 0);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [send, startInspect, stopInspect]);

  // ---------------------------------------------------------------- API ready
  const onApi = useCallback((api) => {
    if (!api || apiRef.current) return;
    apiRef.current = api;
    applyViewport();
    preloadFonts().finally(() => post('ready'));
  }, [applyViewport]);

  useEffect(() => {
    document.documentElement.classList.toggle('over-inactive', !activeRef.current);
  }, []);

  const renderTopRightUI = useCallback((isMobile) => (
    <div className="over-actions">
      <Button
        type="button"
        className={'collab-button over-send' + (isMobile ? ' over-send--icon' : '')}
        onSelect={send}
        title="Send to Claude (Ctrl+Enter)"
        aria-label="Send to Claude"
      >
        <SendIcon />
        {!isMobile && <span>Send to Claude</span>}
      </Button>
      <Button
        type="button"
        className="over-close"
        onSelect={exit}
        title="Exit drawing mode (Esc)"
        aria-label="Exit drawing mode"
      >
        <CloseIcon />
      </Button>
    </div>
  ), [send, exit]);

  return (
    <>
      <Excalidraw
        excalidrawAPI={onApi}
        initialData={INITIAL_DATA}
        theme="light"
        langCode="en"
        UIOptions={UI_OPTIONS}
        handleKeyboardGlobally
        autoFocus={active}
        detectScroll={false}
        aiEnabled={false}
        validateEmbeddable={false}
        onChange={onChange}
        onScrollChange={onScrollChange}
        renderTopRightUI={renderTopRightUI}
      >
        {/* main menu is hidden via CSS; declared only so the default items (socials etc.) aren't rendered */}
        <MainMenu>
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
      {createPortal(<InspectToolButton checked={inspecting} onSelect={startInspect} />, toolbarHost)}
      {/* Excalidraw's hints are hidden (they talk about moving the canvas); only ours, in hand mode */}
      {handMode && <div className="over-hint">Interaction mode: click and type on the page normally</div>}
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
