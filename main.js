'use strict';

/* ============================================================
 * Vault Commander — an Obsidian plugin
 * A dual-panel orthodox file manager over the real filesystem.
 * Hand-written CommonJS (no build step). Desktop only.
 * ============================================================ */

const { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, MarkdownRenderer, Scope, Platform, normalizePath, Component } = require('obsidian');
// Node's `path` exists on desktop (Electron) but NOT on mobile — there is no Node
// runtime there, so `require('path')` is unavailable. The plus/Node build needs the
// real module for OS-correct paths; the vault build (which is what runs on mobile)
// only ever deals with POSIX, vault-relative paths, so a tiny pure-JS POSIX fallback
// is exact there. Either way `path` is always a usable object.
let path;
try { path = require('path'); } catch (_) { /* no Node on mobile */ }
if (!path || typeof path.extname !== 'function') {
  const str = (p) => String(p == null ? '' : p);
  path = {
    sep: '/',
    join(...a) {
      const j = a.filter((s) => s != null && s !== '').join('/').replace(/\/{2,}/g, '/');
      return j === '' ? '.' : j;
    },
    resolve(...a) { return path.join(...a); },
    dirname(p) { p = str(p).replace(/\/+$/, ''); const i = p.lastIndexOf('/'); return i < 0 ? '.' : (i === 0 ? '/' : p.slice(0, i)); },
    basename(p) { p = str(p).replace(/\/+$/, ''); const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); },
    extname(p) { const b = path.basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },
    relative(a, b) { return str(b); },
    isAbsolute(p) { return str(p).startsWith('/'); },
    parse(p) { return { root: str(p).startsWith('/') ? '/' : '' }; },
  };
}

const VC_NAME = "Vault Commander";                  /* @variant:name */
const VIEW_TYPE_NC = "vault-commander-view";        /* @variant:viewtype */
const VC_PROVIDER = "vault";                         /* @variant:provider */

const DEFAULTS = {
  leftPath: '',   // empty → resolved per backend in makePanelState (Node: home dir, Vault: root)
  rightPath: '',
  leftMode: 'list',   // list | info | tree | quick
  rightMode: 'list',
  leftSort: 'name',   // name | ext | time | size | unsorted
  rightSort: 'name',
  leftSortAsc: true,  // sort direction (true = ascending a..z / oldest / smallest)
  rightSortAsc: true,
  leftLayout: 'full', // full | wide
  rightLayout: 'full',
  theme: 'blue',      // blue (Commander Blue) | gray (Navigator Gray)
  hotlist: [],        // bookmarked directories
  hideMenu: false,    // true = menu only on F9; false = always-on docked top bar
  confirmDelete: true,
  confirmCopy: true,
  enableExec: true,
  showHidden: false,
  maxViewMB: 5,     // viewer (F3) text/code size cap in MB; quick-view text = 1/10 of this (capped at 1 MB)
  maxEditMB: 2,     // internal editor (F4) size cap in MB (editing is heavier than read-only viewing)
  maxImageMB: 32,   // image preview size cap in MB (viewer + quick view)
  openFullscreen: true,   // vault build / mobile: open the commander in fullscreen from the ribbon
  wrapText: false,  // wrap long lines in the text viewer / quick view (off = horizontal scroll)
  fullscreenHotkey: { meta: true, ctrl: false, alt: false, shift: false, key: 'F12' },
  screensaverEnabled: false,
  screensaverName: 'starnight',  // starnight | lines | polygons | fireworks | worms | tiles
  screensaverDelay: 1,         // idle minutes before screensaver starts
};

/* ── helpers ─────────────────────────────────────────────── */

function fmtSize(n) {
  // raw byte count with thousands separators, like classic NC
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}` +
    `  ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Node's `process` global is absent on mobile — guard with typeof (evaluated once).
const IS_WINDOWS = typeof process !== 'undefined' && !!process.platform && process.platform === 'win32';

function isRoot(dir) { return path.dirname(dir) === dir; }

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  return {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  }[ext] || 'application/octet-stream';
}

// turn raw bytes into a `data:` URL using the platform's own base64 encoder
// (FileReader). This avoids String.fromCharCode.apply, which throws on mobile
// engines (iOS/JavaScriptCore) for large argument counts. Works on desktop and
// mobile, for any image size. Accepts a Buffer, Uint8Array or ArrayBuffer.
function bytesToDataURL(data, mime) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const blob = new Blob([u8], { type: mime || 'application/octet-stream' });
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
    fr.readAsDataURL(blob);
  });
}

function nameCompare(a, b) { return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }); }

// validate a new file/folder name; returns an error string, or null if OK.
// Rejects path separators and characters illegal on common filesystems / in the
// Obsidian vault, plus reserved and trailing-space/dot names (Windows).
function invalidNameReason(name) {
  const n = String(name == null ? '' : name);
  if (!n.trim()) return 'Name must not be empty.';
  if (n === '.' || n === '..') return 'That name is reserved.';
  if (/[\\/]/.test(n)) return 'Name must not contain slashes ( / \\ ).';
  if (/[:*?"<>|]/.test(n)) return 'Name must not contain : * ? " < > |';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(n)) return 'Name must not contain control characters.';
  if (/[ .]$/.test(n)) return 'Name must not end with a space or a dot.';
  return null;
}

function hotkeyLabel(hk) {
  if (!hk || !hk.key) return '';
  const parts = [];
  if (hk.meta) parts.push('Cmd');
  if (hk.ctrl) parts.push('Ctrl');
  if (hk.alt) parts.push('Alt');
  if (hk.shift) parts.push('Shift');
  parts.push(hk.key.length === 1 ? hk.key.toUpperCase() : hk.key);
  return parts.join('+');
}

/* ── ZIP support (pure Node: read central directory, inflate entries) ── */
const ZIP_RE = /\.zip$/i;


// list the immediate children of a path inside the zip (synthesizes folders)
function buildZipListing(zip) {
  const prefix = zip.prefix;
  const dirSet = new Set();
  const files = [];
  for (const e of zip.entries) {
    if (!e.name.startsWith(prefix)) continue;
    const rest = e.name.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) files.push({ name: rest, isDir: false, size: e.uncompSize, mtime: e.mtime, zipEntry: e });
    else dirSet.add(rest.slice(0, slash));
  }
  const dirs = [...dirSet].map((d) => ({ name: d, isDir: true, size: 0, mtime: 0 }));
  dirs.sort(nameCompare); files.sort(nameCompare);
  return [{ name: '..', isDir: true, up: true, size: 0, mtime: 0 }].concat(dirs, files);
}

/* ── file-system providers ───────────────────────────────────
 * One source, two backends. The view talks only to `this.fp`.
 *   NodeProvider  — real filesystem (fs/os/child_process/zlib)  [++]
 *   VaultProvider — Obsidian vault adapter                      [public, Stage 2]
 * All I/O methods are async so the same call sites work for the
 * (synchronous) Node backend and the (async) vault adapter.
 * A normalized Stat = { isDir, isSymlink, size, mtime } and a
 * DirEntry = { name, isDir, size, mtime } hide fs.Stats specifics.
 * ─────────────────────────────────────────────────────────── */


// vault-relative POSIX path semantics: always '/', root is '' (the vault root),
// '..' is clamped so a path can never escape the vault.
class VaultPaths {
  get sep() { return '/'; }
  // normalise a list of segments, resolving '.'/'..' and dropping empties
  join(...parts) {
    const segs = [];
    for (const part of parts) {
      if (part == null) continue;
      for (const s of String(part).split('/')) {
        if (s === '' || s === '.') continue;
        if (s === '..') { if (segs.length) segs.pop(); }
        else segs.push(s);
      }
    }
    return segs.join('/');
  }
  resolve(...parts) { return this.join(...parts); }   // vault paths are always relative to the root
  dirname(p) { const s = String(p); const i = s.lastIndexOf('/'); return i < 0 ? '' : s.slice(0, i); }
  basename(p) { const s = String(p); const i = s.lastIndexOf('/'); return i < 0 ? s : s.slice(i + 1); }
  extname(p) { const b = this.basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); }
  relative(from, to) {
    const a = this.join(from).split('/').filter(Boolean);
    const b = this.join(to).split('/').filter(Boolean);
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return a.slice(i).map(() => '..').concat(b.slice(i)).join('/');
  }
  isAbsolute() { return false; }
  isRoot(p) { return !p || p === '/'; }
  root() { return ''; }
}

// Obsidian vault-adapter backend: all I/O stays inside the vault, no Node modules.
class VaultProvider {
  constructor(app) {
    this.app = app;
    this.adapter = app.vault.adapter;
    this.paths = new VaultPaths();
  }
  get capabilities() { return { exec: false, drives: false, archives: false, freeSpace: false, absolutePaths: false, clipboard: false }; }

  // adapter expects '/' for the vault root and slash-free relative paths elsewhere
  // use Obsidian's normalizePath (collapses //, strips leading/trailing /, fixes \).
  // adapter calls want a relative path; root is '/'.
  norm(p) { const s = normalizePath(String(p == null ? '' : p)); return (!s || s === '.') ? '/' : s; }
  homeDir() { return ''; }

  async list(dir, showHidden) {
    const out = [];
    if (dir && dir !== '/' && dir !== '') out.push({ name: '..', isDir: true, size: 0, mtime: 0, up: true });
    let res;
    try { res = await this.adapter.list(this.norm(dir)); } catch (e) { throw e; }
    const dirs = [], files = [];
    for (const f of res.folders) {
      const name = this.paths.basename(f);
      if (!showHidden && name.startsWith('.')) continue;
      let mtime = 0;
      try { const s = await this.adapter.stat(f); if (s) mtime = s.mtime; } catch (_) {}
      dirs.push({ name, isDir: true, size: 0, mtime });
    }
    for (const f of res.files) {
      const name = this.paths.basename(f);
      if (!showHidden && name.startsWith('.')) continue;
      let size = 0, mtime = 0;
      try { const s = await this.adapter.stat(f); if (s) { size = s.size; mtime = s.mtime; } } catch (_) {}
      files.push({ name, isDir: false, size, mtime });
    }
    return out.concat(dirs, files);
  }

  async readdirNames(p) {
    const res = await this.adapter.list(this.norm(p));
    return res.folders.concat(res.files).map((f) => this.paths.basename(f));
  }

  async stat(p) {
    const s = await this.adapter.stat(this.norm(p));
    if (!s) throw new Error('ENOENT: ' + p);
    return { isDir: s.type === 'folder', isSymlink: false, size: s.size || 0, mtime: s.mtime || 0 };
  }
  async lstat(p) { return this.stat(p); }
  async exists(p) { return this.adapter.exists(this.norm(p)); }
  async read(p) { return this.adapter.read(this.norm(p)); }
  async readBinary(p) { return this.adapter.readBinary(this.norm(p)); }
  async write(p, text) { await this.adapter.write(this.norm(p), text); }
  async writeBinary(p, data) { await this.adapter.writeBinary(this.norm(p), data); }
  // idempotent for an existing folder (so merge copy/move works), but a file of
  // the same name is a real conflict → throw (matches fs.mkdirSync semantics).
  async mkdir(p) {
    const n = this.norm(p);
    if (n === '/') return;
    const s = await this.adapter.stat(n);
    if (s) { if (s.type === 'folder') return; throw new Error('a file with that name already exists'); }
    await this.adapter.mkdir(n);
  }
  // non-recursive (like fs.rmdirSync): throws on a non-empty folder, so the
  // move cleanup correctly keeps folders whose files the user chose to skip.
  // (Recursive deletion goes through remove() below.)
  async rmdir(p) { await this.adapter.rmdir(this.norm(p), false); }
  async rename(a, b) { await this.adapter.rename(this.norm(a), this.norm(b)); }

  async remove(p) {
    const n = this.norm(p);
    const s = await this.adapter.stat(n);
    if (s && s.type === 'folder') await this.adapter.rmdir(n, true);
    else await this.adapter.remove(n);
  }

  // recursive copy (the adapter's copy is file-only / unreliable for folders)
  async copy(src, dst) {
    const s = await this.adapter.stat(this.norm(src));
    if (s && s.type === 'folder') {
      await this.mkdir(dst);
      const res = await this.adapter.list(this.norm(src));
      for (const f of res.folders.concat(res.files)) {
        await this.copy(f, this.paths.join(dst, this.paths.basename(f)));
      }
    } else {
      await this.adapter.writeBinary(this.norm(dst), await this.adapter.readBinary(this.norm(src)));
    }
  }

  async move(src, dst) {
    // overwrite cleanly (like FsProvider): the adapter's rename rejects an
    // existing target, so drop it first — otherwise the fallback copy+remove
    // could leave the source behind as a duplicate.
    if (await this.adapter.exists(this.norm(dst))) await this.remove(dst);
    try { await this.adapter.rename(this.norm(src), this.norm(dst)); }
    catch (_) { await this.copy(src, dst); await this.remove(src); }
  }

  async dirSize(dir, shouldCancel) {
    let total = 0;
    const stack = [this.norm(dir)];
    while (stack.length) {
      if (shouldCancel && shouldCancel()) return total;
      const d = stack.pop();
      let res;
      try { res = await this.adapter.list(d); } catch (_) { continue; }
      for (const f of res.folders) stack.push(f);
      for (const f of res.files) { try { const s = await this.adapter.stat(f); if (s) total += s.size || 0; } catch (_) {} }
    }
    return total;
  }

  async countFiles(p) {
    const s = await this.adapter.stat(this.norm(p));
    if (!s) return 0;
    if (s.type !== 'folder') return 1;
    const res = await this.adapter.list(this.norm(p));
    const kids = res.folders.concat(res.files);
    if (!kids.length) return 1;
    let n = 0;
    for (const k of kids) n += await this.countFiles(k);
    return n;
  }

  async volumes() { return []; }
  async freeSpace() { return null; }
  openInSystem() { /* not available in the vault build */ }
  exec() { /* not available in the vault build */ }
  async readZipCentral() { throw new Error('Archives are not available in the vault build.'); }
  async extractZipEntry() { throw new Error('Archives are not available in the vault build.'); }
}

/* ── the view ────────────────────────────────────────────── */

