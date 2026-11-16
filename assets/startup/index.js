import './fengyu-audio-data.js';
import './fengyu-audio.js';

export const FENGYU_SPLASH_ID = 'xd_fengyu_splash';
const NAME = '风雨如晦（上）';
const PREFIX = `extension_${NAME}_`;
const INSTANCE = Symbol.for('xd.fengyu.registered-splash');
const MEDIA = new URL('./', import.meta.url);
const fields = {
  enabled: 'fengyu_splash_enabled',
  previous: 'fengyu_splash_previous',
  modeSize: 'fengyu_splash_mode_size',
};

const MODE_SIZES = { compact: '紧凑', medium: '适中', original: '原尺寸' };
const modeSizeValue = lib => Object.hasOwn(MODE_SIZES, lib.config[PREFIX + fields.modeSize])
  ? lib.config[PREFIX + fields.modeSize] : 'medium';

// Hanging signs under the eave: how far each sign hangs below the base line (fraction of its height).
const HANG = [0.07, 0.17, 0.02, 0.13, 0.21, 0.09, 0.15, 0, 0.19, 0.05, 0.11, 0.16];
// Water drops painted on the thatch tips, in wallpaper pixels (the picture is 1672 x 941).
const ART_SIZE = [1672, 941];
const EAVE_DRIPS = [76, 100, 114, 104, 149, 108, 197, 110, 246, 106, 276, 102, 310, 108, 347, 104, 386, 100,
  478, 104, 510, 98, 549, 96, 600, 93, 649, 98, 708, 96, 767, 94, 796, 93, 837, 92, 879, 100, 924, 104, 969, 98,
  1008, 72, 1059, 90, 1105, 61, 1137, 74, 1215, 82, 1249, 84, 1283, 26, 1336, 58, 1404, 40, 1485, 30, 1550, 38,
  1599, 46, 1627, 30];
const RAIN_SLANT = 0.32; // the painted rain falls down and to the right
// Optional new art for each sign: assets/startup/modes/<mode>.png (or .jpg / .webp).
const ART_TYPES = ['png', 'jpg', 'jpeg', 'webp'];
const WOOD = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='480'>"
  + "<filter id='g' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='0.55 0.011' numOctaves='3' seed='11'/>"
  + "<feColorMatrix values='0 0 0 0 0.11 0 0 0 0 0.065 0 0 0 0 0.03 0 0 0 1.5 -0.48'/></filter>"
  + "<filter id='h' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='0.9 0.02' numOctaves='2' seed='3'/>"
  + "<feColorMatrix values='0 0 0 0 0.85 0 0 0 0 0.66 0 0 0 0 0.45 0 0 0 1.2 -0.62'/></filter>"
  + "<rect width='160' height='480' fill='#694729'/><rect width='160' height='480' filter='url(#h)'/><rect width='160' height='480' filter='url(#g)'/></svg>")}")`;

/** Native menu entries. All enable controls derive from the engine's splash_style. */
export function createFengyuSplashConfig(lib, game, ui) {
  const controller = () => installFengyuStartup(lib, game, ui);
  return {
    [fields.enabled]: {
      name: '风雨如晦启动页',
      init: lib.config.splash_style === FENGYU_SPLASH_ID,
      intro: '与外观中的启动页选择同步；关闭时恢复上一个样式。启动页内可立即切换，对局中设置下次启动生效。',
      onclick(on) { controller().setEnabled(on); },
    },
    [fields.modeSize]: {
      name: '模式按钮大小', init: modeSizeValue(lib), item: { ...MODE_SIZES },
      intro: '仅调整风雨如晦启动页的模式卡片；图片和模式入口保持原有内容。',
      onclick(size) { return controller().setModeSize(size); },
    },
  };
}

