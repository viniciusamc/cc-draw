/* cc-draw overlay — injected into every HTML page served by cc-draw.
 * The drawing itself is the real Excalidraw, running in a transparent iframe on top of the page
 * (/__over/canvas/index.html). This script handles the rest: syncing scroll, persisting,
 * numbering the marks (with one comment/instruction per mark), converting Excalidraw elements
 * into DOM-linked annotations, capturing and sending to Claude. */
(() => {
  'use strict';
  if (window.__ccDraw || window.top !== window) return;
  window.__ccDraw = true;

  const CANVAS_URL = '/__over/canvas/index.html';
  const MSG = 'cc-draw';
  const KIND_LABEL = {
    rect: 'Rectangle', diamond: 'Diamond', ellipse: 'Ellipse', loop: 'Outline', line: 'Underline',
    scribble: 'Scribble', arrow: 'Arrow', text: 'Note', group: 'Group', image: 'Image', frame: 'Frame',
    picked: 'Selected element',
  };
  // Excalidraw 0.18 palette (open-color, shades 0/2/4/6/8 + radix bronze), with Excalidraw's English names
  const PALETTE = {
    gray: ['#f8f9fa', '#e9ecef', '#ced4da', '#868e96', '#343a40'],
    bronze: ['#f8f1ee', '#eaddd7', '#d2bab0', '#a18072', '#846358'],
    red: ['#fff5f5', '#ffc9c9', '#ff8787', '#fa5252', '#e03131'],
    pink: ['#fff0f6', '#fcc2d7', '#f783ac', '#e64980', '#c2255c'],
    grape: ['#f8f0fc', '#eebefa', '#da77f2', '#be4bdb', '#9c36b5'],
    violet: ['#f3f0ff', '#d0bfff', '#9775fa', '#7950f2', '#6741d9'],
    blue: ['#e7f5ff', '#a5d8ff', '#4dabf7', '#228be6', '#1971c2'],
    cyan: ['#e3fafc', '#99e9f2', '#3bc9db', '#15aabf', '#0c8599'],
    teal: ['#e6fcf5', '#96f2d7', '#38d9a9', '#12b886', '#099268'],
    green: ['#ebfbee', '#b2f2bb', '#69db7c', '#40c057', '#2f9e44'],
    yellow: ['#fff9db', '#ffec99', '#ffd43b', '#fab005', '#f08c00'],
    orange: ['#fff4e6', '#ffd8a8', '#ffa94d', '#fd7e14', '#e8590c'],
  };
  // #f08c00 is the 5th default stroke pick and reads as orange, so it gets that name (checked first)
  const SWATCHES = [['black', '#1e1e1e'], ['white', '#ffffff'], ['orange', '#f08c00']];
  for (const [name, shades] of Object.entries(PALETTE)) {
    shades.forEach((hex, i) => SWATCHES.push([i < 2 ? 'light ' + name : name, hex]));
  }
  const MARK_TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'image', 'frame', 'magicframe']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BR', 'HEAD', 'TITLE']);
  const STORE_KEY = 'cc-draw:excalidraw:' + location.pathname;
  const COMMENTS_KEY = 'cc-draw:comments:' + location.pathname;
  const DISMISS_KEY = 'cc-draw:dismissed-run';
  const AUTO_OPEN_DELAY = 500;
  const BATCH_KEY = 'cc-draw:batch:' + location.pathname;   // the batch sent to Claude (survives reloads)
  const BASE_KEY = 'cc-draw:baseline:' + location.pathname; // page fingerprint used to highlight what changed
  const FP_PROPS = ['color', 'background-color', 'background-image', 'font-size', 'font-weight', 'font-family', 'padding',
    'margin', 'border-width', 'border-style', 'border-color', 'border-radius', 'box-shadow', 'opacity', 'display', 'gap',
    'text-align', 'text-decoration', 'transform'];

  const ICON = {
    send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
    close: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
    draw: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
    bubble: '<path d="M5 3h14a3 3 0 013 3v8a3 3 0 01-3 3h-7l-5 4v-4H5a3 3 0 01-3-3V6a3 3 0 013-3z"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    get(k, area = sessionStorage) { try { return area.getItem(k); } catch { return null; } },
    set(k, v, area = sessionStorage) { try { area.setItem(k, v); } catch {} },
    del(k, area = sessionStorage) { try { area.removeItem(k); } catch {} },
  };

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  [hidden] { display: none !important; }
  .ui {
    --bg: #ffffff; --fg: #1b1b1f; --muted: #6e6e7a; --line: #e6e6ee; --soft: #f3f3f8;
    --accent: #6965db; --accent-soft: #ecebff; --on-accent: #fff; --danger: #d9480f;
    --shadow: 0 1px 2px rgba(0,0,0,.06), 0 10px 30px rgba(20,20,50,.16);
    color: var(--fg); font-size: 13px; line-height: 1.4;
  }
  @media (prefers-color-scheme: dark) {
    .ui { --bg: #232329; --fg: #ececf1; --muted: #9e9eab; --line: #36363f; --soft: #2c2c33;
          --accent: #a8a5ff; --accent-soft: #37355e; --on-accent: #16161a; --danger: #ff8a5b; }
  }
  .ui > * { pointer-events: auto; }
  .panel { background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }

  .btn { all: unset; box-sizing: border-box; flex: none; position: relative; width: 34px; height: 34px; display: grid;
         place-items: center; border-radius: 8px; cursor: pointer; color: var(--fg); }
  .btn:hover { background: var(--soft); }
  .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
  .primary { all: unset; box-sizing: border-box; flex: none; height: 34px; padding: 0 14px 0 12px; border-radius: 8px;
             background: var(--accent); color: var(--on-accent); font-weight: 600; font-size: 13px; display: inline-flex;
             align-items: center; gap: 7px; cursor: pointer; white-space: nowrap; }
  .primary:hover { filter: brightness(1.07); }
  .primary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .primary:disabled { opacity: .55; cursor: progress; }
  .primary svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  .fab { position: fixed; right: 18px; bottom: 18px; display: flex; gap: 6px; align-items: center; }
  .fab .primary { height: 40px; border-radius: 999px; padding: 0 16px 0 14px; box-shadow: var(--shadow); }
  .chip { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 14px;
          border-radius: 999px; background: var(--bg); border: 1px solid var(--line); box-shadow: var(--shadow); font-weight: 500; }

  /* numbered badges: one container in document coordinates, shifted by the scroll */
  .ui > .marks { pointer-events: none; }
  .marks { position: fixed; left: 0; top: 0; width: 0; height: 0; will-change: transform; }
  .badge { all: unset; box-sizing: border-box; position: absolute; transform: translate(-50%, -50%); min-width: 22px; height: 22px;
           padding: 0 6px; border-radius: 11px; border: 2px solid #fff; display: inline-flex; align-items: center;
           justify-content: center; gap: 3px; color: #fff; font: 700 11px/1 ui-sans-serif, system-ui, sans-serif;
           box-shadow: 0 1px 3px rgba(0,0,0,.3); cursor: pointer; pointer-events: auto; white-space: nowrap; }
  .badge:hover { filter: brightness(1.12); }
  .badge:focus-visible { outline: 2px solid #6965db; outline-offset: 2px; }
  .badge svg { width: 11px; height: 11px; fill: #fff; stroke: none; }
  .badge .tip { display: none; position: absolute; left: calc(100% + 8px); top: 50%; transform: translateY(-50%);
                width: max-content; max-width: 260px; padding: 7px 10px; border-radius: 8px; background: #fff; color: #1b1b1f;
                border: 1px solid #e6e6ee; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 6px 20px rgba(20,20,50,.18);
                font: 400 12.5px/1.4 ui-sans-serif, system-ui, sans-serif; white-space: pre-wrap; text-align: left;
                pointer-events: none; }
  .badge:hover .tip { display: block; }
  .badge.open .tip { display: none; }

  /* sent batch: badge progress (pending → working → done) */
  .badge[data-state="pending"] { opacity: .5; filter: saturate(.55); }
  .badge[data-state="working"] { box-shadow: 0 0 0 2px #fff, 0 0 14px 3px var(--c); }
  .badge[data-state="working"]::after { content: ''; position: absolute; inset: -5px; border-radius: 999px; pointer-events: none;
                                        border: 2px solid var(--c); animation: od-ring 1.2s ease-out infinite; }
  .badge[data-state="done"] { background: #2f9e44 !important; animation: od-pop .38s cubic-bezier(.3, 1.7, .5, 1); }
  @keyframes od-ring { 0% { transform: scale(.85); opacity: .95; } 100% { transform: scale(1.8); opacity: 0; } }
  @keyframes od-pop { 0% { transform: translate(-50%, -50%) scale(.5); } 100% { transform: translate(-50%, -50%) scale(1); } }
  /* fallback mode (no progress reported yet): each new tool call flashes the working badges as a sign of life */
  .marks.bump .badge[data-state="working"] { animation: od-flash .65s ease-out; }
  @keyframes od-flash {
    0% { filter: brightness(1.5); box-shadow: 0 0 0 3px #fff, 0 0 28px 10px var(--c); }
    100% { filter: none; box-shadow: 0 0 0 2px #fff, 0 0 14px 3px var(--c); }
  }
  .marks { transition: opacity .6s ease; }
  .marks.fade { opacity: 0; }

  /* "what changed": glow boxes tracking the changed elements (above the page, below our panels) */
  .ui > .hl { pointer-events: none; }
  .hl { position: fixed; left: 0; top: 0; width: 0; height: 0; }
  .hl-box { position: fixed; border-radius: 6px; box-shadow: 0 0 0 2px var(--c), 0 0 18px 4px var(--glow); background: var(--fill);
            opacity: 0; animation: od-hl-in .2s ease-out forwards, od-hl-out 2s ease-in .6s forwards; }
  .hl-tag { position: absolute; left: -2px; top: -22px; padding: 2px 7px; border-radius: 10px; background: var(--c); color: #fff;
            font: 700 11px/1.3 ui-sans-serif, system-ui, sans-serif; white-space: nowrap; }
  @keyframes od-hl-in { from { opacity: 0; transform: scale(1.04); } to { opacity: 1; transform: scale(1); } }
  @keyframes od-hl-out { to { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .badge[data-state="working"]::after, .badge[data-state="done"], .marks.bump .badge[data-state="working"] { animation: none; }
    .marks { transition: none; }
    .hl-box { animation: none; opacity: 1; box-shadow: 0 0 0 2px var(--c); background: none; }
  }

  /* comment popover (Excalidraw look: white card, subtle shadow, 8px radius) */
  .pop { position: fixed; width: 264px; padding: 8px; display: grid; gap: 6px; background: #fff; color: #1b1b1f;
         border: 1px solid #e6e6ee; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(20,20,50,.18); }
  .pop textarea { all: unset; box-sizing: border-box; width: 100%; min-height: 38px; max-height: 160px; padding: 6px 8px;
                  border-radius: 6px; background: #f3f3f8; color: #1b1b1f; font-size: 13px; line-height: 1.4;
                  white-space: pre-wrap; overflow: auto; }
  .pop textarea:focus { box-shadow: 0 0 0 1.5px #6965db; }
  .pop-hint { font-size: 11px; color: #6e6e7a; }

  /* element picker (DevTools style): orange margin, yellow border, green padding, blue content */
  .ui > .inspect { pointer-events: none; }
  .inspect > div { position: fixed; box-sizing: border-box; border-style: solid; border-width: 0; }
  .inspect .im { border-color: rgba(246,178,107,.55); }
  .inspect .ib { border-color: rgba(255,229,153,.6); }
  .inspect .ip { border-color: rgba(147,196,125,.55); background: rgba(111,168,220,.35); background-clip: content-box; }
  .inspect .il { padding: 3px 7px; border-radius: 4px; background: rgba(27,27,31,.92); color: #c9c9d1; white-space: nowrap;
                 font: 500 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; max-width: calc(100vw - 8px);
                 overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
  .inspect .il b { color: #f7a8ff; font-weight: 600; }
  .inspect .il i { color: #9ecbff; font-style: normal; }

  .composer { position: fixed; right: 18px; bottom: 18px; width: min(430px, calc(100vw - 36px));
              max-height: calc(100vh - 110px); display: flex; flex-direction: column; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 8px; padding: 12px 10px 10px 16px; border-bottom: 1px solid var(--line); }
  .head h3 { margin: 0; font-size: 14px; font-weight: 650; flex: 1; display: flex; align-items: center; gap: 8px; }
  .head .btn { width: 28px; height: 28px; }
  .list { list-style: none; margin: 0; padding: 6px 8px; overflow: auto; flex: 1 1 auto; min-height: 0; }
  .list li { display: flex; gap: 10px; padding: 8px; border-radius: 8px; }
  .list li:hover { background: var(--soft); }
  .list li > div { flex: 1; min-width: 0; }
  .num { flex: none; width: 20px; height: 20px; border-radius: 50%; color: #fff; font-size: 11px; font-weight: 700;
         display: grid; place-items: center; margin-top: 1px; }
  .list b { font-weight: 600; }
  .list code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; background: var(--soft);
               padding: 1px 5px; border-radius: 4px; word-break: break-all; }
  .note { color: var(--muted); margin-top: 2px; white-space: pre-wrap; }
  .cmt { margin-top: 4px; padding: 4px 7px; border-radius: 6px; background: var(--accent-soft); white-space: pre-wrap;
         cursor: text; }
  .cmt:hover { box-shadow: inset 0 0 0 1px var(--accent); }
  .cmt.none { background: none; color: var(--accent); padding: 2px 0; cursor: pointer; }
  .cmt.none:hover { box-shadow: none; text-decoration: underline; }
  textarea.cmt-edit { all: unset; box-sizing: border-box; display: block; width: 100%; margin-top: 4px; padding: 5px 7px;
                      min-height: 34px; max-height: 140px; border-radius: 6px; border: 1px solid var(--accent);
                      background: var(--soft); font-size: 13px; line-height: 1.4; white-space: pre-wrap; overflow: auto; }
  .empty { color: var(--muted); padding: 10px 8px; }
  .foot { padding: 10px 12px 12px; border-top: 1px solid var(--line); display: grid; gap: 10px; }
  textarea.notes { all: unset; box-sizing: border-box; width: 100%; min-height: 64px; max-height: 160px; padding: 9px 11px;
                   border: 1px solid var(--line); border-radius: 8px; background: var(--soft); white-space: pre-wrap;
                   font-size: 13px; overflow: auto; }
  textarea.notes:focus { border-color: var(--accent); }
  .row { display: flex; align-items: center; gap: 10px; }
  .row label { flex: 1; display: flex; align-items: center; gap: 6px; color: var(--muted); cursor: pointer; }
  .row input { accent-color: var(--accent); margin: 0; }

  .status { position: fixed; left: 18px; bottom: 18px; width: min(420px, calc(100vw - 36px)); max-height: min(55vh, 480px);
            display: flex; flex-direction: column; overflow: hidden; }
  .log { margin: 0; padding: 8px 14px 12px; overflow: auto; display: grid; gap: 6px; font-size: 12.5px; }
  .log .tool { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .log .tool b { color: var(--accent); font-weight: 600; }
  .log .text { white-space: pre-wrap; }
  .log .result { white-space: pre-wrap; background: var(--soft); border-radius: 8px; padding: 8px 10px; }
  .log .error { white-space: pre-wrap; color: var(--danger); }
  .log .meta, .log .info { color: var(--muted); font-size: 11.5px; }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--accent-soft); border-top-color: var(--accent);
          animation: spin .8s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .ghost { all: unset; cursor: pointer; font-size: 12px; color: var(--muted); padding: 4px 8px; border-radius: 6px; }
  .ghost:hover { background: var(--soft); color: var(--fg); }

  .toast { position: fixed; left: 50%; bottom: 76px; transform: translateX(-50%); padding: 9px 14px; border-radius: 10px;
           background: var(--fg); color: var(--bg); font-weight: 500; box-shadow: var(--shadow); max-width: calc(100vw - 40px); }
  .toast.bad { background: var(--danger); color: #fff; }
  `;

  // ---------------------------------------------------------------- DOM
  const host = document.createElement('cc-draw-root');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${CSS}</style>
    <div class="ui">
      <div class="hl"></div>
      <div class="marks" hidden></div>
      <div class="pop" hidden></div>
      <div class="inspect" hidden><div class="im"></div><div class="ib"></div><div class="ip"></div><div class="il"></div></div>

      <div class="fab">
        <button class="chip" data-act="show-status" hidden><span class="spin"></span>Claude is working…</button>
        <button class="primary" data-act="toggle" title="Annotate design — Alt+Shift+D">${svg('draw')}Annotate</button>
      </div>

      <section class="composer panel" hidden>
        <div class="head"><h3>Send to Claude</h3><button class="btn" data-act="close-composer" title="Close — Esc">${svg('close')}</button></div>
        <ol class="list"></ol>
        <div class="foot">
          <textarea class="notes" placeholder="General instructions (optional) — e.g. make the hero bolder"></textarea>
          <div class="row">
            <label class="cont"><input type="checkbox" checked> Continue the previous conversation</label>
            <button class="primary" data-act="send" title="Ctrl+Enter">${svg('send')}Send</button>
          </div>
        </div>
      </section>

      <section class="status panel" hidden>
        <div class="head"><h3></h3>
          <button class="ghost" data-act="cancel">Cancel</button>
          <button class="btn" data-act="close-status" title="Close">${svg('close')}</button>
        </div>
        <div class="log"></div>
      </section>

      <div class="toast" hidden></div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (sel) => shadow.querySelector(sel);
  const ui = $('.ui');
  const marksEl = $('.marks');
  const popEl = $('.pop');
  const composer = $('.composer');
  const notesTA = $('.notes');
  const contLabel = $('.cont');
  const contBox = $('.cont input');
  const statusEl = $('.status');
  const logEl = $('.log');
  const toastEl = $('.toast');

  // ---------------------------------------------------------------- state
  const state = { active: false, elements: [], comments: {}, hasSession: false, run: null, sending: false };
  try {
    const saved = JSON.parse(store.get(STORE_KEY) || '[]');
    if (Array.isArray(saved)) state.elements = saved.filter((e) => e && !e.isDeleted);
  } catch {}
  try {
    const saved = JSON.parse(store.get(COMMENTS_KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) state.comments = saved;
  } catch {}
  store.del('cc-draw:shapes:' + location.pathname); // old format (hand-made drawing layer)

  const persist = () => store.set(STORE_KEY, JSON.stringify(state.elements));
  // comments are stored by the mark's stable id; comments of deleted marks are just ignored
  // (so Excalidraw's Ctrl+Z brings the mark back together with its comment)
  const persistComments = () => store.set(COMMENTS_KEY, JSON.stringify(state.comments));

  // ---------------------------------------------------------------- Excalidraw iframe
  let frame = null;
  let frameReady = false;
  let readyTimer = 0;
  let pointerDown = false; // button pressed inside Excalidraw (drawing)
  let gesture = null;      // { x, y, drawing } of the current pointer gesture inside Excalidraw
  let lastFramePointer = 0; // performance.now() of the last pointerdown inside Excalidraw
  let lastUserPointer = 0;  // last user pointerdown anywhere (iframe, page, our UI outside the popover)
  // hand tool (H) = "interact with the page": the iframe only takes the pointer over Excalidraw's UI islands
  const pass = { on: false, rects: [], over: false };
  const PASS_TOL = 6;
  const exports = new Map();

  function post(msg) {
    if (frame && frameReady) frame.contentWindow.postMessage({ source: MSG, ...msg }, location.origin);
  }
  function ensureFrame() {
    if (frame) return frame;
    frame = document.createElement('iframe');
    frame.src = CANVAS_URL;
    frame.title = 'cc-draw — drawing';
    frame.setAttribute('allowtransparency', 'true');
    frame.setAttribute('aria-label', 'cc-draw drawing area');
    frame.style.cssText = [
      // an iframe is a replaced element: without explicit width/height it stays 300×150 even with inset:0
      'all:initial', 'position:fixed', 'inset:0', 'width:100%', 'height:100%', 'margin:0', 'padding:0', 'border:0',
      // color-scheme light: with "normal" Chrome paints an opaque backdrop behind the iframe on dark pages
      'background:transparent', 'color-scheme:light', 'z-index:2147483646', 'pointer-events:none', 'display:none',
    ].map((d) => d + ' !important').join(';');
    frame.addEventListener('load', () => {
      clearTimeout(readyTimer);
      // the app says "ready" once Excalidraw has mounted; if it never does, the route is missing/broken
      // ("ready" waits for Excalidraw's default font — it can take a few seconds)
      readyTimer = setTimeout(() => { if (!frameReady) frameFailed(); }, 15000);
    });
    document.documentElement.appendChild(frame);
    return frame;
  }
  function frameFailed() {
    toast('Could not load Excalidraw (/__over/canvas).', true);
    frame?.remove();
    frame = null;
    frameReady = false;
    state.active = false;
    $('.fab').hidden = false;
    renderBadges();
  }
  function syncFrame() {
    const show = state.active || state.elements.length > 0;
    if (show) ensureFrame();
    if (!frame) return;
    frame.style.setProperty('display', show ? 'block' : 'none', 'important');
    const pe = state.active && (!pass.on || pass.over) ? 'auto' : 'none';
    frame.style.setProperty('pointer-events', pe, 'important');
  }
  const isEditable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  function focusFrame() {
    if (!frame || !state.active) return;
    // never steal focus from a page field (hand mode: the user may be typing in a form)
    if (isEditable(document.activeElement)) return;
    try { frame.focus(); frame.contentWindow.focus(); } catch {}
  }

  // hand mode: on every move decide whether the pointer is over Excalidraw's UI (the iframe takes it) or over
  // the page (the iframe lets the pointer through). While the iframe is "auto" the page can't see the pointer —
  // then the iframe itself reports that the pointer left its UI (ui-leave).
  function onPassPointer(e) {
    if (!state.active || !pass.on) return;
    const x = e.clientX, y = e.clientY;
    const over = pass.rects.some((r) => x >= r.x - PASS_TOL && x <= r.x + r.w + PASS_TOL && y >= r.y - PASS_TOL && y <= r.y + r.h + PASS_TOL);
    if (over === pass.over) return;
    pass.over = over;
    syncFrame();
    // focus the iframe only when nobody else has focus (don't take it from a page field or the popover/composer)
    const ae = document.activeElement;
    if (over && (!ae || ae === document.body || ae === de)) focusFrame();
  }
  document.addEventListener('pointermove', onPassPointer, true);
  document.addEventListener('pointerdown', onPassPointer, true);
  // a user click on the page or on our UI (outside the popover itself) counts as "click outside" the popover
  document.addEventListener('pointerdown', (e) => {
    if (!e.composedPath().includes(popEl)) lastUserPointer = performance.now();
  }, true);
  function setPassthrough(on, rects) {
    const was = pass.on;
    pass.on = !!on;
    pass.rects = (Array.isArray(rects) ? rects : [])
      .map((r) => ({ x: +r?.x, y: +r?.y, w: +r?.w, h: +r?.h }))
      .filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite));
    if (!pass.on) pass.over = false;
    // when it turns on, the pointer is almost always still over the toolbar (inside the iframe, where we can't
    // see it): stay "auto" until the first ui-leave — otherwise the next toolbar click would need a re-hover
    else if (!was) pass.over = true;
    syncFrame();
  }
  // same origin: we can peek into the iframe to know whether the user is still mid-stroke/mid-text
  function watchFramePointer() {
    try {
      const w = frame.contentWindow;
      w.addEventListener('pointerdown', (e) => {
        pointerDown = true;
        lastFramePointer = lastUserPointer = performance.now();
        // a new stroke before any typing: the user is still drawing, not commenting
        if (keyBuffer?.draw && !keyBuffer.text && !keyBuffer.enter) keyBuffer = null;
        gesture = { x: e.clientX, y: e.clientY, drawing: drawingToolActive() };
      }, true);
      // popover open and focus fell into the iframe: no key goes to Excalidraw (it would be a shortcut) — it goes to the popover
      w.addEventListener('keydown', onFrameKeyWhilePopover, true);
      w.addEventListener('pointerup', (e) => {
        pointerDown = false;
        // a drawing gesture just ended: from now on keystrokes belong to the upcoming comment popover, not to
        // Excalidraw (they'd be shortcuts), even before the debounced "change" brings the new mark
        const g = gesture;
        gesture = null;
        if (g?.drawing && !pop.key && !(keyBuffer && !keyBuffer.draw) && Math.hypot(e.clientX - g.x, e.clientY - g.y) > 3) {
          keyBuffer = { until: performance.now() + 2500, text: '', enter: false, cancel: false, draw: true };
        }
      }, true);
      // a pointerup outside the iframe never arrives here: moving with no button pressed means the gesture is over
      w.addEventListener('pointermove', (e) => { if (pointerDown && !e.buttons) pointerDown = false; }, true);
      w.addEventListener('pointercancel', () => { pointerDown = false; }, true);
      // focus coming back to the iframe without a click (Excalidraw/browser restoring focus): the open popover takes it back
      w.addEventListener('focus', () => reclaimPopoverFocus());
      // pointer left the iframe (out of the window or over our UI): hide the picker highlight
      w.document.documentElement.addEventListener('mouseleave', () => clearInspect());
    } catch {}
  }
  // is a shape/drawing tool active in Excalidraw's toolbar? (test id, aria-label or English title)
  const DRAW_TOOL = /\b(rectangle|diamond|ellipse|arrow|line|freedraw|draw)\b/i;
  function drawingToolActive() {
    try {
      const c = frame.contentDocument.querySelector('.App-toolbar input:checked');
      if (!c) return false;
      return DRAW_TOOL.test([c.getAttribute('data-testid'), c.getAttribute('aria-label'), c.closest('label')?.getAttribute('title')].join(' '));
    } catch { return false; }
  }
  function excalidrawBusy() {
    if (pointerDown) return true;
    try { return !!frame?.contentDocument?.querySelector('textarea.excalidraw-wysiwyg'); } catch { return false; }
  }

  const de = document.documentElement;
  const viewport = () => ({
    scrollX: scrollX, scrollY: scrollY,
    width: de.clientWidth || innerWidth,
    height: document.compatMode === 'CSS1Compat' ? de.clientHeight || innerHeight : innerHeight,
  });
  const sendViewport = () => post({ type: 'viewport', ...viewport() });

  addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || m.source !== MSG) return;
    switch (m.type) {
      case 'ready':
        frameReady = true;
        clearTimeout(readyTimer);
        setPassthrough(false); // new (or reloaded) app: starts outside hand mode
        watchFramePointer();
        post({ type: 'init', elements: state.elements, active: state.active });
        sendViewport();
        focusFrame();
        return;
      case 'change':
        setElements(m.elements, { fromUser: true });
        return;
      case 'wheel': {
        if (m.ctrlKey) return; // no zoom: the drawing stays locked to the page's scale
        const k = m.deltaMode === 1 ? 40 : m.deltaMode === 2 ? innerHeight : 1;
        scrollBy({ left: (+m.deltaX || 0) * k, top: (+m.deltaY || 0) * k, behavior: 'instant' });
        sendViewport();
        return;
      }
      case 'pan':
        scrollTo({ left: +m.scrollX || 0, top: +m.scrollY || 0, behavior: 'instant' });
        // always reply (even if the page was already at its limit and didn't scroll): the canvas expects it
        sendViewport();
        return;
      case 'inspect-start':
        inspect.on = true;
        return;
      case 'inspect-move':
        // a late move (the canvas's rAF) can arrive after inspect-end: outside the mode, ignore it
        if (!inspect.on) return;
        return m.x == null || m.y == null ? clearInspect() : inspectAt(+m.x, +m.y);
      case 'inspect-pick':
        clearInspect(); // like DevTools: once picked, the highlight goes away (the next move redraws it if still inspecting)
        // from now until the popover opens, keystrokes are held for it instead of reaching Excalidraw
        if (!m.shiftKey) keyBuffer = { until: performance.now() + 2500, text: '', enter: false, cancel: false, draw: false };
        return pickAt(+m.x, +m.y, !!m.shiftKey);
      case 'inspect-end':
        inspect.on = false;
        return clearInspect();
      case 'added': return onAdded(m);
      case 'passthrough': return setPassthrough(m.on, m.rects);
      case 'ui-leave':
        if (pass.on && pass.over) { pass.over = false; syncFrame(); }
        return;
      case 'send': return openComposer();
      case 'exit': return toggle(false);
      case 'toggle': return toggle();
      case 'exported': {
        const done = exports.get(m.id);
        if (done) { exports.delete(m.id); done(m); }
        return;
      }
    }
  });

  function setElements(list, { fromUser = false } = {}) {
    state.elements = Array.isArray(list) ? list.filter((e) => e && !e.isDeleted) : [];
    persist();
    syncFrame();
    const gs = groups();
    renderBadges(gs); // badges first: a new mark's popover may open right away (keys already typed)
    if (fromUser) trackNewMarks(gs);
    else for (const g of gs) seenKeys.add(g.key);
    openPickedPopover();
    if (!composer.hidden && !state.sending && !inlineEditing) renderComposer();
  }

  function requestExport() {
    return new Promise((resolve, reject) => {
      if (!frameReady) return reject(new Error('Excalidraw is not loaded'));
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { exports.delete(id); reject(new Error('Excalidraw did not export in time')); }, 8000);
      exports.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      post({ type: 'export', id });
    });
  }

  // ---------------------------------------------------------------- Excalidraw element geometry
  const union = (a, b) => {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  };
  const rectDist = (a, b) => Math.hypot(
    Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)),
    Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)),
  );
  function boundsOf(pts, pad = 0) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  }
  const rotate = (pts, cx, cy, a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
  };
  const isLinear = (e) => Array.isArray(e.points) && e.points.length > 0;
  // points in document coordinates (Excalidraw scene == document, zoom 1)
  function absPoints(e) {
    const pts = e.points.map(([px, py]) => [e.x + px, e.y + py]);
    if (!e.angle) return pts;
    const b = boundsOf(pts);
    return rotate(pts, b.x + b.w / 2, b.y + b.h / 2, e.angle);
  }
  function elBox(e) {
    if (isLinear(e)) return boundsOf(absPoints(e), (e.strokeWidth || 1) / 2);
    const x = Math.min(e.x, e.x + e.width), y = Math.min(e.y, e.y + e.height);
    const w = Math.abs(e.width), h = Math.abs(e.height);
    if (!e.angle) return { x, y, w, h };
    return boundsOf(rotate([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], x + w / 2, y + h / 2, e.angle));
  }
  const textOf = (t) => String(t.originalText ?? t.text ?? '').trim();

  /* Groups the elements into annotations:
   * - every non-text element is a mark; elements in the same Excalidraw group (groupIds[0]) form a single mark;
   * - text inside a shape (containerId) or an arrow label becomes a note of that mark;
   * - free text sticks to the nearest mark (up to 160px) or becomes a standalone note.
   * Every annotation has a stable `key` (group id, or element id) — that's where its comment is stored. */
  function groups() {
    const els = state.elements.filter((e) => e && !e.isDeleted);
    const groupKey = (e) => (e.groupIds?.length ? e.groupIds[0] : null);
    const gs = [];
    const byGroupId = new Map();
    const groupOf = new Map(); // element id → annotation
    els.forEach((e, i) => {
      if (!MARK_TYPES.has(e.type)) return;
      const gid = groupKey(e);
      let g = gid && byGroupId.get(gid);
      if (!g) {
        g = { key: gid || e.id, order: i, members: [], notes: [], box: null };
        gs.push(g);
        if (gid) byGroupId.set(gid, g);
      }
      g.members.push(e);
      g.box = g.box ? union(g.box, elBox(e)) : elBox(e);
      groupOf.set(e.id, g);
      if ((e.type === 'frame' || e.type === 'magicframe') && e.name?.trim()) g.notes.push(e.name.trim());
    });
    const loose = [];
    els.forEach((t, i) => {
      if (t.type !== 'text') return;
      const text = textOf(t);
      if (!text) return;
      const tb = elBox(t);
      let g = (t.containerId && groupOf.get(t.containerId)) || (groupKey(t) && byGroupId.get(groupKey(t)));
      if (!g) {
        let bd = Infinity;
        for (const c of gs) {
          const d = rectDist(tb, c.box);
          if (d < bd) { bd = d; g = c; }
        }
        if (bd >= 160) g = null;
      }
      if (g) { g.notes.push(text); groupOf.set(t.id, g); } else {
        const s = { key: t.id, order: i, members: [], notes: [text], box: tb, text: t };
        loose.push(s);
        groupOf.set(t.id, s);
      }
    });
    const all = [...gs, ...loose].sort((a, b) => a.order - b.order);
    all.forEach((g, i) => {
      g.n = i + 1;
      g.color = (g.members[0] || g.text).strokeColor || '#1e1e1e';
      g.comment = state.comments[g.key] || '';
    });
    all.groupOf = groupOf;
    return all;
  }

  // ---------------------------------------------------------------- numbered badges (DOM, clickable)
  function hexRgb(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  function badgeFill(color) {
    const rgb = hexRgb(color);
    if (!rgb) return color && color !== 'transparent' ? color : '#6965db';
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    return lum > 0.8 ? '#1e1e1e' : color; // white/light stroke: a white number wouldn't show
  }
  function badgeAnchor(g) {
    const m = g.members.length === 1 && g.members[0];
    if (m && m.type === 'arrow' && isLinear(m)) {
      const [x, y] = absPoints(m)[0];
      return [x - 12, y - 12];
    }
    return [g.box.x - 6, g.box.y - 6];
  }

  const badgeEls = new Map(); // key → <button>
  // badges of a sent batch stay visible (with their progress) even with drawing mode off
  const badgesVisible = () => (state.active || !composer.hidden || !!state.batch) && state.elements.length > 0;
  function renderBadges(gs = groups()) {
    marksEl.hidden = !badgesVisible();
    const alive = new Set();
    for (const g of gs) {
      alive.add(g.key);
      let b = badgeEls.get(g.key);
      if (!b) {
        b = document.createElement('button');
        b.className = 'badge';
        b.dataset.key = g.key;
        marksEl.appendChild(b);
        badgeEls.set(g.key, b);
      }
      const [x, y] = badgeAnchor(g);
      b.style.left = x + 'px';
      b.style.top = y + 'px';
      b.style.background = badgeFill(g.color);
      b.style.setProperty('--c', badgeFill(g.color));
      const bs = batchStateFor(g); // null (not sent) | pending | working | done
      if ((b.dataset.state || '') !== (bs || '')) b.dataset.state = bs || '';
      const sig = g.n + ' ' + bs + ' ' + g.comment;
      if (b.dataset.sig !== sig) {
        b.dataset.sig = sig;
        b.classList.toggle('has', !!g.comment);
        b.innerHTML = `<span>${bs === 'done' ? '✓' : g.n}</span>${g.comment ? svg('bubble') + `<span class="tip">${esc(g.comment)}</span>` : ''}`;
        b.setAttribute('aria-label', `Annotation ${g.n}${g.comment ? ': ' + g.comment : ' — add instruction'}`);
      }
      b.classList.toggle('open', pop.key === g.key);
    }
    for (const [k, b] of badgeEls) if (!alive.has(k)) { b.remove(); badgeEls.delete(k); }
    placeMarks();
    if (pop.key && !alive.has(pop.key)) closePopover('gone');
  }
  // scroll: only shifts the container (cheap) and repositions the popover
  function placeMarks() {
    marksEl.style.transform = `translate(${-scrollX}px, ${-scrollY}px)`;
    placePopover();
    if (inspect.on && inspect.hasPointer) inspectAt(inspect.x, inspect.y); // the page scrolled: another element under the pointer
  }

  // scroll/resize: rAF-throttled — sends the viewport to Excalidraw and moves the badges in the same frame
  let vpRaf = 0;
  function onViewport() {
    if (vpRaf) return;
    vpRaf = requestAnimationFrame(() => { vpRaf = 0; sendViewport(); placeMarks(); });
  }
  addEventListener('scroll', onViewport, { passive: true, capture: true });
  addEventListener('resize', onViewport);

  // ---------------------------------------------------------------- comments (one instruction per mark)
  function setComment(key, text) {
    const t = String(text || '').trim();
    if (t) state.comments[key] = t; else delete state.comments[key];
    persistComments();
    renderBadges();
    if (!composer.hidden && !inlineEditing) renderComposer();
  }
  // Enter saves, Shift+Enter inserts a new line, Esc / clicking outside closes and saves; empty removes the comment.
  // Keys never leave the shadow DOM (no page shortcuts).
  function bindCommentInput(ta, onDone, { onBlur = (close) => close() } = {}) {
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      onDone(ta.value, how);
    };
    const autosize = () => {
      ta.style.height = '0px';
      ta.style.height = Math.min(ta.scrollHeight + 2, 160) + 'px';
    };
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); finish('key'); }
      else if (e.key === 'Escape') { e.preventDefault(); finish('key'); }
    });
    for (const t of ['keyup', 'keypress']) ta.addEventListener(t, (e) => e.stopPropagation());
    ta.addEventListener('blur', () => onBlur(() => finish('blur')));
    requestAnimationFrame(autosize);
    return finish;
  }

  const pop = { key: null, finish: null, openedAt: 0, refocus: 0 };
  function openPopover(key) {
    if (pop.key) closePopover('switch');
    const b = badgeEls.get(key);
    if (!b) return;
    pop.key = key;
    pop.openedAt = performance.now();
    pop.refocus = 0;
    popEl.innerHTML = '<textarea rows="1" placeholder="What do you want here?"></textarea>'
      + '<div class="pop-hint">Enter saves · Shift+Enter new line · Esc closes</div>';
    const ta = popEl.querySelector('textarea');
    ta.value = state.comments[key] || '';
    pop.finish = bindCommentInput(ta, (text, how) => {
      if (pop.key !== key) return;
      pop.key = null;
      pop.finish = null;
      popEl.hidden = true;
      popEl.innerHTML = '';
      setComment(key, text);
      // closed by keyboard/button: give focus back to the drawing (on click-outside / badge switch focus is already there)
      if (how !== 'blur' && how !== 'switch') focusFrame();
    }, {
      // blur is not always "click outside": the window may have lost focus (alt-tab), or Excalidraw/the browser
      // moved focus back to the iframe without any click since the popover opened — in those cases it stays open
      onBlur: (close) => setTimeout(() => {
        if (!ta.isConnected || pop.key !== key || shadow.activeElement === ta) return;
        if (!document.hasFocus()) return; // the window lost focus (alt-tab): stays open
        const ae = document.activeElement;
        // no user click since it opened and focus went to the iframe/body: that was Excalidraw (selection after
        // add-rect, container focus) or the browser — not a "click outside": take focus back
        if (lastUserPointer < pop.openedAt && (!ae || ae === frame || ae === document.body || ae === de)) return reclaimPopoverFocus();
        close();
      }, 0),
    });
    popEl.hidden = false;
    b.classList.add('open');
    placePopover();
    const grab = () => {
      if (pop.key !== key || !ta.isConnected || lastUserPointer > pop.openedAt) return;
      if (shadow.activeElement === ta && document.activeElement === host) return;
      try { window.focus(); } catch {}
      ta.focus();
    };
    grab();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    // the click that created the mark (or the pick) is still finishing inside the iframe, which may pull focus
    // back right after: re-assert focus a few times during the first ~400ms
    for (const d of [0, 60, 180, 400]) setTimeout(grab, d);
  }
  function onFrameKeyWhilePopover(e) {
    if (bufferKey(e)) return;
    const ta = pop.key && popEl.querySelector('textarea');
    if (!ta || lastUserPointer > pop.openedAt) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) { pop.finish?.('key'); return; }
    const s = ta.selectionStart ?? ta.value.length, t = ta.selectionEnd ?? s;
    if (e.key === 'Backspace') ta.setRangeText('', s === t ? Math.max(0, s - 1) : s, t, 'end');
    else if (e.key === 'Enter') ta.setRangeText('\n', s, t, 'end');
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) ta.setRangeText(e.key, s, t, 'end');
    ta.dispatchEvent(new Event('input'));
    try { window.focus(); } catch {}
    ta.focus();
  }
  function closePopover(how = 'close') {
    if (pop.key && pop.finish) pop.finish(how);
    else { pop.key = null; popEl.hidden = true; }
  }
  function reclaimPopoverFocus() {
    const ta = pop.key && popEl.querySelector('textarea');
    if (!ta || lastUserPointer > pop.openedAt || pop.refocus >= 8) return;
    pop.refocus++;
    setTimeout(() => {
      if (!ta.isConnected) return;
      try { window.focus(); } catch {}
      ta.focus();
    }, 0);
  }
  function placePopover() {
    if (!pop.key || popEl.hidden) return;
    const b = badgeEls.get(pop.key);
    if (!b) return;
    const r = b.getBoundingClientRect();
    const vw = de.clientWidth || innerWidth, vh = innerHeight;
    const w = popEl.offsetWidth || 264, h = popEl.offsetHeight || 90;
    let left = r.right + 8;
    if (left + w > vw - 8) left = Math.max(8, r.left - 8 - w);
    const top = Math.max(8, Math.min(vh - h - 8, r.top - 6));
    popEl.style.left = left + 'px';
    popEl.style.top = top + 'px';
  }

  // opens the popover on its own when the user finishes a NEW mark (not text, not an extra stroke in a group)
  const seenKeys = new Set();
  let autoKey = null, autoTimer = 0;
  let recentMark = null; // { key, at }: the newest mark, for keys typed after the debounce already gave up on it
  let autoDelay = AUTO_OPEN_DELAY;
  function trackNewMarks(gs) {
    for (const g of gs) {
      if (seenKeys.has(g.key)) continue;
      seenKeys.add(g.key);
      if (g.members.length) {
        autoKey = g.key;
        recentMark = { key: g.key, at: performance.now() };
        // freehand/line marks are often several strokes (an X, a scribble): wait longer before popping up, so the
        // popover doesn't land where the next stroke starts. Typing never waits (the key buffer opens it at once).
        autoDelay = g.members.some((e) => e.type === 'freedraw' || e.type === 'line') ? 1200 : AUTO_OPEN_DELAY;
      }
    }
    clearTimeout(autoTimer);
    if (!autoKey) return;
    // the user already started typing (keys held since the pointerup): open now, no debounce
    if (keyBuffer?.draw && (keyBuffer.text || keyBuffer.enter || keyBuffer.cancel)) tryAutoOpen(true);
    else autoTimer = setTimeout(tryAutoOpen, autoDelay);
  }
  function tryAutoOpen(force = false) {
    if (!autoKey) return;
    if (force !== true && excalidrawBusy()) { autoTimer = setTimeout(tryAutoOpen, 300); return; }
    clearTimeout(autoTimer);
    const key = autoKey;
    autoKey = null;
    const buf = keyBuffer?.draw ? keyBuffer : null;
    if (buf) keyBuffer = null;
    if (buf?.cancel) return; // Esc right after drawing: no popover for this mark
    if (!state.active || !composer.hidden || pop.key || state.sending || state.comments[key]) return;
    if (!badgeEls.has(key)) return;
    openPopover(key);
    pourBuffer(buf, key); // keys typed between the pointerup and now
  }

  // ---------------------------------------------------------------- element picker (DevTools style)
  // Excalidraw reports (inspect-*) in client coordinates; the highlight is drawn here, above the iframe.
  const inspect = { on: false, hasPointer: false, x: 0, y: 0, el: null };
  const inspectEl = $('.inspect');
  const [imEl, ibEl, ipEl, ilEl] = inspectEl.children;
  const pendingPicks = new Map(); // add-rect requestId → { open, rect }
  let pickOpen = null;            // { id, until }: open the popover as soon as the picked rectangle arrives
  // Keys typed right after a pick or right after finishing a drawing — before the popover exists, since A's
  // "added"/"change" take a moment — would reach Excalidraw as shortcuts ("o" = ellipse, "s" = stroke colour…):
  // hold them here and pour them into the popover when it opens. Delete, arrows, Tab and modifier combos pass through.
  let keyBuffer = null; // { until, text, enter, cancel, draw }
  function bufferKey(e) {
    const b = keyBuffer;
    if (pop.key || !b || b.cancel || performance.now() > b.until) return false;
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
    const k = e.key;
    if (!(k.length === 1 || k === 'Enter' || k === 'Escape' || (k === 'Backspace' && b.text))) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (k === 'Escape') b.cancel = true;
    else if (k === 'Enter' && !e.shiftKey) b.enter = true;
    else if (k === 'Enter') b.text += '\n';
    else if (k === 'Backspace') b.text = b.text.slice(0, -1);
    else b.text += k;
    b.until = Math.max(b.until, performance.now() + 1500); // keep holding while the user types
    if (b.draw) {
      // typing = done drawing: open the popover now for the new mark (or the newest one, if the debounce gave up)
      if (!autoKey && recentMark && performance.now() - recentMark.at < 4000 && !state.comments[recentMark.key]) autoKey = recentMark.key;
      if (autoKey) tryAutoOpen(true);
    }
    return true;
  }
  function pourBuffer(buf, key) {
    if (!buf || pop.key !== key) return;
    const ta = popEl.querySelector('textarea');
    if (buf.text) {
      ta.value += buf.text;
      ta.dispatchEvent(new Event('input'));
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    if (buf.enter) pop.finish?.('key'); // Enter was already pressed: save and close
  }

  function hitAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // the iframe (pointer-events:auto) comes first; our UI shows up as the host: skip both
    for (const el of document.elementsFromPoint(x, y)) if (el !== frame && el !== host) return el;
    return null;
  }
  const px = (v) => Math.max(0, parseFloat(v) || 0);
  function placeBox(div, x, y, w, h, [t, r, b, l]) {
    Object.assign(div.style, {
      left: x + 'px', top: y + 'px', width: Math.max(0, w) + 'px', height: Math.max(0, h) + 'px',
      borderWidth: `${t}px ${r}px ${b}px ${l}px`,
    });
  }
  function drawInspect() {
    const el = inspect.el;
    if (!el || !el.isConnected) { inspectEl.hidden = true; return; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const m = [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].map(px);
    const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(px);
    const p = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px);
    placeBox(imEl, r.left - m[3], r.top - m[0], r.width + m[1] + m[3], r.height + m[0] + m[2], m);
    placeBox(ibEl, r.left, r.top, r.width, r.height, bw);
    placeBox(ipEl, r.left + bw[3], r.top + bw[0], r.width - bw[1] - bw[3], r.height - bw[0] - bw[2], p);
    const cls = [...el.classList].filter((c) => c.length < 40).slice(0, 4);
    ilEl.innerHTML = `<b>${esc(el.tagName.toLowerCase())}</b>${el.id ? `<i>#${esc(el.id)}</i>` : ''}`
      + `${cls.map((c) => `<i>.${esc(c)}</i>`).join('')} | ${Math.round(r.width)}×${Math.round(r.height)}`;
    inspectEl.hidden = false;
    // label above the box; if it doesn't fit, below; if not even that, inside the top edge
    const lh = ilEl.offsetHeight || 20, lw = ilEl.offsetWidth || 120;
    const vw = de.clientWidth || innerWidth, vh = innerHeight;
    let top = r.top - m[0] - lh - 4;
    if (top < 4) {
      top = r.bottom + m[2] + 4;
      if (top + lh > vh - 4) top = Math.max(4, r.top + 4);
    }
    ilEl.style.left = Math.max(4, Math.min(vw - lw - 4, r.left)) + 'px';
    ilEl.style.top = top + 'px';
  }
  function inspectAt(x, y) {
    inspect.hasPointer = true;
    inspect.x = x;
    inspect.y = y;
    inspect.el = hitAt(x, y);
    drawInspect();
  }
  function clearInspect() {
    inspect.hasPointer = false;
    inspect.el = null;
    inspectEl.hidden = true;
  }
  // a selector that resolves to exactly this element (the short cssPath if already unique; otherwise the full path)
  function uniqueSelector(el) {
    const unique = (s) => { try { return document.querySelectorAll(s).length === 1 && document.querySelector(s) === el; } catch { return false; } };
    const short = cssPath(el);
    if (unique(short)) return short;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n === document.body) { parts.unshift('body'); break; }
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id) && unique('#' + n.id)) { parts.unshift('#' + n.id); break; }
      let s = n.tagName.toLowerCase();
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(n) + 1})`;
      parts.unshift(s);
      if (unique(parts.join(' > '))) return parts.join(' > ');
    }
    const full = parts.join(' > ');
    return unique(full) ? full : short;
  }
  function pickAt(x, y, shiftKey) {
    const el = hitAt(x, y);
    if (!el || el === de || el === document.body) { keyBuffer = null; return; } // nothing picked: release the keys
    const r = el.getBoundingClientRect();
    const pad = 4;
    const requestId = 'pick-' + Math.random().toString(36).slice(2, 10);
    const rect = {
      x: r.left + scrollX - pad, y: r.top + scrollY - pad, width: r.width + 2 * pad, height: r.height + 2 * pad,
      customData: { ccDraw: { selector: uniqueSelector(el), picked: true } },
    };
    pendingPicks.set(requestId, { open: !shiftKey, rect }); // with Shift the user is picking several: don't open the popover
    post({ type: 'add-rect', requestId, ...rect });
  }
  function onAdded(m) {
    const req = pendingPicks.get(m.requestId);
    if (!req) return;
    pendingPicks.delete(m.requestId);
    if (!m.id) return;
    seenKeys.add(m.id); // handled here already: the normal path (500ms debounce) won't open it again
    // the "change" carrying the new rectangle arrives a bit later (it's debounced): show it right away with the
    // geometry we asked for, so the badge and the popover appear immediately; the next change replaces it
    // with the real element (same id → same key, so the open popover stays)
    if (!state.elements.some((e) => e.id === m.id)) {
      const r = req.rect;
      state.elements = [...state.elements, {
        id: m.id, type: 'rectangle', x: r.x, y: r.y, width: r.width, height: r.height, angle: 0,
        strokeColor: '#e03131', backgroundColor: 'transparent', groupIds: [], isDeleted: false, customData: r.customData,
      }];
      syncFrame();
      renderBadges();
    }
    if (req.open) {
      pickOpen = { id: m.id, until: performance.now() + 3000 };
      openPickedPopover();
    }
  }
  // "added" may arrive before the "change" that brings the rectangle: retry on every change
  function openPickedPopover() {
    if (!pickOpen) return;
    if (performance.now() > pickOpen.until) { pickOpen = null; return; }
    const g = groups().find((c) => c.members.some((e) => e.id === pickOpen.id));
    if (!g || !badgeEls.has(g.key)) return;
    pickOpen = null;
    seenKeys.add(g.key);
    const buf = keyBuffer?.draw ? null : keyBuffer;
    if (buf) keyBuffer = null;
    if (buf?.cancel) return; // Esc right after the pick: no popover
    if (!state.comments[g.key]) openPopover(g.key);
    pourBuffer(buf, g.key); // whatever was typed before the popover existed
  }

  // ---------------------------------------------------------------- drawing mode
  function toggle(on = !state.active) {
    state.active = on;
    if (!on) { closeComposer(); if (pop.key) closePopover(); inspect.on = false; clearInspect(); }
    $('.fab').hidden = on;
    syncFrame();
    post({ type: 'active', active: on });
    if (on) { sendViewport(); focusFrame(); } else if (frame && document.activeElement === frame) frame.blur();
    renderBadges();
  }

  let inlineEditing = false;
  function editInline(el) {
    const key = el.dataset.cmt;
    const ta = document.createElement('textarea');
    ta.className = 'cmt-edit';
    ta.rows = 1;
    ta.placeholder = 'What do you want here?';
    ta.value = state.comments[key] || '';
    inlineEditing = true;
    el.replaceWith(ta);
    bindCommentInput(ta, (text) => {
      inlineEditing = false;
      setComment(key, text);
      renderComposer();
    });
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  ui.addEventListener('click', (e) => {
    const cmt = e.target.closest('[data-cmt]');
    if (cmt) return editInline(cmt);
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.key) {
      if (b.dataset.state) return; // already sent: Claude is on it (or done with it)
      return pop.key === b.dataset.key ? closePopover() : openPopover(b.dataset.key);
    }
    switch (b.dataset.act) {
      case 'toggle': return toggle();
      case 'close-composer': return closeComposer();
      case 'send': return send();
      case 'cancel': return fetch('/__over/cancel', { method: 'POST' });
      case 'close-status':
        if (state.run) store.set(DISMISS_KEY, state.run.id);
        return renderRun(state.run);
      case 'show-status':
        store.set(DISMISS_KEY, '');
        return renderRun(state.run);
    }
  });
  // mousedown on the popover's own badge must not blur the popover before the click (it would close and reopen)
  marksEl.addEventListener('mousedown', (e) => {
    const b = e.target.closest('.badge');
    if (b && b.dataset.key === pop.key) e.preventDefault();
  });

  // in active mode focus lives in the iframe (which handles its own shortcuts); here only what applies to the page
  addEventListener('keydown', (e) => {
    // right after a pick the keys belong to the upcoming popover (focus may be on the page instead of the iframe)
    if (!e.composedPath().includes(host) && bufferKey(e)) return;
    if (e.altKey && e.shiftKey && (e.code === 'KeyD' || e.key.toLowerCase() === 'd')) {
      e.preventDefault();
      toggle();
      return;
    }
    // Esc inside our own fields (popover, inline edit, general instructions) is handled by them.
    // In hand mode Esc on the page belongs to the page (closing a modal, clearing a field…): it only closes the composer.
    if (e.key === 'Escape' && !e.composedPath().includes(host) && ((state.active && !pass.on) || !composer.hidden)) {
      e.preventDefault();
      e.stopPropagation();
      if (!composer.hidden) closeComposer();
      else toggle(false);
    }
  }, true);

  // ---------------------------------------------------------------- annotation → DOM conversion
  function collectElements() {
    const out = [];
    const sx = scrollX, sy = scrollY;
    for (const el of document.body.getElementsByTagName('*')) {
      if (SKIP_TAGS.has(el.tagName) || (el instanceof SVGElement && el.ownerSVGElement)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) continue;
      out.push({ el, x: r.left + sx, y: r.top + sy, w: r.width, h: r.height, a: r.width * r.height });
    }
    return out;
  }
  function smallestAt(els, x, y) {
    let best = null;
    for (const e of els) {
      if (x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h && (!best || e.a <= best.a)) best = e;
    }
    return best;
  }
  function elementsForBox(els, r) {
    const ra = Math.max(1, r.w * r.h);
    let best = null, bs = 0;
    for (const e of els) {
      const ix = Math.min(r.x + r.w, e.x + e.w) - Math.max(r.x, e.x);
      const iy = Math.min(r.y + r.h, e.y + e.h) - Math.max(r.y, e.y);
      if (ix <= 0 || iy <= 0) continue;
      const inter = ix * iy;
      const iou = inter / (ra + e.a - inter);
      if (iou >= bs) { bs = iou; best = e; } // >= : on a tie, the innermost element wins
    }
    if (best && bs >= 0.3) return { target: describe(best.el) };
    const m = 6;
    const inside = els.filter((e) => e.x >= r.x - m && e.y >= r.y - m && e.x + e.w <= r.x + r.w + m && e.y + e.h <= r.y + r.h + m);
    const set = new Set(inside.map((e) => e.el));
    const tops = inside.filter((e) => {
      for (let p = e.el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    }).sort((a, b) => b.a - a.a).slice(0, 6);
    if (tops.length) return { targets: tops.map((e) => describe(e.el)) };
    const c = smallestAt(els, r.x + r.w / 2, r.y + r.h / 2);
    return { target: c ? describe(c.el) : null };
  }
  // freehand stroke (or line): closed outline, underline/strike-through, or scribble
  function classifyStroke(p, b) {
    const span = Math.max(b.w, b.h);
    const gap = Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]);
    if (p.length > 2 && span > 24 && gap < span * 0.3) return { kind: 'loop', region: b };
    if (b.h < Math.max(18, b.w * 0.2)) return { kind: 'line', region: { x: b.x, y: b.y - 24, w: b.w, h: b.h + 36 } };
    return { kind: 'scribble', region: b };
  }

  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && parts.length < 5) {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) { parts.unshift('#' + el.id); break; }
      let p = el.tagName.toLowerCase();
      const cls = [...el.classList].filter((c) => /^[A-Za-z_-][\w-]*$/.test(c) && c.length < 40).slice(0, 3);
      if (cls.length) p += '.' + cls.join('.');
      const parent = el.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === el.tagName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(p);
      el = el.parentElement;
    }
    return parts.join(' > ') || 'body';
  }
  function snippet(el) {
    const tag = el.tagName.toLowerCase();
    const attrs = [...el.attributes]
      .filter((a) => !a.name.startsWith('data-v-') && a.name !== 'style')
      .map((a) => ` ${a.name}="${a.value.length > 160 ? a.value.slice(0, 160) + '…' : a.value}"`)
      .join('');
    const inner = el.children.length ? '…' : (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return `<${tag}${attrs}>${inner}</${tag}>`.slice(0, 420);
  }
  function sourceHint(el) {
    try {
      for (let n = el, d = 0; n && d < 6; n = n.parentElement, d++) {
        if (n.__svelte_meta?.loc) return `${n.__svelte_meta.loc.file}:${n.__svelte_meta.loc.line}`;
        const vue = n.__vueParentComponent?.type?.__file;
        if (vue) return vue;
        const fk = Object.keys(n).find((k) => k.startsWith('__reactFiber$'));
        if (fk) {
          for (let f = n[fk], i = 0; f && i < 15; f = f.return, i++) {
            if (f._debugSource) return `${f._debugSource.fileName}:${f._debugSource.lineNumber}`;
          }
          for (let f = n[fk]; f; f = f.return) {
            const t = f.type;
            if (typeof t === 'function' && (t.displayName || t.name)) return `React component <${t.displayName || t.name}>`;
          }
          return null;
        }
      }
    } catch {}
    return null;
  }
  function describe(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const styles = {};
    const put = (k, v) => {
      if (v && !['none', 'normal', '0px', 'auto', 'rgba(0, 0, 0, 0)', 'transparent'].includes(v)) styles[k] = v;
    };
    put('font-size', cs.fontSize);
    put('font-weight', cs.fontWeight);
    put('font-family', cs.fontFamily.split(',')[0]);
    put('color', cs.color);
    put('background', cs.backgroundColor);
    put('padding', cs.padding);
    put('margin', cs.margin);
    put('border-radius', cs.borderRadius);
    put('display', cs.display);
    if (/flex|grid/.test(cs.display)) put('gap', cs.gap);
    return {
      selector: cssPath(el),
      html: snippet(el),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 140),
      size: `${Math.round(r.width)}×${Math.round(r.height)}`,
      styles,
      source: sourceHint(el),
    };
  }
  function colorName(color) {
    const c = String(color || '').trim().toLowerCase();
    if (!c || c === 'transparent') return 'transparent';
    const exact = SWATCHES.find(([, h]) => h === c);
    if (exact) return exact[0];
    const rgb = hexRgb(c);
    if (!rgb) return c;
    let best = null, bd = Infinity;
    for (const [name, h] of SWATCHES) {
      const q = hexRgb(h);
      const d = Math.hypot(rgb[0] - q[0], rgb[1] - q[1], rgb[2] - q[2]);
      if (d < bd) { bd = d; best = name; }
    }
    return bd < 60 ? best : c;
  }
  const roundBox = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });

  function convert(gs = groups()) {
    const els = collectElements();
    const ref = (id, self) => {
      const g = id && gs.groupOf.get(id);
      return g && g !== self ? g.n : null;
    };
    return gs.map((g) => {
      const base = { n: g.n, color: colorName(g.color), bbox: roundBox(g.box), comment: g.comment, notes: g.notes };
      if (!g.members.length) {
        const b = g.box;
        const el = smallestAt(els, b.x + Math.min(10, b.w / 2), b.y + b.h / 2);
        return { ...base, kind: 'text', target: el ? describe(el.el) : null };
      }
      if (g.members.length > 1) return { ...base, kind: 'group', ...elementsForBox(els, g.box) };
      const m = g.members[0];
      const picked = m.customData?.ccDraw?.picked ? m.customData.ccDraw : null;
      if (picked) {
        // element chosen with the picker: the target is exact (via the saved selector), no area heuristic
        let el = null;
        try { el = picked.selector ? document.querySelector(picked.selector) : null; } catch {}
        if (el) return { ...base, kind: 'picked', selector: picked.selector, target: describe(el) };
        return { ...base, kind: 'picked', selector: picked.selector || null, selectorMissing: true, ...elementsForBox(els, g.box) };
      }
      switch (m.type) {
        case 'arrow': {
          const p = absPoints(m);
          const [x1, y1] = p[0], [x2, y2] = p[p.length - 1];
          const [px, py] = p.length > 1 ? p[p.length - 2] : p[0];
          const out = { ...base, kind: 'arrow' };
          const fromN = ref(m.startBinding?.elementId, g), toN = ref(m.endBinding?.elementId, g);
          if (fromN) out.fromAnnotation = fromN;
          else { const f = smallestAt(els, x1, y1); out.from = f ? describe(f.el) : null; }
          if (toN) out.toAnnotation = toN;
          else {
            // the tip usually stops a bit short of the target: sample 14px further along the last segment
            const len = Math.hypot(x2 - px, y2 - py) || 1;
            const t = smallestAt(els, x2 + ((x2 - px) / len) * 14, y2 + ((y2 - py) / len) * 14);
            out.to = t ? describe(t.el) : null;
          }
          return out;
        }
        case 'freedraw':
        case 'line': {
          const { kind, region } = classifyStroke(absPoints(m), g.box);
          return { ...base, kind, ...elementsForBox(els, region) };
        }
        case 'rectangle': return { ...base, kind: 'rect', ...elementsForBox(els, g.box) };
        case 'magicframe':
        case 'frame': return { ...base, kind: 'frame', ...elementsForBox(els, g.box) };
        default: return { ...base, kind: m.type, ...elementsForBox(els, g.box) }; // diamond, ellipse, image
      }
    });
  }

  // ---------------------------------------------------------------- screen capture
  let libPromise = null;
  function loadLib() {
    return libPromise ||= new Promise((resolve, reject) => {
      if (window.modernScreenshot) return resolve(window.modernScreenshot);
      const s = document.createElement('script');
      s.src = '/__over/modern-screenshot.js';
      s.onload = () => (window.modernScreenshot ? resolve(window.modernScreenshot) : reject(new Error('modern-screenshot did not load')));
      s.onerror = () => { libPromise = null; reject(new Error('could not load modern-screenshot')); };
      document.head.appendChild(s);
    });
  }
  function pageBackground() {
    for (const el of [document.body, document.documentElement]) {
      const c = el && getComputedStyle(el).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
    }
    return '#ffffff';
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('invalid Excalidraw PNG'));
      img.src = src;
    });
  }

  // wraps the text into lines of at most maxW; at most maxLines, with an ellipsis on the last one
  function wrapText(c, text, maxW, maxLines) {
    const lines = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (let word of para.split(/\s+/).filter(Boolean)) {
        while (c.measureText(word).width > maxW && word.length > 1) { // word wider than the box: break it
          let i = word.length - 1;
          while (i > 1 && c.measureText(word.slice(0, i)).width > maxW) i--;
          if (line) { lines.push(line); line = ''; }
          lines.push(word.slice(0, i));
          word = word.slice(i);
        }
        const t = line ? line + ' ' + word : word;
        if (!line || c.measureText(t).width <= maxW) line = t;
        else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    if (lines.length > maxLines) {
      let last = lines[maxLines - 1];
      while (last && c.measureText(last + '…').width > maxW) last = last.slice(0, -1);
      lines.length = maxLines;
      lines[maxLines - 1] = last.replace(/\s+$/, '') + '…';
    }
    return lines;
  }
  function drawBadges(c, gs, { callouts = false, clip = null, k = 1 } = {}) {
    for (const g of gs) {
      const [x, y] = badgeAnchor(g);
      const fill = badgeFill(g.color);
      c.save();
      c.beginPath();
      c.arc(x, y, 10, 0, Math.PI * 2);
      c.fillStyle = fill;
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = '#fff';
      c.stroke();
      c.fillStyle = '#fff';
      c.font = 'bold 11px system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(String(g.n), x, y + 0.5);
      c.restore();
      if (callouts && g.comment) drawCallout(c, x, y, g.comment, fill, clip, k);
    }
  }
  // the comment becomes a small callout next to the badge (k compensates for the image being scaled down)
  function drawCallout(c, x, y, text, color, clip, k) {
    const fs = 12 * k, lh = 16 * k, px = 8 * k, py = 6 * k, maxW = 260 * k;
    c.save();
    c.font = `500 ${fs}px system-ui, sans-serif`;
    const lines = wrapText(c, text, maxW - 2 * px, 4);
    const w = Math.max(...lines.map((l) => c.measureText(l).width)) + 2 * px;
    const h = lines.length * lh + 2 * py;
    let bx = x + 14 * k, by = y - 10 * k;
    if (clip) {
      if (bx + w > clip.x + clip.w - 4) bx = x - 14 * k - w;
      bx = Math.max(clip.x + 4, bx);
      by = Math.max(clip.y + 4, Math.min(clip.y + clip.h - h - 4, by));
    }
    c.shadowColor = 'rgba(20,20,50,.22)';
    c.shadowBlur = 8 * k;
    c.shadowOffsetY = 2 * k;
    c.beginPath();
    c.roundRect(bx, by, w, h, 6 * k);
    c.fillStyle = '#fff';
    c.fill();
    c.shadowColor = 'transparent';
    c.lineWidth = 1.5 * k;
    c.strokeStyle = color;
    c.stroke();
    c.fillStyle = '#1b1b1f';
    c.textBaseline = 'top';
    lines.forEach((l, i) => c.fillText(l, bx + px, by + py + i * lh + 1 * k));
    c.restore();
  }

  async function capture(gs, drawing) {
    const docW = Math.max(de.scrollWidth, de.clientWidth);
    const docH = Math.max(de.scrollHeight, de.clientHeight);
    const viewW = de.clientWidth, viewH = innerHeight;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    let R;
    if (state.elements.length) {
      let u = state.elements.map(elBox).reduce(union);
      if (drawing?.bounds) { const b = drawing.bounds; u = union(u, { x: b.x, y: b.y, w: b.w, h: b.h }); }
      R = { x: u.x - 160, y: u.y - 160, w: u.w + 320, h: u.h + 320 };
      if (R.w < viewW) { R.x -= (viewW - R.w) / 2; R.w = viewW; }
      if (R.h < viewH) { R.y -= (viewH - R.h) / 2; R.h = viewH; }
    } else {
      R = { x: scrollX, y: scrollY, w: viewW, h: viewH };
    }
    R.w = Math.min(R.w, docW);
    R.h = Math.min(R.h, docH);
    R.x = clamp(R.x, 0, docW - R.w);
    R.y = clamp(R.y, 0, docH - R.h);
    R = roundBox(R);

    let page = null, error = null;
    const bg = pageBackground();
    try {
      const lib = await loadLib();
      page = await lib.domToCanvas(de, {
        width: docW, height: docH, scale: 1, backgroundColor: bg, timeout: 15000,
        filter: (node) => node !== host && node !== frame,
      });
    } catch (err) {
      error = String(err?.message || err);
      console.warn('[cc-draw] capture failed:', err);
    }

    const scale = Math.min(1, 1800 / R.w, 7000 / R.h);
    const make = (withMarks) => {
      const c = document.createElement('canvas');
      c.width = Math.round(R.w * scale);
      c.height = Math.round(R.h * scale);
      const x = c.getContext('2d');
      x.fillStyle = bg;
      x.fillRect(0, 0, c.width, c.height);
      if (page) {
        const k = page.width / docW; // the library may render at a different scale
        x.drawImage(page, R.x * k, R.y * k, R.w * k, R.h * k, 0, 0, c.width, c.height);
      }
      if (withMarks) {
        x.scale(scale, scale);
        x.translate(-R.x, -R.y);
        if (drawing?.img) {
          const b = drawing.bounds;
          x.drawImage(drawing.img, b.x, b.y, b.w, b.h);
        }
        drawBadges(x, gs, { callouts: true, clip: R, k: Math.min(2, 1 / scale) });
      }
      return c.toDataURL('image/jpeg', 0.9);
    };
    const images = [];
    if (page) images.push({ label: 'clean', dataUrl: make(false) });
    if (!page || gs.length) images.push({ label: 'annotated', dataUrl: make(true) });
    return { images, region: R, error };
  }

  // ---------------------------------------------------------------- composer / sending
  function targetSummary(a) {
    const c = (d) => (d ? `<code>${esc(d.selector)}</code>` : '<i>nothing</i>');
    if (a.kind === 'arrow') {
      const end = (n, d) => (n ? `<b>#${n}</b>` : c(d));
      return `${end(a.fromAnnotation, a.from)} → ${end(a.toAnnotation, a.to)}`;
    }
    if (a.targets) return `${a.targets.length} ${a.targets.length === 1 ? 'element' : 'elements'}: ${a.targets.slice(0, 3).map(c).join(', ')}${a.targets.length > 3 ? '…' : ''}`;
    return c(a.target);
  }
  function renderComposer() {
    const gs = groups();
    const data = convert(gs);
    $('.list').innerHTML = data.length
      ? data.map((a, i) => `<li><span class="num" style="background:${esc(badgeFill(gs[i].color))}">${a.n}</span><div>
          <b>${KIND_LABEL[a.kind] || esc(a.kind)}</b> ${a.kind === 'arrow' ? 'from' : 'on'} ${targetSummary(a)}
          ${a.comment
            ? `<div class="cmt" data-cmt="${esc(gs[i].key)}" title="Click to edit the instruction">${esc(a.comment)}</div>`
            : `<div class="cmt none" data-cmt="${esc(gs[i].key)}">+ Add instruction</div>`}
          ${a.notes.map((n) => `<div class="note">“${esc(n)}”</div>`).join('')}</div></li>`).join('')
      : '<li class="empty">No annotations drawn — you can send just the instructions below.</li>';
  }
  function openComposer() {
    if (pop.key) closePopover();
    renderComposer();
    contLabel.hidden = !state.hasSession;
    composer.hidden = false;
    renderBadges();
    setTimeout(() => notesTA.focus(), 0);
  }
  function closeComposer() {
    if (composer.hidden) return;
    composer.hidden = true;
    inlineEditing = false;
    renderBadges();
    focusFrame();
  }

  notesTA.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    if (e.key === 'Escape') { e.preventDefault(); closeComposer(); }
  });

  async function send() {
    if (state.sending) return;
    const notes = notesTA.value.trim();
    if (!state.elements.length && !notes) return toast('Draw something or write an instruction.', true);
    const btn = $('[data-act="send"]');
    state.sending = true;
    btn.disabled = true;
    btn.lastChild.textContent = 'Capturing…';
    try {
      // 1) PNG of the drawings only (transparent, in document coordinates), straight from Excalidraw
      let drawing = null, drawError = null;
      if (state.elements.length) {
        try {
          const ex = await requestExport();
          if (Array.isArray(ex.elements)) { // fresher than the last (debounced) "change"
            state.elements = ex.elements.filter((e) => e && !e.isDeleted);
            persist();
          }
          if (ex.dataUrl && ex.bounds) drawing = { bounds: ex.bounds, img: await loadImage(ex.dataUrl) };
          else if (state.elements.length) throw new Error(ex.error || 'empty export');
        } catch (err) {
          drawError = String(err?.message || err);
          console.warn('[cc-draw] Excalidraw export failed:', err);
        }
      }
      // 2) conversion + 3) page capture
      const gs = groups();
      const annotations = convert(gs);
      const cap = await capture(gs, drawing);
      const captureError = [cap.error && `page: ${cap.error}`, drawError && `drawings: ${drawError}`].filter(Boolean).join(' | ') || null;
      btn.lastChild.textContent = 'Sending…';
      const res = await fetch('/__over/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          page: {
            url: location.href, title: document.title,
            viewport: { w: de.clientWidth, h: innerHeight },
            scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
            region: cap.region,
          },
          notes, annotations, images: cap.images, captureError,
          continueSession: state.hasSession && contBox.checked,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || res.statusText);
      // the drawings stay (read-only, drawing mode off) with badges showing Claude's progress; they're cleared at the end
      notesTA.value = '';
      startBatch(j.id, gs, annotations);
      toggle(false);
      store.set(DISMISS_KEY, '');
      toast('Sent! Claude is working…');
      syncBatch(state.run); // the first run snapshots may have arrived before this response
    } catch (err) {
      toast('Failed: ' + err.message, true);
    } finally {
      state.sending = false;
      btn.disabled = false;
      btn.lastChild.textContent = 'Send';
    }
  }

  let toastTimer = 0;
  function toast(msg, bad = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('bad', bad);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
  }

  // ---------------------------------------------------------------- sent batch: progress + "what changed"
  // After a send the drawings stay on the page (read-only) and their badges follow Claude's progress; meanwhile the
  // page is watched and whatever changes gets a short glow. Batch and baseline live in sessionStorage, so a reload in
  // the middle (or at the end) of the run picks up where it left off, re-attached by the SSE hello/run replay.
  state.batch = null; // { feedbackId, sentAt, items: [{ n, key, ids, bbox, color, sels }], progress: { n: state }, finishing, attached }
  try {
    const b = JSON.parse(store.get(BATCH_KEY) || 'null');
    // status is confirmed by the SSE hello replay; until then a stored batch counts as running
    if (b && b.feedbackId && Array.isArray(b.items)) state.batch = { progress: {}, ...b, status: 'running', finishing: false, attached: false };
  } catch {}
  let baseline = null; // { byEl: WeakMap<Element, fp> | null (after a reload), byKey: { structuralPath: fp } }
  if (state.batch) {
    try {
      const byKey = JSON.parse(store.get(BASE_KEY) || 'null');
      if (byKey && typeof byKey === 'object') baseline = { byEl: null, byKey };
    } catch {}
  }
  function saveBatch() {
    const b = state.batch;
    if (b) store.set(BATCH_KEY, JSON.stringify({ feedbackId: b.feedbackId, sentAt: b.sentAt, items: b.items, progress: b.progress }));
  }
  // after a reload the page needs a moment (SPA mount, fonts, images) before it can be compared with the baseline
  const settled = new Promise((resolve) => {
    const go = () => setTimeout(resolve, 700);
    if (document.readyState === 'complete') go(); else addEventListener('load', go, { once: true });
  });

  function startBatch(feedbackId, gs, annotations) {
    const items = gs.map((g, i) => {
      const a = annotations[i] || {};
      const sels = [a.selector, a.target?.selector, a.to?.selector, ...(a.targets || []).map((t) => t.selector)].filter(Boolean);
      return { n: g.n, key: g.key, ids: g.members.map((e) => e.id), bbox: roundBox(g.box), color: badgeFill(g.color), sels };
    });
    state.batch = { feedbackId, sentAt: Date.now(), items, progress: {}, status: 'running', finishing: false, attached: true };
    saveBatch();
    setBaseline(scanPage());
    startWatching();
    renderBadges();
  }
  function batchItemFor(g) {
    const b = state.batch;
    if (!b) return null;
    return b.items.find((it) => it.key === g.key)
      || b.items.find((it) => g.members.some((e) => it.ids.includes(e.id))) || null;
  }
  const hasProgress = (b) => Object.keys(b.progress).length > 0;
  function batchStateFor(g) {
    const it = batchItemFor(g);
    if (!it) return null;
    const b = state.batch;
    if (b.progress[it.n]) return b.progress[it.n];
    // Claude may never report progress: until the first progress event, the whole batch pulses as "working"
    // while the run is on; after it, only the annotations named in events move and the rest wait as pending
    return b.status === 'running' && !hasProgress(b) ? 'working' : 'pending';
  }
  let bumpTimer = 0;
  function bumpBadges() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    marksEl.classList.remove('bump');
    void marksEl.offsetWidth; // restart the animation on every bump
    marksEl.classList.add('bump');
    clearTimeout(bumpTimer);
    bumpTimer = setTimeout(() => marksEl.classList.remove('bump'), 700);
  }

  // follows the run snapshots (SSE hello replay and run updates) for the batch we sent
  function syncBatch(run, fromHello = false) {
    const b = state.batch;
    if (!b || b.finishing) return;
    const mine = !!run && (run.feedbackId != null ? run.feedbackId === b.feedbackId : (run.startedAt || 0) >= b.sentAt - 10000);
    if (!mine) {
      // the server no longer knows this run (restarted) or another one started: stop tracking, keep the drawings
      if (fromHello || (run && (run.startedAt || 0) > b.sentAt)) endBatch();
      return;
    }
    let changed = false;
    for (const ev of run.events || []) {
      if (ev.kind !== 'progress' || !Number.isFinite(+ev.n)) continue;
      const n = +ev.n, st = ev.state === 'done' ? 'done' : 'working';
      if (b.progress[n] !== 'done' && b.progress[n] !== st) { b.progress[n] = st; changed = true; }
    }
    if (changed) saveBatch();
    b.status = run.status;
    // sign of life in fallback mode: every new tool call flashes the working badges
    const lastTool = (run.events || []).reduce((m, ev) => (ev.kind === 'tool' && (ev.t || 0) > m ? ev.t || 0 : m), 0);
    if (b.lastToolT !== undefined && lastTool > b.lastToolT && run.status === 'running' && !hasProgress(b)) bumpBadges();
    b.lastToolT = lastTool;
    renderBadges();
    if (!b.attached) { // first contact after a reload: compare the reloaded page with the stored baseline
      b.attached = true;
      if (run.status === 'running') scheduleDiff();
    }
    if (run.status === 'running') startWatching();
    else if (run.status === 'done') finishDone();
    else finishFailed(); // error / cancelled
  }
  function finishDone() {
    const b = state.batch;
    if (!b || b.finishing) return;
    b.finishing = true;
    for (const it of b.items) b.progress[it.n] = 'done'; // markers may be missing: a finished run means all done
    saveBatch();
    renderBadges();
    finalDiff().then(() => setTimeout(fadeOutBatch, 1200));
  }
  function finishFailed() {
    const b = state.batch;
    if (!b || b.finishing) return;
    b.finishing = true;
    // nothing destructive: drawings and comments stay for editing and resending; badges go back to normal
    finalDiff().then(endBatch);
  }
  function fadeOutBatch() {
    if (!state.batch) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    marksEl.classList.add('fade');
    if (frame) {
      frame.style.setProperty('transition', reduce ? 'none' : 'opacity .6s ease', 'important');
      frame.style.setProperty('opacity', '0', 'important');
    }
    setTimeout(() => {
      post({ type: 'clear' }); // undoable with Ctrl+Z in Excalidraw
      state.comments = {};
      persistComments();
      endBatch();
      setElements([]);
      marksEl.classList.remove('fade');
      if (frame) { frame.style.removeProperty('opacity'); frame.style.removeProperty('transition'); }
    }, reduce ? 0 : 650);
  }
  function endBatch() {
    state.batch = null;
    baseline = null;
    store.del(BATCH_KEY);
    store.del(BASE_KEY);
    stopWatching();
    renderBadges();
  }

  // ---- page fingerprint: own text, rounded size and a style subset per visible element (never x/y, so reflow
  // below a change doesn't flag everything). Keys are structural paths without classes (a class swap is a style
  // change of the same element); in-page, elements are also matched by identity, which survives re-renders.
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }
  function scanPage() {
    const out = [];
    const walk = (parent, path) => {
      const seen = {};
      for (const el of parent.children) {
        const tag = el.tagName;
        seen[tag] = (seen[tag] || 0) + 1;
        if (SKIP_TAGS.has(tag) || el === host || el === frame) continue;
        const key = el.id && /^[A-Za-z][\w-]*$/.test(el.id) ? '#' + el.id : `${path}>${tag.toLowerCase()}${seen[tag]}`;
        const cs = getComputedStyle(el);
        if (cs.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (cs.visibility !== 'hidden' && r.width >= 1 && r.height >= 1 && r.right + scrollX > 0 && r.bottom + scrollY > 0) {
          let text = '';
          for (const n of el.childNodes) if (n.nodeType === 3) text += n.nodeValue;
          out.push({
            el, key, rect: r,
            t: hash(text.trim().replace(/\s+/g, ' ')),
            s: Math.round(r.width) + 'x' + Math.round(r.height),
            st: hash(FP_PROPS.map((p) => cs.getPropertyValue(p)).join('|')),
          });
        }
        if (!(el instanceof SVGElement)) walk(el, key);
      }
    };
    if (document.body) walk(document.body, 'body');
    return out;
  }
  function setBaseline(cur) {
    const byEl = new WeakMap(), byKey = {};
    for (const it of cur) {
      const fp = { t: it.t, s: it.s, st: it.st };
      byEl.set(it.el, fp);
      byKey[it.key] = fp;
    }
    baseline = { byEl, byKey };
    store.set(BASE_KEY, JSON.stringify(byKey));
  }

  // ---- watching: DOM mutations (incl. <head>: Vite CSS HMR swaps <style> contents), debounced diff
  let mo = null, diffTimer = 0;
  const ours = (n) => n === host || n === frame;
  function startWatching() {
    if (mo || !baseline) return;
    mo = new MutationObserver((recs) => {
      for (const r of recs) {
        if (ours(r.target)) continue;
        if (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(ours)) continue;
        return scheduleDiff();
      }
    });
    mo.observe(de, { subtree: true, attributes: true, characterData: true, childList: true });
  }
  function stopWatching() {
    mo?.disconnect();
    mo = null;
    clearTimeout(diffTimer);
  }
  function scheduleDiff() {
    clearTimeout(diffTimer);
    diffTimer = setTimeout(() => settled.then(diffPage), 300);
  }
  function finalDiff() {
    clearTimeout(diffTimer);
    return settled.then(() => { diffPage(); stopWatching(); });
  }
  function diffPage() {
    if (!baseline || !state.batch) return;
    const cur = scanPage();
    const changed = [];
    for (const it of cur) {
      const prev = baseline.byEl?.get(it.el) || baseline.byKey[it.key];
      if (!prev) { changed.push({ ...it, kinds: ['added'] }); continue; }
      const kinds = [];
      if (prev.t !== it.t) kinds.push('text');
      if (prev.st !== it.st) kinds.push('style');
      if (prev.s !== it.s) kinds.push('size');
      if (kinds.length) changed.push({ ...it, kinds });
    }
    setBaseline(cur); // re-baseline: each later change only highlights what's new
    for (const c of reduceChanges(changed)) highlight(c);
  }
  function reduceChanges(list) {
    const has = (c, k) => c.kinds.includes(k);
    const inside = (a, b) => a !== b && b.el.contains(a.el);
    // a container whose only change is its size just reflowed around something that changed inside it
    let res = list.filter((c) => !(c.kinds.length === 1 && has(c, 'size') && list.some((o) => inside(o, c))));
    // a new block brings its children along: keep the outermost new element
    res = res.filter((c) => !(has(c, 'added') && res.some((o) => has(o, 'added') && inside(c, o))));
    // too many: an element whose own style changed explains what changed inside it (inherited colours, fonts…)
    if (res.length > 12) res = res.filter((c) => !res.some((o) => (has(o, 'style') || has(o, 'added')) && inside(c, o)));
    // huge containers (page wrappers) only when they're the only change
    const vp = innerWidth * innerHeight;
    const notHuge = res.filter((c) => c.rect.width * c.rect.height <= 0.6 * vp);
    if (notHuge.length) res = notHuge;
    const rank = (c) => (has(c, 'text') || has(c, 'added') ? 0 : has(c, 'style') ? 1 : 2);
    const area = (c) => c.rect.width * c.rect.height;
    return res.sort((a, b) => rank(a) - rank(b) || area(a) - area(b)).slice(0, 15);
  }

  // ---- highlight boxes: tracked every frame while alive, coloured and tagged by the annotation they belong to
  const hlEl = $('.hl');
  const hls = new Set();
  let hlRaf = 0;
  function attribute(el, rect) {
    const b = state.batch;
    if (!b) return null;
    let best = null, bestScore = 0;
    for (const it of b.items) {
      let score = 0;
      for (const s of it.sels) {
        let t = null;
        try { t = document.querySelector(s); } catch {}
        if (t) score = Math.max(score, t === el ? 3 : t.contains(el) ? 2.5 : el.contains(t) ? 1.2 : 0);
      }
      if (!score) { // no selector relation: overlap with the drawing's area
        const bb = it.bbox;
        const ix = Math.min(rect.x + rect.w, bb.x + bb.w) - Math.max(rect.x, bb.x);
        const iy = Math.min(rect.y + rect.h, bb.y + bb.h) - Math.max(rect.y, bb.y);
        if (ix > 0 && iy > 0) score = (ix * iy) / Math.max(1, Math.min(rect.w * rect.h, bb.w * bb.h));
      }
      if (score > bestScore) { bestScore = score; best = it; }
    }
    return best;
  }
  function highlight(c) {
    const r = c.el.getBoundingClientRect();
    const it = attribute(c.el, { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
    const color = it?.color || '#6965db';
    const rgb = hexRgb(color) || [105, 101, 219];
    const box = document.createElement('div');
    box.className = 'hl-box';
    box.style.setProperty('--c', color);
    box.style.setProperty('--glow', `rgba(${rgb.join(',')},.45)`);
    box.style.setProperty('--fill', `rgba(${rgb.join(',')},.08)`);
    if (it) box.innerHTML = `<span class="hl-tag">#${it.n}</span>`;
    hlEl.appendChild(box);
    const h = { el: c.el, box };
    hls.add(h);
    placeHl(h);
    trackHls();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => { box.remove(); hls.delete(h); }, reduce ? 1500 : 2700);
  }
  function placeHl({ el, box }) {
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect(), pad = 3;
    Object.assign(box.style, {
      left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + 2 * pad + 'px', height: r.height + 2 * pad + 'px',
    });
  }
  function trackHls() {
    if (hlRaf) return;
    const step = () => {
      hlRaf = 0;
      for (const h of hls) placeHl(h);
      if (hls.size) hlRaf = requestAnimationFrame(step);
    };
    hlRaf = requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- Claude status
  function renderEvent(ev) {
    switch (ev.kind) {
      case 'info': return `<div class="info">${esc(ev.text)}</div>`;
      case 'start': return `<div class="info">${ev.resumed ? 'Continuing the conversation' : 'New conversation'}${ev.model ? ' · ' + esc(ev.model) : ''}</div>`;
      case 'tool': return `<div class="tool"><b>${esc(ev.name)}</b> ${esc(ev.detail || '')}</div>`;
      case 'text': return `<div class="text">${esc(ev.text)}</div>`;
      case 'result': {
        const meta = [
          ev.durationMs ? `${Math.round(ev.durationMs / 1000)}s` : '',
          ev.costUsd ? `$${ev.costUsd.toFixed(3)}` : '',
          ev.denials?.length ? `permission denied: ${[...new Set(ev.denials)].join(', ')} (try --permission-mode)` : '',
        ].filter(Boolean).join(' · ');
        return `<div class="${ev.ok ? 'result' : 'error'}">${esc(ev.text || (ev.ok ? 'Done.' : 'Failed.'))}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}`;
      }
      case 'progress': return ev.state === 'done' ? `<div class="info">✓ #${esc(ev.n)}</div>` : '';
      case 'error': return `<div class="error">${esc(ev.text)}</div>`;
    }
    return '';
  }
  function renderRun(run) {
    state.run = run;
    const running = run?.status === 'running';
    const dismissed = !run || store.get(DISMISS_KEY) === run.id;
    statusEl.hidden = dismissed;
    $('[data-act="show-status"]').hidden = !(running && dismissed);
    if (!run) return;
    const title = {
      running: '<span class="spin"></span>Claude is working…',
      done: '<span class="dot" style="background:#2f9e44"></span>Done',
      error: '<span class="dot" style="background:#e03131"></span>Error',
      cancelled: '<span class="dot" style="background:#868e96"></span>Cancelled',
    }[run.status];
    statusEl.querySelector('h3').innerHTML = title;
    $('[data-act="cancel"]').hidden = !running;
    const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
    // the final answer arrives twice (last assistant text + result): show only the result
    const final = run.events.find((ev) => ev.kind === 'result')?.text;
    logEl.innerHTML = run.events.filter((ev) => !(ev.kind === 'text' && ev.text === final)).map(renderEvent).join('');
    if (stick || !running) logEl.scrollTop = logEl.scrollHeight;
  }

  function connect() {
    const es = new EventSource('/__over/events');
    es.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'hello') { state.hasSession = m.hasSession; renderRun(m.run); syncBatch(m.run, true); }
      else if (m.type === 'session') state.hasSession = m.hasSession;
      else if (m.type === 'run') {
        if (m.run.status !== 'running' && m.run.events.some((ev) => ev.sessionId)) state.hasSession = true;
        renderRun(m.run);
        syncBatch(m.run);
      } else if (m.type === 'reload') {
        persist();
        persistComments();
        saveBatch();
        location.reload();
      }
    };
  }

  // ---------------------------------------------------------------- init
  for (const g of groups()) seenKeys.add(g.key); // restored marks don't open the popover on their own
  syncFrame(); // only creates the iframe right away if this page has saved drawings
  renderBadges();
  connect();
})();