class NCView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    let fp;
    this.fp = fp || new VaultProvider(plugin.app);
    this.P = this.fp.paths;   // backend-specific path helper (real-OS vs. vault-relative posix)
    this.left = this.makePanelState('left', plugin.settings.leftPath);
    this.right = this.makePanelState('right', plugin.settings.rightPath);
    this.active = this.left;
    this.fullscreen = false;
    this.fileClip = null;   // { mode: 'copy'|'move', files: [{name, full}] } — Cmd+C/X
  }

  getViewType() { return VIEW_TYPE_NC; }
  getDisplayText() { return VC_NAME; }
  getIcon() { return 'panel-left-dashed'; }
  makePanelState(side, cwd) {
    const dir = cwd || this.fp.homeDir();
    const mode = this.plugin.settings[side + 'Mode'] || 'list';
    const sortKey = this.plugin.settings[side + 'Sort'] || 'name';
    const sortAsc = this.plugin.settings[side + 'SortAsc'] !== false;
    const layout = this.plugin.settings[side + 'Layout'] || 'full';
    return { side, cwd: dir, mode, sortKey, sortAsc, layout, tree: null, zip: null, entries: [], cursor: 0, tagged: new Set(), searchBuf: '', searchTime: 0, renderSeq: 0, el: null, listEl: null, headEl: null, footEl: null };
  }

  // fall back to home if a saved directory is no longer reachable
  async validateCwd(p) {
    try { if (!(await this.fp.exists(p.cwd))) p.cwd = this.fp.homeDir(); }
    catch (_) { p.cwd = this.fp.homeDir(); }
  }

  async onOpen() {
    this.buildDom();
    await this.validateCwd(this.left);
    await this.validateCwd(this.right);
    await this.loadPanel(this.left, this.left.cwd);
    await this.loadPanel(this.right, this.right.cwd);
    if (this.left.mode === 'tree') await this.initTree(this.left);
    if (this.right.mode === 'tree') await this.initTree(this.right);
    // never start with the keyboard focus on a passive (info/quick) panel
    if ((this.active.mode === 'info' || this.active.mode === 'quick')) {
      const o = this.otherOf(this.active);
      if (o.mode === 'list' || o.mode === 'tree') this.active = o;
    }
    this.renderAll();
    // mobile: fill the whole screen by default (Obsidian's header/tab chrome
    // otherwise eats space); respects the setting and is still toggleable (menu / F10)
    if (Platform.isMobile && this.plugin.settings.openFullscreen) window.setTimeout(() => this.setFullscreen(true), 0);
    window.setTimeout(() => this.focusView(), 0);
    this.initScreensaverSystem();
  }

  async onClose() {
    if (this._clockTimer) { window.clearInterval(this._clockTimer); this._clockTimer = null; }
    this.teardownTetris();   // stop a game left running when the leaf is closed
    this.menu = null;
    this.popMenuScope();
    window.clearTimeout(this._qsTimer);
    if (this._infoSizeTimer) { window.clearTimeout(this._infoSizeTimer); this._infoSizeTimer = null; }
    this._ssCancelTimer();
    if (this._ssAnimFrame) { cancelAnimationFrame(this._ssAnimFrame); this._ssAnimFrame = null; }
    if (this._ssCanvas) { this._ssCanvas.remove(); this._ssCanvas = null; }
    document.body.classList.remove('nc-fs-active');
    this._clearFsLeaf();
  }

  focusView() { this.rootEl && this.rootEl.focus(); }

  buildDom() {
    const c = this.contentEl;
    c.empty();
    c.addClass('nc-content');
    this.applyTheme();

    const root = c.createDiv({ cls: 'nc-root' });
    root.tabIndex = 0;
    this.rootEl = root;

    this.topbarEl = root.createDiv({ cls: 'nc-topbar' });   // persistent menu bar (when enabled)

    if (this._clockTimer) window.clearInterval(this._clockTimer);
    this._clockTimer = window.setInterval(() => this.updateClock(), 1000);

    const panels = root.createDiv({ cls: 'nc-panels' });
    this.left.el = this.buildPanel(panels, this.left);
    this.right.el = this.buildPanel(panels, this.right);

    // command line — only when the backend can run commands (Node build);
    // the vault build has no shell, so the row is omitted entirely
    this.cmdInput = null;
    if (this.fp.capabilities.exec) {
      const cmd = root.createDiv({ cls: 'nc-cmdline' });
      this.cmdPrompt = cmd.createSpan({ cls: 'nc-cmd-prompt', text: '' });   // cwd (ellipsised)
      this.cmdSep = cmd.createSpan({ cls: 'nc-cmd-sep', text: '' });          // " $ " / " > "
      this.cmdInput = cmd.createEl('input', { cls: 'nc-cmd-input', attr: { type: 'text', spellcheck: 'false' } });
    }

    // function key bar
    const bar = root.createDiv({ cls: 'nc-fnbar' });
    const keys = [
      ['1', 'Help', () => this.actHelp()],
      ['2', 'Menu', () => this.openUserMenu()],
      ['3', 'View', () => this.actView()],
      ['4', 'Edit', () => this.actEdit()],
      ['5', 'Copy', () => this.actCopy()],
      ['6', 'RenMov', () => this.actMove()],
      ['7', 'Mkdir', () => this.actMkdir()],
      ['8', 'Delete', () => this.actDelete()],
      ['9', 'PullDn', () => this.openPulldown()],
      ['10', 'Quit', () => this.actQuit()],
    ];
    this.fnActions = {};
    for (const [num, label, fn] of keys) {
      this.fnActions[num] = fn;
      const b = bar.createDiv({ cls: 'nc-fkey' });
      b.createSpan({ cls: 'nc-fkey-num', text: num });
      b.createSpan({ cls: 'nc-fkey-label', text: label });
      b.addEventListener('click', (e) => { e.preventDefault(); this.focusView(); fn(); });
    }

    this.renderTopbar();   // show the docked menu bar if "Hide menu" is off

    // events
    this.registerDomEvent(root, 'keydown', (e) => this.onKey(e));
    this.registerDomEvent(root, 'mousedown', () => {
      // clicking empty area keeps focus on the view for keyboard control
      if (document.activeElement !== this.cmdInput) this.focusView();
    });
    if (this.cmdInput) this.registerDomEvent(this.cmdInput, 'keydown', (e) => this.onCmdKey(e));
  }

  buildPanel(parent, p) {
    const el = parent.createDiv({ cls: 'nc-panel' });
    p.headEl = el.createDiv({ cls: 'nc-panel-head' });
    const colhead = el.createDiv({ cls: 'nc-colhead' });
    p.colName = colhead.createSpan({ cls: 'nc-c-name', text: 'Name' });
    p.colSize = colhead.createSpan({ cls: 'nc-c-size', text: 'Size' });
    p.colDate = colhead.createSpan({ cls: 'nc-c-date', text: 'Date' });
    // click a column header to sort by it; click the active column again to flip direction
    const sortOnClick = (el, key) => el.addEventListener('click', (e) => {
      e.stopPropagation(); this.setActive(p);
      // the Name column keeps its current name/ext key; clicking it toggles direction
      this.setSort(p, (key === 'name' && p.sortKey === 'ext') ? 'ext' : key);
    });
    sortOnClick(p.colName, 'name');
    sortOnClick(p.colSize, 'size');
    sortOnClick(p.colDate, 'time');
    p.listEl = el.createDiv({ cls: 'nc-list' });
    p.footEl = el.createDiv({ cls: 'nc-panel-foot' });

    el.addEventListener('mousedown', () => { this.setActive(p); });
    p.listEl.addEventListener('click', (e) => {
      const row = e.target.closest('.nc-row');
      if (!row) return;
      // ignore the click the browser synthesizes right after a long-press tag
      if (this._tagPressAt && Date.now() - this._tagPressAt < 600) { this._tagPressAt = 0; return; }
      const i = parseInt(row.dataset.i, 10);
      // Mobile has no reliable dblclick: a tap selects the row; tapping the row
      // you just tapped opens it. tapRow (not cursor) gates this, so the default
      // cursor position after navigating in does NOT count as a first tap.
      const reTap = Platform.isMobile && this.active === p && p.tapRow === i;
      this.active = p;
      if (reTap) { p.tapRow = -1; this.openEntry(); return; }
      p.cursor = i; p.tapRow = i;
      this.refreshMarks(this.left); this.refreshMarks(this.right); this.renderCmd();
    });
    p.listEl.addEventListener('dblclick', (e) => {
      if (Platform.isMobile) return;   // mobile opens via the re-tap logic above
      const row = e.target.closest('.nc-row');
      if (!row) return;
      this.active = p;
      p.cursor = parseInt(row.dataset.i, 10);
      this.openEntry();
    });
    // Mobile: long-press (500ms) on a row = Space (tag it; for folders also compute
    // the size). Gives multi-select + folder size without a swipe, which Obsidian
    // reserves for opening side panels. Passive listeners; a small move cancels it
    // so scrolling still works.
    if (Platform.isMobile) {
      let timer = null, sx = 0, sy = 0;
      const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      p.listEl.addEventListener('touchstart', (e) => {
        const row = e.target.closest('.nc-row');
        if (!row) return;
        const t = e.touches[0]; sx = t.clientX; sy = t.clientY;
        const i = parseInt(row.dataset.i, 10);
        cancel();
        timer = setTimeout(() => { timer = null; this._tagPressAt = Date.now(); this.longPressTag(p, i); }, 500);
      }, { passive: true });
      p.listEl.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) cancel();
      }, { passive: true });
      p.listEl.addEventListener('touchend', cancel, { passive: true });
      p.listEl.addEventListener('touchcancel', cancel, { passive: true });
    }
    return el;
  }

  // long-press handler: select the row and toggle its tag (same as Space)
  async longPressTag(p, i) {
    const en = p.entries[i];
    if (!en || en.up) return;
    this.setActive(p); p.cursor = i;
    await this.toggleTag();
  }

  /* ── data ── */

  async loadPanel(p, dir) {
    p.zip = null;
    const target = this.P.resolve(dir);
    let entries;
    try {
      entries = await this.fp.list(target, this.plugin.settings.showHidden);
    } catch (e) {
      new Notice(`Zugriff verweigert: ${target}`);
      return false;
    }
    p.cwd = target;
    p.entries = entries;
    this.applySort(p);
    p.tagged = new Set();
    if (p.cursor >= entries.length) p.cursor = Math.max(0, entries.length - 1);
    this.persist();
    return true;
  }

  persist() {
    this.plugin.settings.leftPath = this.left.cwd;
    this.plugin.settings.rightPath = this.right.cwd;
    this.plugin.settings.leftMode = this.left.mode;
    this.plugin.settings.rightMode = this.right.mode;
    this.plugin.settings.leftSort = this.left.sortKey;
    this.plugin.settings.rightSort = this.right.sortKey;
    this.plugin.settings.leftSortAsc = this.left.sortAsc;
    this.plugin.settings.rightSortAsc = this.right.sortAsc;
    this.plugin.settings.leftLayout = this.left.layout;
    this.plugin.settings.rightLayout = this.right.layout;
    this.plugin.saveSettings();
  }

  /* ── rendering ── */
  renderAll() { this.renderPanel(this.left); this.renderPanel(this.right); this.renderCmd(); }

  // dispatch to the right renderer based on the panel's view mode
  renderPanel(p) {
    p.tapRow = -1;   // any full re-render (navigation/sort/toggle) disarms mobile tap-to-open
    p.el.classList.remove('nc-mode-list', 'nc-mode-info', 'nc-mode-tree', 'nc-mode-quick');
    p.el.classList.add('nc-mode-' + p.mode);
    p.el.toggleClass('nc-layout-wide', p.mode === 'list' && p.layout === 'wide');
    if (p.mode === 'info') return this.renderInfoPanel(p);
    if (p.mode === 'tree') return this.renderTreePanel(p);
    if (p.mode === 'quick') return this.renderQuickPanel(p);
    return this.renderListPanel(p);
  }

  // full rebuild of a panel's rows — used on load / refresh / dir change
  renderListPanel(p) {
    p.headEl.empty();
    const pathEl = p.headEl.createDiv({ cls: 'nc-panel-path' });
    const starEl = p.headEl.createDiv({ cls: 'nc-panel-star' });
    starEl.innerHTML = '★'; // yellow star
    starEl.addEventListener('click', (e) => { e.stopPropagation(); this.setActive(p); this.openHotlist(); });

    if (p.zip) {
      pathEl.setText(`${p.zip.path} ▸ /${p.zip.prefix.replace(/\/$/, '')}`);
    } else {
      const innerPath = pathEl.createSpan();
      innerPath.style.direction = 'ltr';
      innerPath.style.unicodeBidi = 'plaintext';

      const navToPart = async (targetPath) => {
        if (p.cwd === targetPath) return;
        if (await this.loadPanel(p, targetPath)) {
          p.cursor = 0; this.renderPanel(p); this.renderCmd();
        }
      };

      let segments = [];
      let current = p.cwd;
      // On the vault build the root cwd is '' (falsy); emit a single '/' root
      // segment so the header is never blank (regression from dispPath()).
      if (!current) segments.unshift({ name: '/', path: current });
      while (current) {
        if (this.P.isRoot(current) || current === '/') {
          segments.unshift({ name: this.fp.capabilities.absolutePaths ? (this.P.root(p.cwd) || '/') : '/', path: current });
          break;
        }
        let b = this.P.basename(current);
        if (!b) break;
        segments.unshift({ name: b, path: current });
        let parent = this.P.dirname(current);
        if (parent === current) break;
        current = parent;
      }

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (i > 0) {
          const sepText = this.P.sep || '/';
          let s = sepText;
          if (segments[i-1].name.endsWith(sepText)) {
            s = '';
          }
          if (s) {
            innerPath.createSpan({ text: s });
          }
        }
        const sEl = innerPath.createSpan({ text: seg.name });
        sEl.style.cursor = 'pointer';
        sEl.addEventListener('mouseenter', () => { sEl.style.textDecoration = 'underline'; });
        sEl.addEventListener('mouseleave', () => { sEl.style.textDecoration = 'none'; });
        sEl.addEventListener('click', (e) => { e.stopPropagation(); this.setActive(p); navToPart(seg.path); });
      }
    }
    this.updateColHead(p);
    const wide = p.layout === 'wide';
    p.listEl.empty();
    for (let i = 0; i < p.entries.length; i++) {
      const en = p.entries[i];
      const row = p.listEl.createDiv({ cls: en.isDir ? 'nc-row nc-dir' : 'nc-row' });
      row.dataset.i = String(i);
      row.createSpan({ cls: 'nc-name', text: en.up ? '..' : en.name });
      if (!wide) {   // Wide view shows names only, in multiple columns
        let sizeCol;
        if (en.up) sizeCol = '‹UP›';
        else if (en.isDir) sizeCol = (en.dirSize != null) ? fmtSize(en.dirSize) : '‹DIR›';
        else sizeCol = fmtSize(en.size);
        row.createSpan({ cls: 'nc-size', text: sizeCol });
        row.createSpan({ cls: 'nc-date', text: en.up ? '' : fmtDate(en.mtime) });
      }
    }
    this.refreshMarks(p);
  }

  // lightweight update: only toggle cursor / tagged / active classes,
  // WITHOUT rebuilding the DOM (so native dblclick keeps working)
  refreshMarks(p) {
    p.el.toggleClass('nc-active', p === this.active);
    if (p.mode === 'tree') { this.refreshTreeMarks(p); return; }
    if (p.mode !== 'list') return;   // info / quick are passive — nothing to mark
    const rows = p.listEl.children;
    for (let i = 0; i < rows.length; i++) {
      const en = p.entries[i];
      rows[i].classList.toggle('nc-cursor', i === p.cursor);
      rows[i].classList.toggle('nc-tagged', !!(en && !en.up && p.tagged.has(en.name)));
    }
    this.updateFoot(p);
    const curEl = rows[p.cursor];
    if (curEl) curEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.syncSpecials(p);   // a dependent Info / Quick view on the other side follows along
  }

  updateFoot(p) {
    let foot;
    if (p.tagged.size) {
      let total = 0;
      for (const en of p.entries) {
        if (en.up || !p.tagged.has(en.name)) continue;
        total += en.isDir ? (en.dirSize || 0) : en.size;
      }
      foot = `${p.tagged.size} tagged · ${fmtSize(total)} bytes`;
    } else {
      // full detail for the one selected entry — the only place to see
      // size/date in the Wide view, useful everywhere else too
      const cur = p.entries[p.cursor];
      if (!cur) foot = '';
      else if (cur.up) foot = '..';
      else {
        const size = cur.isDir ? (cur.dirSize != null ? `${fmtSize(cur.dirSize)} bytes` : '‹DIR›') : `${fmtSize(cur.size)} bytes`;
        const date = cur.mtime ? fmtDate(cur.mtime) : '';
        foot = `${cur.name}   ${size}${date ? '   ' + date : ''}`;
      }
    }
    p.footEl.setText(foot);
  }

  renderCmd() {
    if (!this.cmdInput) return;   // no command line in the vault build
    const sep = IS_WINDOWS ? '>' : '$';
    // a passive (info/quick) panel has no meaningful cwd of its own — show the file panel's
    const p = (this.active.mode === 'list' || this.active.mode === 'tree') ? this.active : (this.workPanel() || this.active);
    this.cmdPrompt.setText(this.dispPath(p.cwd));
    this.cmdSep.setText(` ${sep} `);
  }

  /* ── navigation ── */

  setActive(p) {
    if (this.active === p) return;
    this.active = p;
    this.refreshMarks(this.left); this.refreshMarks(this.right); this.renderCmd();
  }

  otherPanel() { return this.active === this.left ? this.right : this.left; }

  moveCursor(delta) {
    const p = this.active;
    const n = p.entries.length;
    if (!n) return;
    p.cursor = Math.max(0, Math.min(n - 1, p.cursor + delta));
    this.refreshMarks(p);
  }

  pageSize(p) {
    const rowH = 20;
    return Math.max(1, Math.floor(p.listEl.clientHeight / rowH) - 1);
  }

  async openEntry() {
    const p = this.active;
    const en = p.entries[p.cursor];
    if (!en) return;
    if (en.up) return this.goUp();

    // inside an archive
    if (p.zip) {
      if (en.isDir) {
        p.zip.prefix = p.zip.prefix + en.name + '/';
        p.entries = buildZipListing(p.zip);
        this.applySort(p);
        p.cursor = 0; this.renderPanel(p); this.renderCmd();
      } else {
        this.actView();
      }
      return;
    }

    if (en.isDir) {
      const target = this.P.join(p.cwd, en.name);
      if (await this.loadPanel(p, target)) { p.cursor = 0; this.renderPanel(p); this.renderCmd(); }
      return;
    }

    const full = this.P.join(p.cwd, en.name);

    // a .zip → step into it like a folder
    if (ZIP_RE.test(en.name) && this.fp.capabilities.archives) {
      if (await this.enterZip(p, full)) { this.renderPanel(p); this.renderCmd(); }
      return;
    }

    // markdown / canvas inside the vault → open in Obsidian
    const vaultFile = this.toVaultPath(full);
    if (vaultFile && /\.(md|canvas)$/i.test(en.name)) {
      const af = this.app.vault.getAbstractFileByPath(vaultFile);
      // leave fullscreen first: opening in a new tab restructures the tab group,
      // which would strand the fixed-positioned commander (blank tab on return).
      // Dropping to a normal tab avoids that; the observer only covers same-leaf
      // re-layouts (e.g. mobile rotation), not tab-group changes.
      if (af) { this.setFullscreen(false); this.app.workspace.getLeaf(true).openFile(af); return; }
    }
    this.actView();
  }

  async goUp() {
    const p = this.active;

    if (p.zip) {
      if (p.zip.prefix === '') {
        // leave the archive, land back on the .zip file itself
        const zipPath = p.zip.path;
        p.zip = null;
        if (await this.loadPanel(p, this.P.dirname(zipPath))) {
          const base = this.P.basename(zipPath);
          const idx = p.entries.findIndex((e) => !e.up && e.name === base);
          p.cursor = idx >= 0 ? idx : 0;
          this.renderPanel(p); this.renderCmd();
        }
      } else {
        const trimmed = p.zip.prefix.replace(/[^/]+\/$/, '');
        const leaving = p.zip.prefix.slice(trimmed.length).replace(/\/$/, '');
        p.zip.prefix = trimmed;
        p.entries = buildZipListing(p.zip);
        this.applySort(p);
        const idx = p.entries.findIndex((e) => !e.up && e.isDir && e.name === leaving);
        p.cursor = idx >= 0 ? idx : 0;
        this.renderPanel(p); this.renderCmd();
      }
      return;
    }

    if (this.P.isRoot(p.cwd)) return;
    const leaving = this.P.basename(p.cwd);
    const parent = this.P.dirname(p.cwd);
    if (await this.loadPanel(p, parent)) {
      const idx = p.entries.findIndex((e) => !e.up && e.isDir && e.name === leaving);
      p.cursor = idx >= 0 ? idx : 0;
      this.renderPanel(p); this.renderCmd();
    }
  }

  async toggleTag() {
    const p = this.active;
    const en = p.entries[p.cursor];
    if (!en || en.up) return;
    if (p.tagged.has(en.name)) {
      p.tagged.delete(en.name);
    } else {
      p.tagged.add(en.name);
      // compute the recursive content size of a tagged folder, show it in the Size column
      if (en.isDir) await this.computeDirSize(p, en);
    }
    // desktop advances to the next row (rapid Space-tagging); on mobile the
    // long-press should leave the cursor on the row you just marked.
    if (!Platform.isMobile) p.cursor = Math.min(p.entries.length - 1, p.cursor + 1);
    this.renderPanel(p);
  }

  getSelection(p) {
    p = p || this.workPanel() || this.active;
    let names;
    if (p.tagged.size) names = [...p.tagged];
    else {
      const en = p.entries[p.cursor];
      if (!en || en.up) return [];
      names = [en.name];
    }
    return names.map((n) => {
      const en = p.entries.find((e) => !e.up && e.name === n);
      return { name: n, full: p.zip ? null : this.P.join(p.cwd, n), en };
    });
  }

  async refresh() {
    const lc = this.left.cursor, rc = this.right.cursor;
    if (this.left.mode === 'list') await this.reloadOne(this.left);
    if (this.right.mode === 'list') await this.reloadOne(this.right);
    if (this.left.mode === 'tree') await this.initTree(this.left);
    if (this.right.mode === 'tree') await this.initTree(this.right);
    this.left.cursor = Math.max(0, Math.min(lc, this.left.entries.length - 1));
    this.right.cursor = Math.max(0, Math.min(rc, this.right.entries.length - 1));
    this.renderAll();
  }

  async reloadOne(p) {
    if (p.zip) {
      try { p.zip.entries = await this.fp.readZipCentral(p.zip.path); } catch (_) { /* keep old listing */ }
      p.entries = buildZipListing(p.zip);
      this.applySort(p);
    } else {
      await this.loadPanel(p, p.cwd);
    }
  }

  toVaultPath(full) {
    // vault backend: the path already IS vault-relative
    if (!this.fp.capabilities.absolutePaths) return full || '';
    const adapter = this.app.vault.adapter;
    const base = adapter && adapter.basePath;
    if (!base) return null;
    const rel = this.P.relative(base, full);
    if (rel.startsWith('..') || this.P.isAbsolute(rel)) return null;
    return rel.split(this.P.sep).join('/');
  }

  // human-readable path for headers / prompts. Vault paths are shown rooted
  // ("/", "/Ordner1/ABC") so the vault feels like a self-contained root;
  // absolute (node) paths are shown as-is.
  dispPath(p) {
    if (this.fp.capabilities.absolutePaths) return p || '/';
    const s = this.P.join(p || '');
    return s ? '/' + s : '/';
  }

  /* ── keyboard ── */

  onKey(e) {
    if (e.target === this.cmdInput) return;
    if (this._ssWake()) { e.preventDefault(); return; }   // a key dismisses the screensaver
    if (this.menu) { this.menuKey(e); return; }
    // function keys, Tab and drive switches work the same in every panel mode
    if (this.handleGlobalKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    const p = this.active;
    let handled;
    if (p.mode === 'tree') handled = this.treeNavKey(e);
    else if (p.mode === 'info' || p.mode === 'quick') handled = this.passiveNavKey(e);
    else handled = this.listNavKey(e);
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  // F-keys / Tab / Alt+F1·F2 — independent of the active panel's view mode
  handleGlobalKey(e) {
    // Strg+F3..F7 — set the sort order of the active file panel
    if (e.ctrlKey && /^F[3-7]$/.test(e.key)) {
      const sp = this.workPanel() || this.active;
      const map = { F3: 'name', F4: 'ext', F5: 'time', F6: 'size', F7: 'unsorted' };
      if (sp.mode === 'list') this.setSort(sp, map[e.key]);
      return true;
    }
    if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) { this.openHotlist(); return true; }
    if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) { this.actRenameInPlace(); return true; }
    // Cmd/Ctrl+C·X·V — file clipboard (copy / cut / paste). On the standalone the
    // native Edit menu owns these (focus-aware), so we bind them here only for the
    // Obsidian builds, where there is no such menu. Text fields are unaffected:
    // onKey() ignores the command line, and the editor/dialogs are separate modals.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && /^[cxv]$/i.test(e.key)) {
      const nativeEdit = typeof window !== 'undefined' && window.__vc && window.__vc.nativeEditMenu;
      // Never hijack a live text selection (e.g. Ctrl+C on text in Quick View /
      // Info / Tree) — let the browser's native copy handle it.
      const hasTextSel = typeof window !== 'undefined' && window.getSelection && String(window.getSelection()).length > 0;
      if (!nativeEdit && !hasTextSel) {
        const k = e.key.toLowerCase();
        if (k === 'c') this.actFileCopy();
        else if (k === 'x') this.actFileCut();
        else this.actPaste();
        return true;
      }
    }
    if (e.altKey && e.key === 'F1') { if (this.fp.capabilities.drives) this.actDrive(this.left); return true; }
    if (e.altKey && e.key === 'F2') { if (this.fp.capabilities.drives) this.actDrive(this.right); return true; }
    switch (e.key) {
      case 'Tab': this.setActive(this.otherPanel()); return true;
      case 'F1': this.actHelp(); return true;
      case 'F2': this.openUserMenu(); return true;
      case 'F3': this.actView(); return true;
      case 'F4': this.actEdit(); return true;
      case 'F5': this.actCopy(); return true;
      case 'F6': this.actMove(); return true;
      case 'F7': this.actMkdir(); return true;
      case 'F8':
      case 'Delete': this.actDelete(); return true;
      case 'F9': this.openPulldown(); return true;
      case 'F10': this.actQuit(); return true;
      default: return false;
    }
  }

  // cursor / open / tag — normal file-list panel
  listNavKey(e) {
    const p = this.active;
    const wide = p.layout === 'wide';
    switch (e.key) {
      case 'ArrowUp': this.moveCursor(-1); return true;
      case 'ArrowDown': this.moveCursor(1); return true;
      case 'ArrowLeft': if (wide) { this.moveCursor(-this.colRows(p)); return true; } return false;
      case 'ArrowRight': if (wide) { this.moveCursor(this.colRows(p)); return true; } return false;
      case 'PageUp': this.moveCursor(-this.pageSize(p)); return true;
      case 'PageDown': this.moveCursor(this.pageSize(p)); return true;
      case 'Home': p.cursor = 0; this.refreshMarks(p); return true;
      case 'End': p.cursor = p.entries.length - 1; this.refreshMarks(p); return true;
      case 'Enter': this.openEntry(); return true;
      case 'Backspace': this.goUp(); return true;
      case 'Escape': if (p.searchBuf) { p.searchBuf = ''; this.updateFoot(p); return true; } return false;
      case ' ':
      case 'Insert': this.toggleTag(); return true;
      default:
        // quick filter: a printable key jumps to the matching entry
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { this.quickSearch(e.key); return true; }
        return false;
    }
  }

  // Info / Quick view are passive — arrows just scroll their content
  passiveNavKey(e) {
    const c = this.active.listEl;
    switch (e.key) {
      case 'ArrowDown': c.scrollTop += 20; return true;
      case 'ArrowUp': c.scrollTop -= 20; return true;
      case 'PageDown': c.scrollTop += c.clientHeight * 0.9; return true;
      case 'PageUp': c.scrollTop -= c.clientHeight * 0.9; return true;
      case 'Home': c.scrollTop = 0; return true;
      case 'End': c.scrollTop = c.scrollHeight; return true;
      default: return false;
    }
  }

  onCmdKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); this.runCommand(this.cmdInput.value); this.cmdInput.value = ''; }
    else if (e.key === 'Escape') { e.preventDefault(); this.cmdInput.value = ''; this.focusView(); }
  }

  /* ── actions ── */

  actHelp() {
    const cap = this.fp.capabilities;
    const sections = [];
    if (Platform.isMobile) sections.push(
`VAULT COMMANDER — Touch gestures

  Tap a row . . . . . . select it (move the cursor)
  Tap it again  . . . . open: enter the folder / view the file
  Long-press a row  . . mark it (= Space). Folders also show their size.
                        Long-press several rows to multi-select for Copy / Move.
  Tap the path header . open the bookmarks dialog for that panel
  Bottom F-key bar  . . tap F1–F10 to run those actions
  Bookmarks . . . . . . tap an entry to go there; the red ✕ removes it.`);
    sections.push(
`VAULT COMMANDER — Keyboard

  ↑ ↓ . . . . . Move cursor            Enter . . Open / enter directory
  PgUp/PgDn . . Page up / down         Backspace Go up one level (..)
  Home/End  . . Top / bottom           Tab . . . Activate the other panel
  Space/Ins . . Tag file

  F2 User menu   F3 View   F4 Edit   F5 Copy
  F6 Move/Rename   F7 Make directory   F8 Delete
  F9 Pull-down menu   F10 Close`);
    if (cap.drives) sections.push(`  Alt+F1 / Alt+F2 . . Drive/volume for the left / right panel`);
    sections.push(
`  Fullscreen hotkey . opens / brings the Commander to fullscreen (default Cmd+F12,
                      changeable in settings). F10 closes it again.`);
    if (cap.archives) sections.push(
`  Archives: Enter on a .zip opens it like a folder.
  Inside: F3 view, F5 extract to the other panel, .. leaves the archive.`);
    sections.push(
`  F9 opens the menu on the side of the active panel (Left or Right).
  Options → "Hide menu": turn off to keep the menu bar always docked on top.

  Panel views (F9 → Left / Right): Full · Wide · Info · Tree · Quick view.
  Wide shows names only in several columns (←→ move between columns).
  Tree: ↑↓ selects (the other panel follows), → expand, ← collapse,
        Enter/Space toggle. Info & Quick view show info / a live preview
        of the other (file) panel.

  Sorting (Ctrl+F3..F7 or the Left/Right menu): Name · Extension · Time ·
        Size · Unsorted. The active column is marked with ▾ in the header.

  Quick filter: just type — the cursor jumps to the matching entry; the
        same letter again jumps to the next match; Esc clears the filter.
  Ctrl+D: bookmarked folders (1–9 = open by number, Enter = go,
        Ins = bookmark current, Del = remove). Themes: F9 → Options.
  Copy/Move onto an existing file asks: Overwrite / all / Skip / Rename;
        folders merge, prompting per conflicting file inside.
  F3 on an image: hover to read the pixel colour (#hex); click copies it.

  In menus: ↑↓ select, ←→ switch category (F9), Enter run, Esc close.`);
    if (cap.exec) sections.push(
`  Command line at the bottom: 'cd <path>' changes the active panel,
  any other command runs in the current directory.`);
    if (!Platform.isMobile) sections.push(
`Note: on macOS the function keys may be claimed by the system —
the bar at the bottom is clickable and always works.`);
    new ViewerModal(this.app, { title: 'Help', content: sections.join('\n\n') }).open();
  }

  // viewer size limits (MB in settings → bytes), with a safe fallback if mis-set.
  // Quick view uses a fraction of the viewer limit (capped) so the live preview
  // stays responsive as the cursor moves.
  viewLimit()  { const mb = Number(this.plugin.settings.maxViewMB);  return (mb > 0 ? mb : DEFAULTS.maxViewMB)  * 1024 * 1024; }
  editLimit()  { const mb = Number(this.plugin.settings.maxEditMB);  return (mb > 0 ? mb : DEFAULTS.maxEditMB)  * 1024 * 1024; }
  imageLimit() { const mb = Number(this.plugin.settings.maxImageMB); return (mb > 0 ? mb : DEFAULTS.maxImageMB) * 1024 * 1024; }
  quickTextLimit() { return Math.min(this.viewLimit() / 10, 1024 * 1024); }

  async actView() {
    const wp = this.workPanel();
    if (!wp) { new Notice('No file panel active.'); return; }

    // work out which entry to open first (the cursor's file)
    let startIdx;
    if (wp.zip) {
      const cur = wp.entries[wp.cursor];
      if (!cur || cur.up || cur.isDir) { new Notice('No file to view.'); return; }
      startIdx = wp.cursor;
    } else {
      const sel = this.getSelection(wp);
      if (!sel.length) return;
      const name = sel[0].name;
      startIdx = wp.entries.findIndex((e) => !e.up && e.name === name);
      if (startIdx < 0) startIdx = wp.cursor;
    }

    // build the first page; a failure here is explicit (Notice shown)
    const opts = await this.buildViewerOpts(wp, wp.entries[startIdx], false);
    if (!opts) return;

    // Prev/Next paging: step through the panel's entries, skipping folders and
    // any file that can't be shown (too large / binary / read error). The
    // viewer keeps the last-pressed nav button focused so Space pages on.
    // Paging tracks its position locally (curIdx) and deliberately leaves the
    // panel cursor where the user left it, so closing the viewer doesn't jump it.
    let curIdx = startIdx;
    opts.nav = async (dir) => {
      let i = curIdx + dir;
      while (i >= 0 && i < wp.entries.length) {
        const en = wp.entries[i];
        if (en && !en.up && !en.isDir) {
          const o = await this.buildViewerOpts(wp, en, true);
          if (o) {
            curIdx = i;
            return o;
          }
        }
        i += dir;
      }
      return null;   // nothing viewable further in that direction
    };

    new ViewerModal(this.app, opts).open();
  }

  // Build the ViewerModal content options for a single panel entry, or null if
  // it can't be shown (directory, too large, binary / read error). With
  // `silent` (Prev/Next paging) failures are swallowed so the file is simply
  // skipped; otherwise a Notice explains why (an explicit F3 on one file).
  async buildViewerOpts(wp, en, silent) {
    if (!en || en.up || en.isDir) return null;
    const note = (m) => { if (!silent) new Notice(m); };
    const isMd = /\.(md|markdown)$/i.test(en.name);

    // inside an archive: read the entry's bytes straight from the zip
    if (wp.zip) {
      let buf;
      try { buf = await this.fp.extractZipEntry(wp.zip.path, en.zipEntry); }
      catch (e) { note('Could not read entry: ' + (e && e.message ? e.message : e)); return null; }
      if (IMAGE_RE.test(en.name)) {
        if (buf.length > this.imageLimit()) { note(`Image too large for preview (max ${fmtSize(this.imageLimit())}).`); return null; }
        return { title: `View — ${en.name}`, image: await bytesToDataURL(buf, mimeFor(en.name)) };
      }
      if (buf.length > this.viewLimit()) { note(`File too large for the viewer (max ${fmtSize(this.viewLimit())}).`); return null; }
      const content = new TextDecoder().decode(buf);
      if (isMd) return { title: `Preview — ${en.name}`, markdown: content, sourcePath: '' };
      return { title: `View — ${en.name}`, content, wrap: this.plugin.settings.wrapText };
    }

    // a real file in a panel directory
    const full = this.P.join(wp.cwd, en.name);
    let st;
    try { st = await this.fp.stat(full); } catch (_) { note('Cannot read file.'); return null; }
    if (st.isDir) { note('That is a directory.'); return null; }

    // images → show the picture (read as a data: URL so it works outside the vault)
    if (IMAGE_RE.test(en.name)) {
      if (st.size > this.imageLimit()) { note(`Image too large for preview (max ${fmtSize(this.imageLimit())}).`); return null; }
      try {
        const buf = await this.fp.readBinary(full);
        return { title: `View — ${en.name}`, image: await bytesToDataURL(buf, mimeFor(en.name)) };
      } catch (e) { note('Could not load image: ' + (e && e.message ? e.message : e)); return null; }
    }

    if (st.size > this.viewLimit()) { note(`File too large for the viewer (max ${fmtSize(this.viewLimit())}).`); return null; }
    let content;
    try { content = await this.fp.read(full); }
    catch (_) { note('Binary file or read error.'); return null; }

    // markdown → rendered preview (F4 still opens the raw text)
    if (isMd) return { title: `Preview — ${en.name}`, markdown: content, sourcePath: this.toVaultPath(full) || '' };
    return { title: `View — ${en.name}`, content, wrap: this.plugin.settings.wrapText };
  }

  async actEdit() {
    const wp = this.workPanel();
    if (!wp) { new Notice('No file panel active.'); return; }
    if (wp.zip) { new Notice('Editing inside an archive is not possible.'); return; }
    const sel = this.getSelection(wp);
    if (!sel.length) return;
    const f = sel[0];
    let st;
    try { st = await this.fp.stat(f.full); } catch (_) { new Notice('Cannot open file.'); return; }
    if (st.isDir) { new Notice('That is a directory.'); return; }

    // md / canvas inside the vault → open in Obsidian's own editor (new tab).
    // Other types (txt, json, …) have no in-app editor, so openFile() would hand
    // them to the OS ("open with…" on iOS) — those use the built-in editor below.
    const vaultFile = this.toVaultPath(f.full);
    if (vaultFile && /\.(md|canvas)$/i.test(f.name)) {
      const af = this.app.vault.getAbstractFileByPath(vaultFile);
      // leave fullscreen first (see openEntry) so returning to the commander tab
      // shows it normally instead of a stranded, blank fixed-positioned leaf
      if (af) { this.setFullscreen(false); this.app.workspace.getLeaf('tab').openFile(af); return; }
    }

    if (st.size > this.editLimit()) { new Notice(`File too large for the internal editor (max ${fmtSize(this.editLimit())}).`); return; }
    let content;
    try { content = await this.fp.read(f.full); }
    catch (_) { new Notice('Binary file or read error.'); return; }
    new ViewerModal(this.app, {
      title: `Edit — ${f.name}`, content, editable: true, wrap: this.plugin.settings.wrapText,
      onSave: async (text) => {
        try { await this.fp.write(f.full, text); new Notice('Saved.'); await this.refresh(); }
        catch (e) { new Notice('Error while saving: ' + e.message); }
      },
    }).open();
  }

  actCopy() {
    const wp = this.workPanel();
    if (!wp) { new Notice('No file panel active.'); return; }
    const sel = this.getSelection(wp);
    if (!sel.length) return;
    const dest = this.destDir();
    if (dest == null) { new Notice('Target panel is not a file directory.'); return; }

    // extracting OUT of an archive into the other (real) panel
    if (wp.zip) {
      const run = () => this.extractSelectionTo(dest);
      if (this.plugin.settings.confirmCopy) {
        new ConfirmModal(this.app, { title: 'Extract', body: `${sel.length} object(s) to extract to\n${dest}?`, onConfirm: run }).open();
      } else run();
      return;
    }

    if (dest === wp.cwd) { new Notice('Source and target directory are identical.'); return; }
    // single file → offer a rename in the dialog; multiple → keep their names
    const run = (renameTo) => this.transferSelection(sel, dest, 'copy', renameTo);
    if (this.plugin.settings.confirmCopy) {
      new CopyModal(this.app, {
        count: sel.length,
        destDir: dest,
        name: sel.length === 1 ? sel[0].name : null,
        onConfirm: (renameTo) => run(renameTo),
      }).open();
    } else run(null);
  }

  // Copy / Cut the current selection to the commander's file clipboard (Cmd+C /
  // Cmd+X). Copy also exposes the paths on the OS clipboard (best effort).
  actFileCopy() { this._fileClipSet('copy'); }
  actFileCut()  { this._fileClipSet('move'); }
  _fileClipSet(mode) {
    const wp = this.workPanel();
    if (!wp) { new Notice('No file panel active.'); return; }
    if (wp.zip) { new Notice('Cannot ' + (mode === 'move' ? 'cut' : 'copy') + ' from inside an archive.'); return; }
    const sel = this.getSelection(wp);
    if (!sel.length) return;
    this.fileClip = { mode, files: sel.map((f) => ({ name: f.name, full: f.full })) };
    if (mode === 'copy' && this.fp.writeClipboardFiles) this.fp.writeClipboardFiles(sel.map((f) => f.full));
    // remember the OS clipboard state now, so a later paste can tell whether
    // the user has since copied something else in Finder (which should win)
    this.fileClip.osSig = (this.fp.clipboardFiles ? this.fp.clipboardFiles() : []).join('\x00');
    new Notice(`${mode === 'move' ? 'Cut' : 'Copied'} ${sel.length} item(s) to clipboard.`);
  }

  // Copy the selected entries' paths to the OS text clipboard (absolute on the
  // node build, vault-relative resolved against the vault base otherwise).
  async actCopyPath() {
    const wp = this.workPanel();
    if (!wp) { new Notice('No file panel active.'); return; }
    const sel = this.getSelection(wp);
    if (!sel.length) return;

    const paths = sel.map((f) => {
      if (f.full == null) return '';
      if (this.fp.capabilities.absolutePaths) return f.full;
      const base = this.app.vault.adapter && this.app.vault.adapter.basePath;
      return base ? this.P.join(base, f.full) : f.full;
    }).filter(Boolean);

    if (!paths.length) { new Notice('Cannot copy paths from an archive.'); return; }

    try {
      await navigator.clipboard.writeText(paths.join('\n'));
      new Notice(`Copied ${paths.length} path(s) to clipboard.`);
    } catch (e) {
      new Notice('Clipboard error: ' + (e && e.message ? e.message : e));
    }
  }

  // Pick a non-colliding "<base> copy" name for duplicating a file into its own
  // folder (e.g. note.md → "note copy.md" → "note copy 2.md").
  async _dupName(dir, name) {
    const dot = name.lastIndexOf('.');
    const hasExt = dot > 0;
    const base = hasExt ? name.slice(0, dot) : name;
    const ext = hasExt ? name.slice(dot) : '';
    for (let i = 1; ; i++) {
      const cand = i === 1 ? `${base} copy${ext}` : `${base} copy ${i}${ext}`;
      if (!(await this.fp.exists(this.P.join(dir, cand)))) return cand;
    }
  }

  // Cmd/Ctrl+V — paste into the active panel's folder. Prefers the commander's
  // own file clipboard (Copy/Cut), then files from the OS file manager, then a
  // raster image on the clipboard (saved as a new PNG).
  async actPaste() {
    const wp = this.workPanel();
    if (!wp) { new Notice('No file panel active.'); return; }
    if (wp.zip) { new Notice('Cannot paste into an archive.'); return; }
    const destDir = wp.cwd;
    const osFiles = this.fp.clipboardFiles ? this.fp.clipboardFiles() : [];
    const clip = this.fileClip;
    // the internal clipboard wins, UNLESS it was a Copy and the user has since
    // copied something different in Finder (then that newer OS copy wins)
    const osChanged = osFiles.length && (!clip || osFiles.join(' ') !== clip.osSig);

    // 1) the commander's own clipboard (Copy = duplicate, Cut = move once)
    if (clip && clip.files.length && !(clip.mode === 'copy' && osChanged)) {
      const mode = clip.mode;
      const files = clip.files;
      if (mode === 'move') {
        const moved = files.filter((f) => this.P.dirname(f.full) !== destDir);
        if (!moved.length) { new Notice('Already in this folder.'); return; }
        await this.transferSelection(moved, destDir, 'move');
        this.fileClip = null;   // Cut is one-shot
        return;
      }
      // Copy: pasting into the source folder duplicates (file → "file copy"),
      // rather than offering to overwrite the file with itself.
      const inPlace = files.filter((f) => this.P.dirname(f.full) === destDir);
      const elsewhere = files.filter((f) => this.P.dirname(f.full) !== destDir);
      if (elsewhere.length) await this.transferSelection(elsewhere, destDir, 'copy');
      for (const f of inPlace) {
        const dup = await this._dupName(destDir, f.name);
        await this.transferSelection([f], destDir, 'copy', dup);
      }
      return;
    }

    // 2) files/folders from the OS file manager (Finder / Explorer)
    if (osFiles.length) {
      const sel = osFiles.map((full) => ({ name: this.P.basename(full), full }));
      const realDest = sel.filter((f) => this.P.dirname(f.full) !== destDir);
      if (!realDest.length) { new Notice('Those files are already in this folder.'); return; }
      await this.transferSelection(realDest, destDir, 'copy');
      return;
    }

    // 3) a raster image on the clipboard → write a fresh PNG
    const png = this.fp.clipboardImage && this.fp.clipboardImage();
    if (png) {
      let n = 0, name, target;
      do { name = 'pasted-image' + (n ? `-${n}` : '') + '.png'; target = this.P.join(destDir, name); n++; }
      while (await this.fp.exists(target));
      try {
        await this.fp.writeBinary(target, png);
        await this.refresh();
        new Notice('Pasted image as ' + name);
      } catch (e) { new Notice('Could not save image: ' + (e && e.message ? e.message : e)); }
      return;
    }

    new Notice('Clipboard has no file or image to paste.');
  }

  // Rename a single entry within its folder, refusing to clobber an existing
  // sibling. Copy/move have their own conflict prompts, but a bare rename does
  // not — and fs.renameSync would silently overwrite the target. A case-only
  // change on a case-insensitive filesystem targets the same object, so allow it.
  async renameEntry(f, wp, name) {
    if (!name || name === f.name) return;
    const target = this.P.join(wp.cwd, name);
    const caseOnly = name.toLowerCase() === f.name.toLowerCase();
    if (!caseOnly && (await this.fp.exists(target))) {
      new Notice(`An object named "${name}" already exists.`);
      return;
    }
    try { await this.fp.rename(f.full, target); await this.refresh(); }
    catch (e) { new Notice('Error: ' + e.message); }
  }

  actRenameInPlace() {
    const wp = this.workPanel();
    if (!wp) { new Notice('No file panel active.'); return; }
    if (wp.zip) { new Notice('Rename inside an archive is not possible.'); return; }
    const sel = this.getSelection(wp);
    if (!sel.length) return;
    if (sel.length !== 1) { new Notice('Select only one object to rename.'); return; }
    const f = sel[0];
    new PromptModal(this.app, {
      title: 'Rename', value: f.name,
      // for files, pre-select only the name so the extension is preserved
      selectBasename: !(f.en && f.en.isDir),
      validate: (name) => invalidNameReason(name),
      onSubmit: (name) => this.renameEntry(f, wp, name),
    }).open();
  }

  actMove() {
    const wp = this.workPanel();
    if (!wp) { new Notice('No file panel active.'); return; }
    if (wp.zip) { new Notice('Move/rename inside an archive is not possible.'); return; }
    const sel = this.getSelection(wp);
    if (!sel.length) return;
    const dest = this.destDir();
    if (dest == null) { new Notice('Target panel is not a file directory.'); return; }
    if (dest === wp.cwd) {
      // same dir → rename the single cursor entry
      if (sel.length !== 1) { new Notice('Select only one object to rename.'); return; }
      const f = sel[0];
      new PromptModal(this.app, {
        title: 'Rename', value: f.name,
        // for files, pre-select only the name so the extension is preserved
        selectBasename: !(f.en && f.en.isDir),
        validate: (name) => invalidNameReason(name),
        onSubmit: (name) => this.renameEntry(f, wp, name),
      }).open();
      return;
    }
    const displayDest = dest.length > 55 ? '...' + dest.slice(-52) : dest;
    new ConfirmModal(this.app, {
      title: 'Move', body: `Move ${sel.length} object(s) to ${displayDest}?`,
      nowrap: true,
      onConfirm: () => this.transferSelection(sel, dest, 'move'),
    }).open();
  }

  /* ── conflict-aware copy / move: prompt before overwriting ── */
  askConflict(name, mode) {
    return new Promise((resolve) => { new ConflictModal(this.app, { name, mode, onChoice: resolve }).open(); });
  }
  askName(value) {
    return new Promise((resolve) => { new PromptModal(this.app, { title: 'Rename to', value, onSubmit: (v) => resolve(v) }).open(); });
  }
  async transferSelection(sel, destDir, mode, renameSingle) {
    // shared state: counts files (not top-level objects) and the all/cancel flags,
    // which carry through the whole operation including into nested folders
    const st = { overwriteAll: false, skipAll: false, created: 0, overwritten: 0, skipped: 0, failed: 0, cancelled: false };
    for (const f of sel) {
      if (st.cancelled) break;
      // a single-file copy may have been renamed in the dialog
      const name = (renameSingle && sel.length === 1) ? renameSingle : f.name;
      await this.transferEntry(f.full, this.P.join(destDir, name), name, mode, st);
    }
    // explicit, file-accurate summary so the chosen action is clear
    const verb = mode === 'copy' ? 'copied' : 'moved';
    const parts = [];
    const done = st.created + st.overwritten;
    if (done) {
      let s = `${done} ${done === 1 ? 'item' : 'items'} ${verb}`;
      if (st.overwritten) s += ` (${st.overwritten} overwritten)`;
      parts.push(s);
    }
    if (st.skipped) parts.push(`${st.skipped} skipped`);
    if (st.failed) parts.push(`${st.failed} failed`);
    if (st.cancelled) parts.push('cancelled');
    new Notice(parts.length ? parts.join(', ') + '.' : 'Nothing done.');
    await this.refresh();
  }
  // recursively copy/move one entry. Folders are MERGED into the target (like an
  // orthodox file manager) so every conflicting file inside gets its own prompt,
  // "Overwrite/Skip all" carry on through the rest, and the counts are per file.
  async transferEntry(src, target, relName, mode, st) {
    if (st.cancelled) return;
    const fail = (e) => new Notice(`${mode === 'copy' ? 'Copy' : 'Move'} failed: ${relName} (${e.code || e.message})`);
    let s;
    try { s = await this.fp.lstat(src); }
    catch (e) { st.failed++; fail(e); return; }

    if (s.isDir) {
      if (!(await this.fp.exists(target))) {
        // no conflict anywhere below → transfer the whole subtree in one shot
        const n = await this.fp.countFiles(src);
        try {
          if (mode === 'copy') await this.fp.copy(src, target);
          else await this.fp.move(src, target);
          st.created += n;
        } catch (e) { st.failed += n; fail(e); }
        return;
      }
      // target folder already exists → recurse so each file gets its own prompt
      try { await this.fp.mkdir(target); } catch (e) {}
      let kids;
      try { kids = await this.fp.readdirNames(src); }
      catch (e) { st.failed++; fail(e); return; }
      for (const k of kids) {
        if (st.cancelled) break;
        await this.transferEntry(this.P.join(src, k), this.P.join(target, k), relName + '/' + k, mode, st);
      }
      // for a move, drop the (now-empty) source folder; a non-empty one means
      // files were skipped, so rmdir throws and we correctly leave them behind
      if (mode === 'move' && !st.cancelled) { try { await this.fp.rmdir(src); } catch (e) {} }
      return;
    }

    // a single file (or symlink) → resolve its conflict here
    let finalTarget = target;
    let existed = await this.fp.exists(target);
    let proceed = true;
    if (existed) {
      if (st.overwriteAll) proceed = true;
      else if (st.skipAll) proceed = false;
      else {
        const choice = await this.askConflict(relName, mode);
        if (choice === 'overwrite') proceed = true;
        else if (choice === 'overwriteAll') { st.overwriteAll = true; proceed = true; }
        else if (choice === 'skip') proceed = false;
        else if (choice === 'skipAll') { st.skipAll = true; proceed = false; }
        else if (choice === 'rename') {
          const base = this.P.basename(relName);
          const nn = await this.askName(base);
          if (nn && nn !== base) { finalTarget = this.P.join(this.P.dirname(target), nn); existed = await this.fp.exists(finalTarget); }
          else proceed = false;
        } else { st.cancelled = true; return; }   // cancel → stop the whole operation
      }
    }
    if (!proceed) { st.skipped++; return; }
    try {
      if (mode === 'copy') await this.fp.copy(src, finalTarget);
      else await this.fp.move(src, finalTarget);
      if (existed) st.overwritten++; else st.created++;
    } catch (e) { st.failed++; fail(e); }
  }

  actMkdir() {
    const wp = this.workPanel();
    if (!wp) { new Notice('No file panel active.'); return; }
    if (wp.zip) { new Notice('Making a directory inside an archive is not possible.'); return; }
    new PromptModal(this.app, {
      title: 'Make directory', value: '', placeholder: 'Name',
      validate: (name) => invalidNameReason(name),
      onSubmit: async (name) => {
        if (!name) return;
        const full = this.P.join(wp.cwd, name);
        try {
          if (await this.fp.exists(full)) { new Notice('Already exists: ' + name); return; }
          await this.fp.mkdir(full);
          await this.refresh();
          const idx = wp.entries.findIndex((e) => e.name === name);
          if (idx >= 0) { wp.cursor = idx; this.renderPanel(wp); }
        } catch (e) { new Notice('Error: ' + e.message); }
      },
    }).open();
  }

  actDelete() {
    const wp = this.workPanel();
    if (!wp) { new Notice('No file panel active.'); return; }
    if (wp.zip) { new Notice('Deleting inside an archive is not possible.'); return; }
    const sel = this.getSelection(wp);
    if (!sel.length) return;
    const run = async () => {
      let ok = 0;
      for (const f of sel) {
        try { await this.fp.remove(f.full); ok++; }
        catch (e) { new Notice(`Delete failed: ${f.name} (${e.code || e.message})`); }
      }
      new Notice(`${ok} object(s) deleted.`); await this.refresh();
    };
    if (this.plugin.settings.confirmDelete) {
      const names = sel.map((f) => f.name).join(', ');
      new ConfirmModal(this.app, {
        title: 'Delete', danger: true,
        body: `Delete ${sel.length} object(s) PERMANENTLY?\n\n${names.length > 200 ? names.slice(0, 200) + '…' : names}`,
        onConfirm: run,
      }).open();
    } else run();
  }

  /* ── menus: F2 user menu (centered list) & F9 pulldown (top bar) ── */

  panelMenuItems(panel) {
    const m = panel.mode, sk = panel.sortKey || 'name';
    const items = [
      { label: 'Full', checked: m === 'list' && (panel.layout || 'full') !== 'wide', run: () => this.setListLayout(panel, 'full') },
      { label: 'Wide', checked: m === 'list' && panel.layout === 'wide', run: () => this.setListLayout(panel, 'wide') },
      { label: 'Info', checked: m === 'info', run: () => this.setPanelMode(panel, 'info') },
      { label: 'Tree', checked: m === 'tree', run: () => this.setPanelMode(panel, 'tree') },
      { label: 'Quick view', checked: m === 'quick', run: () => this.setPanelMode(panel, 'quick') },
      { sep: true },
      { label: 'Name         Ctrl+F3', checked: sk === 'name', run: () => this.setSort(panel, 'name') },
      { label: 'Extension    Ctrl+F4', checked: sk === 'ext', run: () => this.setSort(panel, 'ext') },
      { label: 'Time         Ctrl+F5', checked: sk === 'time', run: () => this.setSort(panel, 'time') },
      { label: 'Size         Ctrl+F6', checked: sk === 'size', run: () => this.setSort(panel, 'size') },
      { label: 'Unsorted     Ctrl+F7', checked: sk === 'unsorted', run: () => this.setSort(panel, 'unsorted') },
      { sep: true },
    ];
    if (this.fp.capabilities.drives) items.push({ label: 'Drive / Volume…', run: () => this.actDrive(panel) });
    items.push({ label: 'Re-read', run: () => this.reloadPanel(panel) });
    items.push({ sep: true });
    items.push({ label: 'Hidden files', checked: this.plugin.settings.showHidden, run: () => this.toggleHidden() });
    return items;
  }
  filesItems() {
    return [
      { label: 'View              F3', run: () => this.actView() },
      { label: 'Edit              F4', run: () => this.actEdit() },
      { label: 'Copy              F5', run: () => this.actCopy() },
      { label: 'Move/Rename       F6', run: () => this.actMove() },
      { label: 'Make directory    F7', run: () => this.actMkdir() },
      { label: 'Delete            F8', run: () => this.actDelete() },
      { sep: true },
      { label: 'Select all', run: () => this.selectAll() },
      { label: 'Unselect all', run: () => this.clearTags() },
    ];
  }
  // clipboard file operations — same actions the desktop Edit menu / Cmd+X·C·V
  // drive. Copy/Cut remember the selection; Paste drops it into the active panel.
  editItems() {
    const k = (typeof process !== 'undefined' && process.platform === 'darwin') ? '⌘' : 'Ctrl+';
    return [
      { label: 'Cut'.padEnd(18) + k + 'X', run: () => this.actFileCut() },
      { label: 'Copy'.padEnd(18) + k + 'C', run: () => this.actFileCopy() },
      { label: 'Paste'.padEnd(18) + k + 'V', run: () => this.actPaste() },
      { sep: true },
      { label: 'Rename in place   Ctrl+R', run: () => this.actRenameInPlace() },
      { sep: true },
      { label: 'Copy path', run: () => this.actCopyPath() },
    ];
  }
  commandsItems() {
    const items = [
      { label: 'Swap panels', run: () => this.swapPanels() },
      { label: 'Equalize panels', run: () => this.equalizePanels() },
      { sep: true },
    ];
    if (this.fp.capabilities.exec) items.push({ label: 'Open in Finder', run: () => this.openInSystem() });
    items.push({ label: 'Go to vault folder', run: () => this.gotoVault() });
    items.push({ sep: true });
    items.push({ label: 'Bookmarks…  Ctrl+D', run: () => this.openHotlist() });
    items.push({ label: 'Add bookmark (current dir)', run: () => this.addBookmark((this.workPanel() || this.active).cwd) });
    items.push({ sep: true });
    items.push({ label: 'Toggle fullscreen', run: () => this.toggleFullscreen() });
    return items;
  }
  optionsItems() {
    const s = this.plugin.settings;
    const items = [
      { label: 'Configuration…', run: () => this.openConfig() },
      { sep: true },
      { label: 'Confirm deletions', checked: s.confirmDelete, run: () => this.toggleSetting('confirmDelete') },
      { label: 'Confirm copies', checked: s.confirmCopy, run: () => this.toggleSetting('confirmCopy') },
    ];
    if (this.fp.capabilities.exec) items.push({ label: 'Command line enabled', checked: s.enableExec, run: () => this.toggleSetting('enableExec') });
    items.push({ label: 'Hidden files', checked: s.showHidden, run: () => this.toggleHidden() });
    items.push({ label: 'Wrap long lines (viewer / quick view)', checked: s.wrapText, run: () => this.toggleWrap() });
    items.push({ sep: true });
    items.push({ label: 'Theme: Commander Blue', checked: s.theme !== 'gray', run: () => this.setTheme('blue') });
    items.push({ label: 'Theme: Navigator Gray', checked: s.theme === 'gray', run: () => this.setTheme('gray') });
    items.push({ sep: true });
    items.push({ label: 'Hide menu (open with F9)', checked: s.hideMenu, run: () => this.toggleHideMenu() });
    return items;
  }

  applyTheme() {
    if (this.contentEl) this.contentEl.toggleClass('nc-theme-gray', this.plugin.settings.theme === 'gray');
  }
  setTheme(name) {
    this.plugin.settings.theme = name;
    this.plugin.saveSettings();
    this.applyTheme();
  }
  toggleTheme() { this.setTheme(this.plugin.settings.theme === 'gray' ? 'blue' : 'gray'); }

  menuCats() {
    return [
      { label: 'Left', items: this.panelMenuItems(this.left) },
      { label: 'Files', items: this.filesItems() },
      { label: 'Edit', items: this.editItems() },
      { label: 'Commands', items: this.commandsItems() },
      { label: 'Options', items: this.optionsItems() },
      { label: 'Tools', items: this.toolsItems() },
      { label: 'Right', items: this.panelMenuItems(this.right) },
    ];
  }

  toolsItems() {
    return [
      { label: 'Calendar', run: () => this.openCalendar() },
      { label: 'Calculator', run: () => this.openCalculator() },
      { label: 'ASCII Chart', run: () => this.openAscii() },
      { label: 'Symbols Chart', run: () => this.openSymbols() },
      { sep: true },
      { label: 'Puzzle', run: () => this.openPuzzle() },
      { label: 'Tetris', run: () => this.openTetris() },
    ];
  }

  openConfig() {
    if (this.menu) this.closeMenu();
    this.menu = { kind: 'config', focusItem: 2 };
    this.renderMenu();
    this.pushMenuScope();
  }

  openConfigScreensaver() {
    if (this.menu) { this.popMenuScope(); if (this.overlayEl) { this.overlayEl.remove(); this.overlayEl = null; } this.menu = null; }
    const s = this.plugin.settings;
    this.menu = { kind: 'config-screensaver', enabled: s.screensaverEnabled, name: s.screensaverName, delay: s.screensaverDelay };
    this.renderMenu();
    this.pushMenuScope();
  }

  saveConfigScreensaver() {
    const m = this.menu;
    this.plugin.settings.screensaverEnabled = m.enabled;
    this.plugin.settings.screensaverName = m.name;
    this.plugin.settings.screensaverDelay = m.delay;
    this.plugin.saveSettings();
    this.resetScreensaverTimer();
    this.closeMenu();
  }

  initScreensaverSystem() {
    this._ssCanvas = null;
    this._ssAnimFrame = null;
    this._ssIdleTimer = null;
    if (!this.rootEl) return;
    // Screensaver fires after N minutes with mouse OUTSIDE the commander window.
    // mouseenter cancels the countdown and stops any running screensaver.
    this.rootEl.addEventListener('mouseleave', () => this._ssArmTimer());
    this.rootEl.addEventListener('mouseenter', () => {
      this._ssCancelTimer();
      this.stopScreensaver();
    });
    // Any activity inside the view also dismisses a running saver — needed when
    // it was started with the pointer already inside (e.g. the "Test" button),
    // where mouseenter never fires. Keyboard is handled via onKey → _ssWake().
    const wake = () => this._ssWake();
    this.rootEl.addEventListener('mousemove', wake);
    this.rootEl.addEventListener('mousedown', wake);
    this.rootEl.addEventListener('wheel', wake, { passive: true });
    this.rootEl.addEventListener('touchstart', wake, { passive: true });
  }

  // Stop a running screensaver on user activity. Returns true if one was showing
  // (so a key press that woke it is swallowed rather than acted on).
  _ssWake() {
    if (!this._ssCanvas) return false;
    this._ssCancelTimer();
    this.stopScreensaver();
    return true;
  }

  _ssArmTimer() {
    this._ssCancelTimer();
    if (!this.plugin.settings.screensaverEnabled) return;
    const ms = Math.max(1, this.plugin.settings.screensaverDelay || 1) * 60000;
    this._ssIdleTimer = window.setTimeout(() => this.startScreensaver(), ms);
  }

  _ssCancelTimer() {
    if (this._ssIdleTimer) { window.clearTimeout(this._ssIdleTimer); this._ssIdleTimer = null; }
  }

  resetScreensaverTimer() {
    // Called after settings change — just cancel any pending timer.
    // The timer re-arms next time the mouse leaves the window.
    this._ssCancelTimer();
  }

  startScreensaver(nameOverride) {
    if (this._ssCanvas) return;
    if (!this.rootEl) return;
    const w = this.rootEl.offsetWidth, h = this.rootEl.offsetHeight;
    if (!w || !h) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'nc-screensaver';
    canvas.width = w;
    canvas.height = h;
    this.rootEl.appendChild(canvas);
    this._ssCanvas = canvas;
    const name = nameOverride || this.plugin.settings.screensaverName || 'matrix';
    if (name === 'starnight')       this._ssStarnight(canvas);
    else if (name === 'lines')     this._ssLines(canvas);
    else if (name === 'polygons')  this._ssPolygons(canvas);
    else if (name === 'fireworks') this._ssFireworks(canvas);
    else if (name === 'worms')     this._ssWorms(canvas);
    else if (name === 'tiles')     this._ssTiles(canvas);
    else                           this._ssStarnight(canvas);
  }

  stopScreensaver() {
    if (this._ssAnimFrame) { cancelAnimationFrame(this._ssAnimFrame); this._ssAnimFrame = null; }
    if (this._ssCanvas) { this._ssCanvas.remove(); this._ssCanvas = null; }
  }

  // ── Turbo Vision / CGA shared helpers ─────────────────────────
  _tvSetup(canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const CW = Math.max(6, Math.floor(W / 80));
    const CH = CW * 2;
    const COLS = Math.floor(W / CW);
    const ROWS = Math.floor(H / CH);
    ctx.font = `${CH}px "Px437 IBM VGA8","PxPlus IBM VGA8","Perfect DOS VGA 437","Consolas",monospace`;
    ctx.textBaseline = 'top';
    return { ctx, W, H, CW, CH, COLS, ROWS };
  }

  // CGA 16-color palette
  _cga() {
    return ['#000000','#0000aa','#00aa00','#00aaaa','#aa0000','#aa00aa','#aa5500','#aaaaaa',
            '#555555','#5555ff','#55ff55','#55ffff','#ff5555','#ff55ff','#ffff55','#ffffff'];
  }

  // Draw a fake Norton Commander screen (for destructive screensavers)
  _drawNCScreen(canvas) {
    const { ctx, W, H, CW, CH, COLS, ROWS } = this._tvSetup(canvas);
    const CGA = this._cga();
    const putCell = (ch, c, r, fg, bg) => {
      ctx.fillStyle = CGA[bg];
      ctx.fillRect(c * CW, r * CH, CW, CH);
      if (ch !== ' ' && ch !== '') {
        ctx.fillStyle = CGA[fg];
        ctx.fillText(ch, c * CW, r * CH);
      }
    };
    const putStr = (str, c, r, fg, bg) => {
      for (let i = 0; i < str.length && c + i < COLS; i++) putCell(str[i], c + i, r, fg, bg);
    };
    const fillRect = (c, r, w, h, bg) => {
      ctx.fillStyle = CGA[bg];
      ctx.fillRect(c * CW, r * CH, w * CW, h * CH);
    };

    fillRect(0, 0, COLS, ROWS, 1); // blue background

    // Menu bar (cyan, row 0)
    fillRect(0, 0, COLS, 1, 3);
    putStr(' Left   Files   Edit   Commands   Options   Tools   Right', 0, 0, 0, 3);

    const PW = Math.floor((COLS - 1) / 2); // panel width
    const RP = PW + 1;                      // right panel start col

    // Panel borders (row 1..ROWS-3)
    const drawBox = (c, r, w, h, fg) => {
      putStr('╔' + '═'.repeat(w - 2) + '╗', c, r, fg, 1);
      for (let i = r + 1; i < r + h - 1; i++) {
        putCell('║', c, i, fg, 1);
        putCell('║', c + w - 1, i, fg, 1);
      }
      putStr('╚' + '═'.repeat(w - 2) + '╝', c, r + h - 1, fg, 1);
    };
    const panelH = ROWS - 3;
    drawBox(0, 1, PW, panelH, 11);
    drawBox(RP, 1, COLS - RP, panelH, 11);

    // Column header (row 2)
    const hdr = ' Name' + ' '.repeat(PW - 15) + '   Size    Date ';
    putStr(hdr.slice(0, PW - 2), 1, 2, 14, 1);
    putStr(hdr.slice(0, COLS - RP - 2), RP + 1, 2, 14, 1);

    // Left file entries
    const leftFiles = [
      ['../','', 14], ['Documents/','', 14], ['Pictures/','', 14], ['Projects/','', 14],
      ['README.md','  2 048  11.05', 15], ['config.yaml','    512  08.03', 15],
      ['notes.txt','  4 096  22.06', 15], ['archive.zip',' 1.2 MB  01.01', 7],
      ['photo.jpg','  8 192  15.04', 7],  ['script.sh','    256  30.05', 15],
    ];
    for (let i = 0; i < panelH - 4 && i < leftFiles.length; i++) {
      const [name, info, fg] = leftFiles[i];
      const entry = (' ' + name).padEnd(PW - 2 - info.length) + info;
      putStr(entry.slice(0, PW - 2), 1, 3 + i, fg, 1);
    }
    // Right file entries
    const rightFiles = [
      ['../','', 14], ['vault-commander/','', 14], ['node_modules/','', 14],
      ['src/','', 14], ['desktop/','', 14], ['dist/','', 14],
      ['package.json','    908  29.06', 15], ['build.mjs','  3 584  29.06', 15],
      ['styles.css',' 45 056  29.06', 15], ['variants.json','    280  10.03', 15],
    ];
    for (let i = 0; i < panelH - 4 && i < rightFiles.length; i++) {
      const [name, info, fg] = rightFiles[i];
      const rw = COLS - RP - 2;
      const entry = (' ' + name).padEnd(rw - info.length) + info;
      putStr(entry.slice(0, rw), RP + 1, 3 + i, fg, 1);
    }

    // Command line (ROWS - 2)
    putStr('C:\\>', 0, ROWS - 2, 7, 1);

    // Function key bar (ROWS - 1, black)
    fillRect(0, ROWS - 1, COLS, 1, 0);
    putStr('1Help 2Menu 3View 4Edit 5Copy 6RenMov 7Mkdir 8Delete 9PullDn 10Quit', 0, ROWS - 1, 15, 0);
  }

  // ── Screensaver 1: Starry Night (NC4 style) ───────────────────
  _ssStarnight(canvas) {
    const { ctx, W, H, CW, CH, COLS, ROWS } = this._tvSetup(canvas);
    const CGA = this._cga();
    const STAR_CHARS = ['.', '+', '*', '\xF9', '\xFA']; // · and ░ CP437 fallback
    const STAR_COLS  = [15, 15, 14, 11, 7];
    // Sparse grid: null = empty, {ch, fg} = star
    const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    // Seed ~3% of cells with stars
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (Math.random() < 0.03) {
          const si = Math.floor(Math.random() * STAR_CHARS.length);
          grid[r][c] = { ch: STAR_CHARS[si], fg: STAR_COLS[si] };
        }

    const drawCell = (c, r) => {
      ctx.fillStyle = CGA[0];
      ctx.fillRect(c * CW, r * CH, CW, CH);
      if (grid[r][c]) {
        ctx.fillStyle = CGA[grid[r][c].fg];
        ctx.fillText(grid[r][c].ch, c * CW, r * CH);
      }
    };
    // Initial draw
    ctx.fillStyle = CGA[0];
    ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r][c]) drawCell(c, r);

    let frame = 0;
    const tick = () => {
      if (this._ssCanvas !== canvas) return;
      frame++;
      if (frame % 20 !== 0) { this._ssAnimFrame = requestAnimationFrame(tick); return; }
      const n = Math.max(1, Math.floor(COLS * ROWS * 0.004));
      for (let i = 0; i < n; i++) {
        const r = Math.floor(Math.random() * ROWS);
        const c = Math.floor(Math.random() * COLS);
        if (grid[r][c]) grid[r][c] = null;
        else if (Math.random() < 0.5) {
          const si = Math.floor(Math.random() * STAR_CHARS.length);
          grid[r][c] = { ch: STAR_CHARS[si], fg: STAR_COLS[si] };
        }
        drawCell(c, r);
      }
      this._ssAnimFrame = requestAnimationFrame(tick);
    };
    this._ssAnimFrame = requestAnimationFrame(tick);
  }

  // ── Screensaver 2: Floating Lines (colored scanlines) ─────────
  _ssLines(canvas) {
    const { ctx, W, H, CW, CH, COLS, ROWS } = this._tvSetup(canvas);
    const CGA = this._cga();
    // Horizontal "scanlines" made of '─' that drift up/down
    const LINE_FG  = [9, 11, 10, 14, 12, 13, 3]; // bright CGA colors
    const scanlines = Array.from({ length: 7 }, (_, i) => ({
      row: Math.floor(Math.random() * ROWS),
      fg:  LINE_FG[i],
      dy:  Math.random() < 0.5 ? 1 : -1,
      speed: 1 + Math.floor(Math.random() * 3),
      tick: 0,
    }));
    ctx.fillStyle = CGA[1]; // blue bg
    ctx.fillRect(0, 0, W, H);

    const drawLine = (row, fg, bg) => {
      ctx.fillStyle = CGA[bg];
      ctx.fillRect(0, row * CH, W, CH);
      ctx.fillStyle = CGA[fg];
      for (let c = 0; c < COLS; c++) ctx.fillText('─', c * CW, row * CH); // ─
    };

    let frame = 0;
    const tick = () => {
      if (this._ssCanvas !== canvas) return;
      frame++;
      if (frame % 20 !== 0) { this._ssAnimFrame = requestAnimationFrame(tick); return; }
      for (const s of scanlines) {
        drawLine(s.row, 1, 1); // erase (blue on blue)
        s.tick++;
        if (s.tick >= s.speed) {
          s.tick = 0;
          s.row += s.dy;
          if (s.row < 0)       { s.row = 0;       s.dy = 1; }
          if (s.row >= ROWS)   { s.row = ROWS - 1; s.dy = -1; }
        }
        drawLine(s.row, s.fg, 1); // draw
      }
      this._ssAnimFrame = requestAnimationFrame(tick);
    };
    // Initial draw
    for (const s of scanlines) drawLine(s.row, s.fg, 1);
    this._ssAnimFrame = requestAnimationFrame(tick);
  }

  // ── Screensaver 3: Moving Polygons (flying boxes) ─────────────
  _ssPolygons(canvas) {
    const { ctx, W, H, CW, CH, COLS, ROWS } = this._tvSetup(canvas);
    const CGA = this._cga();
    ctx.fillStyle = CGA[1];
    ctx.fillRect(0, 0, W, H);

    const BOX_FG = [9, 11, 10, 14, 12, 13];
    const boxes = Array.from({ length: 5 }, (_, i) => {
      const bw = 6 + Math.floor(Math.random() * 14);
      const bh = 4 + Math.floor(Math.random() * 8);
      return {
        col: Math.floor(Math.random() * (COLS - bw)),
        row: Math.floor(Math.random() * (ROWS - bh)),
        w: bw, h: bh,
        dc: Math.random() < 0.5 ? 1 : -1,
        dr: Math.random() < 0.5 ? 1 : -1,
        fg: BOX_FG[i],
        speed: 1 + Math.floor(Math.random() * 2),
        tick: 0,
      };
    });

    // Draw a box of double-line chars at col,row with given fg
    const drawBox = (b, fg) => {
      const { col: c, row: r, w, h } = b;
      ctx.fillStyle = CGA[fg];
      ctx.fillText('╔', c * CW, r * CH);                       // ╔
      ctx.fillText('╗', (c + w - 1) * CW, r * CH);             // ╗
      ctx.fillText('╚', c * CW, (r + h - 1) * CH);             // ╚
      ctx.fillText('╝', (c + w - 1) * CW, (r + h - 1) * CH);  // ╝
      for (let i = 1; i < w - 1; i++) {
        ctx.fillText('═', (c + i) * CW, r * CH);               // ═
        ctx.fillText('═', (c + i) * CW, (r + h - 1) * CH);
      }
      for (let i = 1; i < h - 1; i++) {
        ctx.fillText('║', c * CW, (r + i) * CH);               // ║
        ctx.fillText('║', (c + w - 1) * CW, (r + i) * CH);
      }
    };
    const eraseBox = (b) => {
      ctx.fillStyle = CGA[1];
      ctx.fillRect(b.col * CW, b.row * CH, b.w * CW, b.h * CH);
    };

    for (const b of boxes) drawBox(b, b.fg);

    let frame = 0;
    const tick = () => {
      if (this._ssCanvas !== canvas) return;
      frame++;
      if (frame % 20 !== 0) { this._ssAnimFrame = requestAnimationFrame(tick); return; }
      for (const b of boxes) {
        b.tick++;
        if (b.tick < b.speed) continue;
        b.tick = 0;
        eraseBox(b);
        b.col += b.dc; b.row += b.dr;
        if (b.col <= 0 || b.col + b.w >= COLS) b.dc *= -1;
        if (b.row <= 0 || b.row + b.h >= ROWS) b.dr *= -1;
        b.col = Math.max(0, Math.min(COLS - b.w, b.col));
        b.row = Math.max(0, Math.min(ROWS - b.h, b.row));
        drawBox(b, b.fg);
      }
      this._ssAnimFrame = requestAnimationFrame(tick);
    };
    this._ssAnimFrame = requestAnimationFrame(tick);
  }

  // ── Screensaver 4: Fireworks (character-mode) ──────────────────
  _ssFireworks(canvas) {
    const { ctx, W, H, CW, CH, COLS, ROWS } = this._tvSetup(canvas);
    const CGA = this._cga();
    const BURST_FG = [9, 11, 10, 14, 12, 13, 15]; // bright colors
    const SPARKS = ['▒', '*', '+', '.', '\xF9']; // ▒ * + . ·
    const particles = [];

    const explode = () => {
      const cc = 2 + Math.floor(Math.random() * (COLS - 4));
      const cr = 1 + Math.floor(Math.random() * (ROWS - 2));
      const fg = BURST_FG[Math.floor(Math.random() * BURST_FG.length)];
      // Starburst pattern in several rings
      const DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
      for (const [dc, dr] of DIRS) {
        for (let r = 1; r <= 3 + Math.floor(Math.random() * 3); r++) {
          particles.push({ c: cc + dc * r, r: cr + dr * r, fg, life: 12 + Math.floor(Math.random() * 8), ch: SPARKS[Math.min(r - 1, SPARKS.length - 1)] });
        }
      }
    };

    ctx.fillStyle = CGA[0];
    ctx.fillRect(0, 0, W, H);

    let nextBoom = 3;
    let frame = 0;
    const tick = () => {
      if (this._ssCanvas !== canvas) return;
      frame++;
      if (frame % 20 !== 0) { this._ssAnimFrame = requestAnimationFrame(tick); return; }
      nextBoom--;
      if (nextBoom <= 0) {
        explode();
        nextBoom = 3 + Math.floor(Math.random() * 5);
      }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        // Erase old position
        if (p.c >= 0 && p.c < COLS && p.r >= 0 && p.r < ROWS) {
          ctx.fillStyle = CGA[0];
          ctx.fillRect(p.c * CW, p.r * CH, CW, CH);
        }
        p.life--;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        // Draw if in bounds
        if (p.c >= 0 && p.c < COLS && p.r >= 0 && p.r < ROWS) {
          ctx.fillStyle = CGA[0];
          ctx.fillRect(p.c * CW, p.r * CH, CW, CH);
          ctx.fillStyle = CGA[p.life > 8 ? p.fg : 7];
          ctx.fillText(p.ch, p.c * CW, p.r * CH);
        }
      }
      this._ssAnimFrame = requestAnimationFrame(tick);
    };
    this._ssAnimFrame = requestAnimationFrame(tick);
  }

  // ── Screensaver 5: Worms — destructive (eats NC screen) ───────
  _ssWorms(canvas) {
    const { ctx, W, H, CW, CH, COLS, ROWS } = this._tvSetup(canvas);
    const CGA = this._cga();
    const WORM_CHARS = ['O', '0', 'o'];
    const WORM_FG    = [10, 11, 12, 14, 9]; // bright green, cyan, red, yellow, blue
    const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];
    const eaten = new Set();

    const borderPos = () => {
      const side = Math.floor(Math.random() * 4);
      if (side === 0) return { c: 0,        r: Math.floor(Math.random() * ROWS), dir: 0 };
      if (side === 1) return { c: COLS - 1, r: Math.floor(Math.random() * ROWS), dir: 1 };
      if (side === 2) return { c: Math.floor(Math.random() * COLS), r: 0,        dir: 2 };
                      return { c: Math.floor(Math.random() * COLS), r: ROWS - 1, dir: 3 };
    };

    const worms = Array.from({ length: 6 }, (_, i) => {
      const pos = borderPos();
      // First 3: straight (prefer current dir), last 3: random walk
      return { c: pos.c, r: pos.r, dir: pos.dir, fg: WORM_FG[i % WORM_FG.length], ch: WORM_CHARS[i % WORM_CHARS.length], tick: 0, random: i >= 3 };
    });

    // Shuffle array in-place (Fisher-Yates) — used for random-walk direction order
    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };

    const startAnim = () => {
      let frame = 0;
      const tick = () => {
        if (this._ssCanvas !== canvas) return;
        frame++;
        if (frame % 20 !== 0) { this._ssAnimFrame = requestAnimationFrame(tick); return; }
        for (const w of worms) {
          w.tick++;
          if (w.tick % 2 !== 0) continue;
          const key = `${w.c},${w.r}`;
          eaten.add(key);
          ctx.fillStyle = CGA[0];
          ctx.fillRect(w.c * CW, w.r * CH, CW, CH);
          ctx.fillStyle = CGA[w.fg];
          ctx.fillText(w.ch, w.c * CW, w.r * CH);

          // Straight worms: prefer current direction, only turn when blocked.
          // Random-walk worms: try directions in random order each step.
          const order = w.random
            ? shuffle([0, 1, 2, 3])
            : [0, 1, 2, 3].map(i => (w.dir + i) % 4);
          let moved = false;
          for (const d of order) {
            const [dc, dr] = DIRS[d];
            const nc = w.c + dc, nr = w.r + dr;
            if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS && !eaten.has(`${nc},${nr}`)) {
              w.dir = d; w.c = nc; w.r = nr; moved = true; break;
            }
          }
          if (!moved) { // trapped — reset at border
            const pos = borderPos();
            w.c = pos.c; w.r = pos.r; w.dir = pos.dir;
          }
        }
        this._ssAnimFrame = requestAnimationFrame(tick);
      };
      this._ssAnimFrame = requestAnimationFrame(tick);
    };


    this._drawNCScreen(canvas);
    startAnim();
  }

  // ── Screensaver 6: Screen Shuffle — sliding-puzzle random walk ─
  _ssTiles(canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const TCOLS = 30, TROWS = 20;
    const TW = Math.floor(W / TCOLS), TH = Math.floor(H / TROWS);
    const N = TCOLS * TROWS;
    const DIRS4 = [[-1,0],[1,0],[0,-1],[0,1]];

    const startAnim = (snap) => {
      // grid[pos] = source tile index at that display position; -1 = hole
      const grid = Array.from({ length: N }, (_, i) => i);
      let hole = Math.floor(Math.random() * N);
      grid[hole] = -1;

      const drawTile = (dstPos, srcIdx) => {
        const sx = (srcIdx % TCOLS) * TW, sy = Math.floor(srcIdx / TCOLS) * TH;
        const dx = (dstPos % TCOLS) * TW, dy = Math.floor(dstPos / TCOLS) * TH;
        ctx.putImageData(snap, dx - sx, dy - sy, sx, sy, TW, TH);
      };
      const clearPos = (pos) => {
        ctx.fillStyle = '#000000';
        ctx.fillRect((pos % TCOLS) * TW, Math.floor(pos / TCOLS) * TH, TW, TH);
      };

      clearPos(hole);

      let frame = 0;
      const tick = () => {
        if (this._ssCanvas !== canvas) return;
        frame++;
        if (frame % 20 !== 0) { this._ssAnimFrame = requestAnimationFrame(tick); return; }
        // 3 slides per rendered frame (~9 slides/sec at 3 fps)
        for (let s = 0; s < 3; s++) {
          const hc = hole % TCOLS, hr = Math.floor(hole / TCOLS);
          const adj = [];
          for (const [dc, dr] of DIRS4) {
            const nc = hc + dc, nr = hr + dr;
            if (nc >= 0 && nc < TCOLS && nr >= 0 && nr < TROWS) adj.push(nr * TCOLS + nc);
          }
          const next = adj[Math.floor(Math.random() * adj.length)];
          drawTile(hole, grid[next]);
          grid[hole] = grid[next];
          grid[next] = -1;
          clearPos(next);
          hole = next;
        }
        this._ssAnimFrame = requestAnimationFrame(tick);
      };
      this._ssAnimFrame = requestAnimationFrame(tick);
    };


    this._drawNCScreen(canvas);
    startAnim(ctx.getImageData(0, 0, W, H));
  }

  // persistent top menu bar — shown only when "Hide menu" is off, as its own
  // row above the panels (so it never overlaps a panel header)
  renderTopbar() {
    if (!this.topbarEl) return;
    this.topbarEl.empty();
    if (this.plugin.settings.hideMenu) return;   // :empty hides the row entirely
    const bar = this.topbarEl.createDiv({ cls: 'nc-menubar' });
    this.menuCats().forEach((cat, ci) => {
      const active = !!(this.menu && this.menu.docked && this.menu.cat === ci);
      const c = bar.createSpan({ cls: 'nc-menucat' + (active ? ' nc-sel' : ''), text: cat.label });
      c.addEventListener('mousedown', (e) => { e.preventDefault(); this.openDockedCat(ci); });
      c.addEventListener('mouseenter', () => { if (this.menu && this.menu.docked) this.openDockedCat(ci); });
    });
    const clock = bar.createSpan({ cls: 'nc-menu-clock' });
    clock.addEventListener('mousedown', (e) => { e.preventDefault(); this.openCalendar(); });
    this.updateClock();
  }

  updateClock() {
    if (!this.rootEl) return;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const txt = `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}  ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const clocks = this.rootEl.querySelectorAll('.nc-menu-clock');
    for (let i = 0; i < clocks.length; i++) clocks[i].textContent = txt;
  }

  toggleHideMenu() {
    this.plugin.settings.hideMenu = !this.plugin.settings.hideMenu;
    this.plugin.saveSettings();
    if (this.menu) this.closeMenu();   // closeMenu re-renders the top bar
    else this.renderTopbar();
  }

  // open one category's dropdown anchored under the persistent bar
  openDockedCat(ci) {
    this.menu = { kind: 'pulldown', cats: this.menuCats(), cat: ci, item: 0, docked: true };
    this.skipToSelectable(1);
    this.renderMenu();
    this.pushMenuScope();
  }

  openPulldown() {
    if (this.menu) { this.closeMenu(); return; }
    const startCat = (this.active === this.left) ? 0 : 6;   // open on the active panel's side (6 = Right)
    if (!this.plugin.settings.hideMenu) { this.openDockedCat(startCat); return; }
    this.menu = { kind: 'pulldown', cats: this.menuCats(), cat: startCat, item: 0 };
    this.skipToSelectable(1);
    this.renderMenu();
    this.pushMenuScope();
  }

  openCalendar() {
    if (this.menu) { this.closeMenu(); return; }
    this.menu = { kind: 'calendar', date: new Date(), focusItem: 0 };
    this.renderMenu();
    this.pushMenuScope();
  }

  changeCalendarMonth(dir) {
    if (this.menu.kind !== 'calendar') return;
    const d = this.menu.date;
    this.menu.date = new Date(d.getFullYear(), d.getMonth() + dir, 1);
    this.renderMenu();
  }

  openCalculator() {
    if (this.menu) { this.closeMenu(); return; }
    this.menu = { kind: 'calculator', disp: '0', op: null, val: null, clearNext: false, focusItem: 0 };
    this.renderMenu();
    this.pushMenuScope();
  }

  calcPress(b) {
    if (this.menu.kind !== 'calculator') return;
    const m = this.menu;
    if (b === 'C') { m.disp = '0'; m.op = null; m.val = null; m.clearNext = false; }
    else if (b === '←') { m.disp = m.disp.length > 1 ? m.disp.slice(0, -1) : '0'; }
    else if (b === '±') { m.disp = m.disp.startsWith('-') ? m.disp.slice(1) : '-' + m.disp; }
    else if (b === '%') { m.disp = String(parseFloat(m.disp) / 100); }
    else if ('0123456789'.includes(b)) {
      if (m.clearNext || m.disp === '0') { m.disp = b; m.clearNext = false; }
      else { m.disp += b; }
    }
    else if (b === '.') {
      if (m.clearNext) { m.disp = '0.'; m.clearNext = false; }
      else if (!m.disp.includes('.')) m.disp += '.';
    }
    else if ('+-*/'.includes(b)) {
      if (m.op && !m.clearNext) this.calcEval();
      m.val = parseFloat(m.disp);
      m.op = b;
      m.clearNext = true;
    }
    else if (b === '=') {
      if (m.op) this.calcEval();
      m.op = null;
    }
    this.renderMenu();
  }

  calcEval() {
    const m = this.menu;
    const v1 = m.val;
    const v2 = parseFloat(m.disp);
    let r = 0;
    if (m.op === '+') r = v1 + v2;
    if (m.op === '-') r = v1 - v2;
    if (m.op === '*') r = v1 * v2;
    if (m.op === '/') {
      if (v2 === 0) { m.disp = 'ERROR'; m.clearNext = true; return; }
      r = v1 / v2;
    }
    m.disp = String(Math.round(r * 1e8) / 1e8);
    m.clearNext = true;
  }

  /* --- ASCII Chart --- */
  openAscii() {
    if (this.menu) { this.closeMenu(); return; }
    this.menu = { kind: 'ascii', val: 0 };
    this.renderMenu();
    this.pushMenuScope();
  }

  getAsciiChar(i) {
    const cp437 = " ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
    return cp437[i] || ' ';
  }

  copyAsciiChar() {
    const ch = this.getAsciiChar(this.menu.val);
    navigator.clipboard.writeText(ch).then(
      () => new Notice('Copied ' + (ch === ' ' ? '(space)' : ch)),
      () => new Notice('Clipboard unavailable.'),
    );
  }

  /* --- Symbols Chart --- */
  openSymbols() {
    if (this.menu) { this.closeMenu(); return; }
    this.menu = { kind: 'symbols', val: 0, picked: false };
    this.renderMenu();
    this.pushMenuScope();
  }

  // Curated Unicode symbols useful for text editing. Each entry is [char, name].
  // Grid is SYM_COLS wide (keep in sync with renderMenu + keyboard handling).
  getSymbols() {
    return [
      // Checks & boxes
      ['✓', 'Check mark'], ['✔', 'Heavy check mark'], ['✗', 'Ballot X'], ['✘', 'Heavy ballot X'],
      ['☑', 'Checked box'], ['☒', 'Crossed box'], ['☐', 'Ballot box'], ['⌫', 'Erase left'],
      // Stars, bullets & shapes
      ['★', 'Black star'], ['☆', 'White star'], ['•', 'Bullet'], ['◦', 'White bullet'],
      ['‣', 'Triangular bullet'], ['⁃', 'Hyphen bullet'], ['●', 'Black circle'], ['○', 'White circle'],
      ['■', 'Black square'], ['□', 'White square'], ['▪', 'Small black square'], ['▫', 'Small white square'],
      ['◆', 'Black diamond'], ['◇', 'White diamond'], ['♥', 'Heart'], ['♦', 'Diamond'],
      // Arrows
      ['←', 'Left arrow'], ['→', 'Right arrow'], ['↑', 'Up arrow'], ['↓', 'Down arrow'],
      ['↔', 'Left-right arrow'], ['↕', 'Up-down arrow'], ['⇐', 'Left double arrow'], ['⇒', 'Right double arrow'],
      ['⇑', 'Up double arrow'], ['⇓', 'Down double arrow'], ['⇔', 'Left-right double arrow'], ['↩', 'Return arrow'],
      ['➜', 'Heavy arrow'], ['➤', 'Arrowhead'], ['»', 'Right guillemet'], ['«', 'Left guillemet'],
      // Legal & marks
      ['©', 'Copyright'], ['®', 'Registered'], ['™', 'Trademark'], ['℠', 'Service mark'],
      ['℗', 'Sound recording copyright'], ['§', 'Section'], ['¶', 'Pilcrow'], ['†', 'Dagger'],
      ['‡', 'Double dagger'], ['*', 'Asterisk'], ['№', 'Numero'], ['%', 'Percent'],
      // Typography / punctuation
      ['—', 'Em dash'], ['–', 'En dash'], ['…', 'Ellipsis'], ['·', 'Middle dot'],
      ['“', 'Left double quote'], ['”', 'Right double quote'], ['‘', 'Left single quote'], ['’', 'Right single quote'],
      ['‹', 'Single left guillemet'], ['›', 'Single right guillemet'], ['′', 'Prime'], ['″', 'Double prime'],
      // Currency
      ['€', 'Euro'], ['£', 'Pound'], ['¥', 'Yen'], ['¢', 'Cent'],
      ['$', 'Dollar'], ['₩', 'Won'], ['₹', 'Rupee'], ['₽', 'Ruble'],
      // Math
      ['×', 'Multiplication'], ['÷', 'Division'], ['±', 'Plus-minus'], ['∓', 'Minus-plus'],
      ['≈', 'Almost equal'], ['≠', 'Not equal'], ['≤', 'Less-or-equal'], ['≥', 'Greater-or-equal'],
      ['∞', 'Infinity'], ['√', 'Square root'], ['∑', 'Sum'], ['∏', 'Product'],
      ['∫', 'Integral'], ['∆', 'Delta'], ['∂', 'Partial'], ['µ', 'Micro'],
      ['π', 'Pi'], ['°', 'Degree'], ['‰', 'Per mille'], ['∙', 'Bullet operator'],
      ['½', 'One half'], ['¼', 'One quarter'], ['¾', 'Three quarters'], ['⅓', 'One third'],
      // Misc editing
      ['⚠', 'Warning'], ['⚡', 'Lightning'], ['☀', 'Sun'], ['☺', 'Smiley'],
      ['♪', 'Note'], ['♫', 'Notes'], ['✉', 'Envelope'], ['✏', 'Pencil'],
      ['✂', 'Scissors'], ['⌘', 'Command'], ['⌥', 'Option'], ['⇧', 'Shift'],
    ];
  }

  copySymbolChar() {
    const ch = this.getSymbols()[this.menu.val][0];
    navigator.clipboard.writeText(ch).then(
      () => new Notice('Copied ' + ch),
      () => new Notice('Clipboard unavailable.'),
    );
  }

  /* --- Puzzle --- */
  openPuzzle() {
    if (this.menu) { this.closeMenu(); return; }
    let tiles = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O',''];
    let emptyIdx = 15;
    for (let i = 0; i < 300; i++) {
      const valid = [];
      if (emptyIdx >= 4) valid.push(emptyIdx - 4);
      if (emptyIdx < 12) valid.push(emptyIdx + 4);
      if (emptyIdx % 4 !== 0) valid.push(emptyIdx - 1);
      if (emptyIdx % 4 !== 3) valid.push(emptyIdx + 1);
      const move = valid[Math.floor(Math.random() * valid.length)];
      tiles[emptyIdx] = tiles[move];
      tiles[move] = '';
      emptyIdx = move;
    }
    this.menu = { kind: 'puzzle', tiles, moves: 0, emptyIdx };
    this.renderMenu();
    this.pushMenuScope();
  }

  puzzleMove(idx) {
    if (this.menu.kind !== 'puzzle') return;
    const m = this.menu;
    const isAdj = (idx === m.emptyIdx - 1 && idx % 4 !== 3) || 
                  (idx === m.emptyIdx + 1 && idx % 4 !== 0) || 
                  (idx === m.emptyIdx - 4) || 
                  (idx === m.emptyIdx + 4);
    if (isAdj) {
      m.tiles[m.emptyIdx] = m.tiles[idx];
      m.tiles[idx] = '';
      m.emptyIdx = idx;
      m.moves++;
      this.renderMenu();
    }
  }

  puzzleKeyMove(dir) {
    if (this.menu.kind !== 'puzzle') return;
    const eIdx = this.menu.emptyIdx;
    let target = -1;
    if (dir === 'Right' && eIdx % 4 !== 0) target = eIdx - 1;
    if (dir === 'Left' && eIdx % 4 !== 3) target = eIdx + 1;
    if (dir === 'Up' && eIdx < 12) target = eIdx + 4;
    if (dir === 'Down' && eIdx >= 4) target = eIdx - 4;
    if (target !== -1) this.puzzleMove(target);
  }

  /* --- Tetris --- */
  openTetris() {
    if (this.menu) { this.closeMenu(); return; }
    this.menu = {
      kind: 'tetris',
      board: Array.from({length: 20}, () => Array(10).fill(0)),
      score: 0, lines: 0, level: 1,
      active: null, next: this.randomTetromino(),
      gameOver: false, timer: null
    };
    
    // Mobile Touch Controls
    this.tetrisTouchStartX = 0;
    this.tetrisTouchStartY = 0;
    this.tetrisHasSwiped = false;
    this.tetrisHardDropped = false;
    this.boundTetrisTouchStart = (e) => {
      if (e.touches.length > 1) return;
      this.tetrisTouchStartX = e.touches[0].clientX;
      this.tetrisTouchStartY = e.touches[0].clientY;
      this.tetrisHasSwiped = false;
      this.tetrisHardDropped = false;
    };
    this.boundTetrisTouchMove = (e) => {
      if (e.touches.length > 1 || !this.tetrisTouchStartX || !this.tetrisTouchStartY) return;
      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const dx = currentX - this.tetrisTouchStartX;
      const dy = currentY - this.tetrisTouchStartY;
      const SWIPE_STEP = 24; // Pixels per grid movement
      
      if (Math.abs(dx) >= SWIPE_STEP) {
        this.tetrisHasSwiped = true;
        const steps = Math.floor(Math.abs(dx) / SWIPE_STEP);
        for (let i = 0; i < steps; i++) this.tetrisMove(dx > 0 ? 1 : -1, 0);
        this.tetrisTouchStartX += (dx > 0 ? steps * SWIPE_STEP : -steps * SWIPE_STEP);
      }
      
      if (dy >= SWIPE_STEP) {
        this.tetrisHasSwiped = true;
        const steps = Math.floor(dy / SWIPE_STEP);
        for (let i = 0; i < steps; i++) this.tetrisMove(0, 1);
        this.tetrisTouchStartY += steps * SWIPE_STEP;
      } else if (dy <= -50 && !this.tetrisHardDropped) {
        this.tetrisHasSwiped = true;
        this.tetrisHardDropped = true;
        this.tetrisHardDrop();
      }
    };
    this.boundTetrisTouchEnd = (e) => {
      if (!this.tetrisHasSwiped && this.tetrisTouchStartX && this.tetrisTouchStartY) {
        if (e.target.closest('.nc-tetris')) {
          this.tetrisRotate();
          if (e.cancelable) e.preventDefault();
        }
      }
      this.tetrisTouchStartX = 0;
      this.tetrisTouchStartY = 0;
    };
    
    document.addEventListener('touchstart', this.boundTetrisTouchStart, { passive: true });
    document.addEventListener('touchmove', this.boundTetrisTouchMove, { passive: true });
    document.addEventListener('touchend', this.boundTetrisTouchEnd, { passive: false });

    this.spawnTetrisPiece();
    this.renderMenu();
    this.pushMenuScope();
    this.menu.timer = window.setInterval(() => this.tetrisTick(), this.tetrisSpeed());
  }

  tetrisSpeed() { return Math.max(100, 800 - (this.menu.level - 1) * 70); }

  randomTetromino() {
    const pieces = [
      { shape: [[1,1,1,1]], color: 1 }, // I
      { shape: [[2,0,0],[2,2,2]], color: 2 }, // J
      { shape: [[0,0,3],[3,3,3]], color: 3 }, // L
      { shape: [[4,4],[4,4]], color: 4 }, // O
      { shape: [[0,5,5],[5,5,0]], color: 5 }, // S
      { shape: [[0,6,0],[6,6,6]], color: 6 }, // T
      { shape: [[7,7,0],[0,7,7]], color: 7 }  // Z
    ];
    return pieces[Math.floor(Math.random() * pieces.length)];
  }

  spawnTetrisPiece() {
    const m = this.menu;
    m.active = { shape: m.next.shape, color: m.next.color, x: Math.floor((10 - m.next.shape[0].length) / 2), y: 0 };
    m.next = this.randomTetromino();
    if (this.tetrisCollision(m.active.x, m.active.y, m.active.shape)) {
      m.gameOver = true;
      if (m.timer) window.clearInterval(m.timer);
    }
  }

  tetrisTick() {
    if (this.menu.kind !== 'tetris' || this.menu.gameOver) return;
    if (!this.tetrisMove(0, 1)) this.tetrisLock();
  }

  tetrisMove(dx, dy) {
    const m = this.menu;
    if (this.tetrisCollision(m.active.x + dx, m.active.y + dy, m.active.shape)) return false;
    m.active.x += dx;
    m.active.y += dy;
    this.updateTetrisDOM();
    return true;
  }

  tetrisRotate() {
    const m = this.menu;
    const s = m.active.shape;
    const rot = s[0].map((val, index) => s.map(row => row[index]).reverse());
    if (!this.tetrisCollision(m.active.x, m.active.y, rot)) {
      m.active.shape = rot;
      this.updateTetrisDOM();
    }
  }

  tetrisCollision(x, y, shape) {
    const m = this.menu;
    for (let r = 0; r < shape.length; r++) {
      for (let c = 0; c < shape[r].length; c++) {
        if (!shape[r][c]) continue;
        let nx = x + c, ny = y + r;
        if (nx < 0 || nx >= 10 || ny >= 20) return true;
        if (ny >= 0 && m.board[ny][nx]) return true;
      }
    }
    return false;
  }

  tetrisLock() {
    const m = this.menu;
    const shape = m.active.shape;
    for (let r = 0; r < shape.length; r++) {
      for (let c = 0; c < shape[r].length; c++) {
        if (shape[r][c]) m.board[m.active.y + r][m.active.x + c] = m.active.color;
      }
    }
    let cleared = 0;
    for (let r = 19; r >= 0; r--) {
      if (m.board[r].every(cell => cell > 0)) {
        m.board.splice(r, 1);
        m.board.unshift(Array(10).fill(0));
        cleared++; r++;
      }
    }
    if (cleared > 0) {
      m.lines += cleared;
      m.score += [0, 40, 100, 300, 1200][cleared] * m.level;
      if (m.lines >= m.level * 10) {
        m.level++;
        if (m.timer) window.clearInterval(m.timer);
        m.timer = window.setInterval(() => this.tetrisTick(), this.tetrisSpeed());
      }
    }
    this.spawnTetrisPiece();
    this.updateTetrisDOM();
  }

  tetrisHardDrop() {
    while (this.tetrisMove(0, 1)) {}
    this.tetrisLock();
  }

  updateTetrisDOM() {
    if (!this.overlayEl) return;
    const m = this.menu;
    if (m.kind !== 'tetris') return;
    
    const boardEl = this.overlayEl.querySelector('.nc-tetris-board');
    if (!boardEl) return;
    
    const displayBoard = m.board.map(row => [...row]);
    if (m.active) {
      for (let r = 0; r < m.active.shape.length; r++) {
        for (let c = 0; c < m.active.shape[r].length; c++) {
          if (m.active.shape[r][c]) {
            const y = m.active.y + r, x = m.active.x + c;
            if (y >= 0 && y < 20 && x >= 0 && x < 10) displayBoard[y][x] = m.active.color;
          }
        }
      }
    }
    
    let i = 0;
    const cells = boardEl.children;
    displayBoard.forEach(row => {
      row.forEach(cell => {
        cells[i].className = 'nc-tetris-cell c' + cell;
        i++;
      });
    });
    
    const scoreEls = this.overlayEl.querySelectorAll('.nc-tetris-sidebar > div:not(.label)');
    if (scoreEls.length >= 3) {
      scoreEls[0].textContent = String(m.score);
      scoreEls[1].textContent = String(m.level);
      scoreEls[2].textContent = String(m.lines);
    }
    
    const previewEl = this.overlayEl.querySelector('.nc-tetris-preview');
    if (previewEl) {
      let pi = 0;
      const pcells = previewEl.children;
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 4; c++) {
          const isFilled = m.next.shape[r] && m.next.shape[r][c];
          pcells[pi].className = 'nc-tetris-cell c' + (isFilled ? m.next.color : '0');
          pi++;
        }
      }
    }
    
    if (m.gameOver && !this.overlayEl.querySelector('.nc-tetris-over')) {
      this.overlayEl.querySelector('.nc-tetris').createDiv({ cls: 'nc-tetris-over', text: 'GAME OVER' });
    }
  }

  openUserMenu() {
    if (this.menu) { this.closeMenu(); return; }
    const items = [];
    if (this.fp.capabilities.absolutePaths) items.push({ label: 'Home directory (~)', run: () => this.gotoPath(this.fp.homeDir()) });
    items.push({ label: 'Vault folder', run: () => this.gotoVault() });
    if (this.fp.capabilities.absolutePaths) items.push({ label: 'Root directory /', run: () => this.gotoPath(this.P.root(this.active.cwd)) });
    items.push({ sep: true });
    if (this.fp.capabilities.exec) items.push({ label: 'Open in Finder', run: () => this.openInSystem() });
    items.push({ label: 'New file…', run: () => this.newFile() });
    items.push({ sep: true });
    items.push({ label: 'Equalize panels', run: () => this.equalizePanels() });
    items.push({ label: 'Swap panels', run: () => this.swapPanels() });
    items.push({ sep: true });
    items.push({ label: 'Toggle theme (Blue / Gray)', run: () => this.toggleTheme() });
    items.push({ label: 'Toggle fullscreen' + (hotkeyLabel(this.plugin.settings.fullscreenHotkey) ? `  (${hotkeyLabel(this.plugin.settings.fullscreenHotkey)})` : ''), run: () => this.toggleFullscreen() });
    this.menu = { kind: 'list', title: 'User menu', items, item: 0 };
    this.skipToSelectable(1);
    this.renderMenu();
    this.pushMenuScope();
  }

  currentItems() {
    return this.menu.kind === 'pulldown' ? this.menu.cats[this.menu.cat].items : this.menu.items;
  }
  skipToSelectable(dir) {
    const items = this.currentItems();
    let guard = 0;
    while (items[this.menu.item] && items[this.menu.item].sep && guard < items.length) {
      this.menu.item = (this.menu.item + dir + items.length) % items.length;
      guard++;
    }
  }

  renderMenu() {
    if (this.overlayEl) this.overlayEl.remove();
    const ov = this.rootEl.createDiv({ cls: 'nc-overlay' });
    this.overlayEl = ov;
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) this.closeMenu(); });

    if (this.menu.kind === 'pulldown' && this.menu.docked) {
      // dropdown only — the persistent top bar already shows the categories
      this.renderTopbar();
      ov.style.top = this.topbarEl.offsetHeight + 'px';   // leave the bar above clickable
      const drop = ov.createDiv({ cls: 'nc-dropdown nc-dropdown-docked' });
      const barCat = this.topbarEl.querySelectorAll('.nc-menucat')[this.menu.cat];
      if (barCat) drop.style.left = barCat.offsetLeft + 'px';
      this.fillMenuItems(drop, this.menu.cats[this.menu.cat].items);
    } else if (this.menu.kind === 'pulldown') {
      const bar = ov.createDiv({ cls: 'nc-menubar' });
      this.menu.cats.forEach((cat, ci) => {
        const c = bar.createSpan({ cls: 'nc-menucat' + (ci === this.menu.cat ? ' nc-sel' : ''), text: cat.label });
        c.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.menu.cat = ci; this.menu.item = 0; this.skipToSelectable(1); this.renderMenu();
        });
      });
      const clock = bar.createSpan({ cls: 'nc-menu-clock' });
      clock.addEventListener('mousedown', (e) => { e.preventDefault(); this.openCalendar(); });
      this.updateClock();
      const drop = ov.createDiv({ cls: 'nc-dropdown' });
      const activeCatEl = bar.children[this.menu.cat];
      if (activeCatEl) drop.style.left = activeCatEl.offsetLeft + 'px';
      this.fillMenuItems(drop, this.menu.cats[this.menu.cat].items);
    } else if (this.menu.kind === 'calendar') {
      const box = ov.createDiv({ cls: 'nc-calendar' });
      box.createDiv({ cls: 'nc-calendar-title', text: ' Calendar ' });
      const hdr = box.createDiv({ cls: 'nc-calendar-hdr' });
      
      const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const monStr = `${monthNames[this.menu.date.getMonth()]} ${this.menu.date.getFullYear()}`;
      
      const btnPrev = hdr.createSpan({ cls: 'nc-cal-btn' + (this.menu.focusItem === 0 ? ' nc-sel' : ''), text: '▲' });
      hdr.createSpan({ cls: 'nc-cal-month', text: monStr });
      const btnNext = hdr.createSpan({ cls: 'nc-cal-btn' + (this.menu.focusItem === 1 ? ' nc-sel' : ''), text: '▼' });
      
      btnPrev.addEventListener('mousedown', (e) => { e.preventDefault(); this.changeCalendarMonth(-1); });
      btnNext.addEventListener('mousedown', (e) => { e.preventDefault(); this.changeCalendarMonth(1); });

      const grid = box.createDiv({ cls: 'nc-cal-grid' });
      const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
      days.forEach(d => grid.createSpan({ cls: 'nc-cal-day-hdr', text: d }));

      const d = this.menu.date;
      const first = new Date(d.getFullYear(), d.getMonth(), 1);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      const today = new Date();
      
      for (let i = 0; i < first.getDay(); i++) {
        grid.createSpan({ text: '' });
      }
      for (let i = 1; i <= last.getDate(); i++) {
        const isToday = today.getDate() === i && today.getMonth() === d.getMonth() && today.getFullYear() === d.getFullYear();
        grid.createSpan({ cls: 'nc-cal-day' + (isToday ? ' nc-today' : ''), text: String(i) });
      }
    } else if (this.menu.kind === 'calculator') {
      const box = ov.createDiv({ cls: 'nc-calculator' });
      box.createDiv({ cls: 'nc-calculator-title', text: ' Calculator ' });
      const disp = box.createDiv({ cls: 'nc-calc-disp', text: this.menu.disp });
      const grid = box.createDiv({ cls: 'nc-calc-grid' });
      const btns = [
        ['C','←','%','±'],
        ['7','8','9','/'],
        ['4','5','6','*'],
        ['1','2','3','-'],
        ['0','.','=','+']
      ];
      btns.forEach((row, ri) => {
        row.forEach((b, ci) => {
          const isFocused = this.menu.focusItem === (ri * 4 + ci);
          const btn = grid.createDiv({ cls: 'nc-calc-btn' + (isFocused ? ' nc-sel' : ''), text: b });
          btn.addEventListener('mousedown', (e) => { e.preventDefault(); this.calcPress(b); });
        });
      });
    } else if (this.menu.kind === 'ascii') {
      const box = ov.createDiv({ cls: 'nc-ascii' });
      box.createDiv({ cls: 'nc-ascii-title', text: ' ASCII Chart ' });
      const grid = box.createDiv({ cls: 'nc-ascii-grid' });
      for (let i = 0; i < 256; i++) {
        const cell = grid.createDiv({ cls: 'nc-ascii-cell' + (this.menu.val === i ? ' nc-sel' : '') });
        cell.createSpan({ cls: 'nc-ascii-char', text: this.getAsciiChar(i) });
        cell.addEventListener('mousedown', (e) => { e.preventDefault(); this.menu.val = i; this.menu.picked = true; this.renderMenu(); });
      }
      const info = box.createDiv({ cls: 'nc-ascii-info' });
      info.textContent = `Char: ${this.getAsciiChar(this.menu.val)}   Decimal: ${String(this.menu.val).padStart(3, ' ')} Hex: ${this.menu.val.toString(16).toUpperCase().padStart(2, '0')}`;
      if (this.menu.picked) {
        const btnRow = box.createDiv({ cls: 'nc-ascii-btnrow' });
        const copyBtn = btnRow.createDiv({ cls: 'nc-config-okbtn', text: 'Copy' });
        copyBtn.addEventListener('mousedown', (e) => { e.preventDefault(); this.copyAsciiChar(); });
      }
    } else if (this.menu.kind === 'symbols') {
      const box = ov.createDiv({ cls: 'nc-ascii nc-symbols' });
      box.createDiv({ cls: 'nc-ascii-title', text: ' Symbols Chart ' });
      const syms = this.getSymbols();
      const grid = box.createDiv({ cls: 'nc-ascii-grid nc-symbols-grid' });
      syms.forEach((s, i) => {
        const cell = grid.createDiv({ cls: 'nc-ascii-cell' + (this.menu.val === i ? ' nc-sel' : '') });
        cell.createSpan({ cls: 'nc-ascii-char', text: s[0] });
        cell.addEventListener('mousedown', (e) => { e.preventDefault(); this.menu.val = i; this.menu.picked = true; this.renderMenu(); });
      });
      const sel = syms[this.menu.val];
      const cp = sel[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      const info = box.createDiv({ cls: 'nc-ascii-info' });
      info.textContent = `Char: ${sel[0]}   ${sel[1]}   U+${cp}`;
      if (this.menu.picked) {
        const btnRow = box.createDiv({ cls: 'nc-ascii-btnrow' });
        const copyBtn = btnRow.createDiv({ cls: 'nc-config-okbtn', text: 'Copy' });
        copyBtn.addEventListener('mousedown', (e) => { e.preventDefault(); this.copySymbolChar(); });
      }
    } else if (this.menu.kind === 'puzzle') {
      const box = ov.createDiv({ cls: 'nc-puzzle' });
      box.createDiv({ cls: 'nc-puzzle-title', text: ' Puzzle ' });
      const layout = box.createDiv({ cls: 'nc-puzzle-layout' });
      const grid = layout.createDiv({ cls: 'nc-puzzle-grid' });
      this.menu.tiles.forEach((t, i) => {
        const tile = grid.createDiv({ cls: 'nc-puzzle-tile' + (t === '' ? ' empty' : ''), text: t });
        if (t !== '') tile.addEventListener('mousedown', (e) => { e.preventDefault(); this.puzzleMove(i); });
      });
      const sidebar = layout.createDiv({ cls: 'nc-puzzle-sidebar' });
      sidebar.createDiv({ text: 'Move' });
      sidebar.createDiv({ text: String(this.menu.moves), cls: 'nc-puzzle-moves' });
    } else if (this.menu.kind === 'tetris') {
      const box = ov.createDiv({ cls: 'nc-tetris' });
      box.createDiv({ cls: 'nc-tetris-title', text: ' Tetris ' });
      const layout = box.createDiv({ cls: 'nc-tetris-layout' });
      const boardEl = layout.createDiv({ cls: 'nc-tetris-board' });
      const m = this.menu;
      const displayBoard = m.board.map(row => [...row]);
      if (m.active) {
        for (let r = 0; r < m.active.shape.length; r++) {
          for (let c = 0; c < m.active.shape[r].length; c++) {
            if (m.active.shape[r][c]) {
              const y = m.active.y + r, x = m.active.x + c;
              if (y >= 0 && y < 20 && x >= 0 && x < 10) displayBoard[y][x] = m.active.color;
            }
          }
        }
      }
      displayBoard.forEach(row => row.forEach(cell => boardEl.createDiv({ cls: 'nc-tetris-cell c' + cell })));
      const sidebar = layout.createDiv({ cls: 'nc-tetris-sidebar' });
      sidebar.createDiv({ cls: 'label', text: 'Score' });
      sidebar.createDiv({ text: String(m.score) });
      sidebar.createDiv({ cls: 'label', text: 'Level' });
      sidebar.createDiv({ text: String(m.level) });
      sidebar.createDiv({ cls: 'label', text: 'Lines' });
      sidebar.createDiv({ text: String(m.lines) });
      sidebar.createDiv({ cls: 'label', text: 'Next' });
      const preview = sidebar.createDiv({ cls: 'nc-tetris-preview' });
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 4; c++) {
          const isFilled = m.next.shape[r] && m.next.shape[r][c];
          preview.createDiv({ cls: 'nc-tetris-cell c' + (isFilled ? m.next.color : '0') });
        }
      }
      if (m.gameOver) box.createDiv({ cls: 'nc-tetris-over', text: 'GAME OVER' });
    } else if (this.menu.kind === 'config' || this.menu.kind === 'config-screensaver') {
      this._renderConfigDialog(ov);
      if (this.menu.kind === 'config-screensaver') this._renderScreensaverDialog(ov);
    } else {
      const box = ov.createDiv({ cls: 'nc-usermenu' });
      box.createDiv({ cls: 'nc-usermenu-title', text: this.menu.title });
      this.fillMenuItems(box, this.menu.items);
    }
  }

  _renderConfigDialog(ov) {
    const m = this.menu;
    const inactive = m.kind === 'config-screensaver';
    const box = ov.createDiv({ cls: 'nc-config-dialog' + (inactive ? ' nc-config-inactive' : '') });
    box.createDiv({ cls: 'nc-config-title', text: ' Configuration ' });

    const CONFIG_ITEMS = [
      { label: 'Screen',        desc: 'Select screen options',             active: false },
      { label: 'Panel Options', desc: 'Configure Commander Panels',        active: false },
      { label: 'Screen Savers', desc: 'Configure Screen Savers',           active: true  },
      { label: 'Printer/mouse', desc: 'Configure printer & mouse options', active: false },
      { label: 'Editor',        desc: 'Select Editor Options',             active: false },
      { label: 'Confirmations', desc: 'Set/Reset Program Prompts',        active: false },
      { label: 'Compression',   desc: 'Configure Commander Compression',   active: false },
    ];

    const list = box.createDiv({ cls: 'nc-config-list' });
    CONFIG_ITEMS.forEach((item, i) => {
      const row = list.createDiv({ cls: 'nc-config-row' });
      const btnCls = 'nc-config-btn' +
        (item.active ? '' : ' nc-config-btn-disabled') +
        (!inactive && item.active && i === m.focusItem ? ' nc-sel' : '');
      const btn = row.createDiv({ cls: btnCls });
      btn.textContent = item.label;
      row.createDiv({ cls: 'nc-config-desc' + (item.active ? '' : ' nc-config-dim') }).textContent = item.desc;
      if (!inactive && item.active) {
        btn.addEventListener('mousedown', (e) => { e.preventDefault(); this.openConfigScreensaver(); });
      }
    });

    const footer = box.createDiv({ cls: 'nc-config-footer' });
    footer.createDiv({ cls: 'nc-config-checkbox nc-config-dim' }).textContent = '[x] Auto save setup';

    const btnRow = box.createDiv({ cls: 'nc-config-btnrow' });
    const makeBtn = (label, fn) => {
      const b = btnRow.createDiv({ cls: 'nc-config-okbtn' + (inactive ? ' nc-config-dim' : '') });
      b.textContent = label;
      if (!inactive) b.addEventListener('mousedown', (e) => { e.preventDefault(); fn(); });
    };
    makeBtn('Ok', () => this.closeMenu());
    makeBtn('Cancel', () => this.closeMenu());
  }

  _renderScreensaverDialog(ov) {
    const m = this.menu;
    const SAVERS = [
      { id: 'starnight', label: 'Starry Night'    },
      { id: 'lines',     label: 'Floating Lines'  },
      { id: 'polygons',  label: 'Moving Polygons' },
      { id: 'fireworks', label: 'Fireworks'       },
      { id: 'worms',     label: 'Worms'           },
      { id: 'tiles',     label: 'Screen Shuffle'  },
    ];

    const box = ov.createDiv({ cls: 'nc-config-ss-dialog' });
    box.createDiv({ cls: 'nc-config-ss-title', text: ' Screen Savers ' });

    const frame = box.createDiv({ cls: 'nc-config-ss-frame' });
    frame.createDiv({ cls: 'nc-config-ss-framelabel', text: 'Screen Saver' });

    const grid = frame.createDiv({ cls: 'nc-config-ss-grid' });
    SAVERS.forEach((s) => {
      const row = grid.createDiv({ cls: 'nc-config-ss-row' });
      const radio = row.createSpan({ cls: 'nc-config-radio' + (m.name === s.id ? ' nc-sel' : '') });
      radio.textContent = m.name === s.id ? '(●)' : '( )';
      const lbl = row.createSpan({ cls: 'nc-config-ss-label' + (m.name === s.id ? ' nc-config-ss-active' : '') });
      lbl.textContent = ' ' + s.label;
      row.addEventListener('mousedown', (e) => { e.preventDefault(); m.name = s.id; this.renderMenu(); });
    });

    const opts = box.createDiv({ cls: 'nc-config-ss-opts' });
    const chkRow = opts.createDiv({ cls: 'nc-config-ss-chkrow' });
    const chk = chkRow.createSpan({ cls: 'nc-config-radio' });
    chk.textContent = m.enabled ? '[x]' : '[ ]';
    chkRow.createSpan().textContent = '  Use screen saver';
    chkRow.addEventListener('mousedown', (e) => { e.preventDefault(); m.enabled = !m.enabled; this.renderMenu(); });

    const delayRow = opts.createDiv({ cls: 'nc-config-ss-chkrow' });
    const minus = delayRow.createSpan({ cls: 'nc-config-ss-spin' });
    minus.textContent = '[◄]';
    minus.addEventListener('mousedown', (e) => { e.preventDefault(); if (m.delay > 1) { m.delay--; this.renderMenu(); } });
    const delayVal = delayRow.createSpan({ cls: 'nc-config-ss-delayval' });
    delayVal.textContent = ' ' + m.delay + ' ';
    const plus = delayRow.createSpan({ cls: 'nc-config-ss-spin' });
    plus.textContent = '[►]';
    plus.addEventListener('mousedown', (e) => { e.preventDefault(); if (m.delay < 99) { m.delay++; this.renderMenu(); } });
    delayRow.createSpan().textContent = '  Minutes';

    const btnRow = box.createDiv({ cls: 'nc-config-btnrow nc-config-ss-btnrow' });
    const okBtn = btnRow.createDiv({ cls: 'nc-config-okbtn' });
    okBtn.textContent = 'Ok';
    okBtn.addEventListener('mousedown', (e) => { e.preventDefault(); this.saveConfigScreensaver(); });
    const testBtn = btnRow.createDiv({ cls: 'nc-config-okbtn' });
    testBtn.textContent = 'Test';
    testBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const name = m.name;
      this.closeMenu();
      window.setTimeout(() => this.startScreensaver(name), 50);
    });
    const cancelBtn = btnRow.createDiv({ cls: 'nc-config-okbtn' });
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('mousedown', (e) => { e.preventDefault(); this.openConfig(); });
  }

  fillMenuItems(container, items) {
    items.forEach((it, idx) => {
      if (it.sep) { container.createDiv({ cls: 'nc-menu-sep' }); return; }
      const row = container.createDiv({ cls: 'nc-menu-item' + (idx === this.menu.item ? ' nc-sel' : '') });
      row.dataset.idx = String(idx);
      const mark = (it.checked != null) ? (it.checked ? '√  ' : '   ') : '';
      row.setText(mark + it.label);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); this.menu.item = idx; this.runMenuItem(); });
      row.addEventListener('mouseenter', () => {
        this.menu.item = idx;
        container.querySelectorAll('.nc-menu-item').forEach((el) => {
          el.classList.toggle('nc-sel', parseInt(el.dataset.idx, 10) === idx);
        });
      });
    });
  }

  menuKey(e) {
    if (this.menu.kind === 'calendar') {
      e.preventDefault(); e.stopPropagation();
      switch (e.key) {
        case 'Escape': this.closeMenu(); break;
        case 'Tab':
        case 'ArrowRight':
        case 'ArrowLeft':
          this.menu.focusItem = 1 - this.menu.focusItem;
          this.renderMenu();
          break;
        case 'Enter':
        case ' ':
          this.changeCalendarMonth(this.menu.focusItem === 0 ? -1 : 1);
          break;
        case 'ArrowUp': this.changeCalendarMonth(-1); break;
        case 'ArrowDown': this.changeCalendarMonth(1); break;
      }
      return;
    }
    if (this.menu.kind === 'calculator') {
      e.preventDefault(); e.stopPropagation();
      const btns = ['C','←','%','±','7','8','9','/','4','5','6','*','1','2','3','-','0','.','=','+'];
      switch (e.key) {
        case 'Escape': this.closeMenu(); break;
        case 'Tab':
        case 'ArrowRight': this.menu.focusItem = (this.menu.focusItem + 1) % 20; this.renderMenu(); break;
        case 'ArrowLeft': this.menu.focusItem = (this.menu.focusItem - 1 + 20) % 20; this.renderMenu(); break;
        case 'ArrowDown': this.menu.focusItem = (this.menu.focusItem + 4) % 20; this.renderMenu(); break;
        case 'ArrowUp': this.menu.focusItem = (this.menu.focusItem - 4 + 20) % 20; this.renderMenu(); break;
        case ' ': this.calcPress(btns[this.menu.focusItem]); break;
        case 'Enter': this.calcPress('='); break;
        case 'Backspace': this.calcPress('←'); break;
        case 'Delete':
        case 'c':
        case 'C': this.calcPress('C'); break;
        default:
          if (btns.includes(e.key)) this.calcPress(e.key);
          break;
      }
      return;
    }
    if (this.menu.kind === 'ascii') {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { this.closeMenu(); return; }
      if (e.key === 'Enter') { if (this.menu.picked) this.copyAsciiChar(); else this.closeMenu(); return; }
      let c = this.menu.val;
      if (e.key === 'ArrowRight') c = (c + 1) % 256;
      else if (e.key === 'ArrowLeft') c = (c - 1 + 256) % 256;
      else if (e.key === 'ArrowDown') c = (c + 32) % 256;
      else if (e.key === 'ArrowUp') c = (c - 32 + 256) % 256;
      if (c !== this.menu.val) { this.menu.val = c; this.menu.picked = true; this.renderMenu(); }
      return;
    }
    if (this.menu.kind === 'symbols') {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { this.closeMenu(); return; }
      if (e.key === 'Enter') { if (this.menu.picked) this.copySymbolChar(); else this.closeMenu(); return; }
      const len = this.getSymbols().length;
      const COLS = 16;   // keep in sync with .nc-symbols-grid columns
      let c = this.menu.val;
      if (e.key === 'ArrowRight') c = (c + 1) % len;
      else if (e.key === 'ArrowLeft') c = (c - 1 + len) % len;
      else if (e.key === 'ArrowDown') c = (c + COLS) % len;
      else if (e.key === 'ArrowUp') c = (c - COLS + len) % len;
      if (c !== this.menu.val) { this.menu.val = c; this.menu.picked = true; this.renderMenu(); }
      return;
    }
    if (this.menu.kind === 'puzzle') {
      e.preventDefault(); e.stopPropagation();
      switch (e.key) {
        case 'Escape': this.closeMenu(); break;
        case 'ArrowRight': this.puzzleKeyMove('Right'); break;
        case 'ArrowLeft': this.puzzleKeyMove('Left'); break;
        case 'ArrowUp': this.puzzleKeyMove('Up'); break;
        case 'ArrowDown': this.puzzleKeyMove('Down'); break;
      }
      return;
    }
    if (this.menu.kind === 'tetris') {
      e.preventDefault(); e.stopPropagation();
      switch (e.key) {
        case 'Escape': this.closeMenu(); break;
        case 'ArrowLeft': this.tetrisMove(-1, 0); break;
        case 'ArrowRight': this.tetrisMove(1, 0); break;
        case 'ArrowUp': this.tetrisRotate(); break;
        case 'ArrowDown': this.tetrisMove(0, 1); break;
        case ' ': this.tetrisHardDrop(); break;
      }
      return;
    }
    if (this.menu.kind === 'config') {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { this.closeMenu(); return; }
      if (e.key === 'Enter' || e.key === ' ') { this.openConfigScreensaver(); return; }
      return;
    }
    if (this.menu.kind === 'config-screensaver') {
      e.preventDefault(); e.stopPropagation();
      const m = this.menu;
      const SAVERS = ['starnight', 'lines', 'polygons', 'fireworks', 'worms', 'tiles'];
      if (e.key === 'Escape') { this.openConfig(); return; }
      if (e.key === 'Enter') { this.saveConfigScreensaver(); return; }
      if (e.key === 'ArrowUp') {
        const i = SAVERS.indexOf(m.name);
        if (i > 0) { m.name = SAVERS[i - 1]; this.renderMenu(); }
        return;
      }
      if (e.key === 'ArrowDown') {
        const i = SAVERS.indexOf(m.name);
        if (i < SAVERS.length - 1) { m.name = SAVERS[i + 1]; this.renderMenu(); }
        return;
      }
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const items = this.currentItems();
    const move = (dir) => {
      let guard = 0;
      do {
        this.menu.item = (this.menu.item + dir + items.length) % items.length;
        guard++;
      } while (items[this.menu.item] && items[this.menu.item].sep && guard < items.length);
      this.renderMenu();
    };
    switch (e.key) {
      case 'Escape': this.closeMenu(); break;
      case 'Tab': this.closeMenu(); break;
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'Enter': this.runMenuItem(); break;
      case 'ArrowRight':
        if (this.menu.kind === 'pulldown') { this.menu.cat = (this.menu.cat + 1) % this.menu.cats.length; this.menu.item = 0; this.skipToSelectable(1); this.renderMenu(); }
        break;
      case 'ArrowLeft':
        if (this.menu.kind === 'pulldown') { this.menu.cat = (this.menu.cat - 1 + this.menu.cats.length) % this.menu.cats.length; this.menu.item = 0; this.skipToSelectable(1); this.renderMenu(); }
        break;
      case 'Home': this.menu.item = 0; this.skipToSelectable(1); this.renderMenu(); break;
      case 'End': this.menu.item = items.length - 1; this.skipToSelectable(-1); this.renderMenu(); break;
      case 'F9': if (this.menu.kind === 'pulldown') this.closeMenu(); break;
      case 'F2': if (this.menu.kind === 'list') this.closeMenu(); break;
    }
  }

  runMenuItem() {
    const items = this.currentItems();
    const it = items[this.menu.item];
    this.closeMenu();
    if (it && it.run) it.run();
  }

  // Stop an open Tetris game: clear its interval timer and drop the three
  // document-level touch listeners. Safe to call unconditionally (both closeMenu
  // and onClose route through it, so closing the leaf mid-game never leaks).
  teardownTetris() {
    if (this.menu && this.menu.timer) { window.clearInterval(this.menu.timer); this.menu.timer = null; }
    if (this.boundTetrisTouchStart) {
      document.removeEventListener('touchstart', this.boundTetrisTouchStart);
      document.removeEventListener('touchmove', this.boundTetrisTouchMove);
      document.removeEventListener('touchend', this.boundTetrisTouchEnd);
      this.boundTetrisTouchStart = null;
      this.boundTetrisTouchMove = null;
      this.boundTetrisTouchEnd = null;
    }
  }

  closeMenu() {
    this.teardownTetris();
    this.popMenuScope();
    if (this.overlayEl) { this.overlayEl.remove(); this.overlayEl = null; }
    this.menu = null;
    this.focusView();
    this.renderTopbar();   // clear any docked-category highlight (and reflect Hide-menu changes)
  }

  // While a menu is open, push a keymap scope that swallows Esc, so closing
  // the menu with Esc does NOT bubble up and make Obsidian close the whole
  // Commander leaf (this is the same mechanism Obsidian's own modals use).
  pushMenuScope() {
    if (this.menuScope) return;
    this.menuScope = new Scope();
    this.menuScope.register([], 'Escape', () => { this.closeMenu(); return false; });
    this.app.keymap.pushScope(this.menuScope);
  }
  popMenuScope() {
    if (!this.menuScope) return;
    this.app.keymap.popScope(this.menuScope);
    this.menuScope = null;
  }

  /* ── menu helper actions ── */
  async reloadPanel(p) {
    if (p.mode === 'tree') { await this.initTree(p); this.renderPanel(p); await this.driveFromTree(p); return; }
    if (p.mode === 'list') { await this.reloadOne(p); this.renderPanel(p); return; }
    this.renderPanel(p);   // info / quick just re-read the other panel
  }
  async gotoPath(target) {
    const p = this.workPanel();
    if (!p) { new Notice('No file panel active.'); return; }
    if (await this.loadPanel(p, target)) { p.cursor = 0; this.renderPanel(p); this.renderCmd(); }
    else new Notice('Path not reachable: ' + target);
  }
  gotoVault() {
    if (!this.fp.capabilities.absolutePaths) { this.gotoPath(''); return; }   // vault root
    const base = this.app.vault.adapter && this.app.vault.adapter.basePath;
    if (base) this.gotoPath(base); else new Notice('Vault path not found.');
  }
  async swapPanels() {
    const a = this.left.cwd, b = this.right.cwd;
    await this.loadPanel(this.left, b); await this.loadPanel(this.right, a);
    this.left.cursor = 0; this.right.cursor = 0; this.renderAll();
  }
  async equalizePanels() {
    const target = this.active.cwd, other = this.otherPanel();
    if (await this.loadPanel(other, target)) { other.cursor = 0; this.renderAll(); }
  }
  async selectAll() {
    const p = this.workPanel();
    if (!p) return;
    for (const en of p.entries) {
      if (en.up) continue;
      p.tagged.add(en.name);
      if (en.isDir) await this.computeDirSize(p, en);
    }
    this.renderPanel(p);
  }
  clearTags() { const p = this.workPanel(); if (!p) return; p.tagged.clear(); this.renderPanel(p); }
  toggleHidden() { this.plugin.settings.showHidden = !this.plugin.settings.showHidden; this.plugin.saveSettings(); this.refresh(); }
  toggleSetting(key) { this.plugin.settings[key] = !this.plugin.settings[key]; this.plugin.saveSettings(); }
  toggleWrap() { this.plugin.settings.wrapText = !this.plugin.settings.wrapText; this.plugin.saveSettings(); this.renderAll(); }
  openInSystem() {
    const p = this.workPanel() || this.active;
    try { this.fp.openInSystem(p.cwd); }
    catch (_) { new Notice('Could not open the system file manager.'); }
  }
  newFile() {
    const wp = this.workPanel();
    if (!wp) { new Notice('No file panel active.'); return; }
    if (wp.zip) { new Notice('Not possible inside an archive.'); return; }
    new PromptModal(this.app, { title: 'New file', placeholder: 'File name',
      validate: (name) => invalidNameReason(name),
      onSubmit: async (name) => {
      if (!name) return;
      const full = this.P.join(wp.cwd, name);
      try {
        if (await this.fp.exists(full)) { new Notice('Already exists.'); return; }
        await this.fp.write(full, '');
        await this.refresh();
      } catch (e) { new Notice('Fehler: ' + e.message); }
    } }).open();
  }

  /* ── archives: browse a .zip like a folder ── */
  async enterZip(p, zipPath) {
    let entries;
    try { entries = await this.fp.readZipCentral(zipPath); }
    catch (e) { new Notice('Could not read archive: ' + e.message); return false; }
    p.zip = { path: zipPath, entries, prefix: '' };
    p.entries = buildZipListing(p.zip);
    this.applySort(p);
    p.tagged = new Set();
    p.cursor = 0;
    return true;
  }

  zipDirSize(zip, base) {
    let total = 0;
    for (const ze of zip.entries) if (ze.name.startsWith(base) && !ze.name.endsWith('/')) total += ze.uncompSize;
    return total;
  }

  async computeDirSize(p, en, shouldCancel) {
    if (en.dirSize != null) return;
    if (p.zip) { en.dirSize = this.zipDirSize(p.zip, p.zip.prefix + en.name + '/'); return; }
    try {
      const size = await this.fp.dirSize(this.P.join(p.cwd, en.name), shouldCancel);
      // a cancelled walk returns a partial total — don't cache it as the real size
      if (shouldCancel && shouldCancel()) return;
      en.dirSize = size;
    } catch (_) { en.dirSize = 0; }
  }

  // extract the current selection (files / folders) out to a real directory
  async extractSelectionTo(destDir) {
    const p = this.workPanel();
    if (!p) return;
    const sel = this.getSelection(p);
    let ok = 0, fail = 0;
    const write = async (ze, rel) => {
      const target = this.P.join(destDir, rel);
      try {
        await this.fp.mkdir(this.P.dirname(target));
        await this.fp.writeBinary(target, await this.fp.extractZipEntry(p.zip.path, ze));
        ok++;
      } catch (_) { fail++; }
    };
    for (const item of sel) {
      const en = item.en;
      if (!en) continue;
      if (en.isDir) {
        const base = p.zip.prefix + en.name + '/';
        for (const ze of p.zip.entries) {
          if (!ze.name.startsWith(base) || ze.name.endsWith('/')) continue;
          await write(ze, ze.name.slice(p.zip.prefix.length));
        }
      } else {
        await write(en.zipEntry, en.name);
      }
    }
    new Notice(`${ok} file(s) extracted${fail ? `, ${fail} failed` : ''}.`);
    await this.refresh();
  }

  /* ── fullscreen: make the NC leaf fill the whole Obsidian window ── */
  setFullscreen(on) {
    // set the flag unconditionally so toggle/summon logic never desyncs, even if
    // the leaf element isn't attached yet; apply the leaf styling when it is.
    this.fullscreen = !!on;
    document.body.classList.toggle('nc-fs-active', this.fullscreen);
    if (this.fullscreen) {
      this._bindFsReasserts();
      this._applyFsLeaf();
    } else {
      this._clearFsLeaf();
    }
    this.focusView();
  }

  // Fullscreen has to cover the whole window, which means positioning the *leaf*
  // itself — never an element inside the view. Obsidian sets `contain: strict` on
  // `.workspace-leaf`, which makes the leaf a containing block for any fixed-
  // positioned descendant, so a fixed element inside the view can only ever fill
  // the leaf, not the window.
  //
  // The leaf is Obsidian's, so we can't style it from our stylesheet without an
  // `!important` (which the plugin review flags as a caution). Instead we set the
  // positioning as inline styles on the leaf. Obsidian re-writes the leaf's inline
  // style on any re-layout (mobile orientation change, tab switch), wiping ours —
  // so we re-assert on every such signal (window resize/orientationchange +
  // workspace resize/layout-change) and via a MutationObserver, each time
  // re-resolving the leaf in case Obsidian swapped the element out.
  _fsLeaf() { return this.containerEl.closest('.workspace-leaf'); }

  _applyFsLeaf() {
    const el = this._fsLeaf();
    if (!el) return;
    this._fsLeafEl = el;
    el.classList.add('nc-fs');
    // drop anything Obsidian's own layout may have set that would fight a full-
    // window box (an explicit width/height for the split, an animation transform)…
    el.style.width = '';
    el.style.height = '';
    el.style.transform = '';
    // …then pin the leaf to the viewport.
    el.style.position = 'fixed';
    el.style.inset = '0';
    el.style.zIndex = '100';
    this._observeFsLeaf(el);
  }

  _clearFsLeaf() {
    if (this._fsObserver) this._fsObserver.disconnect();
    const el = this._fsLeafEl || this._fsLeaf();
    if (el) {
      el.classList.remove('nc-fs');
      el.style.position = '';
      el.style.inset = '';
      el.style.zIndex = '';
      el.style.transform = '';
    }
    this._fsLeafEl = null;
  }

  // re-apply the fullscreen box after Obsidian re-lays-out the leaf (orientation
  // change, tab switch); a no-op unless we're actually fullscreen.
  _reassertFs() { if (this.fullscreen) this._applyFsLeaf(); }

  _observeFsLeaf(el) {
    if (!this._fsObserver) {
      this._fsObserver = new MutationObserver(() => {
        // Obsidian rewrote the leaf's style; re-assert if it dropped our positioning.
        if (this.fullscreen && this._fsLeafEl && this._fsLeafEl.style.position !== 'fixed') {
          this._fsObserver.disconnect();   // don't observe our own write
          this._applyFsLeaf();
        }
      });
    } else {
      this._fsObserver.disconnect();
    }
    this._fsObserver.observe(el, { attributes: true, attributeFilter: ['style'] });
  }

  // bind the relayout listeners once (auto-cleaned when the view unloads); each
  // handler no-ops unless fullscreen, so it's safe to leave bound across toggles.
  _bindFsReasserts() {
    if (this._fsReassertsBound) return;
    this._fsReassertsBound = true;
    const reassert = () => this._reassertFs();
    this.registerDomEvent(window, 'resize', reassert);
    this.registerDomEvent(window, 'orientationchange', reassert);
    this.registerEvent(this.app.workspace.on('resize', reassert));
    this.registerEvent(this.app.workspace.on('layout-change', reassert));
  }
  toggleFullscreen() { this.setFullscreen(!this.fullscreen); }

  async actDrive(panel) {
    const vols = await this.fp.volumes();
    new DriveModal(this.app, vols, async (chosen) => {
      if (await this.loadPanel(panel, chosen)) { panel.cursor = 0; this.renderAll(); }
    }).open();
  }

  actQuit() { this.leaf.detach(); }

  async runCommand(raw) {
    const line = raw.trim();
    if (!line) return;
    // ── easter eggs ──
    const egg = line.toLowerCase();
    if (egg === 'xyzzy') { new EggModal(this.app).open(); return; }
    if (egg === 'doom') { new Notice('Knee-deep in the… files. No DOOM here — try “xyzzy”. 😉'); return; }
    const p = this.active;
    if (/^cd\s+/i.test(line) || line === 'cd') {
      const arg = line.replace(/^cd\s*/i, '').trim() || this.fp.homeDir();
      const target = this.P.resolve(p.cwd, arg.replace(/^~(?=$|\/)/, this.fp.homeDir()));
      if (await this.loadPanel(p, target)) { p.cursor = 0; this.renderPanel(p); this.renderCmd(); }
      else new Notice('Directory not found: ' + target);
      return;
    }
    if (!this.fp.capabilities.exec) {
      new Notice('Command execution is not available in this build.');
      return;
    }
    if (!this.plugin.settings.enableExec) {
      new Notice('Command execution is disabled in settings.');
      return;
    }
    this.fp.exec(line, p.cwd, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '') + (err && !stdout && !stderr ? String(err) : '');
      new ViewerModal(this.app, { title: `$ ${line}`, content: out || '(no output)' }).open();
      this.refresh();
    });
  }

  /* ── view modes: Brief (list) · Info · Tree · Quick view ───────────
     A panel can render as a normal file list or as one of three
     companion views that reflect / drive the *other* panel, just like
     the classic Left/Right "Info / Tree / Quick view" menu entries. */

  otherOf(p) { return p === this.left ? this.right : this.left; }

  // the file-list panel that file operations should act on: the active
  // panel if it's a list, otherwise the opposite one if it is. Info/Quick/
  // Tree panels don't hold a file selection, so ops fall back to the list.
  workPanel() {
    if (this.active.mode === 'list') return this.active;
    const o = this.otherOf(this.active);
    if (o.mode === 'list') return o;
    return null;
  }

  // destination directory for copy/move = the panel opposite the work panel,
  // as long as it points at a real directory (list or tree). null otherwise.
  destDir() {
    const src = this.workPanel();
    if (!src) return null;
    const dest = this.otherOf(src);
    if (dest.mode === 'list' || dest.mode === 'tree') return dest.cwd;
    return null;
  }

  // after the file panel changes, refresh a dependent Info / Quick view
  syncSpecials(changed) {
    const o = this.otherOf(changed);
    if (o.mode === 'info' || o.mode === 'quick') this.renderPanel(o);
  }

  /* ── sorting: Name / Endung / Zeit / Größe / Unsortiert (Strg+F3..F7) ── */

  sortComparator(key, asc) {
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    let base;
    switch (key) {
      case 'ext':  base = (a, b) => this.P.extname(a.name).toLowerCase().localeCompare(this.P.extname(b.name).toLowerCase()) || byName(a, b); break;
      case 'time': base = (a, b) => (a.mtime - b.mtime) || byName(a, b); break;   // ascending: oldest first
      case 'size': base = (a, b) => (a.size - b.size) || byName(a, b); break;     // ascending: smallest first
      default:     base = byName;                                                 // 'name'
    }
    return asc === false ? (a, b) => -base(a, b) : base;
  }

  // re-order p.entries in place: '..' first, directories before files, each
  // group ordered by the panel's sort key ('unsorted' keeps the readdir order)
  applySort(p) {
    const key = p.sortKey || 'name';
    const up = p.entries.filter((e) => e.up);
    const dirs = p.entries.filter((e) => !e.up && e.isDir);
    const files = p.entries.filter((e) => !e.up && !e.isDir);
    if (key !== 'unsorted') {
      const cmp = this.sortComparator(key, p.sortAsc !== false);
      dirs.sort(cmp); files.sort(cmp);
    }
    p.entries = up.concat(dirs, files);
  }

  // set the sort column; clicking/choosing the same column again flips direction.
  // `dir` (optional): true = ascending, false = descending; omit = toggle/default.
  setSort(p, key, dir) {
    const cur = p.entries[p.cursor];          // try to keep the cursor on the same entry
    if (key === p.sortKey && key !== 'unsorted') {
      p.sortAsc = dir != null ? dir : !(p.sortAsc !== false);   // same column → flip
    } else {
      p.sortKey = key;
      // new column → classic default: name/ext ascending (a..z), time/size
      // descending (newest / largest first)
      p.sortAsc = dir != null ? dir : !(key === 'time' || key === 'size');
    }
    this.applySort(p);
    const idx = cur ? p.entries.indexOf(cur) : -1;
    if (idx >= 0) p.cursor = idx;
    p.cursor = Math.max(0, Math.min(p.cursor, p.entries.length - 1));
    this.persist();
    this.renderPanel(p);
    const arrow = key === 'unsorted' ? '' : (p.sortAsc !== false ? ' ↑' : ' ↓');
    new Notice('Sort: ' + this.sortLabel(key) + arrow);
  }

  sortLabel(key) {
    return { name: 'Name', ext: 'Extension', time: 'Time', size: 'Size', unsorted: 'Unsorted' }[key] || key;
  }

  // small ▾ marker on the active sort column in the list header
  updateColHead(p) {
    if (!p.colName) return;
    const k = p.sortKey || 'name';
    const arrow = (p.sortAsc !== false) ? ' ▴' : ' ▾';   // ▴ ascending, ▾ descending
    p.colName.setText((k === 'ext' ? 'Extension' : 'Name') + ((k === 'name' || k === 'ext') ? arrow : ''));
    p.colSize.setText('Size' + (k === 'size' ? arrow : ''));
    p.colDate.setText('Date' + (k === 'time' ? arrow : ''));
  }

  /* ── Wide layout (Full = Name/Size/Date · Wide = names in columns) ── */
  colRows(p) {
    const rowH = 20;
    return Math.max(1, Math.floor((p.listEl.clientHeight || rowH) / rowH));
  }
  setListLayout(p, layout) {
    p.layout = layout;
    if (p.mode !== 'list') { this.setPanelMode(p, 'list'); return; }   // also reloads + renders
    this.persist();
    this.renderPanel(p);
    this.refreshMarks(this.left); this.refreshMarks(this.right);
  }

  /* ── quick filter: a printable key jumps to the matching entry; the same
     letter again jumps to the next match; several letters build a prefix ── */
  quickSearch(c) {
    const p = this.active;
    if (p.mode !== 'list' || !p.entries.length) return;
    const now = Date.now();
    if (now - (p.searchTime || 0) > 1000) p.searchBuf = '';
    p.searchTime = now;
    const lc = c.toLowerCase();
    const cand = (p.searchBuf === lc) ? p.searchBuf : (p.searchBuf + lc);   // repeated single letter → cycle
    const start = (cand.length === 1) ? p.cursor + 1 : p.cursor;
    const n = p.entries.length;
    for (let k = 0; k < n; k++) {
      const idx = ((start + k) % n + n) % n;
      const en = p.entries[idx];
      if (en.up) continue;
      if (en.name.toLowerCase().startsWith(cand)) {
        p.searchBuf = cand;
        p.cursor = idx;
        this.refreshMarks(p);
        p.footEl.setText('filter: ' + cand);
        break;
      }
    }
    window.clearTimeout(this._qsTimer);
    this._qsTimer = window.setTimeout(() => { p.searchBuf = ''; if (p.mode === 'list') this.updateFoot(p); }, 1500);
  }

  /* ── bookmarks (directory hotlist) ── */
  addBookmark(dir) {
    const hl = this.plugin.settings.hotlist || (this.plugin.settings.hotlist = []);
    if (hl.includes(dir)) { new Notice('Already bookmarked.'); return; }
    hl.push(dir);
    this.plugin.saveSettings();
    new Notice('Bookmarked: ' + dir);
  }
  removeBookmark(dir) {
    const hl = this.plugin.settings.hotlist || [];
    const i = hl.indexOf(dir);
    if (i >= 0) { hl.splice(i, 1); this.plugin.saveSettings(); }
  }
  openHotlist() {
    const cur = (this.workPanel() || this.active).cwd;
    new HotlistModal(this.app, {
      current: cur,
      home: this.fp.homeDir(),
      absolute: this.fp.capabilities.absolutePaths,
      bookmarks: (this.plugin.settings.hotlist || []).slice(),
      onGo: (target) => this.gotoPath(target),
      onAdd: (target) => this.addBookmark(target),
      onRemove: (target) => this.removeBookmark(target),
    }).open();
  }

  async setPanelMode(p, mode) {
    if (p.mode === mode) return;
    p.mode = mode;
    p.tree = (mode === 'tree') ? p.tree : null;
    if (mode === 'tree') await this.initTree(p);
    // returning to the file list: reload the directory we ended up in
    if (mode === 'list') await this.loadPanel(p, p.cwd);
    // don't leave the keyboard focus stranded on a passive panel
    if ((mode === 'info' || mode === 'quick') && this.active === p) {
      const o = this.otherOf(p);
      if (o.mode === 'list' || o.mode === 'tree') this.active = o;
    }
    this.persist();
    this.renderAll();
    this.refreshMarks(this.left); this.refreshMarks(this.right);
    this.renderCmd();
    this.focusView();
  }

  /* ── Info view ── */

  volumeLabel(dir) {
    if (!this.fp.capabilities.absolutePaths) return 'vault';
    if (IS_WINDOWS) return this.P.root(dir).replace(/\\$/, '');
    const m = /^\/Volumes\/([^/]+)/.exec(dir);
    return m ? m[1] : '/';
  }

  // classic NC reads a "dirinfo" file in the folder and shows its text
  async readDirInfo(dir) {
    try {
      const hit = (await this.fp.readdirNames(dir)).find((n) => /^dirinfo(\.txt)?$/i.test(n));
      if (!hit) return null;
      const full = this.P.join(dir, hit);
      if ((await this.fp.stat(full)).size > 64 * 1024) return '(dirinfo too large)';
      return await this.fp.read(full);
    } catch (_) { return null; }
  }

  renderInfoPanel(p) {
    p.headEl.empty();
    p.headEl.createDiv({ cls: 'nc-panel-path', text: 'Info', attr: { style: 'direction: ltr;' } });
    p.listEl.empty();
    // drop any dir-size walk still pending from a previous (superseded) render
    if (this._infoSizeTimer) { window.clearTimeout(this._infoSizeTimer); this._infoSizeTimer = null; }
    const seq = ++p.renderSeq;
    const wrap = p.listEl.createDiv({ cls: 'nc-info' });
    const src = this.otherOf(p);
    if (src.mode !== 'list') {
      wrap.createDiv({ cls: 'nc-info-line nc-info-dim', text: 'The other panel is not a file panel.' });
      p.footEl.setText('');
      return;
    }

    const ver = (this.plugin.manifest && this.plugin.manifest.version) || '';
    const banner = wrap.createDiv({ cls: 'nc-info-banner' });
    banner.createDiv({ text: `The ${VC_NAME}${ver ? ', Version ' + ver : ''}` });

    let files = 0, dirs = 0, bytes = 0;
    for (const en of src.entries) {
      if (en.up) continue;
      if (en.isDir) dirs++; else { files++; bytes += en.size; }
    }

    const b1 = wrap.createDiv({ cls: 'nc-info-box' });
    // free/total are filled in once freeSpace() resolves (kept above the counts)
    const freeLine = b1.createDiv({ cls: 'nc-info-line' }); freeLine.style.display = 'none';
    const totalLine = b1.createDiv({ cls: 'nc-info-line' }); totalLine.style.display = 'none';
    b1.createDiv({ cls: 'nc-info-line', text: `${files} file(s) and ${dirs} folder(s)` });
    b1.createDiv({ cls: 'nc-info-line', text: `use ${fmtSize(bytes)} bytes here` });
    this.fp.freeSpace(src.cwd).then((disk) => {
      if (seq !== p.renderSeq || !disk) return;
      freeLine.style.display = ''; freeLine.setText(`${fmtSize(disk.free)} bytes free`);
      totalLine.style.display = ''; totalLine.setText(`${fmtSize(disk.total)} bytes total on the volume`);
    }).catch(() => {});

    const b2 = wrap.createDiv({ cls: 'nc-info-box' });
    b2.createDiv({ cls: 'nc-info-line', text: `Directory: ${src.cwd}` });
    b2.createDiv({ cls: 'nc-info-line', text: `Volume: ${this.volumeLabel(src.cwd)}` });

    const cur = src.entries[src.cursor];
    if (cur && !cur.up) {
      const b3 = wrap.createDiv({ cls: 'nc-info-box' });
      const dateSuffix = cur.mtime ? '   ' + fmtDate(cur.mtime) : '';
      b3.createDiv({ cls: 'nc-info-line', text: `${cur.name}` });
      const szLine = b3.createDiv({ cls: 'nc-info-line', text: (cur.isDir ? '‹DIR›' : `${fmtSize(cur.size)} bytes`) + dateSuffix });
      // for folders, show the recursive content size (compute once, cache on the entry)
      if (cur.isDir) {
        if (cur.dirSize != null) szLine.setText(`${fmtSize(cur.dirSize)} bytes${dateSuffix}`);
        else {
          // Defer the (potentially huge) recursive walk until the cursor settles,
          // and cancel it the moment this render is superseded — so scrolling
          // through a folder of big subfolders never piles up blocking walks.
          szLine.setText('calculating…' + dateSuffix);
          this._infoSizeTimer = window.setTimeout(() => {
            this._infoSizeTimer = null;
            this.computeDirSize(src, cur, () => seq !== p.renderSeq).then(() => {
              if (seq !== p.renderSeq) return;
              szLine.setText(cur.dirSize != null ? `${fmtSize(cur.dirSize)} bytes${dateSuffix}` : `‹DIR›${dateSuffix}`);
            }).catch(() => {});
          }, 300);
        }
      }
    }

    const b4 = wrap.createDiv({ cls: 'nc-info-box' });
    this.readDirInfo(src.cwd).then((info) => {
      if (seq !== p.renderSeq) return;
      if (info != null) b4.createEl('pre', { cls: 'nc-info-dirinfo', text: info });
      else b4.createDiv({ cls: 'nc-info-line nc-info-dim', text: 'No "dirinfo" file in this directory' });
    }).catch(() => {});

    p.footEl.setText(src.cwd);
  }

  /* ── Quick view ── */

  renderQuickPanel(p) {
    p.headEl.empty();
    p.headEl.createDiv({ cls: 'nc-panel-path', text: 'Quick view', attr: { style: 'direction: ltr;' } });
    p.listEl.empty();
    const seq = ++p.renderSeq;
    const src = this.otherOf(p);
    if (src.mode !== 'list') {
      p.listEl.createDiv({ cls: 'nc-quick-msg nc-info-dim', text: 'The other panel is not a file panel.' });
      p.footEl.setText('');
      return;
    }
    const en = src.entries[src.cursor];
    p.footEl.setText(en ? (en.up ? '..' : en.name) : '');
    if (!en) return;
    if (en.up) { p.listEl.createDiv({ cls: 'nc-quick-msg', text: 'Parent directory' }); return; }

    if (src.zip) {
      const t = en.isDir ? `‹DIR›  ${en.name}` : `${en.name}\n${fmtSize(en.size)} bytes`;
      p.listEl.createDiv({ cls: 'nc-quick-msg', text: t });
      return;
    }

    const full = this.P.join(src.cwd, en.name);
    if (en.isDir) { this.fillQuickDir(p, seq, full, en); return; }
    this.fillQuickFile(p, seq, full, en);
  }

  async fillQuickDir(p, seq, full, en) {
    let files = 0, dirs = 0;
    try {
      for (const e of await this.fp.list(full, this.plugin.settings.showHidden)) {
        if (e.up) continue;
        if (e.isDir) dirs++; else files++;
      }
    } catch (_) { /* unreadable */ }
    if (seq !== p.renderSeq) return;
    const w = p.listEl.createDiv({ cls: 'nc-quick-dir' });
    w.createDiv({ text: `📁  ${en.name}` });
    w.createDiv({ text: `${files} file(s), ${dirs} folder(s)` });
  }

  async fillQuickFile(p, seq, full, en) {
    let st;
    try { st = await this.fp.stat(full); }
    catch (_) { if (seq === p.renderSeq) p.listEl.createDiv({ cls: 'nc-quick-msg nc-info-dim', text: 'Cannot read file.' }); return; }
    if (seq !== p.renderSeq) return;

    if (IMAGE_RE.test(en.name)) {
      if (st.size > this.imageLimit()) { p.listEl.createDiv({ cls: 'nc-quick-msg', text: `Image too large for preview (max ${fmtSize(this.imageLimit())}).` }); return; }
      try {
        const buf = await this.fp.readBinary(full);
        if (seq !== p.renderSeq) return;
        const src = await bytesToDataURL(buf, mimeFor(en.name));
        if (seq !== p.renderSeq) return;
        const img = p.listEl.createDiv({ cls: 'nc-quick-img' }).createEl('img');
        img.src = src;
      } catch (_) { if (seq === p.renderSeq) p.listEl.createDiv({ cls: 'nc-quick-msg', text: 'Could not load image.' }); }
      return;
    }

    if (st.size > this.quickTextLimit()) { p.listEl.createDiv({ cls: 'nc-quick-msg nc-info-dim', text: `File too large for quick view (${fmtSize(st.size)}, max ${fmtSize(this.quickTextLimit())}).` }); return; }
    let content;
    try { content = await this.fp.read(full); }
    catch (_) { if (seq === p.renderSeq) p.listEl.createDiv({ cls: 'nc-quick-msg nc-info-dim', text: 'Read error.' }); return; }
    if (seq !== p.renderSeq) return;
    if (content.indexOf('\u0000') !== -1) { p.listEl.createDiv({ cls: 'nc-quick-msg nc-info-dim', text: 'Binary file.' }); return; }
    p.listEl.createEl('pre', { cls: 'nc-quick-pre', text: content })
      .toggleClass('nc-wrap', !!this.plugin.settings.wrapText);
  }

  /* ── Tree view: a lazily-loaded directory tree that drives the other panel ── */

  // immediate sub-directory names of `dir`, honouring the hidden-files setting
  async treeChildren(dir) {
    let entries;
    try { entries = await this.fp.list(dir, this.plugin.settings.showHidden); }
    catch (_) { return []; }
    const out = [];
    for (const e of entries) { if (!e.up && e.isDir) out.push(e.name); }
    out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return out;
  }

  makeTreeNode(name, full, depth) {
    return { name, path: full, depth, expanded: false, children: null };
  }

  async loadTreeNode(node) {
    if (node.children) return;
    node.children = (await this.treeChildren(node.path)).map((n) => this.makeTreeNode(n, this.P.join(node.path, n), node.depth + 1));
  }

  // build the tree, anchored at the file panel's current directory so that
  // moving through the tree drives that panel onward from where it already is
  async initTree(p) {
    const o = this.otherOf(p);
    const anchor = (o && o.mode === 'list') ? o.cwd : p.cwd;
    const root = this.fp.capabilities.absolutePaths ? (this.P.root(anchor) || '/') : '';
    const rootNode = this.makeTreeNode(root, root, 0);
    rootNode.expanded = true;
    await this.loadTreeNode(rootNode);

    let cur = rootNode;
    if (anchor !== root) {
      const parts = this.P.relative(root, anchor).split(this.P.sep).filter(Boolean);
      let acc = root;
      for (const part of parts) {
        acc = this.P.join(acc, part);
        await this.loadTreeNode(cur);
        const child = cur.children.find((c) => c.name === part);
        if (!child) break;
        child.expanded = true;
        await this.loadTreeNode(child);
        cur = child;
      }
    }

    p.tree = { root: rootNode, flat: [], cursor: 0 };
    this.flattenTree(p);
    const idx = p.tree.flat.findIndex((f) => f.node === cur);
    p.tree.cursor = idx >= 0 ? idx : 0;
    p.cwd = cur.path;
  }

  // walk the (visible) tree into a flat list, carrying box-drawing prefixes
  flattenTree(p) {
    const out = [];
    const walk = (node, prefix, isLast, isRoot) => {
      out.push({ node, prefix, isLast, isRoot });
      if (node.expanded && node.children) {
        node.children.forEach((c, i) => {
          const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
          walk(c, childPrefix, i === node.children.length - 1, false);
        });
      }
    };
    walk(p.tree.root, '', true, true);
    p.tree.flat = out;
  }

  renderTreePanel(p) {
    p.headEl.empty();
    p.headEl.createDiv({ cls: 'nc-panel-path', text: 'Tree', attr: { style: 'direction: ltr;' } });
    p.listEl.empty();
    if (!p.tree) { this.initTree(p).then(() => this.renderTreePanel(p)); return; }
    p.tree.flat.forEach((it, i) => {
      const row = p.listEl.createDiv({ cls: 'nc-tree-row' });
      row.dataset.i = String(i);
      const conn = it.isRoot ? '' : it.prefix + (it.isLast ? '└── ' : '├── ');
      row.createSpan({ cls: 'nc-tree-conn', text: conn });
      row.createSpan({ cls: 'nc-tree-name', text: it.node.name });
      row.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        // Mobile: tapping the already-selected node toggles it (no dblclick).
        const reTap = Platform.isMobile && this.active === p && p.tree.cursor === i;
        this.setActive(p); p.tree.cursor = i;
        if (reTap) { this.treeToggle(p); return; }
        this.treeSelect(p);
      });
      row.addEventListener('dblclick', (e) => {
        if (Platform.isMobile) return;   // mobile toggles via the re-tap logic above
        e.stopPropagation(); p.tree.cursor = i; this.treeToggle(p);
      });
    });
    this.refreshTreeMarks(p);
  }

  refreshTreeMarks(p) {
    const rows = p.listEl.children;
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('nc-cursor', i === p.tree.cursor);
    const cur = p.tree.flat[p.tree.cursor];
    p.footEl.setText(cur ? cur.node.path : '');
    const el = rows[p.tree.cursor];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  // selected tree node becomes this panel's cwd and drives the other panel
  async treeSelect(p) {
    const cur = p.tree.flat[p.tree.cursor];
    if (!cur) return;
    p.cwd = cur.node.path;
    this.persist();
    this.refreshTreeMarks(p);
    await this.driveFromTree(p);
  }

  async driveFromTree(p) {
    const o = this.otherOf(p);
    if (o.mode !== 'list') return;
    const cur = p.tree.flat[p.tree.cursor];
    if (cur && await this.loadPanel(o, cur.node.path)) { o.cursor = 0; this.renderPanel(o); }
  }

  // re-flatten after expand/collapse, keeping the cursor on the same node
  reflowTree(p) {
    const selNode = p.tree.flat[p.tree.cursor].node;
    this.flattenTree(p);
    const idx = p.tree.flat.findIndex((f) => f.node === selNode);
    p.tree.cursor = idx >= 0 ? idx : Math.min(p.tree.cursor, p.tree.flat.length - 1);
    this.renderTreePanel(p);
  }

  async treeToggle(p) {
    const node = p.tree.flat[p.tree.cursor].node;
    await this.loadTreeNode(node);
    if (node.children.length === 0) return;
    node.expanded = !node.expanded;
    this.reflowTree(p);
  }

  async treeExpand(p) {
    const node = p.tree.flat[p.tree.cursor].node;
    await this.loadTreeNode(node);
    if (node.children.length === 0) return;
    if (!node.expanded) { node.expanded = true; this.reflowTree(p); }
    else if (p.tree.cursor < p.tree.flat.length - 1) { p.tree.cursor++; await this.treeSelect(p); }
  }

  async treeCollapse(p) {
    const node = p.tree.flat[p.tree.cursor].node;
    if (node.expanded) { node.expanded = false; this.reflowTree(p); return; }
    for (let i = p.tree.cursor - 1; i >= 0; i--) {
      if (p.tree.flat[i].node.depth < node.depth) { p.tree.cursor = i; break; }
    }
    await this.treeSelect(p);
  }

  treeNavKey(e) {
    const p = this.active, t = p.tree;
    if (!t) return false;
    const last = t.flat.length - 1;
    switch (e.key) {
      case 'ArrowDown': if (t.cursor < last) { t.cursor++; this.treeSelect(p); } return true;
      case 'ArrowUp': if (t.cursor > 0) { t.cursor--; this.treeSelect(p); } return true;
      case 'PageDown': t.cursor = Math.min(last, t.cursor + this.pageSize(p)); this.treeSelect(p); return true;
      case 'PageUp': t.cursor = Math.max(0, t.cursor - this.pageSize(p)); this.treeSelect(p); return true;
      case 'Home': t.cursor = 0; this.treeSelect(p); return true;
      case 'End': t.cursor = last; this.treeSelect(p); return true;
      case 'ArrowRight': this.treeExpand(p); return true;
      case 'ArrowLeft': this.treeCollapse(p); return true;
      case 'Enter':
      case ' ': this.treeToggle(p); return true;
      default: return false;
    }
  }
}

/* ── modals ──────────────────────────────────────────────── */

// NC-style copy dialog. A single file shows an EDITABLE name field (rename
// before copying); multiple files show the destination path read-only.
// opts: { count, destDir, name (single only), onConfirm(renameTo|null) }
class CopyModal extends Modal {
  constructor(app, opts) { super(app); this.opts = opts; this.submitted = false; }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('nc-modal'); this.containerEl.addClass('nc-modal-parent');
    contentEl.createEl('h3', { text: 'Copy', cls: 'nc-modal-title' });
    const single = this.opts.count === 1;
    const dest = this.opts.destDir || '';
    const displayDest = dest.length > 55 ? '...' + dest.slice(-52) : dest;
    contentEl.createEl('div', {
      text: single ? `Copy file to ${displayDest}` : `Copy ${this.opts.count} files to`,
      cls: 'nc-modal-body',
      attr: { style: 'white-space: nowrap;' }
    });
    const input = contentEl.createEl('input', { cls: 'nc-modal-input', attr: { type: 'text', spellcheck: 'false' } });
    const errEl = contentEl.createDiv({ cls: 'nc-modal-error' });
    const row = contentEl.createDiv({ cls: 'nc-modal-buttons' });
    const ok = row.createEl('button', { text: 'Copy', cls: 'nc-btn nc-btn-default' });
    const cancel = row.createEl('button', { text: 'Cancel', cls: 'nc-btn' });

    const submit = () => {
      if (single) {
        const v = input.value.trim();
        const err = invalidNameReason(v);
        if (err) { errEl.setText(err); return; }
        this.submitted = true; this.close(); this.opts.onConfirm(v);
      } else {
        this.submitted = true; this.close(); this.opts.onConfirm(null);
      }
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => this.close());
    input.addEventListener('input', () => errEl.setText(''));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

    if (single) {
      // editable file name, pre-filled with the original; select the basename
      // (without extension) so a quick retype renames but keeps the suffix
      input.value = this.opts.name || '';
      window.setTimeout(() => {
        input.focus();
        const dot = input.value.lastIndexOf('.');
        if (dot > 0) input.setSelectionRange(0, dot); else input.select();
      }, 0);
    } else {
      // read-only destination path; focus the Copy button so Enter just confirms
      input.value = this.opts.destDir || '';
      input.readOnly = true;
      window.setTimeout(() => ok.focus(), 0);
    }
  }
  onClose() { this.contentEl.empty(); }
}

class ConfirmModal extends Modal {
  constructor(app, opts) { super(app); this.opts = opts; }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('nc-modal'); this.containerEl.addClass('nc-modal-parent');
    if (this.opts.danger) modalEl.addClass('nc-modal-danger');
    contentEl.createEl('h3', { text: this.opts.title, cls: 'nc-modal-title' });
    contentEl.createEl(this.opts.nowrap ? 'div' : 'pre', { 
      text: this.opts.body, 
      cls: 'nc-modal-body',
      ...(this.opts.nowrap ? { attr: { style: 'white-space: nowrap;' } } : {})
    });
    const row = contentEl.createDiv({ cls: 'nc-modal-buttons' });
    const yes = row.createEl('button', { text: this.opts.confirmLabel || 'OK', cls: 'nc-btn nc-btn-default' });
    // optional middle action (e.g. "Don't Save" in the unsaved-changes prompt)
    let extra = null;
    if (this.opts.extraLabel) {
      extra = row.createEl('button', { text: this.opts.extraLabel, cls: 'nc-btn' });
      extra.addEventListener('click', () => { this.close(); this.opts.onExtra && this.opts.onExtra(); });
    }
    const no = row.createEl('button', { text: this.opts.cancelLabel || 'Cancel', cls: 'nc-btn' });
    yes.addEventListener('click', () => { this.close(); this.opts.onConfirm && this.opts.onConfirm(); });
    no.addEventListener('click', () => this.close());
    window.setTimeout(() => yes.focus(), 0);
    // Enter fires the *focused* button — matching Space's native behaviour — so
    // tabbing to Cancel and pressing Enter cancels instead of confirming. With
    // focus on the default button or the body, Enter still confirms.
    this.scope.register([], 'Enter', () => {
      const a = document.activeElement;
      if (a === no) { this.close(); }
      else if (extra && a === extra) { this.close(); this.opts.onExtra && this.opts.onExtra(); }
      else { this.close(); this.opts.onConfirm && this.opts.onConfirm(); }
      return false;
    });
  }
  onClose() { this.contentEl.empty(); }
}

class PromptModal extends Modal {
  constructor(app, opts) { super(app); this.opts = opts; this.submitted = false; }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('nc-modal'); this.containerEl.addClass('nc-modal-parent');
    contentEl.createEl('h3', { text: this.opts.title, cls: 'nc-modal-title' });
    const input = contentEl.createEl('input', { cls: 'nc-modal-input', attr: { type: 'text', spellcheck: 'false' } });
    input.value = this.opts.value || '';
    if (this.opts.placeholder) input.placeholder = this.opts.placeholder;
    const errEl = contentEl.createDiv({ cls: 'nc-modal-error' });
    const row = contentEl.createDiv({ cls: 'nc-modal-buttons' });
    const ok = row.createEl('button', { text: 'OK', cls: 'nc-btn nc-btn-default' });
    const cancel = row.createEl('button', { text: 'Cancel', cls: 'nc-btn' });
    const submit = () => {
      const v = input.value.trim();
      // optional validation keeps the dialog open and shows the reason inline
      if (this.opts.validate) { const err = this.opts.validate(v); if (err) { errEl.setText(err); return; } }
      this.submitted = true; this.close(); this.opts.onSubmit && this.opts.onSubmit(v);
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => this.close());
    input.addEventListener('input', () => errEl.setText(''));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    window.setTimeout(() => {
      input.focus();
      // selectBasename: highlight only the name, leaving the extension intact
      // so a rename doesn't accidentally drop ".md" etc.
      const dot = this.opts.selectBasename ? input.value.lastIndexOf('.') : -1;
      if (dot > 0) input.setSelectionRange(0, dot); else input.select();
    }, 0);
  }
  // resolve callers (e.g. the conflict "Rename" prompt) even when cancelled
  onClose() { this.contentEl.empty(); if (!this.submitted && this.opts.onSubmit) this.opts.onSubmit(null); }
}

class ConflictModal extends Modal {
  constructor(app, opts) { super(app); this.opts = opts; this.decided = false; }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('nc-modal'); this.containerEl.addClass('nc-modal-parent');
    contentEl.createEl('h3', { text: (this.opts.mode === 'move' ? 'Move' : 'Copy') + ' — already exists', cls: 'nc-modal-title' });
    contentEl.createEl('pre', { text: `"${this.opts.name}" already exists in the target folder.`, cls: 'nc-modal-body' });
    const row = contentEl.createDiv({ cls: 'nc-modal-buttons nc-modal-buttons-wrap' });
    const mk = (label, choice, def) => {
      const b = row.createEl('button', { text: label, cls: 'nc-btn' + (def ? ' nc-btn-default' : '') });
      b.addEventListener('click', () => this.choose(choice));
      return b;
    };
    const def = mk('Overwrite', 'overwrite', true);
    mk('Overwrite all', 'overwriteAll');
    mk('Skip', 'skip');
    mk('Skip all', 'skipAll');
    mk('Rename', 'rename');
    mk('Cancel', 'cancel');
    // Enter activates whichever button is focused (no hard-wired overwrite)
    window.setTimeout(() => def.focus(), 0);
  }
  choose(choice) { this.decided = true; this.close(); this.opts.onChoice(choice); }
  onClose() { this.contentEl.empty(); if (!this.decided) this.opts.onChoice('cancel'); }
}

// the secret blue screen — typing "xyzzy" in the command line opens it
class EggModal extends Modal {
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('nc-modal'); this.containerEl.addClass('nc-modal-parent'); modalEl.addClass('nc-egg');
    contentEl.createEl('h3', { text: '✦  X Y Z Z Y  ✦', cls: 'nc-modal-title' });
    const art =
`☺ ☻ ☺ ☻ ☺ ☻ ☺ ☻ ☺ ☻ ☺

╔════════════════════╗
║   VAULT COMMANDER  ║
║    secret  screen  ║
╚════════════════════╝

      "Nothing happens."
       — Colossal Cave, 1977

🍌  GORILLAS.BAS sends regards.
♥ ♦ ♣ ♠  built with bits & beeps`;
    const pre = contentEl.createEl('pre', { cls: 'nc-egg-art' });
    pre.setText(art);
    pre.createSpan({ cls: 'nc-egg-cursor', text: ' █' });
    const row = contentEl.createDiv({ cls: 'nc-modal-buttons' });
    const close = row.createEl('button', { text: 'Close', cls: 'nc-btn nc-btn-default' });
    close.addEventListener('click', () => this.close());
    window.setTimeout(() => close.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}

class ViewerModal extends Modal {
  constructor(app, opts) { super(app); this.opts = opts; this._navFocus = null; this._navBusy = false; }
  onOpen() {
    const { modalEl } = this;
    modalEl.addClass('nc-modal'); this.containerEl.addClass('nc-modal-parent'); modalEl.addClass('nc-viewer');
    // a paged viewer (Prev/Next/Close) gets its own button colouring: the
    // focused (“selected”) button is green, the others sit black.
    if (this.opts.nav) modalEl.addClass('nc-viewer-paged');
    this.render();
  }

  // (Re)build the whole body for the current opts. Called again by Prev/Next
  // so navigation can swap the file in place while the modal stays open.
  render() {
    const { contentEl } = this;
    // tear down the previous page's per-modal renderers before clearing
    if (this._mdComp) { this._mdComp.unload(); this._mdComp = null; }
    if (this._vvFit && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._vvFit);
      window.visualViewport.removeEventListener('scroll', this._vvFit);
      this._vvFit = null;
    }
    contentEl.empty();
    this._titleEl = contentEl.createEl('h3', { text: this.opts.title, cls: 'nc-modal-title' });
    if (this.opts.image) return this.renderImage();
    if (this.opts.markdown != null) return this.renderMarkdown();
    if (this.opts.editable) return this.renderEditable();
    return this.renderText();
  }

  // Build the button row. A paged viewer (opts.nav) shows Prev/Next/Close and
  // restores focus to the last-pressed nav button after a re-render so Space
  // keeps paging; on first open `bodyEl` is focused so PgUp/PgDn/arrows scroll.
  buildButtons(bodyEl) {
    const row = this.contentEl.createDiv({ cls: 'nc-modal-buttons' });
    if (this.opts.nav) {
      const prev = row.createEl('button', { text: 'Prev', cls: 'nc-btn' });
      const next = row.createEl('button', { text: 'Next', cls: 'nc-btn' });
      const close = row.createEl('button', { text: 'Close', cls: 'nc-btn' });
      prev.addEventListener('click', () => this.navigate(-1, 'prev', prev));
      next.addEventListener('click', () => this.navigate(1, 'next', next));
      close.addEventListener('click', () => this.close());
      window.setTimeout(() => {
        if (this._navFocus === 'prev') prev.focus();
        else if (this._navFocus === 'next') next.focus();
        else if (bodyEl && bodyEl.focus) bodyEl.focus();
        else next.focus();
      }, 0);
    } else {
      const close = row.createEl('button', { text: 'Close', cls: 'nc-btn nc-btn-default' });
      close.addEventListener('click', () => this.close());
      window.setTimeout(() => { if (bodyEl && bodyEl.focus) bodyEl.focus(); else close.focus(); }, 0);
    }
    return row;
  }

  // Step to the previous/next viewable file (opts.nav skips unviewable ones).
  // If there is none in that direction we stay put and keep the button focused.
  async navigate(dir, which, btn) {
    if (this._navBusy || !this.opts.nav) return;
    this._navBusy = true;
    this._navFocus = which;
    let o = null;
    try { o = await this.opts.nav(dir); } catch (_) { o = null; }
    this._navBusy = false;
    if (!o) {
      new Notice(dir < 0 ? 'No previous file.' : 'No more files.');
      if (btn) btn.focus();
      return;
    }
    o.nav = this.opts.nav;   // carry the pager across to the next page
    this.opts = o;
    this.render();
  }

  renderImage() {
    const { contentEl } = this;
    {
      const wrap = contentEl.createDiv({ cls: 'nc-viewer-img' });
      const img = wrap.createEl('img');
      img.src = this.opts.image;

      // eyedropper: show the colour under the cursor (sampled from an
      // offscreen canvas) as a hex value + swatch following the pointer
      const readout = contentEl.createDiv({ cls: 'nc-color-readout' });
      readout.style.display = 'none';
      const swatch = readout.createSpan({ cls: 'nc-color-swatch' });
      const hexEl = readout.createSpan({ cls: 'nc-color-hex' });
      const canvas = document.createElement('canvas');
      let ctx = null;
      img.addEventListener('load', () => {
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        try { ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0); }
        catch (_) { ctx = null; }   // e.g. unrasterisable SVG → no readout
      });
      const hx = (n) => n.toString(16).padStart(2, '0');
      let lastHex = null;
      img.addEventListener('mousemove', (e) => {
        if (!ctx) return;
        const r = img.getBoundingClientRect();
        const x = Math.floor((e.clientX - r.left) / r.width * canvas.width);
        const y = Math.floor((e.clientY - r.top) / r.height * canvas.height);
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) { lastHex = null; readout.style.display = 'none'; return; }
        let d; try { d = ctx.getImageData(x, y, 1, 1).data; } catch (_) { return; }
        const hex = '#' + hx(d[0]) + hx(d[1]) + hx(d[2]);
        lastHex = hex;
        swatch.style.background = hex;
        hexEl.setText(`${hex}   rgb ${d[0]},${d[1]},${d[2]}   ${x},${y}   ·   click = copy`);
        readout.style.display = 'flex';
        readout.style.left = (e.clientX + 16) + 'px';
        readout.style.top = (e.clientY + 16) + 'px';
      });
      img.addEventListener('mouseleave', () => { lastHex = null; readout.style.display = 'none'; });
      // left-click copies the hex value under the cursor to the clipboard
      img.addEventListener('click', () => {
        if (!lastHex) return;
        const v = lastHex;
        navigator.clipboard.writeText(v).then(() => new Notice('Copied ' + v), () => new Notice('Clipboard unavailable.'));
      });

      this.buildButtons(null);   // image isn't focusable → focus a button
    }
  }

  renderMarkdown() {
    const { contentEl } = this;
    {
      const div = contentEl.createDiv({ cls: 'nc-viewer-md markdown-rendered' });
      div.tabIndex = 0;
      const src = this.opts.sourcePath || '';
      // own a per-modal Component so the rendered markdown's child renderers /
      // embeds / observers are torn down when THIS modal closes (not when the
      // long-lived Commander view does)
      const comp = this._mdComp = new Component();
      comp.load();
      if (MarkdownRenderer && MarkdownRenderer.render) MarkdownRenderer.render(this.app, this.opts.markdown, div, src, comp);
      else if (MarkdownRenderer && MarkdownRenderer.renderMarkdown) MarkdownRenderer.renderMarkdown(this.opts.markdown, div, src, comp);
      else div.setText(this.opts.markdown);
      this.buildButtons(div);   // autofocus the body so PgUp/PgDn/arrows scroll
    }
  }

  renderEditable() {
    const { contentEl, modalEl } = this;
    {
      const ta = contentEl.createEl('textarea', { cls: 'nc-viewer-area' });
      this._ta = ta;
      ta.toggleClass('nc-wrap', !!this.opts.wrap);
      ta.setAttribute('wrap', this.opts.wrap ? 'soft' : 'off');   // native textarea wrapping
      ta.value = this.opts.content;
      // track unsaved edits: a "*" prefix on the title flags a dirty buffer, and
      // close() (below) asks before dropping unsaved changes. Compare against the
      // original so undoing back to it clears the flag again.
      this._dirty = false;
      const original = this.opts.content;
      ta.addEventListener('input', () => {
        const d = ta.value !== original;
        if (d !== this._dirty) { this._dirty = d; if (this._titleEl) this._titleEl.setText((d ? '* ' : '') + this.opts.title); }
      });
      const row = contentEl.createDiv({ cls: 'nc-modal-buttons' });
      const save = row.createEl('button', { text: 'Save', cls: 'nc-btn nc-btn-default' });
      const close = row.createEl('button', { text: 'Close', cls: 'nc-btn' });
      save.addEventListener('click', () => { this.opts.onSave && this.opts.onSave(ta.value); this._dirty = false; this.close(); });
      close.addEventListener('click', () => this.close());
      window.setTimeout(() => ta.focus(), 0);
      // Mobile: keep the editor above the on-screen keyboard. The keyboard shrinks
      // window.visualViewport; we pin the modal to the visible area and let the
      // textarea flex so the Save/Close buttons stay reachable.
      if (Platform.isMobile && window.visualViewport) {
        modalEl.addClass('nc-viewer-edit-mobile');
        const vv = window.visualViewport;
        const fit = () => {
          const innerH = window.innerHeight || vv.height;
          const innerW = window.innerWidth || innerH;
          // Obsidian on iOS often does NOT shrink visualViewport for the keyboard,
          // so the modal would run under it. If the viewport clearly shrank, use it.
          if (vv.height < innerH - 100) {
            modalEl.style.top = (vv.offsetTop + 6) + 'px';
            modalEl.style.height = (vv.height - 12) + 'px';
            return;
          }
          // otherwise cap to ~half the screen so the buttons stay above the keyboard.
          const h = Math.round(innerH * 0.5);
          let top = vv.offsetTop + 6;                 // landscape: pin near the top
          if (innerH > innerW) {                      // portrait: lots of room → center
            const kbTop = innerH * 0.60;              // keyboard ≈ bottom 40%
            top = Math.round(vv.offsetTop + Math.max(6, (kbTop - h) / 2));
          }
          modalEl.style.top = top + 'px';
          modalEl.style.height = h + 'px';
        };
        this._vvFit = fit;
        vv.addEventListener('resize', fit);
        vv.addEventListener('scroll', fit);
        fit();
        // when the keyboard animates in on focus, re-fit after it settles
        ta.addEventListener('focus', () => window.setTimeout(fit, 150));
      }
    }
  }

  renderText() {
    const { contentEl } = this;
    const pre = contentEl.createEl('pre', { text: this.opts.content, cls: 'nc-viewer-pre' });
    pre.toggleClass('nc-wrap', !!this.opts.wrap);
    pre.tabIndex = 0;
    this.buildButtons(pre);   // autofocus the body so PgUp/PgDn/arrows scroll
  }

  // Guard the editor against losing unsaved edits. Every close path (Close
  // button, Escape, clicking the backdrop) routes through here; when the buffer
  // is dirty we hold the modal open and ask first. The confirm callbacks clear
  // _dirty before re-calling close(), so the second pass falls straight through.
  close() {
    if (this.opts && this.opts.editable && this._dirty) { this.promptUnsaved(); return; }
    super.close();
  }

  promptUnsaved() {
    const ta = this._ta;
    new ConfirmModal(this.app, {
      title: 'Unsaved changes',
      body: 'This file has unsaved changes.\nSave before closing?',
      nowrap: true,
      confirmLabel: 'Save',
      extraLabel: "Don't Save",
      cancelLabel: 'Cancel',
      onConfirm: () => { if (this.opts.onSave) this.opts.onSave(ta ? ta.value : this.opts.content); this._dirty = false; this.close(); },
      onExtra: () => { this._dirty = false; this.close(); },
    }).open();
  }

  onClose() {
    if (this._vvFit && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._vvFit);
      window.visualViewport.removeEventListener('scroll', this._vvFit);
      this._vvFit = null;
    }
    if (this._mdComp) { this._mdComp.unload(); this._mdComp = null; }
    this.contentEl.empty();
  }
}

class DriveModal extends Modal {
  constructor(app, vols, onPick) { super(app); this.vols = vols; this.onPick = onPick; }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('nc-modal'); this.containerEl.addClass('nc-modal-parent');
    contentEl.createEl('h3', { text: 'Drive / Volume', cls: 'nc-modal-title' });
    const list = contentEl.createDiv({ cls: 'nc-drive-list' });
    for (const v of this.vols) {
      const item = list.createDiv({ cls: 'nc-drive-item', text: `${v.label}   ${v.path}` });
      item.addEventListener('click', () => { this.close(); this.onPick(v.path); });
    }
  }
  onClose() { this.contentEl.empty(); }
}

class HotlistModal extends Modal {
  constructor(app, opts) { super(app); this.opts = opts; this.sel = 0; }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('nc-modal'); this.containerEl.addClass('nc-modal-parent');
    contentEl.createEl('h3', { text: 'Bookmarks', cls: 'nc-modal-title' });
    this.listWrap = contentEl.createDiv({ cls: 'nc-hotlist' });
    // keyboard hint only on desktop; mobile uses tap + the per-row ✕ button
    if (!Platform.isMobile) contentEl.createDiv({ cls: 'nc-hotlist-hint', text: '1–9 = open   ·   Enter = go   ·   Ins = bookmark current   ·   Del = remove   ·   Esc = close' });
    this.build();
    this.selectInitial();   // preselect the current folder's bookmark, else "Bookmark current"
    this.scope.register([], 'ArrowDown', (e) => { e.preventDefault(); this.move(1); return false; });
    this.scope.register([], 'ArrowUp', (e) => { e.preventDefault(); this.move(-1); return false; });
    this.scope.register([], 'Enter', (e) => { e.preventDefault(); this.activate(); return false; });
    this.scope.register([], 'Delete', (e) => { e.preventDefault(); this.removeSel(); return false; });
    this.scope.register([], 'Insert', (e) => { e.preventDefault(); this.addCurrent(); return false; });
    // press a digit to jump straight to that bookmark
    for (let d = 1; d <= 9; d++) this.scope.register([], String(d), (e) => { e.preventDefault(); this.gotoNum(d); return false; });
  }
  gotoNum(d) {
    const it = this.items.find((x) => x.kind === 'bookmark' && x.num === d);
    if (it && it.path != null) { this.close(); this.opts.onGo(it.path); }   // '' = vault root is valid
  }
  // on open, highlight the bookmark for the current folder if it exists,
  // otherwise the "Bookmark current folder" action (index 0)
  selectInitial() {
    const i = this.items.findIndex((it) => it.kind === 'bookmark' && it.path === this.opts.current);
    this.sel = i >= 0 ? i : 0;
    this.markSel();
  }
  build() {
    this.items = [{ kind: 'action', label: '★ Bookmark current folder' }];
    if (this.opts.bookmarks.length) {
      this.items.push({ kind: 'header', label: 'Bookmarks' });
      let n = 0;
      for (const p of this.opts.bookmarks) this.items.push({ kind: 'bookmark', label: p, path: p, num: ++n });
    } else {
      this.items.push({ kind: 'note', label: '(no bookmarks yet — press Ins to add the current folder)' });
    }
    if (!this.selectable(this.sel)) this.sel = this.items.findIndex((_, i) => this.selectable(i));
    this.render();
  }
  selectable(i) { const it = this.items[i]; return !!it && (it.kind === 'action' || it.kind === 'bookmark'); }
  // display a path: vault (relative) paths are shown rooted ("/", "/A/B");
  // absolute (node) paths keep their full form, with the home folder as "~".
  disp(p) {
    if (!this.opts.absolute) return p ? '/' + String(p).replace(/^\/+|\/+$/g, '') : '/';
    const h = this.opts.home;
    if (!h) return p;
    if (p === h) return '~';
    if (p.startsWith(h + path.sep)) return '~' + p.slice(h.length);
    return p;
  }
  render() {
    this.listWrap.empty();
    this.items.forEach((it, i) => {
      if (it.kind === 'header') { this.listWrap.createDiv({ cls: 'nc-hotlist-head', text: it.label }); return; }
      if (it.kind === 'note') { this.listWrap.createDiv({ cls: 'nc-hotlist-note', text: it.label }); return; }
      const row = this.listWrap.createDiv({ cls: 'nc-hotlist-item' + (i === this.sel ? ' nc-sel' : '') });
      row.dataset.i = String(i);
      if (it.kind === 'bookmark') {
        // number the bookmarks (1–9 double as a quick-open shortcut) — hidden on
        // mobile, where there is no number row
        if (!Platform.isMobile) row.createSpan({ cls: 'nc-hotlist-num', text: it.num <= 9 ? String(it.num) : '' });
        row.createSpan({ cls: 'nc-hotlist-label', text: '★ ' + this.disp(it.path) });
        // per-row delete button (TurboVision-style); the main way to remove on mobile
        const del = row.createSpan({ cls: 'nc-hotlist-del', text: '✕', attr: { 'aria-label': 'Remove bookmark', title: 'Remove bookmark' } });
        del.addEventListener('click', (e) => { e.stopPropagation(); this.removeAt(i); });
      } else {
        row.createSpan({ cls: 'nc-hotlist-label', text: it.path ? this.disp(it.path) : it.label });
      }
      row.addEventListener('click', () => { this.sel = i; this.activate(); });
      row.addEventListener('mouseenter', () => { this.sel = i; this.markSel(); });
    });
  }
  markSel() {
    this.listWrap.querySelectorAll('.nc-hotlist-item').forEach((el) => el.classList.toggle('nc-sel', parseInt(el.dataset.i, 10) === this.sel));
    const cur = this.listWrap.querySelector('.nc-hotlist-item.nc-sel');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  move(d) {
    const n = this.items.length;
    let i = this.sel;
    for (let k = 0; k < n; k++) { i = (i + d + n) % n; if (this.selectable(i)) { this.sel = i; break; } }
    this.markSel();
  }
  activate() {
    const it = this.items[this.sel];
    if (!it) return;
    if (it.kind === 'action') { this.addCurrent(); return; }
    if (it.path != null) { this.close(); this.opts.onGo(it.path); }   // '' = vault root is valid
  }
  addCurrent() {
    if (!this.opts.bookmarks.includes(this.opts.current)) {
      this.opts.onAdd(this.opts.current);
      this.opts.bookmarks.push(this.opts.current);
    }
    this.build();
  }
  removeSel() { this.removeAt(this.sel); }
  removeAt(i) {
    const it = this.items[i];
    if (!it || it.kind !== 'bookmark') return;
    this.opts.onRemove(it.path);
    const bi = this.opts.bookmarks.indexOf(it.path);
    if (bi >= 0) this.opts.bookmarks.splice(bi, 1);
    if (this.sel >= i && this.sel > 0) this.sel--;   // keep a sensible selection after removal
    this.build();
  }
  onClose() { this.contentEl.empty(); }
}

/* ── settings ────────────────────────────────────────────── */

class NCSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    if (this._recordStop) this._recordStop();   // cancel a pending hotkey recorder before re-rendering (e.g. Reset button)
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: VC_NAME });

    new Setting(containerEl).setName('Show hidden files')
      .setDesc('List dot-files (.dotfiles) too.')
      .addToggle((t) => t.setValue(this.plugin.settings.showHidden)
        .onChange(async (v) => { this.plugin.settings.showHidden = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Confirm deletions')
      .setDesc('Show a safety dialog before deleting (strongly recommended).')
      .addToggle((t) => t.setValue(this.plugin.settings.confirmDelete)
        .onChange(async (v) => { this.plugin.settings.confirmDelete = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Confirm copies')
      .addToggle((t) => t.setValue(this.plugin.settings.confirmCopy)
        .onChange(async (v) => { this.plugin.settings.confirmCopy = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Max file size for viewer (MB)')
      .setDesc('Largest text/code file the F3 viewer will open. Quick view uses 1/10 of this (capped at 1 MB).')
      .addText((t) => t.setPlaceholder(String(DEFAULTS.maxViewMB))
        .setValue(String(this.plugin.settings.maxViewMB))
        .onChange(async (v) => {
          const n = Number(v);
          this.plugin.settings.maxViewMB = (Number.isFinite(n) && n > 0) ? n : DEFAULTS.maxViewMB;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName('Max file size for internal editor (MB)')
      .setDesc('Largest file the built-in F4 editor will open. Editing is heavier than viewing, especially with line wrap.')
      .addText((t) => t.setPlaceholder(String(DEFAULTS.maxEditMB))
        .setValue(String(this.plugin.settings.maxEditMB))
        .onChange(async (v) => {
          const n = Number(v);
          this.plugin.settings.maxEditMB = (Number.isFinite(n) && n > 0) ? n : DEFAULTS.maxEditMB;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName('Max image preview size (MB)')
      .setDesc('Largest image the viewer and quick view will display.')
      .addText((t) => t.setPlaceholder(String(DEFAULTS.maxImageMB))
        .setValue(String(this.plugin.settings.maxImageMB))
        .onChange(async (v) => {
          const n = Number(v);
          this.plugin.settings.maxImageMB = (Number.isFinite(n) && n > 0) ? n : DEFAULTS.maxImageMB;
          await this.plugin.saveSettings();
        }));

    if (VC_PROVIDER !== 'vault') {
      new Setting(containerEl).setName('Command line enabled')
        .setDesc('Allows running real shell commands from the command line.')
        .addToggle((t) => t.setValue(this.plugin.settings.enableExec)
          .onChange(async (v) => { this.plugin.settings.enableExec = v; await this.plugin.saveSettings(); }));
    }

    if (VC_PROVIDER === 'vault' || Platform.isMobile) {
      new Setting(containerEl).setName(VC_NAME + ' opens in fullscreen')
        .setDesc('Open the commander filling the whole window when launched from the ribbon (F10 / the menu still toggles it).')
        .addToggle((t) => t.setValue(this.plugin.settings.openFullscreen)
          .onChange(async (v) => { this.plugin.settings.openFullscreen = v; await this.plugin.saveSettings(); }));
    }

    new Setting(containerEl).setName('Theme')
      .setDesc('Color scheme: Commander Blue or Navigator Gray.')
      .addDropdown((d) => d
        .addOption('blue', 'Commander Blue')
        .addOption('gray', 'Navigator Gray')
        .setValue(this.plugin.settings.theme)
        .onChange(async (v) => { this.plugin.settings.theme = v; await this.plugin.saveSettings(); this.plugin.applyThemeToViews(); }));

    const hkSetting = new Setting(containerEl)
      .setName('Fullscreen hotkey')
      .setDesc('Opens / brings the Commander to fullscreen (F10 closes it). Click "Record" and press the desired combination.');
    hkSetting.addButton((btn) => {
      btn.setButtonText(hotkeyLabel(this.plugin.settings.fullscreenHotkey) || 'Not set');
      btn.onClick(() => {
        btn.setButtonText('Press key(s)…  (Esc = cancel)');
        this.plugin.recordingHotkey = true;
        const stop = () => {
          document.removeEventListener('keydown', onKey, true);
          this.plugin.recordingHotkey = false;
          this._recordStop = null;
        };
        const onKey = (e) => {
          if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Escape') { stop(); btn.setButtonText(hotkeyLabel(this.plugin.settings.fullscreenHotkey) || 'Not set'); return; }
          const hk = { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, key: e.key };
          this.plugin.settings.fullscreenHotkey = hk;
          this.plugin.saveSettings();
          stop();
          btn.setButtonText(hotkeyLabel(hk));
        };
        // remember the canceller so hide() can clean up if the user leaves mid-record
        this._recordStop = stop;
        document.addEventListener('keydown', onKey, true);
      });
    });
    hkSetting.addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('Reset to Cmd+F12')
      .onClick(async () => {
        this.plugin.settings.fullscreenHotkey = { meta: true, ctrl: false, alt: false, shift: false, key: 'F12' };
        await this.plugin.saveSettings();
        this.display();
      }));
  }
  hide() {
    // tear down a pending hotkey recorder if the user closed settings mid-record
    if (this._recordStop) this._recordStop();
  }
}

/* ── plugin ──────────────────────────────────────────────── */

class VaultCommanderPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_NC, (leaf) => new NCView(leaf, this));

    this.addRibbonIcon('panel-left-dashed', VC_NAME, () => this.activateView());
    this.addCommand({
      id: 'open',
      name: 'Open',
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'toggle-fullscreen',
      name: 'Open / bring to fullscreen',
      callback: () => this.summon(),
    });

    this.addSettingTab(new NCSettingTab(this.app, this));

    // configurable fullscreen hotkey — captured before Obsidian's keymap sees it.
    // Opens the Commander in fullscreen if closed, reveals it if hidden.
    this.registerDomEvent(document, 'keydown', (e) => {
      if (this.recordingHotkey || !this.matchesHotkey(e)) return;
      e.preventDefault(); e.stopPropagation();
      this.summon();
    }, true);
  }

  matchesHotkey(e) {
    const hk = this.settings.fullscreenHotkey;
    if (!hk || !hk.key) return false;
    if (!!hk.meta !== e.metaKey || !!hk.ctrl !== e.ctrlKey || !!hk.alt !== e.altKey || !!hk.shift !== e.shiftKey) return false;
    return hk.key.length === 1 ? e.key.toLowerCase() === hk.key.toLowerCase() : e.key === hk.key;
  }

  onunload() {
    // Obsidian cleans up registered views/leaves itself; detaching here is
    // discouraged (it interferes with workspace restore on reload).
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_NC);
    let leaf;
    if (existing.length) {
      leaf = existing[0];
      this.app.workspace.revealLeaf(leaf);
    } else {
      leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_NC, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
    // the vault variant (and any mobile build) opens fullscreen from the ribbon
    // unless the user turned it off — apply whether the leaf is new or revealed
    // (onOpen only runs for a freshly created view). Plus/desktop opens as a tab.
    if (this.settings.openFullscreen && (VC_PROVIDER === 'vault' || Platform.isMobile) && leaf.view && leaf.view.setFullscreen) leaf.view.setFullscreen(true);
  }

  // quick open/show in fullscreen: open if closed, reveal if hidden, pop out if already here
  async summon() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_NC)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_NC, active: true });
      this.app.workspace.revealLeaf(leaf);
      if (leaf.view && leaf.view.setFullscreen) leaf.view.setFullscreen(true);
      return;
    }
    const view = leaf.view;
    // already focused & fullscreen → toggle back out to a normal tab
    if (this.app.workspace.activeLeaf === leaf && view && view.fullscreen) {
      view.setFullscreen(false);
      return;
    }
    this.app.workspace.revealLeaf(leaf);
    if (view && view.setFullscreen) view.setFullscreen(true);
    else if (view && view.focusView) view.focusView();
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULTS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  // re-apply the current theme to any open Vault Commander views
  applyThemeToViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_NC).forEach((l) => { if (l.view && l.view.applyTheme) l.view.applyTheme(); });
  }
}

module.exports = VaultCommanderPlugin;
