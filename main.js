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
  showHidden: true,
  maxViewMB: 5,     // viewer (F3) text/code size cap in MB; quick-view text = 1/10 of this (capped at 1 MB)
  maxEditMB: 2,     // internal editor (F4) size cap in MB (editing is heavier than read-only viewing)
  maxImageMB: 32,   // image preview size cap in MB (viewer + quick view)
  wrapText: false,  // wrap long lines in the text viewer / quick view (off = horizontal scroll)
  fullscreenHotkey: { meta: true, ctrl: false, alt: false, shift: false, key: 'F12' },
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
  get capabilities() { return { exec: false, drives: false, archives: false, freeSpace: false, absolutePaths: false }; }

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

  async dirSize(dir) {
    let total = 0;
    const stack = [this.norm(dir)];
    while (stack.length) {
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
    // otherwise eats space); the user can still toggle it off via the menu / F10
    if (Platform.isMobile) window.setTimeout(() => this.setFullscreen(true), 0);
    window.setTimeout(() => this.focusView(), 0);
  }

  async onClose() {
    this.popMenuScope();
    window.clearTimeout(this._qsTimer);   // don't let the quick-filter timer fire into detached DOM
    document.body.classList.remove('nc-fs-active');
    const leafEl = this.containerEl.closest('.workspace-leaf');
    if (leafEl) leafEl.classList.remove('nc-fs');
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
    // clicking the path header opens the bookmarks dialog for this panel
    p.headEl.addEventListener('click', (e) => { e.stopPropagation(); this.setActive(p); this.openHotlist(); });
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
    p.headEl.setText(p.zip ? `${p.zip.path} ▸ /${p.zip.prefix.replace(/\/$/, '')}` : this.dispPath(p.cwd));
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
        this.viewZipEntry(p, en);
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
      if (af) { this.app.workspace.getLeaf(true).openFile(af); return; }
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
    if (wp.zip) {
      const cur = wp.entries[wp.cursor];
      if (!cur || cur.up || cur.isDir) { new Notice('No file to view.'); return; }
      this.viewZipEntry(wp, cur);
      return;
    }
    const sel = this.getSelection(wp);
    if (!sel.length) return;
    const f = sel[0];
    let st;
    try { st = await this.fp.stat(f.full); } catch (_) { new Notice('Cannot read file.'); return; }
    if (st.isDir) { new Notice('That is a directory.'); return; }

    // images → show the picture (read as a data: URL so it works outside the vault)
    if (IMAGE_RE.test(f.name)) {
      if (st.size > this.imageLimit()) { new Notice(`Image too large for preview (max ${fmtSize(this.imageLimit())}).`); return; }
      try {
        const buf = await this.fp.readBinary(f.full);
        const data = await bytesToDataURL(buf, mimeFor(f.name));
        new ViewerModal(this.app, { title: `View — ${f.name}`, image: data }).open();
      } catch (e) { new Notice('Could not load image: ' + (e && e.message ? e.message : e)); }
      return;
    }

    if (st.size > this.viewLimit()) { new Notice(`File too large for the viewer (max ${fmtSize(this.viewLimit())}).`); return; }
    let content;
    try { content = await this.fp.read(f.full); }
    catch (_) { new Notice('Binary file or read error.'); return; }

    // markdown → rendered preview (F4 still opens the raw text)
    if (/\.(md|markdown)$/i.test(f.name)) {
      new ViewerModal(this.app, {
        title: `Preview — ${f.name}`, markdown: content,
        sourcePath: this.toVaultPath(f.full) || '', component: this,
      }).open();
      return;
    }

    new ViewerModal(this.app, { title: `View — ${f.name}`, content, wrap: this.plugin.settings.wrapText }).open();
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
      if (af) { this.app.workspace.getLeaf('tab').openFile(af); return; }
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
    const run = () => this.transferSelection(sel, dest, 'copy');
    if (this.plugin.settings.confirmCopy) {
      new ConfirmModal(this.app, {
        title: 'Copy', body: `Copy ${sel.length} object(s) to\n${dest}?`, onConfirm: run,
      }).open();
    } else run();
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
        validate: (name) => invalidNameReason(name),
        onSubmit: async (name) => {
          if (!name || name === f.name) return;
          try { await this.fp.rename(f.full, this.P.join(wp.cwd, name)); await this.refresh(); }
          catch (e) { new Notice('Error: ' + e.message); }
        },
      }).open();
      return;
    }
    new ConfirmModal(this.app, {
      title: 'Move', body: `Move ${sel.length} object(s) to\n${dest}?`,
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
  async transferSelection(sel, destDir, mode) {
    // shared state: counts files (not top-level objects) and the all/cancel flags,
    // which carry through the whole operation including into nested folders
    const st = { overwriteAll: false, skipAll: false, created: 0, overwritten: 0, skipped: 0, failed: 0, cancelled: false };
    for (const f of sel) {
      if (st.cancelled) break;
      await this.transferEntry(f.full, this.P.join(destDir, f.name), f.name, mode, st);
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
      { label: 'Commands', items: this.commandsItems() },
      { label: 'Options', items: this.optionsItems() },
      { label: 'Right', items: this.panelMenuItems(this.right) },
    ];
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
    const startCat = (this.active === this.left) ? 0 : 4;   // open on the active panel's side
    if (!this.plugin.settings.hideMenu) { this.openDockedCat(startCat); return; }
    this.menu = { kind: 'pulldown', cats: this.menuCats(), cat: startCat, item: 0 };
    this.skipToSelectable(1);
    this.renderMenu();
    this.pushMenuScope();
  }

  openUserMenu() {
    if (this.menu) { this.closeMenu(); return; }
    const items = [];
    if (this.fp.capabilities.absolutePaths) items.push({ label: 'Home directory (~)', run: () => this.gotoPath(this.fp.homeDir()) });
    else items.push({ label: 'Toggle theme (Blue / Gray)', run: () => this.toggleTheme() });
    items.push({ label: 'Vault folder', run: () => this.gotoVault() });
    if (this.fp.capabilities.absolutePaths) items.push({ label: 'Root directory /', run: () => this.gotoPath(this.P.root(this.active.cwd)) });
    items.push({ sep: true });
    if (this.fp.capabilities.exec) items.push({ label: 'Open in Finder', run: () => this.openInSystem() });
    items.push({ label: 'New file…', run: () => this.newFile() });
    items.push({ sep: true });
    items.push({ label: 'Equalize panels', run: () => this.equalizePanels() });
    items.push({ label: 'Swap panels', run: () => this.swapPanels() });
    items.push({ sep: true });
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
      const drop = ov.createDiv({ cls: 'nc-dropdown' });
      const activeCatEl = bar.children[this.menu.cat];
      if (activeCatEl) drop.style.left = activeCatEl.offsetLeft + 'px';
      this.fillMenuItems(drop, this.menu.cats[this.menu.cat].items);
    } else {
      const box = ov.createDiv({ cls: 'nc-usermenu' });
      box.createDiv({ cls: 'nc-usermenu-title', text: this.menu.title });
      this.fillMenuItems(box, this.menu.items);
    }
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

  closeMenu() {
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

  async viewZipEntry(p, en) {
    let buf;
    try { buf = await this.fp.extractZipEntry(p.zip.path, en.zipEntry); }
    catch (e) { new Notice('Could not read entry: ' + e.message); return; }
    if (IMAGE_RE.test(en.name)) {
      if (buf.length > this.imageLimit()) { new Notice(`Image too large for preview (max ${fmtSize(this.imageLimit())}).`); return; }
      const data = await bytesToDataURL(buf, mimeFor(en.name));
      new ViewerModal(this.app, { title: `View — ${en.name}`, image: data }).open();
      return;
    }
    if (buf.length > this.viewLimit()) { new Notice(`File too large for the viewer (max ${fmtSize(this.viewLimit())}).`); return; }
    const content = new TextDecoder().decode(buf);
    if (/\.(md|markdown)$/i.test(en.name)) {
      new ViewerModal(this.app, { title: `Preview — ${en.name}`, markdown: content, sourcePath: '', component: this }).open();
      return;
    }
    new ViewerModal(this.app, { title: `View — ${en.name}`, content, wrap: this.plugin.settings.wrapText }).open();
  }

  zipDirSize(zip, base) {
    let total = 0;
    for (const ze of zip.entries) if (ze.name.startsWith(base) && !ze.name.endsWith('/')) total += ze.uncompSize;
    return total;
  }

  async computeDirSize(p, en) {
    if (en.dirSize != null) return;
    if (p.zip) en.dirSize = this.zipDirSize(p.zip, p.zip.prefix + en.name + '/');
    else { try { en.dirSize = await this.fp.dirSize(this.P.join(p.cwd, en.name)); } catch (_) { en.dirSize = 0; } }
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
    // the leaf element isn't attached yet; apply the leaf class when it is.
    this.fullscreen = !!on;
    document.body.classList.toggle('nc-fs-active', this.fullscreen);
    const leafEl = this.containerEl.closest('.workspace-leaf');
    if (leafEl) leafEl.classList.toggle('nc-fs', this.fullscreen);
    this.focusView();
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
    p.headEl.setText('Info');
    p.listEl.empty();
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
        else this.computeDirSize(src, cur).then(() => {
          if (seq !== p.renderSeq) return;
          szLine.setText(`${fmtSize(cur.dirSize)} bytes${dateSuffix}`);
        }).catch(() => {});
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
    p.headEl.setText('Quick view');
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
    p.headEl.setText('Tree');
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

class ConfirmModal extends Modal {
  constructor(app, opts) { super(app); this.opts = opts; }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('nc-modal');
    if (this.opts.danger) modalEl.addClass('nc-modal-danger');
    contentEl.createEl('h3', { text: this.opts.title, cls: 'nc-modal-title' });
    contentEl.createEl('pre', { text: this.opts.body, cls: 'nc-modal-body' });
    const row = contentEl.createDiv({ cls: 'nc-modal-buttons' });
    const yes = row.createEl('button', { text: 'OK', cls: 'nc-btn nc-btn-default' });
    const no = row.createEl('button', { text: 'Cancel', cls: 'nc-btn' });
    yes.addEventListener('click', () => { this.close(); this.opts.onConfirm && this.opts.onConfirm(); });
    no.addEventListener('click', () => this.close());
    window.setTimeout(() => yes.focus(), 0);
    this.scope.register([], 'Enter', () => { this.close(); this.opts.onConfirm && this.opts.onConfirm(); return false; });
  }
  onClose() { this.contentEl.empty(); }
}

class PromptModal extends Modal {
  constructor(app, opts) { super(app); this.opts = opts; this.submitted = false; }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('nc-modal');
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
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  // resolve callers (e.g. the conflict "Rename" prompt) even when cancelled
  onClose() { this.contentEl.empty(); if (!this.submitted && this.opts.onSubmit) this.opts.onSubmit(null); }
}

class ConflictModal extends Modal {
  constructor(app, opts) { super(app); this.opts = opts; this.decided = false; }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('nc-modal');
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
    modalEl.addClass('nc-modal'); modalEl.addClass('nc-egg');
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
  constructor(app, opts) { super(app); this.opts = opts; }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('nc-modal'); modalEl.addClass('nc-viewer');
    contentEl.createEl('h3', { text: this.opts.title, cls: 'nc-modal-title' });

    // image preview
    if (this.opts.image) {
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

      const row = contentEl.createDiv({ cls: 'nc-modal-buttons' });
      const close = row.createEl('button', { text: 'Close', cls: 'nc-btn nc-btn-default' });
      close.addEventListener('click', () => this.close());
      window.setTimeout(() => close.focus(), 0);
      return;
    }

    // rendered markdown preview
    if (this.opts.markdown != null) {
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
      const row = contentEl.createDiv({ cls: 'nc-modal-buttons' });
      const close = row.createEl('button', { text: 'Close', cls: 'nc-btn nc-btn-default' });
      close.addEventListener('click', () => this.close());
      window.setTimeout(() => div.focus(), 0);   // autofocus so PgUp/PgDn/arrows scroll
      return;
    }

    if (this.opts.editable) {
      const ta = contentEl.createEl('textarea', { cls: 'nc-viewer-area' });
      ta.toggleClass('nc-wrap', !!this.opts.wrap);
      ta.setAttribute('wrap', this.opts.wrap ? 'soft' : 'off');   // native textarea wrapping
      ta.value = this.opts.content;
      const row = contentEl.createDiv({ cls: 'nc-modal-buttons' });
      const save = row.createEl('button', { text: 'Save', cls: 'nc-btn nc-btn-default' });
      const close = row.createEl('button', { text: 'Close', cls: 'nc-btn' });
      save.addEventListener('click', () => { this.opts.onSave && this.opts.onSave(ta.value); this.close(); });
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
    } else {
      const pre = contentEl.createEl('pre', { text: this.opts.content, cls: 'nc-viewer-pre' });
      pre.toggleClass('nc-wrap', !!this.opts.wrap);
      pre.tabIndex = 0;
      const row = contentEl.createDiv({ cls: 'nc-modal-buttons' });
      const close = row.createEl('button', { text: 'Close', cls: 'nc-btn nc-btn-default' });
      close.addEventListener('click', () => this.close());
      window.setTimeout(() => pre.focus(), 0);   // autofocus so PgUp/PgDn/arrows scroll
    }
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
    modalEl.addClass('nc-modal');
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
    modalEl.addClass('nc-modal');
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
    if (existing.length) { this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_NC, active: true });
    this.app.workspace.revealLeaf(leaf);
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