export function installFengyuStartup(lib, game, ui) {
  if (lib[INSTANCE]) return lib[INSTANCE];
  const appearance = lib.configMenu?.appearence?.config?.splash_style;
  const builtins = (lib.onloadSplashes || []).filter(x => ['style1', 'style2'].includes(x.id));
  if (!appearance || !builtins.some(x => x.id === 'style1')) throw new Error('风雨启动页需要支持 onloadSplashes 的无名杀版本');
  const records = new Map(builtins.map(splash => [splash.id, {
    splash, init: splash.init, dispose: splash.dispose,
  }]));
  let activeHost = null, removed = false, panel = null, focusBeforePanel = null;
  let lastStyle = lib.config.splash_style || 'style1';
  const watchedRows = new Set();
  const active = () => lib.config.splash_style === FENGYU_SPLASH_ID;
  const saveOption = (name, value) => game.saveExtensionConfig(NAME, fields[name], value);
  const registered = id => lib.onloadSplashes.some(x => x.id === id);
  const fallback = () => {
    const id = lib.config[PREFIX + fields.previous];
    return id && id !== FENGYU_SPLASH_ID && registered(id) ? id : 'style1';
  };

  // Reconcile the extension-menu mirror from the one authoritative engine setting.
  if (lib.config[PREFIX + fields.enabled] !== active()) saveOption('enabled', active());
  const css = document.createElement('style');
  css.id = 'xd-fengyu-startup-style';
  css.textContent = `
    @font-face{font-family:'xd-fy-yuanli';src:url("${(lib && lib.assetURL) || ''}font/yuanli.woff2") format('woff2');font-display:swap;}
    @font-face{font-family:'xd-fy-zhuan';src:url("${(lib && lib.assetURL) || ''}font/xiaozhuan.woff2") format('woff2');font-display:swap;}
    #splash.xd-fy-active{z-index:1;background:transparent!important;}
    .xd-fy-backdrop{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;background:#29271e;}
    .xd-fy-backdrop>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:none;border:0;}
    .xd-fy-backdrop>canvas{position:absolute;left:0;top:0;width:100%;height:100%;}
    .xd-fy-backdrop:after{content:'';position:absolute;inset:0;background:linear-gradient(#0a07053d,#0a07051a 28%,transparent 50%),linear-gradient(270deg,transparent 76%,#07090b40);}
    .xd-fy-backdrop.xd-fy-leaving{transition:opacity .8s;opacity:0;}
    .xd-fy-caption{position:absolute;z-index:1;top:12%;left:5.5%;writing-mode:vertical-rl;text-align:start;white-space:nowrap;color:#e7dfce;
      text-shadow:0 0 16px #000,0 0 5px #000c,0 2px 6px #000;font-family:'huangcao','xinwei',serif;}
    .xd-fy-caption strong{display:block;font-weight:400;font-size:clamp(26px,2.9vw,50px);letter-spacing:.06em;}
    .xd-fy-caption p{margin:0;margin-block-start:10px;font-size:clamp(15px,1.6vw,27px);line-height:1.8;letter-spacing:.12em;}
    .xd-fy-toolbar{position:fixed;right:18px;bottom:18px;z-index:5;display:flex;gap:10px;align-items:center;}
    .xd-fy-toolbar>.menubutton{position:relative;flex:0 0 auto;width:max-content;min-width:0;box-sizing:border-box;padding:7px 12px;white-space:nowrap;cursor:pointer;
      color:#f1e6cf!important;font-family:'yuanli','xd-fy-yuanli','xinwei',serif;letter-spacing:.08em;text-shadow:0 1px 2px #000;border:0!important;border-radius:6px!important;
      background:${WOOD} center/cover,#5d3f25!important;box-shadow:inset 0 1px 0 #ffe6be38,inset 0 0 0 1px #1e1208aa,inset 0 -6px 10px #0005,0 6px 12px -4px #000b!important;}
    .xd-fy-toolbar>.menubutton:hover{filter:brightness(1.15);}
    .xd-fy-popup{position:fixed;inset:0;z-index:30;background:#0006;}
    .xd-fy-panel.dialog{position:absolute!important;display:block!important;opacity:1!important;left:50%!important;top:50%!important;right:auto!important;bottom:auto!important;
      background-color:rgba(55,55,55,.98)!important;width:max-content!important;min-width:0!important;max-width:min(360px,calc(100vw - 24px))!important;box-sizing:border-box;height:auto!important;white-space:normal;max-height:82vh;transform:translate(-50%,-50%)!important;margin:0!important;padding:16px!important;overflow:auto;}
    .xd-fy-panel>*{position:relative;} .xd-fy-row>*{position:relative!important;}
    .xd-fy-panel .caption{position:relative;display:block;font-size:24px;margin-bottom:14px;}
    .xd-fy-choices{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0;}
    .xd-fy-size-choices{position:relative;display:flex;flex-wrap:wrap;gap:5px;}
    .xd-fy-panel .menubutton{position:relative;flex:0 0 auto;width:max-content;min-width:0;white-space:nowrap;cursor:pointer;padding:6px 10px;}
    .xd-fy-row{display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:12px;}
    .xd-fy-note{position:relative;display:block;max-width:25em;margin:12px 0;font-size:13px;line-height:1.7;opacity:.8;white-space:normal;overflow-wrap:anywhere;}
    .xd-fy-actions{display:flex;justify-content:flex-end;margin-top:14px;}
    #splash.xd-fy-active{--fy-mode-width:80px;--fy-mode-height:240px;--fy-mode-font:40px;--fy-mode-gap:8px;
      --fy-h:min(var(--fy-mode-height),max(110px,50vh));--fy-top:clamp(34px,9.5vh,120px);--fy-room:clamp(64px,10vw,170px);
      --fy-frame:calc(var(--fy-mode-width)*.09);--fy-frame-top:calc(var(--fy-mode-width)*.26);
      box-sizing:border-box;padding-left:var(--fy-room);overflow-y:hidden;}
    #splash.xd-fy-active[data-fy-mode-size="compact"]{--fy-mode-width:64px;--fy-mode-height:192px;--fy-mode-font:32px;--fy-mode-gap:6px;}
    #splash.xd-fy-active[data-fy-mode-size="original"]{--fy-mode-width:100px;--fy-mode-height:300px;--fy-mode-font:50px;--fy-mode-gap:10px;}
    #splash.xd-fy-active>div[link]{width:var(--fy-mode-width);height:var(--fy-h);vertical-align:top;margin:0 var(--fy-mode-gap);
      top:calc(var(--fy-top) + var(--fy-h)*var(--fy-hang,0));
      --fy-swing:calc((var(--fy-top) + var(--fy-h)*(var(--fy-hang,0) + .5))*var(--fy-sway,.8)*.01745);
      border:0!important;border-radius:calc(var(--fy-mode-width)*.18) calc(var(--fy-mode-width)*.18) 5px 5px!important;
      background:radial-gradient(circle at 50% calc(var(--fy-frame-top)*.5),#120b06 0 2.4px,#ffe2b452 3px 3.8px,transparent 4.4px),${WOOD} center/cover,#5d3f25!important;
      box-shadow:inset 0 1px 0 #ffe6be38,inset 0 0 0 1px #1e1208aa,inset 0 -12px 16px #0006,0 16px 22px -8px #000b,0 2px 4px #0006!important;
      animation:xd-fy-sway var(--fy-sway-time,6s) ease-in-out var(--fy-sway-delay,0s) infinite alternate;}
    #splash.xd-fy-active>div[link]:first-child{margin-left:calc(var(--fy-mode-gap)*2);}
    #splash.xd-fy-active>div[link]:last-child{margin-right:calc(var(--fy-mode-gap)*2);}
    #splash.xd-fy-active>div[link]:before{content:'';position:absolute;left:calc(50% - 1px);width:2px;height:100vh;bottom:calc(100% - var(--fy-frame-top)*.5);
      background:repeating-linear-gradient(#2c1e12 0 3px,#5e432a 3px 5px);box-shadow:1px 0 1px #0006;pointer-events:none;}
    #splash.xd-fy-active>div[link]:after{content:'';position:absolute;left:calc(50% - 2px);top:calc(100% - 3px);width:4px;height:6px;opacity:0;pointer-events:none;
      border-radius:50% 50% 50% 50%/40% 40% 60% 60%;background:radial-gradient(circle at 45% 35%,#fffffff0 0 18%,#d8e6eeb0 40%,#8fa9b866 68%,transparent 72%);
      animation:xd-fy-drip var(--fy-drip-time,6s) ease-in var(--fy-drip-delay,0s) infinite;}
    #splash.xd-fy-active>div[link]>.avatar{left:var(--fy-frame);top:var(--fy-frame-top);width:calc(100% - var(--fy-frame)*2);height:calc(100% - var(--fy-frame-top) - var(--fy-frame));
      border-radius:3px!important;background-size:cover;background-position:center;filter:sepia(.4) saturate(.74) brightness(.8) contrast(1.06);
      box-shadow:inset 0 0 0 1px #0009,inset 0 0 12px #000a!important;}
    #splash.xd-fy-active>div[link]>.avatar[data-fy-art="custom"]{filter:saturate(.95) brightness(.94);}
    #splash.xd-fy-active>div[link]>.avatar[data-fy-art="custom"]:after{background:linear-gradient(118deg,#fff4e01c,#fff4e000 34%),linear-gradient(#1a0f0600 72%,#1a0f0638);}
    #splash.xd-fy-active>div[link][data-fy-art="custom"]>.splashtext{top:calc(var(--fy-frame-top) + var(--fy-mode-width)*.07);bottom:auto;right:calc(var(--fy-frame) + var(--fy-mode-width)*.06);
      font-size:calc(var(--fy-mode-font)*.8);line-height:1.05;color:#24180e;text-shadow:0 0 1px #f1e6cc,0 0 6px #ecdfc0e0;}
    #splash.xd-fy-active>div[link][data-fy-art="custom"]>.splashtext:after{content:'雨';display:inline-block;margin-block-start:.34em;padding:.15em .11em;
      font:normal .36em/1.1 'xd-fy-zhuan','xiaozhuan',serif;color:#f7e9cf;background:#a42b1d;border-radius:.12em;box-shadow:inset 0 0 0 .07em #f7e9cf55;text-shadow:none;}
    #splash.xd-fy-active>div[link]>.avatar:after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;
      background:linear-gradient(118deg,#fff0d72e,#fff0d700 34%),linear-gradient(#1a0f0600 52%,#1a0f068c);}
    #splash.xd-fy-active>div[link]>.splashtext{font-size:var(--fy-mode-font);right:calc(var(--fy-frame) + 2px);bottom:calc(var(--fy-frame) + 3px);
      color:#f3e8cf;text-shadow:0 0 8px #000c,0 1px 2px #000;}
    #splash.xd-fy-active:not(.touch)>div[link]:hover:not(.clicked){transform:translateY(calc(var(--fy-h)*-.035));filter:brightness(1.13) saturate(1.06);}
    #splash.xd-fy-active>div[link].glow{box-shadow:inset 0 1px 0 #ffe6be38,inset 0 0 0 1px #1e1208aa,0 0 18px #ffbe6e88,0 16px 22px -8px #000b!important;}
    #splash.xd-fy-active>div[link].hidden{transform:translateY(calc((var(--fy-top) + var(--fy-h)*1.3)*-1));}
    #splash.xd-fy-active[data-fy-still]>div[link],#splash.xd-fy-active[data-fy-still]>div[link]:after{animation:none;}
    @keyframes xd-fy-sway{from{rotate:calc(var(--fy-sway,.8)*-1deg);translate:calc(var(--fy-swing)*-1) 0;}to{rotate:calc(var(--fy-sway,.8)*1deg);translate:var(--fy-swing) 0;}}
    @keyframes xd-fy-drip{0%{opacity:0;transform:scale(.2);}78%{opacity:.85;transform:scale(1);}84%{opacity:.9;transform:translateY(1px) scale(.85,1.25);}
      91%{opacity:0;transform:translateY(32vh) scale(.6,2.2);}100%{opacity:0;transform:translateY(32vh);}}
    @media(prefers-reduced-motion:reduce){#splash.xd-fy-active>div[link],#splash.xd-fy-active>div[link]:after{animation:none;}}
    @media(max-aspect-ratio:1/1){.xd-fy-backdrop>img{object-fit:contain;}}
    @media(max-height:500px){.xd-fy-toolbar{bottom:10px;right:10px;gap:6px}.xd-fy-toolbar>.menubutton{padding:5px 8px;font-size:13px}.xd-fy-panel.dialog{max-height:87vh;padding:12px!important}
      .xd-fy-caption{display:none;}#splash.xd-fy-active{--fy-room:0px;--fy-top:18px;}}
  `;
  document.head.append(css);

  // Reload only typography. Keep the current mode view and ambient-audio timer alive.
  let captionSheet = null, captionRevision = 0;
  const pendingCaptionSheets = new Map();
  function refreshCaptionStyle() {
    if (removed) return Promise.resolve(false);
    const revision = ++captionRevision;
    const sheet = document.createElement('link'); sheet.rel = 'stylesheet';
    const url = new URL('caption.css', MEDIA);
    url.searchParams.set('v', Date.now() + '-' + revision);
    sheet.href = url.href;
    return new Promise(resolve => {
      const finish = loaded => {
        pendingCaptionSheets.delete(sheet); sheet.onload = sheet.onerror = null;
        if (!loaded || removed || revision !== captionRevision) { sheet.remove(); resolve(false); return; }
        captionSheet?.remove(); captionSheet = sheet; resolve(true);
      };
      pendingCaptionSheets.set(sheet, finish);
      sheet.onload = () => finish(true); sheet.onerror = () => finish(false);
      document.head.append(sheet);
    });
  }
  refreshCaptionStyle();

  function button(parent, text, action) {
    const node = ui.create.div('.menubutton', text, parent, function(event) {
      event?.stopPropagation?.(); action();
    });
    node.setAttribute('role', 'button'); node.tabIndex = 0;
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); action(); }
    });
    return node;
  }

  function rowValue(name) {
    if (name === 'splash_style') return lib.config.splash_style || 'style1';
    if (name === PREFIX + fields.enabled) return active();
    if (name === PREFIX + fields.modeSize) return modeSizeValue(lib);
    return undefined;
  }
  function syncRow(row) {
    const cfg = row._link?.config;
    const value = rowValue(cfg?._name);
    if (value === undefined) return;
    watchedRows.add(row);
    if (cfg.item) {
      row._link.current = value;
      const label = cfg.item[value] || value;
      const target = row._link.choosing || row.lastElementChild;
      if (target && target.textContent !== label) target.textContent = label;
    } else row.classList.toggle('on', !!value);
    cfg.init = value;
  }
  function discover(root) {
    if (root.nodeType !== 1) return;
    if (root.matches('.config')) syncRow(root);
    for (const row of root.querySelectorAll('.config')) syncRow(row);
  }
  const menuObserver = new MutationObserver(events => {
    for (const event of events) for (const node of event.addedNodes) discover(node);
  });
  menuObserver.observe(document.body, { childList: true, subtree: true });
  discover(document.body);

  function syncControls() {
    if (activeHost) activeHost.node.dataset.fyModeSize = modeSizeValue(lib);
    for (const row of watchedRows) syncRow(row);
    if (activeHost?.toolbar) {
      activeHost.toggleButton.textContent = active() ? '之前的启动页' : '风雨如晦（上）';
      activeHost.toggleButton.setAttribute('aria-pressed', String(active()));
    }
    if (panel) {
      for (const node of panel.querySelectorAll('[data-mode-size]')) {
        const selected = node.dataset.modeSize === modeSizeValue(lib);
        node.classList.toggle('active', selected); node.setAttribute('aria-pressed', String(selected));
      }
      for (const node of panel.querySelectorAll('[data-style]')) {
        const selected = node.dataset.style === (lib.config.splash_style || 'style1');
        node.classList.toggle('active', selected); node.setAttribute('aria-pressed', String(selected));
      }
    }
  }

  function selectStyle(id, alreadySaved = false) {
    if (removed || !registered(id)) return false;
    const previous = lastStyle;
    if (id === FENGYU_SPLASH_ID && previous !== id && registered(previous)) saveOption('previous', previous);
    if (id !== FENGYU_SPLASH_ID) saveOption('previous', id);
    if (!alreadySaved) game.saveConfig('splash_style', id);
    lastStyle = id;
    saveOption('enabled', id === FENGYU_SPLASH_ID);
    syncControls();
    if (activeHost && !activeHost.entering && (records.has(id) || id === FENGYU_SPLASH_ID)) queueRender(activeHost, id);
    return true;
  }
  function setEnabled(on) { return selectStyle(on ? FENGYU_SPLASH_ID : (active() ? fallback() : lib.config.splash_style || 'style1')); }
  function setModeSize(size) {
    if (removed || !Object.hasOwn(MODE_SIZES, size)) return false;
    saveOption('modeSize', size); syncControls(); return true;
  }

  // Native optionsMenu already persists the selection before calling onsave.
  const originalSave = appearance.onsave, originalClick = appearance.onclick;
  const savedHook = function(value) {
    originalSave?.call(this, value); selectStyle(value, true);
  };
  const clickHook = function(value, ...args) {
    const result = originalClick.call(this, value, ...args);
    if (result !== false) selectStyle(value);
    return result;
  };
  if (originalClick) appearance.onclick = clickHook;
  else appearance.onsave = savedHook;

  function closePanel() {
    panel?.remove(); panel = null;
    document.removeEventListener('keydown', panelKey);
    if (focusBeforePanel?.isConnected) focusBeforePanel.focus();
    focusBeforePanel = null;
  }
  function panelKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); closePanel(); }
    if (event.key === 'Tab' && panel) {
      const items = Array.from(panel.querySelectorAll('[tabindex="0"]'));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
  function openPanel() {
    if (panel) { closePanel(); return; }
    focusBeforePanel = document.activeElement;
    panel = ui.create.div('.popup-container.xd-fy-popup', document.body);
    panel.addEventListener('click', event => { if (event.target === panel) closePanel(); });
    const box = ui.create.div('.dialog.popped.static.menubg.xd-fy-panel', panel);
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', '设置');
    ui.create.div('.caption', '设置', box);
    const choices = ui.create.div('.xd-fy-choices', box);
    for (const id of ['style1', 'style2', FENGYU_SPLASH_ID]) {
      const entry = lib.onloadSplashes.find(x => x.id === id);
      if (entry) button(choices, entry.name, () => selectStyle(id)).dataset.style = id;
    }
    const sizeRow = ui.create.div('.xd-fy-row', box);
    ui.create.div('', '模式按钮', sizeRow);
    const sizes = ui.create.div('.xd-fy-size-choices', sizeRow);
    for (const [size, label] of Object.entries(MODE_SIZES)) {
      button(sizes, label, () => setModeSize(size)).dataset.modeSize = size;
    }
    const actions = ui.create.div('.xd-fy-actions', box);
    const done = button(actions, '返回', closePanel);
    document.addEventListener('keydown', panelKey); syncControls(); done.focus();
  }

  // Give each sign its own hanging length, swing and drip timing, and load optional new art.
  function hangSigns(node) {
    const signs = node.querySelectorAll(':scope > div[link]');
    signs.forEach((sign, i) => {
      const s = sign.style;
      s.setProperty('--fy-hang', String(HANG[i % HANG.length]));
      s.setProperty('--fy-sway', (0.55 + ((i * 37) % 7) * 0.07).toFixed(2));
      const swing = 5.4 + ((i * 53) % 9) * 0.27;
      s.setProperty('--fy-sway-time', swing.toFixed(2) + 's');
      s.setProperty('--fy-sway-delay', (-((i * 1.9) % swing)).toFixed(2) + 's');
      const drip = 5 + ((i * 29) % 11) * 0.45;
      s.setProperty('--fy-drip-time', drip.toFixed(2) + 's');
      s.setProperty('--fy-drip-delay', (-((i * 2.3 + 1.1) % drip)).toFixed(2) + 's');
    });
    loadCustomArt(signs);
  }
  function applyArt(sign, url) {
    const avatar = sign.querySelector('.avatar');
    if (!avatar || !avatar.isConnected) return;
    const probe = new Image();
    probe.onload = () => {
      if (!avatar.isConnected) return;
      avatar.style.backgroundImage = `url("${url}")`; avatar.dataset.fyArt = 'custom'; sign.dataset.fyArt = 'custom';
    };
    probe.src = url;
  }
  function loadCustomArt(signs) {
    if (!signs.length) return;
    const modeArt = mode => new URL(`modes/${mode}`, MEDIA).href;
    const pick = files => {
      const names = new Map(files.map(file => [String(file).toLowerCase(), file]));
      for (const sign of signs) {
        const mode = sign.getAttribute('link');
        if (!mode) continue;
        for (const type of ART_TYPES) {
          const file = names.get(`${mode}.${type}`.toLowerCase());
          if (file) { applyArt(sign, modeArt(file)); break; }
        }
      }
    };
    if (typeof game.getFileList === 'function') {
      try { game.getFileList(`extension/${NAME}/assets/startup/modes`, (folders, files) => pick(files || []), () => {}); }
      catch (error) { console.warn('风雨木牌新图读取失败', error); }
    }
  }

  // Light rain and drips falling from the painted thatch. Purely visual, drawn behind the signs.
  function startWeather(layer, poster) {
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d');
    if (!g) return null;
    poster.after(canvas);
    let w = 0, h = 0, dpr = 1, scale = 1, ox = 0, oy = 0, frame = 0, last = 0, stopped = false;
    const streaks = [], drops = [], sources = [];
    for (let i = 0; i < EAVE_DRIPS.length; i += 2) sources.push({ x: EAVE_DRIPS[i], y: EAVE_DRIPS[i + 1], next: Math.random() * 2.5 });
    function streak(anywhere) {
      return {
        x: Math.random() * (w + h * RAIN_SLANT) - h * RAIN_SLANT, y: anywhere ? Math.random() * h : -30 - Math.random() * h * 0.3,
        v: h * (1.3 + Math.random() * 0.7), len: 10 + Math.random() * 22, a: 0.05 + Math.random() * 0.08,
      };
    }
    function fit() {
      dpr = Math.min(1.5, globalThis.devicePixelRatio || 1);
      w = layer.clientWidth || innerWidth; h = layer.clientHeight || innerHeight;
      canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
      const contain = getComputedStyle(poster).objectFit === 'contain';
      scale = (contain ? Math.min : Math.max)(w / ART_SIZE[0], h / ART_SIZE[1]);
      ox = (w - ART_SIZE[0] * scale) / 2; oy = (h - ART_SIZE[1] * scale) / 2;
      const count = Math.round(Math.min(150, (w * h) / 9000));
      streaks.length = 0;
      for (let i = 0; i < count; i++) streaks.push(streak(true));
    }
    function draw(now) {
      if (stopped) return;
      frame = requestAnimationFrame(draw);
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0; last = now;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); g.lineCap = 'round';
      g.lineWidth = 1;
      for (const s of streaks) {
        s.y += s.v * dt; s.x += s.v * dt * RAIN_SLANT;
        if (s.y - s.len > h) Object.assign(s, streak(false));
        g.strokeStyle = `rgba(224,229,232,${s.a})`;
        g.beginPath(); g.moveTo(s.x, s.y); g.lineTo(s.x - s.len * RAIN_SLANT, s.y - s.len); g.stroke();
      }
      for (const source of sources) {
        source.next -= dt;
        if (source.next <= 0) {
          drops.push({ x: ox + source.x * scale, y: oy + source.y * scale, v: 0 });
          source.next = 0.9 + Math.random() * 3.2;
        }
      }
      g.lineWidth = Math.max(1.2, 2.4 * scale); g.strokeStyle = 'rgba(236,240,240,.5)';
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        d.v += h * 3.2 * dt; d.y += d.v * dt;
        if (d.y > h + 40) { drops.splice(i, 1); continue; }
        const tail = Math.min(28, 3 + d.v * 0.02);
        g.beginPath(); g.moveTo(d.x, d.y - tail); g.lineTo(d.x, d.y); g.stroke();
      }
    }
    fit(); addEventListener('resize', fit);
    frame = requestAnimationFrame(draw);
    return { stop() { stopped = true; cancelAnimationFrame(frame); removeEventListener('resize', fit); canvas.remove(); } };
  }

  // Wallpaper, hanging signs and weather. Ambient sound has its own 8-second entry timer.
  function mountMedia(host) {
    const layer = ui.create.div('.xd-fy-backdrop', document.body);
    layer.setAttribute('aria-hidden', 'true');
    const poster = document.createElement('img');
    poster.src = new URL('fengyu-rural-storm.png', MEDIA).href;
    poster.alt = ''; poster.decoding = 'async';
    layer.append(poster);
    const still = !!lib.config.low_performance || !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let weather = null, sway = null, closed = false;
    if (!still) {
      try { weather = startWeather(layer, poster); }
      catch (error) { console.warn('风雨动态雨丝未加载', error); }
      // Bamboo, tree, grass and flowers moving in the wind and rain (WebGL); without it the picture stays still.
      import('./fengyu-sway.js').then(({ startFengyuSway }) => {
        if (closed) return;
        sway = startFengyuSway({ layer, poster, readFile: game.readFile, path: `extension/${NAME}/assets/startup/fengyu-rural-storm.png`, size: ART_SIZE });
      }).catch(error => console.warn('风雨植物摆动未加载', error));
    }
    const caption = ui.create.div('.xd-fy-caption', layer);
    caption.innerHTML = '<strong>风雨如晦（上）</strong><p>既见君子 云胡不喜</p>';
    host.node.classList.add('xd-fy-active');
    if (still) host.node.dataset.fyStill = '';
    hangSigns(host.node);
    const ambient = globalThis.createFengyuAmbientAudio({
      onError(error) { console.warn('风雨环境声暂不可用', error); },
    });
    ambient.setEnabled(true);
    function gesture() { if (!closed) ambient.resumeWithGesture(); }
    document.addEventListener('pointerdown', gesture);
    document.addEventListener('keydown', gesture);
    // leaving = a mode was chosen: let the scene and the sound fade with the closing signs.
    return { close(leaving = false) {
      if (closed) return; closed = true;
      document.removeEventListener('pointerdown', gesture);
      document.removeEventListener('keydown', gesture);
      if (leaving) {
        ambient.dispose(0.9);
        layer.classList.add('xd-fy-leaving');
        setTimeout(() => { weather?.stop(); sway?.stop(); layer.remove(); }, 900);
        return;
      }
      weather?.stop(); sway?.stop(); ambient.dispose(); layer.remove(); host.node.classList.remove('xd-fy-active'); delete host.node.dataset.fyStill;
    } };
  }

  async function renderHost(host, id) {
    if (activeHost !== host || host.entering || removed) return;
    if (host.styleId === id && host.delegate) return;
    host.media?.close(); host.media = null;
    host.delegate?.app?.unmount?.();
    host.node.replaceChildren(); host.node.classList.remove('touch', 'slim', 'removing', 'xd-fy-active');
    const record = records.get(id === FENGYU_SPLASH_ID ? 'style1' : id);
    if (!record) return;
    const delegate = new record.splash.constructor();
    host.delegate = delegate; host.record = record; host.styleId = id;
    await record.init.call(delegate, host.node, mode => {
      if (host.delegate !== delegate || host.entering || activeHost !== host) return;
      host.entering = true; closePanel(); host.toolbar?.remove(); host.media?.close(true); host.media = null;
      host.resolve(mode);
    });
    host.node.dataset.splash_style = id === 'style2' ? 'style2' : 'style1';
    if (id === FENGYU_SPLASH_ID && !host.entering) {
      try { host.media = mountMedia(host); }
      catch (error) { console.warn('风雨背景未加载，模式按钮仍可使用', error); }
    }
    syncControls();
  }
  function queueRender(host, id) {
    host.pending = host.pending.then(() => renderHost(host, id)).catch(error => console.error('切换启动页失败', error));
    return host.pending;
  }
  async function beginHost(node, resolve, id) {
    const host = { node, resolve, styleId: null, delegate: null, media: null, entering: false, pending: Promise.resolve() };
    activeHost = host;
    host.toolbar = ui.create.div('.xd-fy-toolbar', document.body);
    host.toggleButton = button(host.toolbar, '', () => setEnabled(!active()));
    button(host.toolbar, '设置', openPanel);
    host.observer = new MutationObserver(() => {
      if (!node.isConnected && activeHost === host) {
        host.media?.close(); host.toolbar.remove(); closePanel(); host.observer.disconnect(); activeHost = null;
      }
    });
    host.observer.observe(node.parentNode, { childList: true });
    await queueRender(host, id);
  }
  async function endHost(node) {
    const host = activeHost;
    if (!host || host.node !== node) { node.remove(); return true; }
    host.entering = true; await host.pending;
    closePanel(); host.toolbar.remove(); host.media?.close(true); host.media = null; host.observer.disconnect();
    try {
      const deleting = await host.record.dispose.call(host.delegate, node);
      if (!deleting) node.remove();
    } finally {
      host.delegate?.app?.unmount?.(); if (activeHost === host) activeHost = null;
    }
    return true;
  }

  // Register an independent third style. Built-in styles receive only the native toolbar.
  const custom = {
    id: FENGYU_SPLASH_ID, name: NAME,
    init(node, resolve) { return beginHost(node, resolve, FENGYU_SPLASH_ID); },
    dispose: endHost,
    preview(node) {
      node.className = 'button character'; node.style.width = '200px'; node.style.height = '112px';
      node.style.backgroundImage = `url("${new URL('fengyu-rural-storm.png', MEDIA).href}")`;
      node.style.backgroundSize = 'cover'; node.style.backgroundPosition = 'center';
      node.setAttribute('aria-label', NAME);
    },
  };
  lib.onloadSplashes.push(custom);
  for (const record of records.values()) {
    record.wrappedInit = (node, resolve) => beginHost(node, resolve, record.splash.id);
    record.wrappedDispose = endHost;
    record.splash.init = record.wrappedInit; record.splash.dispose = record.wrappedDispose;
  }
  const api = {
    id: FENGYU_SPLASH_ID, setEnabled, selectStyle, setModeSize, openPanel, refreshCaptionStyle,
    get enabled() { return active(); },
    async ready() { if (activeHost) await activeHost.pending; },
    async uninstall() {
      if (removed) return;
      if (active()) selectStyle(fallback());
      if (activeHost) await activeHost.pending;
      removed = true; closePanel(); menuObserver.disconnect(); watchedRows.clear();
      ++captionRevision; captionSheet?.remove();
      for (const finish of Array.from(pendingCaptionSheets.values())) finish(false);
      activeHost?.media?.close(); activeHost?.toolbar?.remove(); activeHost?.observer?.disconnect();
      for (const record of records.values()) {
        if (record.splash.init === record.wrappedInit) record.splash.init = record.init;
        if (record.splash.dispose === record.wrappedDispose) record.splash.dispose = record.dispose;
      }
      const index = lib.onloadSplashes.indexOf(custom); if (index >= 0) lib.onloadSplashes.splice(index, 1);
      if (appearance.onclick === clickHook) appearance.onclick = originalClick;
      if (appearance.onsave === savedHook) appearance.onsave = originalSave;
      delete appearance.item?.[FENGYU_SPLASH_ID]; css.remove(); delete lib[INSTANCE];
    },
  };
  lib[INSTANCE] = api;
  return api;
}



