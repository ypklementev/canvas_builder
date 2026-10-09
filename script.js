(() => {
    // ---------- state ----------
    // screens: [{name, shapes, groups, bg, bgPc}]; S.shapes / S.groups / S.bg / S.bgPc always mean the current screen S.screens[S.cur]
    // shapes: flat list in draw order; shape.g = id of its group; groups: {id, name, parent, collapsed, hidden, locked}, members of a group are kept contiguous
    // palette (shared by all screens): [{n: 'C_BG', c}]; shape.pc / shape.epc / screen.bgPc / S.colorPc = palette name the color comes from (the number is kept in sync)
    // assets: {id: dataURL} of uploaded pictures, shape.src points here; not part of undo snapshots, so history stays small
    // shape.id: stable within its screen (animation tracks point at it); screen.anims: [{name, mode, dur, lo, hi, follow, tracks: [{id, p, keys: [{t, v, e, pc}]}]}]
    // screen.tr: the transition onto this screen {type, dur, ease, c, pc}
    // chart: {t: 'chart', x, y, w, h, kind, var, data, lo, hi, auto, grid, gc, border, dots, gap, fc, cols, erase, ec, c}; S.mgr === false: no screen manager in the sketch
    // shape.rot: degrees around the pivot ox, oy (screen pixels); shape.o: opacity 0…254 (absent = 255); text.scroll: one clipped line moved by sx
    // sprite: {t: 'sprite', x, y, w, h, mode, scale, thr, inv, c, f, nw, nh, frames: [{d, src} | {d, shapes}]}; frame shapes are relative to the frame's top-left
    const START = [];
    const blankScreen = name => ({ name, shapes: [], groups: [], bg: 0x0000, bgPc: '', anims: [] });
    const S = { W: 172, H: 320, screens: [Object.assign(blankScreen('Main'), { shapes: START })], cur: 0, palette: [], assets: {}, nextG: 1, nextId: 1, sel: [], tool: 'select', fill: false, color: 0xFFFF, colorPc: '', radius: 8, zoom: 'auto', grid: true, codeMode: 'snippet', textFont: '', textSize: 2, coordConsts: false, imgHeader: false, fonts: [], tlFolded: false };
    for (const k of ['shapes', 'groups', 'bg', 'bgPc']) Object.defineProperty(S, k, { get: () => S.screens[S.cur][k], set: v => { S.screens[S.cur][k] = v; }, enumerable: false });
    const KEY = 'lcd-canvas-builder-v7', OLD_KEYS = ['lcd-canvas-builder-v6', 'lcd-canvas-builder-v5', 'lcd-canvas-builder-v4', 'lcd-canvas-builder-v3', 'lcd-canvas-builder-v2', 'lcd-canvas-builder-v1'];
    try {
        let d = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (!d) for (const k of OLD_KEYS) { const o = JSON.parse(localStorage.getItem(k) || 'null'); if (o && Array.isArray(o.screens)) { d = o; break; } if (o && Array.isArray(o.shapes)) { d = migrate(o); break; } }
        if (d && Array.isArray(d.screens) && d.screens.length) { delete d.sel; Object.assign(S, d); S.cur = Math.min(Math.max(0, S.cur | 0), S.screens.length - 1); }
    } catch (e) { }
    // v6 → v7: the chart type and the project option mgr (screens through goTo), both optional; v5 → v6: screens get an optional default transition tr: {type, dur, ease, c, pc}; v4 → v5: only new optional fields (rot, ox, oy, o, scroll, sx) and the sprite type, so a v4 state loads as it is; the v4 key is left untouched
    // v3 → v4: screens get an (empty) list of animations; shapes get ids from ensureIds() at start-up; the v3 key is left untouched
    for (const sc of S.screens) if (!Array.isArray(sc.anims)) sc.anims = [];
    if (!(S.nextId > 0)) S.nextId = 1;
    // v1 (no groups, palette, names) and v2 (one screen) → v3: everything becomes the screen «Main»; names are filled in by ensureNames() at start-up; old keys are left untouched
    function migrate(d) {
        const scr = { name: 'Main', shapes: d.shapes, groups: d.groups || [], bg: d.bg || 0, bgPc: d.bgPc || '' };
        for (const k of ['shapes', 'groups', 'bg', 'bgPc', 'sel']) delete d[k];
        return Object.assign(d, { screens: [scr], cur: 0, palette: d.palette || [], nextG: d.nextG || 1, assets: {}, colorPc: d.colorPc || '' });
    }
    // assets are serialised only when they change; unused ones are dropped from storage (but stay in memory for undo)
    let assetsVer = 0, assetsKey = '', assetsJson = '{}';
    function save() {
        try {
            const { sel, assets, ...rest } = S, used = usedAssets();
            const key = assetsVer + ':' + [...used].sort().join();
            if (key !== assetsKey) { assetsJson = JSON.stringify(Object.fromEntries(Object.entries(assets).filter(([k]) => used.has(k)))); assetsKey = key; }
            localStorage.setItem(KEY, '{"assets":' + assetsJson + ',' + JSON.stringify(rest).slice(1));
            saveFailed(false);
        } catch (e) { saveFailed(true); }
    }

    // history
    let hist = [], future = [], lastPushKey = '', lastPushT = 0;
    function snapshot() { return JSON.stringify({ screens: S.screens, cur: S.cur, palette: S.palette, nextG: S.nextG, nextId: S.nextId, W: S.W, H: S.H }); }
    function push(key, snap) { const now = Date.now(); if (key && key === lastPushKey && now - lastPushT < 800) { lastPushT = now; return; } lastPushKey = key || ''; lastPushT = now; hist.push(snap || snapshot()); if (hist.length > 200) hist.shift(); future = []; }
    function restore(js) { const d = JSON.parse(js), cur = S.cur; Object.assign(S, d); if (S.cur !== cur) S.sel = []; S.sel = S.sel.filter(i => i < S.shapes.length); }
    function undo() { if (!hist.length) return; future.push(snapshot()); restore(hist.pop()); lastPushKey = ''; syncSettings(); update(); }
    function redo() { if (!future.length) return; hist.push(snapshot()); restore(future.pop()); lastPushKey = ''; syncSettings(); update(); }
    function withScreen(k, fn) { const c = S.cur; S.cur = k; try { return fn(); } finally { S.cur = c; } }

    // ---------- color ----------
    const to565 = hex => { const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255; return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3); };
    const rgb565 = c => [Math.round((c >> 11 & 31) * 255 / 31), Math.round((c >> 5 & 63) * 255 / 63), Math.round((c & 31) * 255 / 31)];
    const toHex = c => '#' + rgb565(c).map(v => v.toString(16).padStart(2, '0')).join('');
    const fmt565 = c => '0x' + (c & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
    const toU32 = c => { const [r, g, b] = rgb565(c); return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0; };
    const NAMED = { BLACK: 0x0000, WHITE: 0xFFFF, RED: 0xF800, GREEN: 0x07E0, BLUE: 0x001F, YELLOW: 0xFFE0, MAGENTA: 0xF81F, CYAN: 0x07FF, ORANGE: 0xFC00 };
    const SWATCHES = [0x0000, 0xFFFF, 0x8410, 0x4208, 0xF800, 0xFD20, 0xFFE0, 0x07E0, 0x07FF, 0x001F, 0x000F, 0xF81F];
    function parse565(str) {
        str = String(str).trim();
        if (/^#[0-9a-f]{6}$/i.test(str)) return to565(str);
        if (/^0x[0-9a-f]{1,4}$/i.test(str)) return parseInt(str, 16);
        if (/^\d+$/.test(str) && +str < 65536) return +str;
        const m = str.toUpperCase().match(/(BLACK|WHITE|RED|GREEN|BLUE|YELLOW|MAGENTA|CYAN|ORANGE)$/);
        return m ? NAMED[m[1]] : null;
    }

    // ---------- Adafruit GFX rasterizer (same algorithms as the library) ----------
    const off = document.createElement('canvas'), offx = off.getContext('2d');
    let img, u32, idb, curCol = 0, cur565 = 0, curId = -1;
    // opacity of the current shape (0…255); while it is below 255 every pixel is blended once (seen); clipBox: [x0, y0, x1, y1) of a scrolling text
    let opa = 255, seen = null, clipBox = null;
    // a: coverage 0…16 (16 = solid); with a gradient (paint) the colour comes from the pixel position; id -3: locked, keeps what is below clickable
    // coverage × opacity = e of 4080: below that the colour is mixed with what is on the canvas (at opacity 255 exactly as a / 16)
    function px(x, y, a = 16) {
        if (x < 0 || y < 0 || x >= S.W || y >= S.H || a <= 0) return;
        if (clipBox && (x < clipBox[0] || y < clipBox[1] || x >= clipBox[2] || y >= clipBox[3])) return;
        const i = y * S.W + x, e = a * opa;
        if (paint || e < 4080) {
            let c = paint ? paintColor(x, y) : cur565;
            if (e < 4080) { if (!e) return; if (opa < 255) { if (seen[i]) return; seen[i] = 1; } c = blendA(from32(u32[i]), c, e); }
            u32[i] = toU32(c);
        }
        else u32[i] = curCol;
        if (curId !== -3) idb[i] = curId;
    }
    function hline(x, y, w) { if (w < 0) { w = -w; x -= w - 1; } for (let i = 0; i < w; i++)px(x + i, y); }
    function vline(x, y, h) { if (h < 0) { h = -h; y -= h - 1; } for (let i = 0; i < h; i++)px(x, y + i); }
    function line(x0, y0, x1, y1) {
        const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
        if (steep) { [x0, y0] = [y0, x0];[x1, y1] = [y1, x1]; }
        if (x0 > x1) { [x0, x1] = [x1, x0];[y0, y1] = [y1, y0]; }
        const dx = x1 - x0, dy = Math.abs(y1 - y0); let err = Math.trunc(dx / 2); const ys = y0 < y1 ? 1 : -1;
        for (; x0 <= x1; x0++) { steep ? px(y0, x0) : px(x0, y0); err -= dy; if (err < 0) { y0 += ys; err += dx; } }
    }
    function drawRect(x, y, w, h) { hline(x, y, w); hline(x, y + h - 1, w); vline(x, y, h); vline(x + w - 1, y, h); }
    function fillRect(x, y, w, h) { for (let i = x; i < x + w; i++)vline(i, y, h); }
    function drawCircle(x0, y0, r) {
        let f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r;
        px(x0, y0 + r); px(x0, y0 - r); px(x0 + r, y0); px(x0 - r, y0);
        while (x < y) {
            if (f >= 0) { y--; ddy += 2; f += ddy; } x++; ddx += 2; f += ddx;
            px(x0 + x, y0 + y); px(x0 - x, y0 + y); px(x0 + x, y0 - y); px(x0 - x, y0 - y);
            px(x0 + y, y0 + x); px(x0 - y, y0 + x); px(x0 + y, y0 - x); px(x0 - y, y0 - x);
        }
    }
    function circHelper(x0, y0, r, c) {
        let f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r;
        while (x < y) {
            if (f >= 0) { y--; ddy += 2; f += ddy; } x++; ddx += 2; f += ddx;
            if (c & 4) { px(x0 + x, y0 + y); px(x0 + y, y0 + x); }
            if (c & 2) { px(x0 + x, y0 - y); px(x0 + y, y0 - x); }
            if (c & 8) { px(x0 - y, y0 + x); px(x0 - x, y0 + y); }
            if (c & 1) { px(x0 - y, y0 - x); px(x0 - x, y0 - y); }
        }
    }
    function fillCircHelper(x0, y0, r, corners, delta) {
        let f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r, pxx = x, py = y; delta++;
        while (x < y) {
            if (f >= 0) { y--; ddy += 2; f += ddy; } x++; ddx += 2; f += ddx;
            if (x < y + 1) { if (corners & 1) vline(x0 + x, y0 - y, 2 * y + delta); if (corners & 2) vline(x0 - x, y0 - y, 2 * y + delta); }
            if (y !== py) { if (corners & 1) vline(x0 + py, y0 - pxx, 2 * pxx + delta); if (corners & 2) vline(x0 - py, y0 - pxx, 2 * pxx + delta); py = y; }
            pxx = x;
        }
    }
    function fillCircle(x0, y0, r) { vline(x0, y0 - r, 2 * r + 1); fillCircHelper(x0, y0, r, 3, 0); }
    function clampR(w, h, r) { const m = Math.trunc((w < h ? w : h) / 2); return r > m ? m : r; }
    function drawRoundRect(x, y, w, h, r) {
        r = clampR(w, h, r);
        hline(x + r, y, w - 2 * r); hline(x + r, y + h - 1, w - 2 * r); vline(x, y + r, h - 2 * r); vline(x + w - 1, y + r, h - 2 * r);
        circHelper(x + r, y + r, r, 1); circHelper(x + w - r - 1, y + r, r, 2); circHelper(x + w - r - 1, y + h - r - 1, r, 4); circHelper(x + r, y + h - r - 1, r, 8);
    }
    function fillRoundRect(x, y, w, h, r) {
        r = clampR(w, h, r);
        fillRect(x + r, y, w - 2 * r, h); fillCircHelper(x + w - r - 1, y + r, r, 1, h - 2 * r - 1); fillCircHelper(x + r, y + r, r, 2, h - 2 * r - 1);
    }
    function fillTriangle(x0, y0, x1, y1, x2, y2) {
        let a, b, y, last;
        if (y0 > y1) { [y0, y1] = [y1, y0];[x0, x1] = [x1, x0]; }
        if (y1 > y2) { [y2, y1] = [y1, y2];[x2, x1] = [x1, x2]; }
        if (y0 > y1) { [y0, y1] = [y1, y0];[x0, x1] = [x1, x0]; }
        if (y0 === y2) { a = b = x0; if (x1 < a) a = x1; else if (x1 > b) b = x1; if (x2 < a) a = x2; else if (x2 > b) b = x2; hline(a, y0, b - a + 1); return; }
        const dx01 = x1 - x0, dy01 = y1 - y0, dx02 = x2 - x0, dy02 = y2 - y0, dx12 = x2 - x1, dy12 = y2 - y1; let sa = 0, sb = 0;
        last = y1 === y2 ? y1 : y1 - 1;
        for (y = y0; y <= last; y++) { a = x0 + Math.trunc(sa / dy01); b = x0 + Math.trunc(sb / dy02); sa += dx01; sb += dx02; if (a > b) [a, b] = [b, a]; hline(a, y, b - a + 1); }
        sa = dx12 * (y - y1); sb = dx02 * (y - y0);
        for (; y <= y2; y++) { a = x1 + Math.trunc(sa / dy12); b = x0 + Math.trunc(sb / dy02); sa += dx12; sb += dx02; if (a > b) [a, b] = [b, a]; hline(a, y, b - a + 1); }
    }
    // ---------- text (same drawChar logic as Adafruit GFX) ----------
    const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const utf8 = new TextEncoder();
    const GLCD = b64(GFX_FONTS.__glcd);
    const FONT_DATA = {};
    for (const k in GFX_FONTS) {
        if (k === '__glcd') continue; const f = GFX_FONTS[k]; let asc = 0, desc = 0;
        for (const g of f.g) if (g[1] && g[2]) { asc = Math.max(asc, -g[5]); desc = Math.max(desc, g[5] + g[2]); }
        FONT_DATA[k] = { first: f.f, last: f.l, ya: f.y, bmp: b64(f.b), g: f.g, asc, desc };
    }
    // project fonts (made from TTF/OTF) are CP1251: a character's code is the byte cp1251() gives on the board; unknown → '?'
    const CP = new Map(); { const dec = new TextDecoder('windows-1251'); for (let b = 0x20; b <= 0xFF; b++) { const ch = dec.decode(Uint8Array.of(b)); if (b !== 0x7F && !(ch >= '\x80' && ch <= '\x9F')) CP.set(ch, b); } }
    function registerFont(f) {
        let asc = 0, desc = 0; for (const g of f.g) if (g[1] && g[2]) { asc = Math.max(asc, -g[5]); desc = Math.max(desc, g[5] + g[2]); }
        FONT_DATA[f.n] = { first: f.f, last: f.l, ya: f.y, bmp: b64(f.b), g: f.g, asc, desc, cp: true, custom: true, ab: f.ab ? b64(f.ab) : null, ag: f.ag || null };
    }
    S.fonts.forEach(registerFont);
    const codeOf = (F, ch) => F.cp ? (CP.get(ch) ?? -1) : ch.charCodeAt(0);
    const glyphOf = (F, ch) => F.g[codeOf(F, ch) - F.first];
    // the bytes write() gets: UTF-8 for the built-in and Adafruit fonts, CP1251 (after cp1251()) for project fonts
    const fontBytes = (F, str) => F && F.cp ? [...str].map(ch => CP.get(ch) ?? 0x3F) : utf8.encode(str);
    function supported(font, ch) {
        const c = ch.charCodeAt(0); if (!font || !FONT_DATA[font]) return c >= 32 && c <= 126;
        const F = FONT_DATA[font], g = glyphOf(F, ch); return !!g && (!F.cp || g[1] > 0 || g[3] > 0);
    }
    function cleanText(font, t) { return [...t].filter(ch => ch === '\n' || supported(font, ch)).join(''); }
    function measureStr(font, size, str) {
        if (!str.length) return { l: 0, w: 0 };
        if (!font || !FONT_DATA[font]) return { l: 0, w: str.length * 6 * size - size };
        const F = FONT_DATA[font]; let x = 0, mn = Infinity, mx = -Infinity;
        for (const ch of str) { const g = glyphOf(F, ch); if (!g) continue; if (g[1] && g[2]) { mn = Math.min(mn, x + g[4]); mx = Math.max(mx, x + g[4] + g[1]); } x += g[3]; }
        return mn === Infinity ? { l: 0, w: 0 } : { l: mn * size, w: (mx - mn) * size };
    }
    // how far print() moves the cursor: write() gets UTF-8 bytes; built-in font: 6 × size per byte, GFXfont: xAdvance × size, bytes outside first..last don't move it; '\r' is ignored
    function advanceStr(font, size, str) {
        const F = font && FONT_DATA[font], bytes = fontBytes(F, str.replace(/\r/g, ''));
        if (!F) return bytes.length * 6 * size;
        let x = 0;
        for (const c of bytes) if (c >= F.first && c <= F.last) x += F.g[c - F.first][3];
        return x * size;
    }
    function fontMetrics(font, size) {
        if (!font || !FONT_DATA[font]) return { pitch: 8 * size, top: 0, block: n => n * 8 * size - size };
        const F = FONT_DATA[font]; return { pitch: F.ya * size, top: F.asc * size, block: n => (n - 1) * F.ya * size + (F.asc + F.desc) * size };
    }
    function wrapText(s) {
        if (scrolls(s)) return [cleanText(s.font, (s.text || '').replace(/\n/g, ' '))]; // a scrolling text is one line, cut by its box
        const out = [], W = Math.max(1, s.w), fits = str => measureStr(s.font, s.size, str).w <= W;
        for (const para of cleanText(s.font, s.text || '').split('\n')) {
            let line = '';
            for (const w of para.split(/ +/)) {
                if (!w) continue;
                const cand = line ? line + ' ' + w : w;
                if (fits(cand)) { line = cand; continue; }
                if (line) { out.push(line); line = ''; }
                if (fits(w)) { line = w; continue; }
                let chunk = ''; for (const ch of w) { if (!chunk || fits(chunk + ch)) chunk += ch; else { out.push(chunk); chunk = ch; } }
                line = chunk;
            }
            out.push(line);
        }
        return out;
    }
    function layoutText(s) {
        const lines = wrapText(s), m = fontMetrics(s.font, s.size), bh = m.block(lines.length);
        let top = s.y;
        if (s.valign === 'middle') top = s.y + Math.round((s.h - bh) / 2); else if (s.valign === 'bottom') top = s.y + s.h - bh;
        return lines.map((t, i) => {
            const mm = measureStr(s.font, s.size, t); let x = s.x;
            if (s.align === 'center') x = s.x + Math.round((s.w - mm.w) / 2); else if (s.align === 'right') x = s.x + s.w - mm.w;
            return { t, cx: x - mm.l, cy: top + m.top + i * m.pitch };
        }).filter(l => l.t.length);
    }
    function drawStr(font, size, str, cx, cy) {
        let x = cx;
        if (!font || !FONT_DATA[font]) {
            for (const ch of str) {
                const c = ch.charCodeAt(0);
                for (let i = 0; i < 5; i++) { let ln = GLCD[c * 5 + i]; for (let j = 0; j < 8; j++, ln >>= 1)if (ln & 1) { size === 1 ? px(x + i, cy + j) : fillRect(x + i * size, cy + j * size, size, size); } }
                x += 6 * size;
            }
            return;
        }
        const F = FONT_DATA[font];
        for (const ch of str) {
            const g = glyphOf(F, ch); if (!g) continue;
            const [bo0, w, h, xa, xo, yo] = g; let bo = bo0, bits = 0, bit = 0;
            for (let yy = 0; yy < h; yy++)for (let xx = 0; xx < w; xx++) {
                if (!(bit++ & 7)) bits = F.bmp[bo++];
                if (bits & 0x80) { size === 1 ? px(x + xo + xx, cy + yo + yy) : fillRect(x + (xo + xx) * size, cy + (yo + yy) * size, size, size); } bits <<= 1;
            }
            x += xa * size;
        }
    }
    const cstr = t => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const fontGroups = () => S.fonts.length ? [...FONT_GROUPS, ['Свои (кириллица)', S.fonts.map(f => f.n)]] : FONT_GROUPS;
    const FONT_GROUPS = [['Встроенный', ['']], ['Pixel', ['Picopixel', 'TomThumb', 'Org_01', 'Tiny3x3a2pt7b']],
    ['Sans', Object.keys(GFX_FONTS).filter(k => k.startsWith('FreeSans'))], ['Mono', Object.keys(GFX_FONTS).filter(k => k.startsWith('FreeMono'))],
    ['Serif', Object.keys(GFX_FONTS).filter(k => k.startsWith('FreeSerif'))]];
    const fontLabel = k => !k ? 'Встроенный 5×7' : k.replace(/(\d+)pt[78]b$/, ' $1pt').replace(/^Tiny3x3a2pt7b$/, 'Tiny3x3');
    const ptOf = k => +((k.match(/(\d+)pt7b$/) || [0, 0])[1]);
    FONT_GROUPS.slice(2).forEach(g => g[1].sort((a, b) => a.replace(/\d+pt7b/, '').localeCompare(b.replace(/\d+pt7b/, '')) || ptOf(a) - ptOf(b)));

    let seenBuf = null;
    function raster(s, id) {
        curCol = toU32(s.c); cur565 = s.c; curId = id;
        opa = opaOf(s); if (opa < 255) { if (!seenBuf || seenBuf.length !== S.W * S.H) seenBuf = new Uint8Array(S.W * S.H); else seenBuf.fill(0); seen = seenBuf; }
        if (rotOk(s)) s = turned(s);
        paint = gradOk(s) ? makePaint(s) : null; if (paint) [pbx, pby, pbw, pbh] = bbox(s);
        const aa = aaOk(s);
        switch (s.t) {
            case 'text':
                if (s.var) { drawVarText(s, aa); break; }
                if (scrolls(s)) clipBox = [s.x, s.y, s.x + s.w, s.y + s.h];
                for (const l of layoutText(s)) (aa ? drawStrAA : drawStr)(s.font, s.size, l.t, l.cx + (scrolls(s) ? s.sx | 0 : 0), l.cy);
                break;
            case 'img': case 'sprite': s.q ? drawImgRot(s) : drawImg(s); break;
            case 'chart': drawChart(s); break;
            case 'rect':
                if (s.q) { const [a, b, c, d] = s.q; if (s.fill) { fillTriangle(...a, ...b, ...c); fillTriangle(...a, ...c, ...d); } else { line(...a, ...b); line(...b, ...c); line(...c, ...d); line(...d, ...a); } }
                else s.fill ? fillRect(s.x, s.y, s.w, s.h) : drawRect(s.x, s.y, s.w, s.h);
                break;
            case 'rrect': aa ? aaRoundRect(s.x, s.y, s.w, s.h, s.r, !s.fill) : s.fill ? fillRoundRect(s.x, s.y, s.w, s.h, s.r) : drawRoundRect(s.x, s.y, s.w, s.h, s.r); break;
            case 'circle': aa ? aaCircle(s.x, s.y, s.r, !s.fill) : s.fill ? fillCircle(s.x, s.y, s.r) : drawCircle(s.x, s.y, s.r); break;
            case 'line': (aa ? aaLine : line)(s.x0, s.y0, s.x1, s.y1); break;
            case 'tri':
                if (aa && s.fill) aaTriangle(s.x0, s.y0, s.x1, s.y1, s.x2, s.y2);
                else if (s.fill) fillTriangle(s.x0, s.y0, s.x1, s.y1, s.x2, s.y2);
                else { const L = aa ? aaLine : line; L(s.x0, s.y0, s.x1, s.y1); L(s.x1, s.y1, s.x2, s.y2); L(s.x2, s.y2, s.x0, s.y0); } break;
            case 'pixel': px(s.x, s.y); break;
        }
        paint = null; opa = 255; seen = null; clipBox = null;
    }

    // ---------- rotation: an integer sine table, the same in the sketch (lcbSinT / lcbRot) ----------
    // sin of whole degrees × 16384; a point turns around the pivot, rounding by (v + 8192) >> 14; positive angles turn clockwise (y goes down)
    const ROT_T = ['rect', 'line', 'tri', 'img', 'sprite', 'rrect', 'circle', 'pixel'];
    const SIN_T = Array.from({ length: 91 }, (_, k) => Math.round(Math.sin(k * Math.PI / 180) * 16384));
    function isin(a) { a = ((a % 360) + 360) % 360; return a <= 90 ? SIN_T[a] : a <= 180 ? SIN_T[180 - a] : a <= 270 ? -SIN_T[a - 180] : -SIN_T[360 - a]; }
    function rotPt(x, y, ox, oy, a) { const s = isin(a), c = isin(a + 90), dx = x - ox, dy = y - oy; return [ox + ((dx * c - dy * s + 8192) >> 14), oy + ((dx * s + dy * c + 8192) >> 14)]; }
    const canRot = s => ROT_T.includes(s.t);
    const rotOk = s => canRot(s) && s.rot != null && s.rot % 360 !== 0;
    // the shape as it is drawn: vertices / centre turned around the pivot; a rectangle or a picture gets its four turned corner pixels q (TL, TR, BR, BL)
    // a rounded rectangle and a circle turn as a point: their centre moves, the shape itself stays upright
    function turned(s) {
        const R = (x, y) => rotPt(x, y, s.ox, s.oy, s.rot), c = { ...s };
        if (!['rect', 'img', 'sprite'].includes(s.t)) delete c.rot; // already turned (a picture still needs its angle for rotMap)
        switch (s.t) {
            case 'line': [c.x0, c.y0] = R(s.x0, s.y0); [c.x1, c.y1] = R(s.x1, s.y1); break;
            case 'tri': [c.x0, c.y0] = R(s.x0, s.y0); [c.x1, c.y1] = R(s.x1, s.y1); [c.x2, c.y2] = R(s.x2, s.y2); break;
            case 'circle': case 'pixel': [c.x, c.y] = R(s.x, s.y); break;
            case 'rrect': { const hw = Math.trunc(s.w / 2), hh = Math.trunc(s.h / 2), [X, Y] = R(s.x + hw, s.y + hh); c.x = X - hw; c.y = Y - hh; break; }
            default: c.q = [R(s.x, s.y), R(s.x + s.w - 1, s.y), R(s.x + s.w - 1, s.y + s.h - 1), R(s.x, s.y + s.h - 1)];
        }
        return c;
    }
    // a turned picture: every screen pixel around the turned corners takes the source pixel it comes from (turned back, nearest)
    function rotMap(x, y, w, h, ox, oy, a, put) {
        const s = isin(a), c = isin(a + 90), q = [rotPt(x, y, ox, oy, a), rotPt(x + w - 1, y, ox, oy, a), rotPt(x + w - 1, y + h - 1, ox, oy, a), rotPt(x, y + h - 1, ox, oy, a)];
        const xa = Math.max(0, Math.min(...q.map(p => p[0])) - 1), xb = Math.min(S.W - 1, Math.max(...q.map(p => p[0])) + 1);
        const ya = Math.max(0, Math.min(...q.map(p => p[1])) - 1), yb = Math.min(S.H - 1, Math.max(...q.map(p => p[1])) + 1);
        for (let Y = ya; Y <= yb; Y++) for (let X = xa; X <= xb; X++) {
            const dx = X - ox, dy = Y - oy, i = ox + ((dx * c + dy * s + 8192) >> 14) - x, j = oy + ((dy * c - dx * s + 8192) >> 14) - y;
            if (i >= 0 && j >= 0 && i < w && j < h) put(X, Y, i, j);
        }
    }
    function drawImgRot(s) {
        const d = imgData(s); if (!d) return;
        const bw = (s.w + 7) >> 3, icon = s.mode === 'icon';
        rotMap(s.x, s.y, s.w, s.h, s.ox, s.oy, s.rot, (X, Y, i, j) => {
            if (icon) { if (d.bits[j * bw + (i >> 3)] & (0x80 >> (i & 7))) px(X, Y); return; }
            if (d.mask && !(d.mask[j * bw + (i >> 3)] & (0x80 >> (i & 7)))) return;
            cur565 = d.px[j * s.w + i]; curCol = toU32(cur565); px(X, Y);
        });
    }
    // opacity, scrolling text
    const opaOf = s => s.o == null ? 255 : Math.max(0, Math.min(255, s.o | 0));
    const scrolls = s => s.t === 'text' && !!s.scroll && !s.var;

    // ---------- gradients and anti-aliasing: the same integer maths as the generated lcb… functions ----------
    const GRAD_T = ['rect', 'rrect', 'circle', 'line', 'tri', 'text', 'img', 'sprite'], AA_T = ['rrect', 'circle', 'line', 'tri', 'text'];
    const gradOk = s => !!s.grad && GRAD_T.includes(s.t) && (!isPic(s) || s.mode === 'icon') && s.grad.stops && s.grad.stops.length >= 2;
    const aaFont = s => { const F = FONT_DATA[s.font]; return !!(F && F.ab); };
    const aaOk = s => !!s.aa && AA_T.includes(s.t) && (s.t !== 'text' || aaFont(s));
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    let paint = null, pbx = 0, pby = 0, pbw = 0, pbh = 0; // the current gradient and the box it spans
    const gradDir = a => [Math.round(Math.cos(a * Math.PI / 180) * 1024), Math.round(Math.sin(a * Math.PI / 180) * 1024)];
    // stops sorted by position; positions 0…100 % → 0…4096
    function makePaint(s) {
        const g = s.grad, st = [...g.stops].sort((a, b) => a.p - b.p).slice(0, 4), [dx, dy] = g.type === 'radial' ? [0, 0] : gradDir(g.angle || 0);
        return { type: g.type === 'radial' ? 2 : 1, dx, dy, n: st.length, c: st.map(x => x.c), pc: st.map(x => x.pc), p: st.map(x => Math.round(x.p * 4096 / 100)), dither: !!g.dither };
    }
    function isqrt(n) { let r = Math.floor(Math.sqrt(n)); while (r * r > n) r--; while ((r + 1) * (r + 1) <= n) r++; return r; }
    // t (0…4096) along the gradient for the pixel centre: linear — projection on the direction across the box, radial — distance from the box centre / half of its larger side
    function paintColor(x, y) {
        const p = paint, X = 2 * x + 1 - (2 * pbx + pbw), Y = 2 * y + 1 - (2 * pby + pbh); let t;
        if (p.type === 1) { const half = Math.abs(p.dx) * pbw + Math.abs(p.dy) * pbh; t = half ? Math.trunc((X * p.dx + Y * p.dy + half) * 4096 / (2 * half)) : 0; }
        else { const R = Math.max(pbw, pbh); t = R ? Math.trunc(isqrt((X * X + Y * Y) * 256) * 4096 / (R * 16)) : 0; }
        if (t < 0) t = 0; if (t > 4096) t = 4096;
        let i = 0; while (i < p.n - 2 && t >= p.p[i + 1]) i++;
        const f = t <= p.p[i] ? 0 : t >= p.p[i + 1] ? 256 : Math.trunc((t - p.p[i]) * 256 / (p.p[i + 1] - p.p[i]));
        const d = p.dither ? BAYER[(y & 3) * 4 + (x & 3)] * 16 + 8 : 128, a = p.c[i], b = p.c[i + 1];
        const ch = (sh, m) => Math.min(m, (((a >> sh) & m) * 256 + (((b >> sh) & m) - ((a >> sh) & m)) * f + d) >> 8);
        return ch(11, 31) << 11 | ch(5, 63) << 5 | ch(0, 31);
    }
    const from32 = v => ((v & 0xF8) << 8) | ((v >> 5) & 0x7E0) | ((v >> 19) & 0x1F); // preview colours expand RGB565 losslessly
    function blendA(b, f, e) { const ch = (sh, m) => { const bv = (b >> sh) & m, fv = (f >> sh) & m; return bv + Math.trunc((fv - bv) * e / 4080); }; return ch(11, 31) << 11 | ch(5, 63) << 5 | ch(0, 31); }
    // coverage: 4×4 samples per pixel in 1/8 px units at 8x+1, 8x+3, 8x+5, 8x+7; shapes are measured from pixel centres (8x+4)
    function cover(x, y, inside) { let n = 0; for (let j = 1; j < 8; j += 2) for (let i = 1; i < 8; i += 2) if (inside(8 * x + i, 8 * y + j)) n++; return n; }
    // filled: radius r + ½ around the centre pixel (as wide as fillCircle); ring: 1 px between r − ½ and r + ½
    function aaCircle(cx, cy, r, ring) {
        const C = 8 * cx + 4, D = 8 * cy + 4, ro = (8 * r + 4) ** 2, ri = ring && r > 0 ? (8 * r - 4) ** 2 : -1;
        const inside = (sx, sy) => { const d = (sx - C) ** 2 + (sy - D) ** 2; return d <= ro && d >= ri; };
        for (let y = cy - r - 1; y <= cy + r + 1; y++) for (let x = cx - r - 1; x <= cx + r + 1; x++) px(x, y, cover(x, y, inside));
    }
    function inRR(sx, sy, x, y, w, h, r) {
        if (w <= 0 || h <= 0 || sx < 8 * x || sy < 8 * y || sx >= 8 * (x + w) || sy >= 8 * (y + h)) return false;
        if (r <= 0) return true;
        const l = 8 * (x + r) + 4, t = 8 * (y + r) + 4, rr = 8 * (x + w - r - 1) + 4, b = 8 * (y + h - r - 1) + 4;
        const dx = sx - (sx < l ? l : sx > rr ? rr : sx), dy = sy - (sy < t ? t : sy > b ? b : sy);
        return dx * dx + dy * dy <= (8 * r + 4) ** 2;
    }
    // ring: the shape minus the same shape 1 px inside (radius − 1)
    function aaRoundRect(x, y, w, h, r, ring) {
        r = clampR(w, h, r);
        const inside = ring ? (sx, sy) => inRR(sx, sy, x, y, w, h, r) && !inRR(sx, sy, x + 1, y + 1, w - 2, h - 2, r - 1) : (sx, sy) => inRR(sx, sy, x, y, w, h, r);
        for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px(i, j, cover(i, j, inside));
    }
    // 1 px wide capsule between the pixel centres of the ends
    function aaLine(x0, y0, x1, y1) {
        const ax = 8 * x0 + 4, ay = 8 * y0 + 4, bx = 8 * x1 + 4, by = 8 * y1 + 4, dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
        const inside = (sx, sy) => {
            const vx = sx - ax, vy = sy - ay, t = vx * dx + vy * dy;
            if (L === 0 || t <= 0) return vx * vx + vy * vy <= 16;
            if (t >= L) return (sx - bx) ** 2 + (sy - by) ** 2 <= 16;
            const v = vx * vx + vy * vy;
            return v * L < 4e15 ? v * L - t * t <= 16 * L : BigInt(v) * BigInt(L) - BigInt(t) * BigInt(t) <= 16n * BigInt(L); // exact like int64 on the board
        };
        // along the longer axis; only ±2 px around the ideal line can be touched
        if (Math.abs(x1 - x0) >= Math.abs(y1 - y0)) {
            for (let x = Math.min(x0, x1) - 1; x <= Math.max(x0, x1) + 1; x++) {
                const xc = Math.max(Math.min(x0, x1), Math.min(Math.max(x0, x1), x)), yc = x1 === x0 ? y0 : y0 + Math.trunc((xc - x0) * (y1 - y0) / (x1 - x0));
                for (let y = yc - 2; y <= yc + 2; y++) px(x, y, cover(x, y, inside));
            }
        } else {
            for (let y = Math.min(y0, y1) - 1; y <= Math.max(y0, y1) + 1; y++) {
                const yc = Math.max(Math.min(y0, y1), Math.min(Math.max(y0, y1), y)), xc = x0 + Math.trunc((yc - y0) * (x1 - x0) / (y1 - y0));
                for (let x = xc - 2; x <= xc + 2; x++) px(x, y, cover(x, y, inside));
            }
        }
    }
    // vertices at pixel centres; a flat triangle is drawn as its edges
    function aaTriangle(x0, y0, x1, y1, x2, y2) {
        const A = [8 * x0 + 4, 8 * y0 + 4], B = [8 * x1 + 4, 8 * y1 + 4], C = [8 * x2 + 4, 8 * y2 + 4];
        const e = (p, q, sx, sy) => (q[0] - p[0]) * (sy - p[1]) - (q[1] - p[1]) * (sx - p[0]), area = e(A, B, C[0], C[1]);
        if (!area) { aaLine(x0, y0, x1, y1); aaLine(x1, y1, x2, y2); return; }
        const sg = area > 0 ? 1 : -1, inside = (sx, sy) => sg * e(A, B, sx, sy) >= 0 && sg * e(B, C, sx, sy) >= 0 && sg * e(C, A, sx, sy) >= 0;
        for (let y = Math.min(y0, y1, y2); y <= Math.max(y0, y1, y2); y++) for (let x = Math.min(x0, x1, x2); x <= Math.max(x0, x1, x2); x++) px(x, y, cover(x, y, inside));
    }
    // smooth text: 4-bit alpha glyphs of a project font (a 0…15 → coverage (a·16 + 7) / 15)
    function drawStrAA(font, size, str, cx, cy) {
        const F = FONT_DATA[font]; let x = cx;
        for (const ch of str) {
            const code = codeOf(F, ch); if (code < F.first || code > F.last) continue;
            const k = code - F.first, [off, w, h, xo, yo] = F.ag[k];
            for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
                const n = yy * w + xx, byte = F.ab[off + (n >> 1)], a4 = n & 1 ? byte & 15 : byte >> 4; if (!a4) continue;
                const a = Math.trunc((a4 * 16 + 7) / 15);
                if (size === 1) px(x + xo + xx, cy + yo + yy, a);
                else for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) px(x + (xo + xx) * size + i, cy + (yo + yy) * size + j, a);
            }
            x += F.g[k][3] * size;
        }
    }

    // ---------- changing text: what the generated drawXxx(value) does on the board ----------
    // Adafruit_GFX::getTextBounds(str, 0, 0, …) with wrap off (charBounds for the classic font and for GFXfont)
    function textBounds(font, size, str) {
        let x = 0, minx = 0x7FFF, miny = 0x7FFF, maxx = -1, maxy = -1; const F = font && FONT_DATA[font];
        for (const c of fontBytes(F, str)) {
            if (c === 10 || c === 13) continue;
            if (!F) { minx = Math.min(minx, x); miny = Math.min(miny, 0); maxx = Math.max(maxx, x + 6 * size - 1); maxy = Math.max(maxy, 8 * size - 1); x += 6 * size; }
            else if (c >= F.first && c <= F.last) {
                const [, gw, gh, xa, xo, yo] = F.g[c - F.first], x1 = x + xo * size, y1 = yo * size; // empty glyphs (space) count too, as in the library
                minx = Math.min(minx, x1); miny = Math.min(miny, y1); maxx = Math.max(maxx, x1 + gw * size - 1); maxy = Math.max(maxy, y1 + gh * size - 1); x += xa * size;
            }
        }
        return { x: maxx >= minx ? minx : 0, w: maxx >= minx ? maxx - minx + 1 : 0, y: maxy >= miny ? miny : 0, h: maxy >= miny ? maxy - miny + 1 : 0 };
    }
    const varText = s => cleanText(s.font, (s.text || '').replace(/\n/g, ' '));
    // cursor exactly as the generated C++: x + (w - bw) / 2 - bx with integer division
    function varLayout(s) {
        const t = varText(s), b = textBounds(s.font, s.size, t);
        const cx = s.align === 'center' ? s.x + Math.trunc((s.w - b.w) / 2) - b.x : s.align === 'right' ? s.x + s.w - b.w - b.x : s.x - b.x;
        const cy = s.valign === 'middle' ? s.y + Math.trunc((s.h - b.h) / 2) - b.y : s.valign === 'bottom' ? s.y + s.h - b.h - b.y : s.y - b.y;
        return { t, cx, cy };
    }
    function drawVarText(s, aa) {
        const col = curCol, P = paint, o = opa; paint = null; opa = 255; curCol = toU32(s.erase === 'color' ? s.ec : S.bg); fillRect(s.x, s.y, s.w, s.h); curCol = col; paint = P; opa = o; // the erase is a plain fillRect
        const l = varLayout(s); (aa ? drawStrAA : drawStr)(s.font, s.size, l.t, l.cx, l.cy);
    }

    // ---------- charts: what the generated drawИмяChart() does on the board, with the sample data ----------
    // line / area / bars over lo…hi (or the data's own range), a pie by the share of every value; grid lines, a frame, dots
    const CHART_KINDS = [['line', 'линия'], ['area', 'область'], ['bar', 'столбцы'], ['pie', 'круговая']];
    function chartRange(s, d) { let lo = s.lo | 0, hi = s.hi | 0; if (s.auto) { lo = Math.min(...d); hi = Math.max(...d); } if (hi <= lo) hi = lo + 1; return [lo, hi]; }
    // a point of the pie: angle a from the top, clockwise
    const piePt = (cx, cy, r, a) => [cx + ((r * isin(a) + 8192) >> 14), cy - ((r * isin(a + 90) + 8192) >> 14)];
    function drawChart(s) {
        const d = s.data || [], n = d.length, { x, y, w, h } = s; if (w < 2 || h < 2 || n < 2) return;
        const keep = [curCol, cur565], set = c => { cur565 = c; curCol = toU32(c); };
        if (s.erase !== 'none') { set(s.erase === 'color' ? s.ec : S.bg); fillRect(x, y, w, h); }
        if (s.kind === 'pie') {
            let total = 0; for (const v of d) if (v > 0) total += v;
            const cx = x + Math.trunc((w - 1) / 2), cy = y + Math.trunc((h - 1) / 2), r = Math.trunc(Math.min(w, h) / 2) - 1, cols = s.cols && s.cols.length ? s.cols : [s.c]; let cum = 0;
            if (total) for (let i = 0; i < n; i++) {
                const a0 = Math.trunc(cum * 360 / total); cum += Math.max(0, d[i]); const a1 = Math.trunc(cum * 360 / total); set(cols[i % cols.length]);
                for (let a = a0; a < a1;) { const b = Math.min(a + 5, a1); fillTriangle(cx, cy, ...piePt(cx, cy, r, a), ...piePt(cx, cy, r, b)); a = b; }
            }
        } else {
            const [lo, hi] = chartRange(s, d), cl = v => Math.min(hi, Math.max(lo, v)), G = s.grid | 0;
            set(s.gc);
            for (let g = 1; g <= G; g++) hline(x, y + Math.trunc((h - 1) * g / (G + 1)), w);
            if (s.border) drawRect(x, y, w, h);
            const X = i => x + Math.trunc(i * (w - 1) / (n - 1)), Y = v => y + h - 1 - Math.trunc((cl(v) - lo) * (h - 1) / (hi - lo)), B = y + h - 1;
            if (s.kind === 'bar') {
                set(s.c);
                for (let i = 0; i < n; i++) {
                    const bx = x + Math.trunc(i * w / n), bw = Math.max(1, x + Math.trunc((i + 1) * w / n) - bx - (s.gap | 0)), bh = Math.trunc((cl(d[i]) - lo) * h / (hi - lo));
                    if (bh > 0) fillRect(bx, y + h - bh, bw, bh);
                }
            } else {
                if (s.kind === 'area') { set(s.fc); for (let i = 1; i < n; i++) { fillTriangle(X(i - 1), Y(d[i - 1]), X(i), Y(d[i]), X(i), B); fillTriangle(X(i - 1), Y(d[i - 1]), X(i), B, X(i - 1), B); } }
                set(s.c);
                for (let i = 1; i < n; i++) line(X(i - 1), Y(d[i - 1]), X(i), Y(d[i]));
                if (s.dots) for (let i = 0; i < n; i++) fillCircle(X(i), Y(d[i]), 2);
            }
        }
        [curCol, cur565] = keep;
    }

    // ---------- pictures ----------
    // the source is decoded once; the w×h result (RGB565 + mask, or 1-bit) is cached; preview draws from those arrays like the library does
    const decoded = new Map(), processed = new Map();
    function srcImage(id) {
        let e = decoded.get(id); if (e) return e.ready ? e : null;
        const url = S.assets[id]; if (!url) return null;
        e = { ready: false, img: new Image(), svg: url.startsWith('data:image/svg'), cache: null }; decoded.set(id, e);
        e.img.onload = () => { e.ready = true; update(); };
        e.img.src = url; return null;
    }
    // source pixels; SVG is rasterised at 4× the target size, then resampled like any picture
    function sourcePixels(e, w, h) {
        const sw = e.svg ? w * 4 : e.img.naturalWidth, sh = e.svg ? h * 4 : e.img.naturalHeight, key = sw + 'x' + sh;
        if (e.cache && e.cache.key === key) return e.cache.data;
        const c = document.createElement('canvas'); c.width = sw; c.height = sh; const x = c.getContext('2d'); x.drawImage(e.img, 0, 0, sw, sh);
        e.cache = { key, data: x.getImageData(0, 0, sw, sh) }; return e.cache.data;
    }
    // nearest: the source pixel under the centre; avg: alpha-weighted mean over the covered source area
    function resample(src, w, h, avg) {
        const { width: sw, height: sh, data: d } = src, out = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            let x0, x1, y0, y1;
            if (avg) { x0 = Math.min(sw - 1, Math.floor(x * sw / w)); x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / w)); y0 = Math.min(sh - 1, Math.floor(y * sh / h)); y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / h)); }
            else { x0 = Math.min(sw - 1, Math.floor((x + .5) * sw / w)); x1 = x0 + 1; y0 = Math.min(sh - 1, Math.floor((y + .5) * sh / h)); y1 = y0 + 1; }
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const k = (yy * sw + xx) * 4, al = d[k + 3]; r += d[k] * al; g += d[k + 1] * al; b += d[k + 2] * al; a += al; n++; }
            const o = (y * w + x) * 4; if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); } out[o + 3] = Math.round(a / n);
        }
        return out;
    }
    // masks and icons use the drawBitmap layout: rows of (w + 7) / 8 bytes, most significant bit = leftmost pixel
    function toRGB(p, w, h) {
        const px = new Uint16Array(w * h), bw = (w + 7) >> 3, mask = new Uint8Array(bw * h); let holes = false;
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
            const o = (j * w + i) * 4; px[j * w + i] = ((p[o] >> 3) << 11) | ((p[o + 1] >> 2) << 5) | (p[o + 2] >> 3);
            if (p[o + 3] >= 128) mask[j * bw + (i >> 3)] |= 0x80 >> (i & 7); else holes = true;
        }
        return { px, mask: holes ? mask : null };
    }
    // icon: a pixel is on when it is darker than the threshold (transparent counts as white); inversion flips it
    function toBits(p, w, h, thr, inv) {
        const bw = (w + 7) >> 3, bits = new Uint8Array(bw * h);
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
            const o = (j * w + i) * 4, lum = p[o + 3] >= 128 ? 299 * p[o] + 587 * p[o + 1] + 114 * p[o + 2] : 255000; // ×1000, integer so that grey 128 is exactly 128
            if ((lum < thr * 1000) !== !!inv) bits[j * bw + (i >> 3)] |= 0x80 >> (i & 7);
        }
        return { bits };
    }
    // a sprite shows its frame f
    const frameIdx = s => Math.max(0, Math.min(s.frames.length - 1, s.f | 0));
    function imgData(s) { return s.t === 'sprite' ? frameData(s, frameIdx(s)) : picData(s, s.src); }
    function picData(s, src) {
        if (!(s.w >= 1 && s.h >= 1)) return null;
        const e = srcImage(src); if (!e) return null;
        return convert(s, src, () => sourcePixels(e, s.w, s.h));
    }
    // the w×h result of a source, cached by everything that changes it
    function convert(s, srcKey, source) {
        const key = [srcKey, s.w, s.h, s.mode, s.scale, s.thr, s.inv].join('|'); let r = processed.get(key); if (r) return r;
        const src = source(); if (!src) return null;
        const rgba = resample(src, s.w, s.h, s.scale === 'avg');
        r = s.mode === 'icon' ? toBits(rgba, s.w, s.h, s.thr, s.inv) : toRGB(rgba, s.w, s.h);
        if (processed.size > 256) processed.clear(); processed.set(key, r); return r;
    }
    // a frame: a picture, or shapes drawn by the rasterizer on the screen background at the sprite's own size nw×nh (then scaled to w×h like a picture)
    function frameData(s, k) {
        const fr = s.frames[k]; if (!fr || !(s.w >= 1 && s.h >= 1)) return null;
        if (fr.src) return picData(s, fr.src);
        return convert(s, `shapes|${s.nw}|${s.nh}|${S.bg}|${JSON.stringify(fr.shapes)}`, () => rasterFrame(fr.shapes, s.nw, s.nh, S.bg));
    }
    // → {width, height, data: RGBA} with alpha 0 where nothing was drawn; null while a picture inside is still loading
    function rasterFrame(shapes, w, h, bg) {
        if (!(w >= 1 && h >= 1)) return null;
        let ready = true;
        const b = offscreen(w, h, bg, () => { for (const s of shapes) { if ((s.t === 'img' || s.t === 'sprite') && !imgData(s)) ready = false; if (!s.hidden) raster(s, 0); } });
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) if (b.idb[i] >= 0) { const v = b.u32[i]; data[i * 4] = v & 255; data[i * 4 + 1] = v >> 8 & 255; data[i * 4 + 2] = v >> 16 & 255; data[i * 4 + 3] = 255; }
        return ready ? { width: w, height: h, data } : null;
    }
    // draw into a separate w×h buffer filled with bg → {u32, idb}; it may run in the middle of drawing (a sprite frame),
    // so everything raster() uses is put back afterwards
    function offscreen(w, h, bg, draw) {
        const keep = [img, u32, idb, S.W, S.H, curCol, cur565, curId, seenBuf, paint, pbx, pby, pbw, pbh, opa, seen, clipBox];
        u32 = new Uint32Array(w * h).fill(toU32(bg)); idb = new Int32Array(w * h).fill(-1); S.W = w; S.H = h; seenBuf = null; paint = null; opa = 255; seen = null; clipBox = null;
        try { draw(); return { u32, idb }; } finally { [img, u32, idb, S.W, S.H, curCol, cur565, curId, seenBuf, paint, pbx, pby, pbw, pbh, opa, seen, clipBox] = keep; }
    }
    // Adafruit drawBitmap(x, y, bitmap, w, h, color) / drawRGBBitmap(x, y, bitmap[, mask], w, h)
    function drawImg(s) {
        const d = imgData(s); if (!d) return;
        const bw = (s.w + 7) >> 3;
        for (let j = 0; j < s.h; j++) {
            let b = 0;
            for (let i = 0; i < s.w; i++) {
                if (s.mode === 'icon') { if (i & 7) b <<= 1; else b = d.bits[j * bw + (i >> 3)]; if (b & 0x80) px(s.x + i, s.y + j); continue; }
                if (d.mask) { if (i & 7) b <<= 1; else b = d.mask[j * bw + (i >> 3)]; if (!(b & 0x80)) continue; }
                cur565 = d.px[j * s.w + i]; curCol = toU32(cur565); px(s.x + i, s.y + j);
            }
        }
    }

    // ---------- shape meta ----------
    const META = {
        rect: { name: 'Прямоугольник', f: [['x', 'x'], ['y', 'y'], ['w', 'w'], ['h', 'h']], canFill: true },
        rrect: { name: 'Скруглённый', f: [['x', 'x'], ['y', 'y'], ['w', 'w'], ['h', 'h'], ['r', 'радиус']], canFill: true },
        circle: { name: 'Круг', f: [['x', 'cx'], ['y', 'cy'], ['r', 'r']], canFill: true },
        line: { name: 'Линия', f: [['x0', 'x0'], ['y0', 'y0'], ['x1', 'x1'], ['y1', 'y1']] },
        tri: { name: 'Треугольник', f: [['x0', 'x0'], ['y0', 'y0'], ['x1', 'x1'], ['y1', 'y1'], ['x2', 'x2'], ['y2', 'y2']], canFill: true },
        pixel: { name: 'Пиксель', f: [['x', 'x'], ['y', 'y']] },
        text: { name: 'Текст', f: [['x', 'x'], ['y', 'y'], ['w', 'w'], ['h', 'h']] },
        img: { name: 'Картинка', f: [['x', 'x'], ['y', 'y'], ['w', 'w'], ['h', 'h']] },
        sprite: { name: 'Спрайт', f: [['x', 'x'], ['y', 'y'], ['w', 'w'], ['h', 'h']] },
        chart: { name: 'График', f: [['x', 'x'], ['y', 'y'], ['w', 'w'], ['h', 'h']] },
    };
    const isPic = s => s.t === 'img' || s.t === 'sprite';
    const colStr = s => s.pc && palEntry(s.pc) ? s.pc : fmt565(s.c);
    function boxHandles(s) {
        const L = Math.min(s.x, s.x + s.w - 1), T = Math.min(s.y, s.y + s.h - 1), R = Math.max(s.x, s.x + s.w - 1), B = Math.max(s.y, s.y + s.h - 1), mx = Math.floor((L + R) / 2), my = Math.floor((T + B) / 2);
        const mk = (x, y, cur, fx, fy) => ({
            x, y, cur, fx, fy, set: (s, nx, ny) => {
                let l = Math.min(s.x, s.x + s.w - 1), t = Math.min(s.y, s.y + s.h - 1), r = Math.max(s.x, s.x + s.w - 1), b = Math.max(s.y, s.y + s.h - 1);
                if (fx === 'l') l = Math.min(nx, r); if (fx === 'r') r = Math.max(nx, l); if (fy === 't') t = Math.min(ny, b); if (fy === 'b') b = Math.max(ny, t);
                s.x = l; s.y = t; s.w = r - l + 1; s.h = b - t + 1;
            }
        });
        const hs = [mk(L, T, 'nwse-resize', 'l', 't'), mk(R, T, 'nesw-resize', 'r', 't'), mk(R, B, 'nwse-resize', 'r', 'b'), mk(L, B, 'nesw-resize', 'l', 'b')];
        if ((R - L + 1) * scale >= 28) hs.push(mk(mx, T, 'ns-resize', null, 't'), mk(mx, B, 'ns-resize', null, 'b'));
        if ((B - T + 1) * scale >= 28) hs.push(mk(L, my, 'ew-resize', 'l', null), mk(R, my, 'ew-resize', 'r', null));
        return hs;
    }
    // a turned shape has only its pivot handle (size and vertices are set in the panel); the pivot comes first, so it wins over a corner under it
    function handles(s) {
        if (!canRot(s) || s.rot == null) return shapeHandles(s);
        const pv = { x: s.ox, y: s.oy, cur: 'crosshair', pt: true, pivot: true, set: (s, a, b) => { s.ox = a; s.oy = b; } };
        return rotOk(s) ? [pv] : [pv, ...shapeHandles(s)];
    }
    function shapeHandles(s) {
        const setR = (s, nx, ny) => { s.r = Math.round(Math.hypot(nx - s.x, ny - s.y)); };
        switch (s.t) {
            case 'rect': case 'rrect': case 'text': case 'img': case 'sprite': case 'chart': return boxHandles(s);
            case 'circle': return [{ x: s.x + s.r, y: s.y, cur: 'ew-resize', set: setR }, { x: s.x - s.r, y: s.y, cur: 'ew-resize', set: setR }, { x: s.x, y: s.y - s.r, cur: 'ns-resize', set: setR }, { x: s.x, y: s.y + s.r, cur: 'ns-resize', set: setR }];
            case 'line': return [{ x: s.x0, y: s.y0, cur: 'move', pt: true, set: (s, a, b) => { s.x0 = a; s.y0 = b; } }, { x: s.x1, y: s.y1, cur: 'move', pt: true, set: (s, a, b) => { s.x1 = a; s.y1 = b; } }];
            case 'tri': return [0, 1, 2].map(i => ({ x: s['x' + i], y: s['y' + i], cur: 'move', pt: true, set: (s, a, b) => { s['x' + i] = a; s['y' + i] = b; } }));
            default: return [];
        }
    }
    // what the shape covers as drawn: a turned shape by its turned geometry (that is also the box its gradient spans, as in lcbFillQuad / lcbRotBitmap)
    function bbox(s) {
        if (s.q) { const xs = s.q.map(p => p[0]), ys = s.q.map(p => p[1]), x = Math.min(...xs), y = Math.min(...ys); return [x, y, Math.max(...xs) - x + 1, Math.max(...ys) - y + 1]; }
        if (rotOk(s)) return bbox(turned(s));
        switch (s.t) {
            case 'rect': case 'rrect': case 'text': case 'img': case 'sprite': case 'chart': return [Math.min(s.x, s.x + s.w), Math.min(s.y, s.y + s.h), Math.abs(s.w), Math.abs(s.h)];
            case 'circle': return [s.x - s.r, s.y - s.r, 2 * s.r + 1, 2 * s.r + 1];
            case 'pixel': return [s.x, s.y, 1, 1];
            default: {
                const xs = [s.x0, s.x1, s.x2].filter(v => v != null), ys = [s.y0, s.y1, s.y2].filter(v => v != null);
                const x = Math.min(...xs), y = Math.min(...ys); return [x, y, Math.max(...xs) - x + 1, Math.max(...ys) - y + 1];
            }
        }
    }
    // the pivot goes along, so a turned shape moves exactly by dx, dy
    function moveShape(s, dx, dy) { for (const k of ['x', 'x0', 'x1', 'x2', 'ox']) if (k in s) s[k] += dx; for (const k of ['y', 'y0', 'y1', 'y2', 'oy']) if (k in s) s[k] += dy; }
    // the pivot when rotation is switched on: the middle of the shape (a line: its first end, like a clock hand)
    function pivotOf(s) { if (s.t === 'line') return [s.x0, s.y0]; const [x, y, w, h] = bbox(s); return [x + ((w - 1) >> 1), y + ((h - 1) >> 1)]; }
    function enableRot(s) { if (s.rot == null) { [s.ox, s.oy] = pivotOf(s); s.rot = 0; } }
    // every shape of a screen, the ones inside sprite frames too
    const deepShapes = list => list.flatMap(s => s.t === 'sprite' ? [s, ...s.frames.flatMap(f => f.shapes ? deepShapes(f.shapes) : [])] : [s]);
    function usedAssets() { const u = new Set(); for (const sc of S.screens) for (const s of deepShapes(sc.shapes)) { if (s.t === 'img') u.add(s.src); if (s.t === 'sprite') for (const f of s.frames) if (f.src) u.add(f.src); } return u; }
    // union bbox of several shapes → [x, y, w, h] or null
    function boxOf(idx) {
        let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
        for (const i of idx) { const [x, y, w, h] = bbox(S.shapes[i]); L = Math.min(L, x); T = Math.min(T, y); R = Math.max(R, x + w); B = Math.max(B, y + h); }
        return L === Infinity ? null : [L, T, R - L, B - T];
    }
    // shape ids are unique within a screen (a duplicated screen keeps them, so its animations stay valid); gradient stops get ids within their shape
    function ensureIds() {
        for (const sc of S.screens) {
            const seen = new Set();
            for (const s of sc.shapes) {
                if (!(s.id > 0) || seen.has(s.id)) s.id = S.nextId++; seen.add(s.id); if (s.id >= S.nextId) S.nextId = s.id + 1;
                if (s.grad && s.grad.stops) { // existing ids first: a new stop must not take the id (and the track) of one further on
                    const ids = new Set(), fresh = []; let n = 0;
                    for (const st of s.grad.stops) { if (st.id >= 0 && !ids.has(st.id)) ids.add(st.id); else fresh.push(st); }
                    for (const st of fresh) { while (ids.has(n)) n++; st.id = n; ids.add(n); }
                }
            }
        }
    }

    // ---------- animation: keyframes (the same integer maths as the generated lcbKey / lcbKeyC / lcbTime) ----------
    // a track animates one property of one shape: coordinates, colour c, gradient colour g<stop id>, visibility vis, text (static text only);
    // between two keys the value goes from the left key to the right one with the left key's easing, progress p = 0…1024
    const EASES = [['linear', 'линейно', 'LCB_E_LINEAR'], ['in', 'разгон', 'LCB_E_IN'], ['out', 'торможение', 'LCB_E_OUT'], ['inout', 'плавно', 'LCB_E_INOUT'], ['step', 'скачком', 'LCB_E_STEP']];
    const MODES = [['loop', 'цикл', 'LCB_LOOP'], ['pingpong', 'туда-обратно', 'LCB_PINGPONG'], ['once', 'один раз', 'LCB_ONCE'], ['value', 'по значению', 'LCB_VALUE']];
    function ease(e, p) {
        switch (e) {
            case 'in': return p * p >> 10;
            case 'out': return 1024 - ((1024 - p) * (1024 - p) >> 10);
            case 'inout': return p < 512 ? p * p >> 9 : 1024 - ((1024 - p) * (1024 - p) >> 9);
            case 'step': return 0;
            default: return p;
        }
    }
    const STEP_P = p => p === 'vis' || p === 'text' || p === 'f';
    const COLOR_P = p => p === 'c' || /^g\d+$/.test(p);
    const ANIM_F = { rect: ['x', 'y', 'w', 'h'], rrect: ['x', 'y', 'w', 'h', 'r'], circle: ['x', 'y', 'r'], line: ['x0', 'y0', 'x1', 'y1'], tri: ['x0', 'y0', 'x1', 'y1', 'x2', 'y2'], pixel: ['x', 'y'], text: ['x', 'y'], img: ['x', 'y'], sprite: ['x', 'y'] };
    // a changing text isn't animated (its function draws whatever value it gets); text wraps inside its box and a picture's array has a fixed size, so their w/h stay
    // rotation (angle, pivot) once it is switched on; opacity always; a scrolling text — its shift sx; a sprite — its frame f (by steps)
    function animProps(s) {
        if ((s.t === 'text' && s.var) || s.t === 'chart') return [];
        const out = [...ANIM_F[s.t]];
        if (canRot(s)) out.push('rot', ...(s.rot != null ? ['ox', 'oy'] : []));
        if (gradOk(s)) for (const st of s.grad.stops) out.push('g' + st.id); else if (!isPic(s) || s.mode === 'icon') out.push('c');
        out.push('o');
        if (s.t === 'text') out.push('text');
        if (scrolls(s)) out.push('sx');
        if (s.t === 'sprite') out.push('f');
        out.push('vis'); return out;
    }
    const PROP_NAMES = { c: 'цвет', vis: 'видимость', text: 'текст', rot: 'поворот', ox: 'ось x', oy: 'ось y', o: 'непрозрачность', sx: 'сдвиг строки', f: 'кадр' };
    function propName(s, p) {
        if (PROP_NAMES[p]) return PROP_NAMES[p];
        if (COLOR_P(p)) { const k = s.grad ? s.grad.stops.findIndex(st => 'g' + st.id === p) : -1; return 'градиент ' + (k + 1); }
        const f = META[s.t].f.find(f => f[0] === p); return f ? f[1] : p;
    }
    const stopOf = (s, p) => s.grad && s.grad.stops.find(st => 'g' + st.id === p);
    // [value, palette name] of a property as the shape has it now
    function getP(s, p) {
        if (p === 'vis') return [s.vis === 0 ? 0 : 1, ''];
        if (p === 'text') return [s.text || '', ''];
        if (COLOR_P(p)) { const o = p === 'c' ? s : stopOf(s, p); return o ? [o.c, o.pc || ''] : null; }
        if (p === 'o') return [opaOf(s), ''];
        if (p === 'sx' || p === 'f' || p === 'rot') return [s[p] | 0, ''];
        return [s[p], ''];
    }
    function setP(s, p, v, pc) {
        if (p === 'vis') { if (v) delete s.vis; else s.vis = 0; return; }
        if (p === 'o') { if (v >= 255) delete s.o; else s.o = Math.max(0, v); return; }
        if (p === 'rot') enableRot(s);
        if (COLOR_P(p)) { const o = p === 'c' ? s : stopOf(s, p); if (!o) return; o.c = v; if (pc) o.pc = pc; else delete o.pc; return; }
        s[p] = v;
    }
    const mix565 = (a, b, e) => { const ch = (sh, m) => { const x = (a >> sh) & m, y = (b >> sh) & m; return x + Math.trunc((y - x) * e / 1024); }; return ch(11, 31) << 11 | ch(5, 63) << 5 | ch(0, 31); };
    // value of a track at t ms → [value, palette name]; a palette name holds only where the value is exactly a key's
    function evalTrack(tr, t) {
        const k = tr.keys; if (t <= k[0].t) return [k[0].v, k[0].pc || ''];
        for (let i = 0; i + 1 < k.length; i++) {
            if (t >= k[i + 1].t) continue;
            const a = k[i], b = k[i + 1], e = STEP_P(tr.p) ? 0 : ease(a.e, Math.trunc((t - a.t) * 1024 / (b.t - a.t)));
            if (!e || (a.v === b.v && (a.pc || '') === (b.pc || ''))) return [a.v, a.pc || ''];
            return [COLOR_P(tr.p) ? mix565(a.v, b.v, e) : a.v + Math.trunc((b.v - a.v) * e / 1024), ''];
        }
        const z = k[k.length - 1]; return [z.v, z.pc || ''];
    }
    // value mode: the value (clamped to lo…hi) picks the moment on the timeline
    const valueT = (a, v) => Math.trunc((Math.min(a.hi, Math.max(a.lo, v)) - a.lo) * a.dur / (a.hi - a.lo));
    const tValue = (a, t) => a.lo + Math.round(t * (a.hi - a.lo) / a.dur);
    // what lcbValue() shows while it follows a new value: from → to in follow ms, decelerating
    const followV = (a, f, now) => { const dt = Math.max(0, now - f.t0); return a.follow && dt < a.follow ? f.from + Math.trunc((f.to - f.from) * ease('out', Math.trunc(dt * 1024 / a.follow)) / 1024) : f.to; };

    // the editor shows one frame: the open animation at the playhead, every other one at its start (0 ms);
    // that frame is written into the shapes, so editing tools work as usual and a changed animated property becomes a key
    const AN = { scr: -1, k: 0, t: 0, rec: false, play: null, sel: [], focus: false, clip: null, fold: new Set(), follow: null };
    const anims = () => S.screens[S.cur].anims;
    const openAnim = () => anims()[AN.k] || null;
    const animTime = a => a === openAnim() ? AN.t : 0;
    function trackOf(id, p) { for (const a of anims()) { const tr = a.tracks.find(tr => tr.id === id && tr.p === p); if (tr) return { a, tr }; } return null; }
    const newKey = (tr, t, v, pc, e) => Object.assign({ t, v, e: STEP_P(tr.p) ? 'step' : e || 'inout' }, pc ? { pc } : {});
    // a key at exactly t gets the value; otherwise a new key, with the easing of the key before it
    function setKey(tr, t, v, pc) {
        let i = tr.keys.findIndex(k => k.t >= t); if (i < 0) i = tr.keys.length;
        let k = tr.keys[i];
        if (!k || k.t !== t) { const prev = tr.keys[i - 1]; k = newKey(tr, t, v, pc, prev && prev.e); tr.keys.splice(i, 0, k); }
        k.v = v; if (pc) k.pc = pc; else delete k.pc;
        return k;
    }
    // a new track in the open animation: from what the shape had at 0 ms to the new value at the playhead
    function addTrack(s, p, was, now) {
        const a = openAnim(), tr = { id: s.id, p, keys: [] };
        tr.keys.push(newKey(tr, 0, ...(AN.t ? was : now)));
        if (AN.t) tr.keys.push(newKey(tr, AN.t, ...now));
        a.tracks.push(tr); return tr;
    }
    let animBase = new Map();
    function animApply() {
        const sc = S.screens[S.cur], byId = new Map(sc.shapes.map(s => [s.id, s]));
        for (const s of sc.shapes) delete s.vis;
        for (const a of sc.anims) { const t = animTime(a); for (const tr of a.tracks) { const s = byId.get(tr.id); if (s) setP(s, tr.p, ...evalTrack(tr, t)); } }
        animBase = new Map(sc.shapes.map(s => [s, Object.fromEntries(animProps(s).map(p => [p, getP(s, p)]))]));
    }
    // compare the shapes with the frame they showed: an animated property → its key at the time it is shown; recording → a new track
    function animDetect() {
        const a0 = openAnim();
        for (const s of S.shapes) {
            const b = animBase.get(s); if (!b) continue;
            for (const p of animProps(s)) {
                const was = b[p], now = getP(s, p); if (!was || !now || (was[0] === now[0] && was[1] === now[1])) continue;
                const own = trackOf(s.id, p);
                if (own) { setKey(own.tr, animTime(own.a), ...now); if (own.a !== a0) flash(`«${propName(s, p)}» у «${s.name}» анимируется в «${own.a.name}» — изменён его ключ на 0 мс.`); }
                else if (a0 && AN.rec && was[0] !== now[0]) addTrack(s, p, was, now); // only a palette link changed: not a reason for a track
                else if (p === 'vis') flash('Видимость задаётся ключами: включи запись ● на таймлайне.');
            }
        }
    }
    // tracks of deleted shapes or of properties a shape no longer has go away; one property belongs to one animation
    function animClean() {
        for (const sc of S.screens) {
            const byId = new Map(sc.shapes.map(s => [s.id, s])), seen = new Set();
            for (const a of sc.anims) a.tracks = a.tracks.filter(tr => {
                const s = byId.get(tr.id), key = tr.id + ':' + tr.p;
                if (!s || !tr.keys.length || seen.has(key) || !animProps(s).includes(tr.p)) return false;
                seen.add(key); return true;
            });
        }
    }

    // ---------- palette ----------
    const palEntry = n => S.palette.find(p => p.n === n);
    const RESERVED = new Set(['W', 'H', 'canvas', 'lcd', 'present', 'setup', 'loop', ...Object.keys(NAMED)]);
    const validName = (n, self) => /^[A-Za-z_]\w*$/.test(n) && !RESERVED.has(n) && !S.palette.some(p => p.n === n && p !== self);
    function newPalName(c) {
        const base = Object.keys(NAMED).find(k => NAMED[k] === c);
        let k = 1, n = base ? 'C_' + base : 'C_COLOR1';
        while (!validName(n)) n = (base ? 'C_' + base : 'C_COLOR') + (++k);
        return n;
    }
    // colors that point at the palette follow it; a deleted entry leaves the last value as a literal
    function syncPalette() {
        const fix = (o, k, pk) => { if (!o[pk]) return; const p = palEntry(o[pk]); if (p) o[k] = p.c; else delete o[pk]; };
        for (const sc of S.screens) {
            for (const s of deepShapes(sc.shapes)) { fix(s, 'c', 'pc'); fix(s, 'ec', 'epc'); if (s.grad) for (const st of s.grad.stops) fix(st, 'c', 'pc'); }
            for (const a of sc.anims) for (const tr of a.tracks) if (COLOR_P(tr.p)) for (const k of tr.keys) fix(k, 'v', 'pc');
            if (sc.bgPc) { const p = palEntry(sc.bgPc); if (p) sc.bg = p.c; else sc.bgPc = ''; }
            if (sc.tr) fix(sc.tr, 'c', 'pc');
        }
        if (S.colorPc) { const p = palEntry(S.colorPc); if (p) S.color = p.c; else S.colorPc = ''; }
    }

    // ---------- groups, names, selection ----------
    const gById = id => S.groups.find(g => g.id === id);
    function anc(gid) { const r = []; while (gid != null && r.length < 64) { const g = gById(gid); if (!g) break; r.push(gid); gid = g.parent; } return r; } // innermost → outermost
    const hiddenAt = i => { const s = S.shapes[i]; return !!s.hidden || anc(s.g).some(id => gById(id).hidden); };
    const lockedAt = i => { const s = S.shapes[i]; return !!s.locked || anc(s.g).some(id => gById(id).locked); };
    const groupMembers = id => S.shapes.map((s, i) => anc(s.g).includes(id) ? i : -1).filter(i => i >= 0);
    // tree view of the flat list: {kids} → {i} for a shape, {id, g, kids} for a group; kids in draw order
    function buildTree() {
        const root = { kids: [] }, nodes = new Map();
        const node = id => {
            if (id == null) return root; if (nodes.has(id)) return nodes.get(id);
            const g = gById(id), p = node(g.parent), n = { id, g, kids: [] }; nodes.set(id, n); p.kids.push(n); return n;
        };
        S.shapes.forEach((s, i) => node(s.g).kids.push({ i }));
        return root;
    }
    const nodeIdx = n => n.i != null ? [n.i] : n.kids.flatMap(nodeIdx);
    const parentOf = n => (n.i != null ? S.shapes[n.i].g : n.g.parent) ?? null;
    function findNode(pred, n = buildTree()) { for (const k of n.kids) { if (pred(k)) return k; if (k.kids) { const r = findNode(pred, k); if (r) return r; } } return null; }
    // drop empty and dangling groups, keep members of every group contiguous
    function normalize() {
        const ids = new Set(S.groups.map(g => g.id));
        for (const g of S.groups) if (g.parent != null && !ids.has(g.parent)) g.parent = null;
        for (const s of S.shapes) if (s.g != null && !ids.has(s.g)) delete s.g;
        const alive = new Set(S.shapes.flatMap(s => anc(s.g)));
        S.groups = S.groups.filter(g => alive.has(g.id));
        const objs = S.sel.map(i => S.shapes[i]), order = [];
        (function walk(n) { for (const k of n.kids) k.i != null ? order.push(k.i) : walk(k); })(buildTree());
        S.shapes = order.map(i => S.shapes[i]);
        setSelObjs(objs);
    }
    function nextName(base, names) { let n = 0; const re = new RegExp('^' + base + ' (\\d+)$'); for (const s of names) { const m = s && s.match(re); if (m) n = Math.max(n, +m[1]); } return base + ' ' + (n + 1); }
    const shapeName = t => nextName(META[t].name, S.shapes.map(s => s.name));
    const groupName = () => nextName('Группа', S.groups.map(g => g.name));
    function ensureNames() { for (const s of S.shapes) if (!s.name) s.name = shapeName(s.t); }

    function setSel(idx) { S.sel = [...new Set(idx)].filter(i => S.shapes[i]).sort((a, b) => a - b); }
    function setSelObjs(objs) { setSel(objs.map(o => S.shapes.indexOf(o))); }
    const one = () => S.sel.length === 1 ? S.shapes[S.sel[0]] : null;
    const selShapes = () => S.sel.map(i => S.shapes[i]);
    // selection as tree nodes: a group whose members are all selected counts as one node
    function selNodes() {
        const sel = new Set(S.sel), out = [];
        (function walk(n) {
            for (const k of n.kids) {
                if (k.i != null) { if (sel.has(k.i)) out.push(k); }
                else if (nodeIdx(k).every(i => sel.has(i))) out.push(k); else walk(k);
            }
        })(buildTree());
        return out;
    }
    const selGroup = () => { const n = selNodes(); return n.length === 1 && n[0].g ? n[0] : null; };
    // what a click on shape i selects: its outermost group, or one level deeper when the selection is already inside that group
    function target(i) {
        const chain = anc(S.shapes[i].g).reverse(); let k = -1;
        for (let j = chain.length - 1; j >= 0; j--) {
            const m = groupMembers(chain[j]);
            if (S.sel.length && S.sel.length < m.length && S.sel.every(x => m.includes(x))) { k = j; break; }
        }
        return chain[k + 1] != null ? groupMembers(chain[k + 1]) : [i];
    }
    const commonParent = nodes => { if (!nodes.length) return null; const cs = nodes.map(n => anc(parentOf(n))); return cs[0].find(id => cs.every(c => c.includes(id))) ?? null; };

    // move a node's block above (drawn later) / below / into (on top inside) another node; false if it makes no sense
    function moveBlock(node, ref, where) {
        const bi = nodeIdx(node), ri = nodeIdx(ref);
        if (bi.some(i => ri.includes(i))) return false;
        const np = where === 'into' ? ref.id : parentOf(ref);
        const block = bi.map(i => S.shapes[i]), refObjs = new Set(ri.map(i => S.shapes[i]));
        if (node.i != null) { if (np == null) delete block[0].g; else block[0].g = np; } else node.g.parent = np;
        const rest = S.shapes.filter(s => !block.includes(s)), pos = rest.map((s, k) => refObjs.has(s) ? k : -1).filter(k => k >= 0);
        const at = where === 'below' ? pos[0] : pos[pos.length - 1] + 1;
        S.shapes = [...rest.slice(0, at), ...block, ...rest.slice(at)];
        setSelObjs(block); normalize();
        return true;
    }
    function groupSel() {
        const nodes = selNodes(); if (!nodes.length) return;
        const id = S.nextG++; S.groups.push({ id, name: groupName(), parent: commonParent(nodes) });
        for (const n of nodes) if (n.i != null) S.shapes[n.i].g = id; else n.g.parent = id;
        // the new group goes where its topmost member was
        const idx = new Set(S.sel), top = Math.max(...S.sel), block = selShapes();
        const others = S.shapes.filter((_, i) => !idx.has(i)), at = S.shapes.slice(0, top).filter((_, i) => !idx.has(i)).length;
        S.shapes = [...others.slice(0, at), ...block, ...others.slice(at)];
        setSelObjs(block); normalize();
    }
    function ungroupSel() {
        const gs = selNodes().filter(n => n.g); if (!gs.length) return false;
        for (const n of gs) {
            const pid = n.g.parent ?? null;
            for (const s of S.shapes) if (s.g === n.id) { if (pid == null) delete s.g; else s.g = pid; }
            for (const g of S.groups) if (g.parent === n.id) g.parent = pid;
            S.groups = S.groups.filter(g => g !== n.g);
        }
        normalize(); return true;
    }
    function delSel() { const idx = new Set(S.sel); S.shapes = S.shapes.filter((_, i) => !idx.has(i)); S.sel = []; normalize(); }
    // the selection as a self-contained piece {shapes, groups, tracks}: only groups that are selected as a whole come along; tracks keep the animation's name
    function clipSel() {
        const idx = new Set(S.sel), full = new Set(S.groups.filter(g => groupMembers(g.id).every(i => idx.has(i))).map(g => g.id));
        const shapes = selShapes().map(s => { const c = JSON.parse(JSON.stringify(s)); if (!full.has(c.g)) delete c.g; return c; });
        const groups = S.groups.filter(g => full.has(g.id)).map(g => ({ ...g, parent: full.has(g.parent) ? g.parent : null }));
        const ids = new Set(shapes.map(s => s.id)), tracks = anims().flatMap(a => a.tracks.filter(tr => ids.has(tr.id)).map(tr => ({ anim: a.name, ...JSON.parse(JSON.stringify(tr)) })));
        return { shapes, groups, tracks };
    }
    // the copies get new ids; their tracks go into the animations of the same name on this screen, shifted with the shapes
    function insertPiece(piece, off, at, parent) {
        const map = new Map(piece.groups.map(g => [g.id, S.nextG++])), ids = new Map();
        S.groups.push(...piece.groups.map(g => ({ ...g, id: map.get(g.id), parent: g.parent != null ? map.get(g.parent) : parent })));
        const shapes = piece.shapes.map(s => { const c = JSON.parse(JSON.stringify(s)); if (c.g != null) c.g = map.get(c.g); else if (parent != null) c.g = parent; moveShape(c, off, off); ids.set(c.id, S.nextId); c.id = S.nextId++; return c; });
        for (const tr of piece.tracks || []) {
            const a = anims().find(a => a.name === tr.anim); if (!a || !ids.has(tr.id)) continue;
            const shift = /^(x\d?|y\d?|ox|oy)$/.test(tr.p) ? off : 0;
            a.tracks.push({ id: ids.get(tr.id), p: tr.p, keys: tr.keys.map(k => ({ ...k, v: k.v + (shift && typeof k.v === 'number' ? shift : 0) })) });
        }
        S.shapes.splice(at, 0, ...shapes); setSelObjs(shapes); normalize();
    }
    function dupSel() { if (!S.sel.length) return; push(); insertPiece(clipSel(), 5, Math.max(...S.sel) + 1, commonParent(selNodes())); update(); }
    // ↑ / ↓: swap the selected node with its neighbour on the same level
    function stepSel(dir) {
        const ns = selNodes(); if (ns.length !== 1) return; const n = ns[0], p = parentOf(n);
        const kids = (p == null ? buildTree() : findNode(k => k.id === p)).kids;
        const k = kids.findIndex(c => n.i != null ? c.i === n.i : c.id === n.id), nb = kids[k + dir];
        if (!nb) return; push(); moveBlock(n, nb, dir > 0 ? 'above' : 'below'); update();
    }
    function shiftSel(idx, dx, dy) { for (const i of idx) moveShape(S.shapes[i], dx, dy); }

    // ---------- snapping ----------
    // doubled coordinates keep centres of odd sizes integer: a box x..x+w gives lines 2x, 2x+w, 2x+2w (right edge is exclusive)
    const SNAP = 5; // screen px
    let guides = { x: [], y: [] };
    function snapLines(excl) {
        const xs = [0, S.W, 2 * S.W], ys = [0, S.H, 2 * S.H];
        S.shapes.forEach((s, i) => { if (excl.has(i) || hiddenAt(i)) return; const [x, y, w, h] = bbox(s); xs.push(2 * x, 2 * x + w, 2 * x + 2 * w); ys.push(2 * y, 2 * y + h, 2 * y + 2 * h); });
        return { xs, ys };
    }
    // nearest line to any anchor within the threshold → shift d in px (rounded like the centring buttons) and the lines that now match
    function snap1(anchors, lines) {
        const thr = 2 * SNAP / scale; let best = null;
        for (const a of anchors) for (const l of lines) { const df = l - a; if (Math.abs(df) <= thr && (best == null || Math.abs(df) < Math.abs(best))) best = df; }
        if (best == null) return { d: 0, at: [] };
        const d = Math.round(best / 2);
        return { d, at: [...new Set(lines.filter(l => anchors.some(a => Math.abs(a + 2 * d - l) <= 1)))] };
    }
    function snapHandle(hd, nx, ny, L) {
        const g = { x: [], y: [] };
        const ax = hd.pt ? [2 * nx, 2 * nx + 1, 2 * nx + 2] : hd.fx === 'l' ? [2 * nx] : hd.fx === 'r' ? [2 * nx + 2] : null;
        const ay = hd.pt ? [2 * ny, 2 * ny + 1, 2 * ny + 2] : hd.fy === 't' ? [2 * ny] : hd.fy === 'b' ? [2 * ny + 2] : null;
        if (ax) { const r = snap1(ax, L.xs); nx += r.d; g.x = r.at; }
        if (ay) { const r = snap1(ay, L.ys); ny += r.d; g.y = r.at; }
        return { x: nx, y: ny, g };
    }
    function snapCreate(a, b, L) {
        const gx = [], gy = [], put = (r, g) => { g.push(...r.at); return r.d; }, pt = v => [2 * v, 2 * v + 1, 2 * v + 2];
        let ax, ay, bx, by;
        if (S.tool === 'circle') { ax = bx = put(snap1([2 * a.x + 1], L.xs), gx); ay = by = put(snap1([2 * a.y + 1], L.ys), gy); }
        else if (S.tool === 'line') { ax = put(snap1(pt(a.x), L.xs), gx); ay = put(snap1(pt(a.y), L.ys), gy); bx = put(snap1(pt(b.x), L.xs), gx); by = put(snap1(pt(b.y), L.ys), gy); }
        else { // box: which edge a corner makes depends on the drag direction
            const rx = b.x >= a.x, ry = b.y >= a.y;
            ax = put(snap1([rx ? 2 * a.x : 2 * a.x + 2], L.xs), gx); bx = put(snap1([rx ? 2 * b.x + 2 : 2 * b.x], L.xs), gx);
            ay = put(snap1([ry ? 2 * a.y : 2 * a.y + 2], L.ys), gy); by = put(snap1([ry ? 2 * b.y + 2 : 2 * b.y], L.ys), gy);
        }
        guides = { x: gx, y: gy };
        return [{ x: a.x + ax, y: a.y + ay }, { x: b.x + bx, y: b.y + by }];
    }

    // ---------- view ----------
    const view = document.getElementById('view'), vx = view.getContext('2d'), stage = document.getElementById('stage'), emptyHint = document.getElementById('emptyHint');
    let scale = 2, preview = null, hover = null, triPts = null;
    // integer scales keep pixels square; the view canvas has to stay within what the browser can allocate
    const ZOOMS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32];
    const maxScale = () => Math.max(1, Math.floor(8192 / (Math.max(S.W, S.H) * (window.devicePixelRatio || 1))));
    const zooms = () => ZOOMS.filter(z => z <= maxScale());
    function calcScale() {
        if (S.zoom !== 'auto') return Math.max(1, Math.min(+S.zoom, maxScale()));
        const narrow = matchMedia('(max-width:980px)').matches;
        const aw = stage.clientWidth - 32 - 28, ah = (narrow ? window.innerHeight * 0.72 : stage.clientHeight - 40) - 44 - 80;
        return Math.max(1, Math.min(8, Math.floor(Math.min(aw / S.W, ah / S.H))));
    }
    const rectAB = (a, b) => [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x) + 1, Math.abs(b.y - a.y) + 1];
    function render() {
        const W = S.W, H = S.H;
        if (!img || img.width !== W || img.height !== H) { off.width = W; off.height = H; img = offx.createImageData(W, H); u32 = new Uint32Array(img.data.buffer); idb = new Int32Array(W * H); }
        idb.fill(-1);
        if (transView && transView.length === W * H) for (let i = 0; i < W * H; i++) u32[i] = toU32(transView[i]); // a transition preview: only its frame, no selection
        else {
            u32.fill(toU32(S.bg));
            S.shapes.forEach((s, i) => { if (!hiddenAt(i) && s.vis !== 0) raster(s, lockedAt(i) ? -3 : i); }); // vis 0: switched off by an animation key at this moment
            if (preview) raster(preview, -2);
        }
        emptyHint.hidden = S.shapes.length > 0 || !!preview || !!triPts;
        offx.putImageData(img, 0, 0);
        scale = calcScale();
        const cw = W * scale, ch = H * scale, dpr = window.devicePixelRatio || 1;
        if (view.width !== Math.round(cw * dpr) || view.height !== Math.round(ch * dpr)) { view.width = Math.round(cw * dpr); view.height = Math.round(ch * dpr); view.style.width = cw + 'px'; view.style.height = ch + 'px'; }
        vx.setTransform(dpr, 0, 0, dpr, 0, 0); vx.imageSmoothingEnabled = false;
        vx.drawImage(off, 0, 0, cw, ch);
        if (S.grid && scale >= 3) {
            vx.lineWidth = 1;
            for (let i = 0; i <= W; i++) { vx.strokeStyle = i % 10 === 0 ? 'rgba(128,140,160,.45)' : 'rgba(128,140,160,.14)'; vx.beginPath(); vx.moveTo(i * scale + .5, 0); vx.lineTo(i * scale + .5, ch); vx.stroke(); }
            for (let j = 0; j <= H; j++) { vx.strokeStyle = j % 10 === 0 ? 'rgba(128,140,160,.45)' : 'rgba(128,140,160,.14)'; vx.beginPath(); vx.moveTo(0, j * scale + .5); vx.lineTo(cw, j * scale + .5); vx.stroke(); }
        }
        if (triPts && hover) { vx.strokeStyle = '#7ea2ff'; vx.setLineDash([4, 3]); vx.beginPath(); const pts = [...triPts, hover]; pts.forEach((p, i) => { const X = (p.x + .5) * scale, Y = (p.y + .5) * scale; i ? vx.lineTo(X, Y) : vx.moveTo(X, Y); }); vx.stroke(); vx.setLineDash([]); }
        const sel = transView ? [] : S.sel.filter(i => S.shapes[i]);
        // a turned rectangle or picture: dashed line through its turned corner pixels
        if (sel.length === 1 && rotOk(S.shapes[sel[0]]) && turned(S.shapes[sel[0]]).q) {
            const q = turned(S.shapes[sel[0]]).q; vx.setLineDash([2, 3]); vx.lineWidth = 1; vx.strokeStyle = 'rgba(47,95,208,.8)'; vx.beginPath();
            q.forEach((p, k) => { const X = (p[0] + .5) * scale, Y = (p[1] + .5) * scale; k ? vx.lineTo(X, Y) : vx.moveTo(X, Y); }); vx.closePath(); vx.stroke(); vx.setLineDash([]);
        }
        if (sel.length > 1) { vx.lineWidth = 1; vx.strokeStyle = 'rgba(47,95,208,.9)'; for (const i of sel) { const [x, y, w, h] = bbox(S.shapes[i]); vx.strokeRect(x * scale + .5, y * scale + .5, w * scale - 1, h * scale - 1); } }
        const sb = boxOf(sel);
        if (sb) {
            const [x, y, w, h] = sb;
            vx.setLineDash([5, 4]); vx.lineWidth = 1.5; vx.strokeStyle = '#ffffff'; vx.strokeRect(x * scale - 1.5, y * scale - 1.5, w * scale + 3, h * scale + 3);
            vx.lineDashOffset = 5; vx.strokeStyle = '#2f5fd0'; vx.strokeRect(x * scale - 1.5, y * scale - 1.5, w * scale + 3, h * scale + 3); vx.setLineDash([]); vx.lineDashOffset = 0;
            const s = one();
            if (s && !lockedAt(sel[0])) for (const hd of handles(s)) {
                const X = (hd.x + .5) * scale, Y = (hd.y + .5) * scale; vx.fillStyle = '#fff'; vx.strokeStyle = '#2f5fd0'; vx.lineWidth = 1.5;
                if (hd.pivot) { vx.strokeStyle = GC; vx.beginPath(); vx.arc(X, Y, 5, 0, 2 * Math.PI); vx.fill(); vx.stroke(); vx.beginPath(); vx.moveTo(X - 9, Y); vx.lineTo(X + 9, Y); vx.moveTo(X, Y - 9); vx.lineTo(X, Y + 9); vx.stroke(); continue; }
                vx.fillRect(X - 4, Y - 4, 8, 8); vx.strokeRect(X - 4, Y - 4, 8, 8);
            }
        }
        if (guides.x.length || guides.y.length) {
            vx.strokeStyle = GC; vx.lineWidth = 1; vx.beginPath();
            for (const g of guides.x) { const X = Math.round(g / 2 * scale) + .5; vx.moveTo(X, 0); vx.lineTo(X, ch); }
            for (const g of guides.y) { const Y = Math.round(g / 2 * scale) + .5; vx.moveTo(0, Y); vx.lineTo(cw, Y); }
            vx.stroke();
        }
        if (drag && drag.mode === 'marquee' && drag.b) {
            const [x, y, w, h] = rectAB(drag.a, drag.b);
            vx.fillStyle = 'rgba(47,95,208,.12)'; vx.fillRect(x * scale, y * scale, w * scale, h * scale);
            vx.strokeStyle = '#2f5fd0'; vx.lineWidth = 1; vx.strokeRect(x * scale + .5, y * scale + .5, w * scale - 1, h * scale - 1);
        }
        if (alt) drawMeasure();
        if (LIVE.port) { LIVE.dirty = true; pump(); } // the board gets the newest frame, at most FPS per second
    }

    // ---------- Option/Alt distance overlay ----------
    let alt = false, hoverShape = -1, hoverT = null;
    const MC = '#f24822', GC = '#ff2d8a';
    function drawMeasure() {
        const Ai = S.sel.length ? S.sel : hoverT; if (!Ai || !Ai.length) return;
        const A = boxOf(Ai);
        const hasB = !!(hoverT && hoverT.some(i => !Ai.includes(i)));
        const B = hasB ? boxOf(hoverT) : [0, 0, S.W, S.H];
        const [ax, ay, aw, ah] = A, [bx, by, bw, bh] = B, ar = ax + aw, ab = ay + ah, br = bx + bw, bb = by + bh;
        const segs = []; // {o:'h'|'v', a, b, at} in pixel-edge units
        const cy = ay + ah / 2, cx = ax + aw / 2;
        const inside = (ax >= bx && ay >= by && ar <= br && ab <= bb), contains = hasB && (bx >= ax && by >= ay && br <= ar && bb <= ab);
        if (inside || !hasB) {
            segs.push({ o: 'h', a: bx, b: ax, at: cy }, { o: 'h', a: ar, b: br, at: cy }, { o: 'v', a: by, b: ay, at: cx }, { o: 'v', a: ab, b: bb, at: cx });
        } else if (contains) {
            const qy = by + bh / 2, qx = bx + bw / 2;
            segs.push({ o: 'h', a: ax, b: bx, at: qy }, { o: 'h', a: br, b: ar, at: qy }, { o: 'v', a: ay, b: by, at: qx }, { o: 'v', a: bb, b: ab, at: qx });
        } else {
            const oy0 = Math.max(ay, by), oy1 = Math.min(ab, bb), ox0 = Math.max(ax, bx), ox1 = Math.min(ar, br);
            const hy = oy1 > oy0 ? (oy0 + oy1) / 2 : cy, vx_ = ox1 > ox0 ? (ox0 + ox1) / 2 : cx;
            if (br <= ax) segs.push({ o: 'h', a: br, b: ax, at: hy, guide: oy1 > oy0 ? null : [B, 'h'] });
            else if (bx >= ar) segs.push({ o: 'h', a: ar, b: bx, at: hy, guide: oy1 > oy0 ? null : [B, 'h'] });
            if (bb <= ay) segs.push({ o: 'v', a: bb, b: ay, at: vx_, guide: ox1 > ox0 ? null : [B, 'v'] });
            else if (by >= ab) segs.push({ o: 'v', a: ab, b: by, at: vx_, guide: ox1 > ox0 ? null : [B, 'v'] });
            if (!segs.length) { // overlapping: edge offsets
                segs.push({ o: 'h', a: Math.min(ax, bx), b: Math.max(ax, bx), at: cy }, { o: 'h', a: Math.min(ar, br), b: Math.max(ar, br), at: cy },
                    { o: 'v', a: Math.min(ay, by), b: Math.max(ay, by), at: cx }, { o: 'v', a: Math.min(ab, bb), b: Math.max(ab, bb), at: cx });
            }
        }
        vx.save();
        if (hasB) { vx.strokeStyle = MC; vx.lineWidth = 1; vx.strokeRect(bx * scale + .5, by * scale + .5, bw * scale - 1, bh * scale - 1); }
        vx.strokeStyle = MC; vx.lineWidth = 1; vx.strokeRect(ax * scale + .5, ay * scale + .5, aw * scale - 1, ah * scale - 1);
        for (const g of segs) {
            const d = g.b - g.a; if (d === 0) continue;
            // dashed guide from the other box toward the measurement line when boxes don't overlap on that axis
            if (g.guide) {
                vx.setLineDash([3, 3]); vx.beginPath();
                if (g.o === 'h') { const ey = g.at < by ? by : bb; const ex = g.a === br ? br : bx; vx.moveTo(ex * scale + .5, ey * scale); vx.lineTo(ex * scale + .5, g.at * scale); }
                else { const ex = g.at < bx ? bx : br; const ey = g.a === bb ? bb : by; vx.moveTo(ex * scale, ey * scale + .5); vx.lineTo(g.at * scale, ey * scale + .5); }
                vx.stroke(); vx.setLineDash([]);
            }
            vx.beginPath();
            let lx, ly;
            if (g.o === 'h') {
                const y = Math.round(g.at * scale) + .5; vx.moveTo(g.a * scale, y); vx.lineTo(g.b * scale, y);
                vx.moveTo(g.a * scale + .5, y - 4); vx.lineTo(g.a * scale + .5, y + 4); vx.moveTo(g.b * scale - .5, y - 4); vx.lineTo(g.b * scale - .5, y + 4); lx = (g.a + g.b) / 2 * scale; ly = y;
            }
            else {
                const x = Math.round(g.at * scale) + .5; vx.moveTo(x, g.a * scale); vx.lineTo(x, g.b * scale);
                vx.moveTo(x - 4, g.a * scale + .5); vx.lineTo(x + 4, g.a * scale + .5); vx.moveTo(x - 4, g.b * scale - .5); vx.lineTo(x + 4, g.b * scale - .5); lx = x; ly = (g.a + g.b) / 2 * scale;
            }
            vx.stroke();
            label(String(Math.abs(d)), lx, ly);
        }
        vx.restore();
    }
    function label(t, x, y) {
        vx.font = '600 11px "JetBrains Mono", monospace';
        const w = vx.measureText(t).width + 8, h = 16;
        x = Math.max(w / 2, Math.min(S.W * scale - w / 2, x)); y = Math.max(h / 2, Math.min(S.H * scale - h / 2, y));
        vx.fillStyle = MC; vx.beginPath(); vx.roundRect ? vx.roundRect(x - w / 2, y - h / 2, w, h, 3) : vx.rect(x - w / 2, y - h / 2, w, h); vx.fill();
        vx.fillStyle = '#fff'; vx.textAlign = 'center'; vx.textBaseline = 'middle'; vx.fillText(t, x, y + .5);
    }

    // ---------- pointer ----------
    let drag = null;
    function ptr(e) { const r = view.getBoundingClientRect(); return { x: Math.floor((e.clientX - r.left) / scale), y: Math.floor((e.clientY - r.top) / scale), sx: e.clientX - r.left, sy: e.clientY - r.top }; }
    // locked shapes don't write the ID buffer, so clicks go through them
    function pick(x, y) {
        let box = -1;
        for (let i = S.shapes.length - 1; i >= 0; i--) { const s = S.shapes[i]; if ((s.t !== 'text' && s.t !== 'chart' && !isPic(s)) || hiddenAt(i) || lockedAt(i) || s.vis === 0) continue; const [bx, by, bw, bh] = bbox(s); if (x >= bx && y >= by && x < bx + bw && y < by + bh) { box = i; break; } }
        for (let rad = 0; rad <= 3; rad++) {
            let best = -1;
            for (let dy = -rad; dy <= rad; dy++)for (let dx = -rad; dx <= rad; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= S.W || Y >= S.H) continue; const v = idb[Y * S.W + X]; if (v > best) best = v; }
            if (best >= 0) return Math.max(best, box);
        }
        return box;
    }
    function hitHandle(p) {
        const s = one(); if (!s || S.tool !== 'select' || lockedAt(S.sel[0])) return null;
        for (const hd of handles(s)) { const X = (hd.x + .5) * scale, Y = (hd.y + .5) * scale; if (Math.abs(p.sx - X) <= 7 && Math.abs(p.sy - Y) <= 7) return hd; }
        return null;
    }
    function focusText(sel) { setTimeout(() => { const ta = document.getElementById('insText'); if (ta) { ta.focus(); if (sel) ta.select(); } }, 0); }
    // double click goes inside groups: selects exactly the shape under the cursor
    view.addEventListener('dblclick', e => {
        if (S.tool !== 'select') return; const p = ptr(e), i = pick(p.x, p.y); if (i < 0) return;
        setSel([i]); update(); if (S.shapes[i].t === 'text') focusText(true);
    });
    function newShape(t, a, b) {
        const c = S.color, f = S.fill;
        switch (t) {
            case 'text': { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { t: 'text', x, y, w: Math.abs(b.x - a.x) + 1, h: Math.abs(b.y - a.y) + 1, text: 'Text', font: S.textFont, size: S.textSize, align: 'left', valign: 'top', c }; }
            case 'rect': case 'rrect': { let w = b.x - a.x, h = b.y - a.y; const s = { t, fill: f, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(w) + 1, h: Math.abs(h) + 1, c }; if (drag && drag.shift) { const m = Math.max(s.w, s.h); s.w = s.h = m; s.x = w < 0 ? a.x - m + 1 : a.x; s.y = h < 0 ? a.y - m + 1 : a.y; } if (t === 'rrect') s.r = S.radius; return s; }
            case 'circle': return { t, fill: f, x: a.x, y: a.y, r: Math.round(Math.hypot(b.x - a.x, b.y - a.y)), c };
            case 'chart': return newChart(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x) + 1, Math.abs(b.y - a.y) + 1, c);
            case 'line': { let x1 = b.x, y1 = b.y; if (drag && drag.shift) { if (Math.abs(x1 - a.x) > Math.abs(y1 - a.y)) y1 = a.y; else x1 = a.x; } return { t, x0: a.x, y0: a.y, x1, y1, c }; }
        }
    }
    // a new chart: a wave of 24 sample points over 0…100; its id (var) names the array and the functions in the sketch
    function newChart(x, y, w, h, c) {
        return { t: 'chart', x, y, w, h, c, kind: 'line', var: uniqueVar('chart', new Set(S.screens.flatMap(sc => sc.shapes.map(t => t.var)).filter(Boolean))), data: Array.from({ length: 24 }, (_, i) => Math.round(50 + 35 * Math.sin(i / 3))),
            lo: 0, hi: 100, auto: false, grid: 3, gc: 0x4208, border: true, dots: false, gap: 1, fc: 0x0320, cols: [0xF800, 0xFD20, 0xFFE0, 0x07E0, 0x07FF, 0x001F, 0xF81F, 0x8410], erase: 'bg', ec: S.bg };
    }
    function addShape(s) { s.name = shapeName(s.t); if (S.colorPc) s.pc = S.colorPc; S.shapes.push(s); setSel([S.shapes.length - 1]); }
    view.addEventListener('pointerdown', e => {
        const p = ptr(e); view.setPointerCapture(e.pointerId); guides = { x: [], y: [] };
        if (S.tool === 'select') {
            const hd = !e.shiftKey && hitHandle(p);
            if (hd) { drag = { mode: 'handle', hd, snap: snapshot(), lines: snapLines(new Set(S.sel)) }; return; }
            const i = pick(p.x, p.y);
            if (i < 0) { if (!e.shiftKey) S.sel = []; drag = { mode: 'marquee', a: p, b: null, base: S.sel.slice() }; update(); return; }
            const t = target(i), all = t.every(j => S.sel.includes(j));
            if (e.shiftKey) { setSel(all ? S.sel.filter(j => !t.includes(j)) : S.sel.concat(t)); update(); return; }
            if (!all) setSel(t);
            drag = { mode: 'move', a: p, orig: S.sel.map(j => JSON.stringify(S.shapes[j])), box: boxOf(S.sel), snap: snapshot(), lines: snapLines(new Set(S.sel)), moved: false };
            update(); return;
        }
        if (S.tool === 'tri') {
            triPts = triPts || []; triPts.push({ x: p.x, y: p.y });
            if (triPts.length === 3) { push(); const [a, b, c] = triPts; triPts = null; addShape({ t: 'tri', fill: S.fill, x0: a.x, y0: a.y, x1: b.x, y1: b.y, x2: c.x, y2: c.y, c: S.color }); update(); }
            else render();
            return;
        }
        if (S.tool === 'pixel') { push(); addShape({ t: 'pixel', x: p.x, y: p.y, c: S.color }); update(); return; }
        drag = { mode: 'create', a: { x: p.x, y: p.y }, shift: e.shiftKey, moved: false, lines: snapLines(new Set()) };
        preview = newShape(S.tool, drag.a, drag.a); render();
    });
    view.addEventListener('pointermove', e => {
        const p = ptr(e); hover = { x: p.x, y: p.y }; status();
        const prevHS = hoverShape, prevAlt = alt; alt = e.altKey;
        if (!drag || drag.mode !== 'move') { hoverShape = pick(p.x, p.y); hoverT = hoverShape >= 0 ? target(hoverShape) : null; }
        if (!drag && S.tool === 'select') { const hd = hitHandle(p); view.style.cursor = hd ? hd.cur : hoverShape >= 0 ? 'move' : ''; }
        else if (S.tool !== 'select') view.style.cursor = S.tool === 'text' ? 'text' : '';
        if (!drag) { if (triPts || alt && (hoverShape !== prevHS || !prevAlt) || prevAlt !== alt) render(); return; }
        const free = e.ctrlKey || e.metaKey; // Ctrl/⌘ held: no snapping
        guides = { x: [], y: [] };
        if (drag.mode === 'create') {
            drag.shift = e.shiftKey; if (p.x !== drag.a.x || p.y !== drag.a.y) drag.moved = true;
            const [a, b] = free ? [drag.a, p] : snapCreate(drag.a, p, drag.lines);
            preview = newShape(S.tool, a, b); render();
        }
        else if (drag.mode === 'move') {
            let dx = p.x - drag.a.x, dy = p.y - drag.a.y;
            if (!drag.moved && !dx && !dy) return; drag.moved = true;
            if (!free) {
                const [x, y, w, h] = drag.box, X = x + dx, Y = y + dy;
                const sx = snap1([2 * X, 2 * X + w, 2 * X + 2 * w], drag.lines.xs), sy = snap1([2 * Y, 2 * Y + h, 2 * Y + 2 * h], drag.lines.ys);
                dx += sx.d; dy += sy.d; guides = { x: sx.at, y: sy.at };
            }
            if (!drag.pushed) { push('', drag.snap); drag.pushed = true; }
            S.sel.forEach((j, k) => { Object.assign(S.shapes[j], JSON.parse(drag.orig[k])); moveShape(S.shapes[j], dx, dy); });
            update(true);
        }
        else if (drag.mode === 'handle') {
            let nx = p.x, ny = p.y;
            if (!free) { const r = snapHandle(drag.hd, nx, ny, drag.lines); nx = r.x; ny = r.y; guides = r.g; }
            if (!drag.pushed) { push('', drag.snap); drag.pushed = true; }
            drag.hd.set(one(), nx, ny); update(true);
        }
        else if (drag.mode === 'marquee') {
            drag.b = p; const [x, y, w, h] = rectAB(drag.a, p), hit = [];
            S.shapes.forEach((s, i) => { if (hiddenAt(i) || lockedAt(i)) return; const [bx, by, bw, bh] = bbox(s); if (bx < x + w && bx + bw > x && by < y + h && by + bh > y) hit.push(i); });
            const tops = hit.flatMap(i => { const ch = anc(S.shapes[i].g); return ch.length ? groupMembers(ch[ch.length - 1]) : [i]; });
            setSel(drag.base.concat(tops)); update(true);
        }
    });
    function endDrag() {
        guides = { x: [], y: [] };
        if (drag && drag.mode === 'create') {
            let s = preview;
            if (!drag.moved) {
                const a = drag.a;
                if (S.tool === 'rect' || S.tool === 'rrect') s = Object.assign(s, { w: 40, h: 30 });
                else if (S.tool === 'text') { const m = fontMetrics(s.font, s.size); s.w = Math.min(120, Math.max(20, S.W - s.x)); s.h = m.block(1); }
                else if (S.tool === 'circle') s.r = 10;
                else if (S.tool === 'chart') Object.assign(s, { w: Math.min(120, Math.max(20, S.W - s.x)), h: 60 });
                else if (S.tool === 'line') { s.x1 = a.x + 30; }
            }
            push(); addShape(s); preview = null;
            if (s.t === 'text') { S.tool = 'select'; drag = null; update(); focusText(true); return; }
        }
        drag = null; update();
    }
    view.addEventListener('pointerup', endDrag);
    view.addEventListener('pointercancel', () => { drag = null; preview = null; guides = { x: [], y: [] }; render(); });
    view.addEventListener('pointerleave', () => { hover = null; hoverShape = -1; hoverT = null; status(); render(); });
    document.addEventListener('keydown', e => { if (e.key === 'Alt') { e.preventDefault(); if (!alt) { alt = true; render(); } } });
    document.addEventListener('keyup', e => { if (e.key === 'Alt') { e.preventDefault(); alt = false; render(); } });
    window.addEventListener('blur', () => { if (alt) { alt = false; render(); } });

    // ---------- UI ----------
    const ICONS = {
        select: '<path d="M5 3l13 8-6 1.5L9 19z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
        rect: '<rect x="4" y="6" width="16" height="12" fill="none" stroke="currentColor" stroke-width="1.8"/>',
        rrect: '<rect x="4" y="6" width="16" height="12" rx="4" fill="none" stroke="currentColor" stroke-width="1.8"/>',
        circle: '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
        line: '<path d="M4 19L20 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        tri: '<path d="M12 4l8.5 15h-17z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
        pixel: '<rect x="9" y="9" width="6" height="6" fill="currentColor"/>',
        text: '<path d="M5 6V4h14v2M12 4v16M9 20h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        img: '<rect x="3.5" y="5" width="17" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M4.5 18l5-5 3 3 3-4 4.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
        sprite: '<rect x="4" y="3.5" width="16" height="17" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 3.5v17M16 3.5v17M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4" fill="none" stroke="currentColor" stroke-width="1.4"/>',
        chart: '<path d="M4 4v16h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M7 15l4-5 3 3 5-6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>',
        group: '<path d="M3 6h6l2 2h10v11H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    };
    const AL = 'fill="currentColor"';
    const ALIGN = [
        ['l', 'К левому краю', `<rect x="2" y="2" width="1.6" height="16" ${AL}/><rect x="5" y="5" width="10" height="4" ${AL}/><rect x="5" y="11" width="6" height="4" ${AL}/>`],
        ['cx', 'По центру по горизонтали', `<rect x="9.2" y="2" width="1.6" height="16" ${AL}/><rect x="4" y="5" width="12" height="4" ${AL}/><rect x="6" y="11" width="8" height="4" ${AL}/>`],
        ['r', 'К правому краю', `<rect x="16.4" y="2" width="1.6" height="16" ${AL}/><rect x="5" y="5" width="10" height="4" ${AL}/><rect x="9" y="11" width="6" height="4" ${AL}/>`],
        ['t', 'К верхнему краю', `<rect x="2" y="2" width="16" height="1.6" ${AL}/><rect x="5" y="5" width="4" height="10" ${AL}/><rect x="11" y="5" width="4" height="6" ${AL}/>`],
        ['cy', 'По центру по вертикали', `<rect x="2" y="9.2" width="16" height="1.6" ${AL}/><rect x="5" y="4" width="4" height="12" ${AL}/><rect x="11" y="6" width="4" height="8" ${AL}/>`],
        ['b', 'К нижнему краю', `<rect x="2" y="16.4" width="16" height="1.6" ${AL}/><rect x="5" y="5" width="4" height="10" ${AL}/><rect x="11" y="9" width="4" height="6" ${AL}/>`],
        ['c', 'Точно по центру экрана', `<rect x="9.2" y="2" width="1.6" height="16" ${AL}/><rect x="2" y="9.2" width="16" height="1.6" ${AL}/><rect x="6" y="6" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.5"/>`],
    ];
    // alignment inside the selection: same icons, plus equal spacing
    const SALIGN = [
        ['l', 'Выровнять левые края', ALIGN[0][2]], ['cx', 'Выровнять центры по горизонтали', ALIGN[1][2]], ['r', 'Выровнять правые края', ALIGN[2][2]],
        ['t', 'Выровнять верхние края', ALIGN[3][2]], ['cy', 'Выровнять центры по вертикали', ALIGN[4][2]], ['b', 'Выровнять нижние края', ALIGN[5][2]],
        ['dh', 'Равные промежутки по горизонтали (от 3 фигур)', `<rect x="2" y="5" width="3" height="10" ${AL}/><rect x="8.5" y="3" width="3" height="14" ${AL}/><rect x="15" y="6" width="3" height="8" ${AL}/>`],
        ['dv', 'Равные промежутки по вертикали (от 3 фигур)', `<rect x="5" y="2" width="10" height="3" ${AL}/><rect x="3" y="8.5" width="14" height="3" ${AL}/><rect x="6" y="15" width="8" height="3" ${AL}/>`],
    ];
    const TOOLS = [['select', 'Выбор и перемещение', 'V'], ['rect', 'Прямоугольник', 'R'], ['rrect', 'Скруглённый прямоугольник', 'O'], ['circle', 'Круг', 'C'], ['line', 'Линия', 'L'], ['tri', 'Треугольник', 'Y'], ['pixel', 'Пиксель', 'P'], ['text', 'Текст', 'T'], ['chart', 'График или диаграмма', 'G']];
    const HINTS = {
        select: 'Клик — выбрать (фигуру в группе — вместе с группой, двойной клик — саму фигуру). Shift+клик — добавить к выделению, рамка по пустому месту — выделить несколько. Тяни — двигать, края и центры прилипают, с Ctrl/⌘ без привязки. Стрелки — 1 px, с Shift 10. Option (Alt) — расстояния.',
        rect: 'Тяни от угла до угла. Shift — квадрат. Просто клик ставит 40×30. Ctrl/⌘ — без привязки.',
        rrect: 'Тяни от угла до угла. Радиус настраивается в панели фигуры.',
        circle: 'Нажми в центре и тяни наружу — это радиус. Привязка у круга по центру.',
        line: 'Тяни от начала до конца. Shift — строго по горизонтали или вертикали.',
        tri: 'Три клика — три вершины. Esc отменяет.',
        text: 'Тяни рамку текстового блока (или просто кликни). Текст переносится по словам внутри рамки. Двойной клик по блоку — редактировать текст.',
        pixel: 'Клик ставит один пиксель.',
        chart: 'Тяни рамку графика (или просто кликни). Вид, данные и диапазон — в панели фигуры; в скетче — массив данных, pushИмя(v) и drawИмяChart().',
    };
    const rail = document.getElementById('rail');
    rail.innerHTML = TOOLS.map(([t, n, k]) => `<button class="tool" data-tool="${t}" title="${n} (${k})" aria-label="${n}"><svg viewBox="0 0 24 24">${ICONS[t]}</svg><kbd>${k}</kbd></button>`).join('')
        + `<button class="tool" id="imgBtn" title="Картинка (I): PNG, JPG или SVG. Можно перетащить файл на холст или вставить из буфера" aria-label="Картинка"><svg viewBox="0 0 24 24">${ICONS.img}</svg><kbd>I</kbd></button>`
        + '<hr><button class="tool fillbtn" id="fillBtn" title="Заливка для новых фигур (F)">fill</button>'
        + '<button class="tool" id="undoBtn" title="Отменить (Ctrl+Z)" aria-label="Отменить"><svg viewBox="0 0 24 24"><path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" transform="translate(0,-3)"/></svg></button>';
    rail.addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
    document.getElementById('fillBtn').onclick = toggleFill;
    document.getElementById('undoBtn').onclick = undo;
    function setTool(t) { S.tool = t; triPts = null; preview = null; update(); }
    function toggleFill() { const ss = selShapes().filter(s => META[s.t].canFill); if (ss.length) { push(); const v = !ss[0].fill; ss.forEach(s => s.fill = v); S.fill = v; } else S.fill = !S.fill; update(); }

    const sw = document.getElementById('swatches');
    sw.innerHTML = SWATCHES.map(c => `<button class="sw" data-c="${c}" style="background:${toHex(c)}" title="${fmt565(c)}" aria-label="${fmt565(c)}"></button>`).join('');
    sw.addEventListener('click', e => { const b = e.target.closest('.sw'); if (b) setColor(+b.dataset.c); });
    const inColor = document.getElementById('inColor'), inColor565 = document.getElementById('inColor565');
    inColor.addEventListener('input', () => setColor(to565(inColor.value), 'color'));
    inColor565.addEventListener('change', () => { const c = parse565(inColor565.value); if (c != null) setColor(c); });
    // pc: palette name, otherwise the color becomes a literal
    function setColor(c, key, pc) {
        S.color = c; S.colorPc = pc || ''; const ss = selShapes();
        if (ss.length) { push(key ? 'col' + S.sel.join() : ''); for (const s of ss) { s.c = c; if (pc) s.pc = pc; else delete s.pc; } }
        update();
    }
    const inBg = document.getElementById('inBg'), inBg565 = document.getElementById('inBg565'), inBgPc = document.getElementById('inBgPc');
    inBg.addEventListener('input', () => { push('bg'); S.bg = to565(inBg.value); S.bgPc = ''; update(); });
    inBg565.addEventListener('change', () => { const c = parse565(inBg565.value); if (c != null) { push(); S.bg = c; S.bgPc = ''; } update(); });
    inBgPc.addEventListener('change', () => { push(); S.bgPc = inBgPc.value; update(); });
    function renderBgPc() {
        inBgPc.hidden = !S.palette.length; if (document.activeElement === inBgPc) return;
        inBgPc.innerHTML = '<option value="">— из палитры —</option>' + S.palette.map(p => `<option${p.n === S.bgPc ? ' selected' : ''}>${p.n}</option>`).join('');
    }

    // palette
    const palEl = document.getElementById('palette'); let palHtml = '';
    function curPc() { const ss = selShapes(); if (!ss.length) return S.colorPc; const p = ss[0].pc || ''; return ss.every(s => (s.pc || '') === p) ? p : ''; }
    function renderPalette() {
        const a = document.activeElement; if (palEl.contains(a) && a.tagName === 'INPUT') return; // don't rebuild under the user's typing or an open color picker
        const cur = curPc(), e = palEntry(cur);
        const html = `<div class="row"><span class="set">Палитра</span>${S.palette.map(p => `<button class="pchip" data-pn="${p.n}" aria-pressed="${p.n === cur}" title="${fmt565(p.c)}"><span class="chip" style="background:${toHex(p.c)}"></span>${p.n}</button>`).join('')}<button class="btn" id="palAdd" title="Добавить текущий цвет в палитру и привязать к нему выбранное">+ в палитру</button></div>`
            + (e ? `<div class="row pal-edit"><span class="set">Цвет палитры</span><input type="text" id="palName" value="${e.n}" style="width:110px" aria-label="Имя цвета"><input type="color" id="palColor" value="${toHex(e.c)}" aria-label="Цвет ${e.n}"><input type="text" id="palHex" value="${fmt565(e.c)}" style="width:72px" aria-label="${e.n} в RGB565"><button class="btn danger" id="palDel" title="Убрать из палитры (у фигур останется этот же цвет числом)">Удалить</button></div><div class="msg warn" id="palWarn"></div>` : '');
        if (html !== palHtml) palEl.innerHTML = palHtml = html;
    }
    palEl.addEventListener('click', e => {
        const chip = e.target.closest('[data-pn]');
        if (chip) { const p = palEntry(chip.dataset.pn); setColor(p.c, '', p.n); return; }
        if (e.target.closest('#palAdd')) {
            push(); const ss = selShapes(), c = ss.length ? ss[0].c : S.color, n = newPalName(c);
            S.palette.push({ n, c });
            if (ss.length) ss.forEach(s => { if (s.c === c) s.pc = n; }); else S.colorPc = n;
            update(); return;
        }
        if (e.target.closest('#palDel')) {
            const n = curPc(); push(); S.palette = S.palette.filter(p => p.n !== n); update();
        }
    });
    palEl.addEventListener('input', e => { if (e.target.id !== 'palColor') return; const p = palEntry(curPc()); if (!p) return; push('pal' + p.n); p.c = to565(e.target.value); update(); });
    palEl.addEventListener('change', e => {
        const p = palEntry(curPc()); if (!p) return;
        if (e.target.id === 'palHex') { const c = parse565(e.target.value); if (c != null) { push(); p.c = c; } update(); }
        if (e.target.id === 'palName') {
            const v = e.target.value.trim(), warn = document.getElementById('palWarn');
            if (v === p.n) return;
            if (!validName(v, p)) { warn.textContent = 'Имя — идентификатор C++ (латиница, цифры, _), не W/H/имя цвета и без повторов.'; e.target.value = p.n; return; }
            push(); for (const sc of S.screens) { for (const s of deepShapes(sc.shapes)) { if (s.pc === p.n) s.pc = v; if (s.epc === p.n) s.epc = v; if (s.grad) for (const st of s.grad.stops) if (st.pc === p.n) st.pc = v; } for (const a of sc.anims) for (const tr of a.tracks) for (const k of tr.keys) if (k.pc === p.n) k.pc = v; if (sc.bgPc === p.n) sc.bgPc = v; if (sc.tr && sc.tr.pc === p.n) sc.tr.pc = v; } if (S.colorPc === p.n) S.colorPc = v; p.n = v; warn.textContent = ''; animBase = new Map(); update();
        }
    });
    palEl.addEventListener('focusout', () => setTimeout(() => { renderPalette(); renderBgPc(); }, 0));

    // screen size presets and orientation
    const PRESETS = [[172, 320, 'Waveshare 1.47″'], [135, 240, '1.14″'], [240, 240, '1.3″ / 1.54″'], [240, 280, '1.69″'], [240, 320, '2.0–2.8″'], [320, 480, '3.5″'], [128, 160, '1.8″'], [128, 128, '']];
    const inW = document.getElementById('inW'), inH = document.getElementById('inH'), inZoom = document.getElementById('inZoom'), inGrid = document.getElementById('inGrid'), inPreset = document.getElementById('inPreset');
    inPreset.innerHTML = '<option value="">свой</option>' + PRESETS.map(([w, h, n], k) => `<option value="${k}">${w}×${h}${n ? ' · ' + n : ''}</option>`).join('');
    function syncSettings() {
        const zs = zooms(); if (S.zoom !== 'auto' && !zs.includes(+S.zoom)) S.zoom = String(zs.filter(z => z <= +S.zoom).pop() || 1);
        inZoom.innerHTML = '<option value="auto">авто</option>' + zs.map(z => `<option>${z}</option>`).join('');
        inW.value = S.W; inH.value = S.H; inZoom.value = S.zoom; inGrid.checked = S.grid;
        const k = PRESETS.findIndex(([w, h]) => Math.min(S.W, S.H) === Math.min(w, h) && Math.max(S.W, S.H) === Math.max(w, h)); inPreset.value = k < 0 ? '' : k;
    }
    inW.addEventListener('change', () => { const v = Math.max(1, Math.min(1024, +inW.value | 0)); push(); S.W = v; syncSettings(); update(); });
    inH.addEventListener('change', () => { const v = Math.max(1, Math.min(1024, +inH.value | 0)); push(); S.H = v; syncSettings(); update(); });
    inPreset.addEventListener('change', () => { if (inPreset.value === '') return; const [w, h] = PRESETS[+inPreset.value], land = S.W > S.H; push(); S.W = land ? h : w; S.H = land ? w : h; syncSettings(); update(); });
    document.getElementById('rotBtn').addEventListener('click', () => { push(); [S.W, S.H] = [S.H, S.W]; syncSettings(); update(); });
    inZoom.addEventListener('change', () => { S.zoom = inZoom.value; update(); });
    // ⌘/Ctrl + wheel (and trackpad pinch, which comes as ctrl+wheel) zooms around the cursor; a plain wheel scrolls
    let wheelAcc = 0;
    stage.addEventListener('wheel', e => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        wheelAcc += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
        if (Math.abs(wheelAcc) < 40) return; // one mouse notch ≈ 100, a pinch gives many small steps
        const dir = wheelAcc < 0 ? 1 : -1; wheelAcc = 0;
        const zs = zooms(), cur = scale, next = dir > 0 ? zs.find(z => z > cur) : [...zs].reverse().find(z => z < cur);
        if (!next) return;
        const r = view.getBoundingClientRect(), fx = (e.clientX - r.left) / cur, fy = (e.clientY - r.top) / cur;
        S.zoom = String(next); inZoom.value = S.zoom; update();
        const r2 = view.getBoundingClientRect(); // keep the canvas point under the cursor where it was
        stage.scrollLeft += r2.left + fx * scale - e.clientX; stage.scrollTop += r2.top + fy * scale - e.clientY;
    }, { passive: false });
    inGrid.addEventListener('change', () => { S.grid = inGrid.checked; update(); });

    // inspector
    const insBody = document.getElementById('insBody'), insBtns = document.getElementById('insBtns');
    const alignHtml = (attr, list, label, aria, dis) => `<div class="align" role="group" aria-label="${aria}"><span class="set">${label}</span>${list.map(([k, n, ic]) => `<button class="ab${k === 'c' ? ' wide' : ''}" ${attr}="${k}" title="${n}" aria-label="${n}"${dis && dis(k) ? ' disabled' : ''}><svg viewBox="0 0 20 20">${ic}</svg>${k === 'c' ? 'центр' : ''}</button>`).join('')}</div>`;
    const stepBtns = '<button class="btn" data-a="up" title="Выше (рисуется позже)">↑</button><button class="btn" data-a="down" title="Ниже (рисуется раньше)">↓</button>';
    // nothing selected: the panel shows the current screen (background, the transition onto it); a selection: the shape(s)
    const insTitle = document.getElementById('insTitle'), scrPanel = document.getElementById('scrPanel');
    function renderInspector() {
        const s = one();
        scrPanel.hidden = S.sel.length > 0;
        insTitle.textContent = !S.sel.length ? `Экран «${S.screens[S.cur].name}»` : s ? 'Фигура' : 'Выделение';
        if (!S.sel.length) {
            insBtns.innerHTML = '';
            insBody.innerHTML = `<div class="empty">Ничего не выбрано — здесь настройки экрана. Новые фигуры: <b>${S.fill ? 'заливка' : 'контур'}</b>, цвет ${S.colorPc || fmt565(S.color)}.</div>`;
            return;
        }
        if (!s) return renderMulti();
        const m = META[s.t], i = S.sel[0];
        insBtns.innerHTML = `${stepBtns}<button class="btn" data-a="dup" title="Дублировать (Ctrl+D)">Копия</button><button class="btn danger" data-a="del" title="Удалить (Del)">Удалить</button>`;
        insBody.innerHTML = `<div class="row" style="justify-content:space-between"><span><span class="chip" style="background:${toHex(s.c)}"></span><b>${esc(s.name || m.name)}</b> <span class="spec">${[(s.name || '').startsWith(m.name) ? '' : m.name, s.pc].filter(Boolean).join(' · ')}</span></span>
    ${m.canFill ? `<span class="seg" id="insFill"><button data-f="0" aria-pressed="${!s.fill}">draw</button><button data-f="1" aria-pressed="${!!s.fill}">fill</button></span>` : ''}</div>
    <div class="fields" style="margin-top:10px">${m.f.map(([k, l]) => `<label>${l}<input type="number" data-k="${k}" id="f-${k}" value="${s[k]}"></label>`).join('')}</div>
    ${xformInspector(s)}${paintInspector(s)}${s.t === 'text' ? textInspector(s) : ''}${isPic(s) ? imgInspector(s) : ''}${s.t === 'sprite' ? spriteInspector(s) : ''}${s.t === 'chart' ? chartInspector(s) : ''}${animInspector(s)}${fxHtml([s])}
    ${alignHtml('data-al', ALIGN, 'По экрану', 'Выравнивание по экрану')}`;
        bindFields(i);
        bindXform(s); bindPaintInspector(s, i); bindAnimInspector(s); bindFx();
        if (s.t === 'text') bindTextInspector(s, i);
        if (isPic(s)) bindImgInspector(s, i);
        if (s.t === 'sprite') bindSpriteInspector(s);
        if (s.t === 'chart') bindChartInspector(s, i);
        const f = document.getElementById('insFill');
        if (f) f.onclick = e => { const b = e.target.closest('button'); if (!b) return; push(); s.fill = b.dataset.f === '1'; S.fill = s.fill; update(); };
    }
    // number fields of the panel (data-k = property): coordinates, angle and pivot, opacity, the shift of a scrolling text
    const fieldVal = (s, k) => k === 'o' ? opaOf(s) : k === 'rot' ? s.rot | 0 : (k === 'ox' || k === 'oy') && s.rot == null ? pivotOf(s)[k === 'ox' ? 0 : 1] : s[k] ?? 0;
    function bindFields(i) {
        insBody.querySelectorAll('input[data-k]').forEach(inp => inp.addEventListener('input', () => {
            if (inp.value === '' || isNaN(+inp.value)) return;
            const s = S.shapes[i], k = inp.dataset.k; let v = Math.trunc(+inp.value);
            push('f' + i + k);
            if (k === 'o') v = Math.max(0, Math.min(255, v));
            if (k === 'rot' || k === 'ox' || k === 'oy') enableRot(s);
            if (s.t === 'rrect' && k === 'r') S.radius = Math.max(0, v); // the next rounded rectangle takes the last radius set
            setP(s, k, v, ''); update(true);
        }));
    }
    // rotation (rectangles, lines, triangles, pictures turn; a rounded rectangle, a circle and a pixel turn as a point) and opacity
    function xformInspector(s) {
        const o = opaOf(s), on = s.rot != null, pt = ['rrect', 'circle', 'pixel'].includes(s.t);
        const rot = !canRot(s) ? '' : `<div class="fields xf" style="margin-top:8px"><label title="Градусы, по часовой стрелке">поворот°<input type="number" data-k="rot" id="f-rot" value="${fieldVal(s, 'rot')}"></label>`
            + `<label title="Ось поворота: её можно тянуть на холсте">ось x<input type="number" data-k="ox" id="f-ox" value="${fieldVal(s, 'ox')}"></label><label>ось y<input type="number" data-k="oy" id="f-oy" value="${fieldVal(s, 'oy')}"></label></div>`
            + (on ? `<div class="row"><button class="btn" id="rotMid" title="Ось — в середину фигуры">ось в центр</button><button class="btn" id="rotOff" title="Убрать поворот вместе с его ключами">без поворота</button>${pt ? '<span class="msg">поворачивается как точка: двигается центр</span>' : rotOk(s) && s.t !== 'line' && s.t !== 'tri' ? '<span class="msg">ручки размера скрыты — размер в полях выше</span>' : ''}</div>` : '');
        if (s.t === 'chart') return rot;
        const body = rot + `<div class="row"><label class="set" title="0 — не видно, 255 — непрозрачно; смешивается с тем, что уже нарисовано под фигурой">непрозрачность <input type="range" data-k="o" id="f-or" min="0" max="255" value="${o}"></label><input type="number" data-k="o" id="f-o" min="0" max="255" value="${o}" style="width:56px" aria-label="Непрозрачность 0…255"></div>`;
        // folded unless used (or opened before); the title says what is set
        const used = rotOk(s) || o < 255, open = used || !!(S.ui && S.ui.xfOpen), what = [rotOk(s) ? `${s.rot}°` : '', o < 255 ? `непрозрачность ${o}` : ''].filter(Boolean).join(', ');
        return `<details class="ins-more" id="xfMore"${open ? ' open' : ''}><summary>${canRot(s) ? 'Поворот и непрозрачность' : 'Непрозрачность'}<span class="spec">${what}</span></summary>${body}</details>`;
    }
    function bindXform(s) {
        const more = document.getElementById('xfMore');
        if (more) more.addEventListener('toggle', () => { const u = S.ui || (S.ui = {}); if (u.xfOpen !== more.open) { u.xfOpen = more.open; save(); } });
        const mid = document.getElementById('rotMid'), off = document.getElementById('rotOff');
        if (mid) mid.onclick = () => { const r = s.rot; delete s.rot; const [x, y] = pivotOf(s); s.rot = r; if (x === s.ox && y === s.oy) return; push(); s.ox = x; s.oy = y; update(); };
        if (off) off.onclick = () => { push(); for (const a of anims()) a.tracks = a.tracks.filter(tr => tr.id !== s.id || !['rot', 'ox', 'oy'].includes(tr.p)); delete s.rot; delete s.ox; delete s.oy; animBase = new Map(); update(); };
    }
    function renderMulti() {
        const ns = selNodes(), grp = selGroup();
        insBtns.innerHTML = (ns.length === 1 ? stepBtns : '')
            + (grp ? '<button class="btn" data-a="ungroup" title="Разгруппировать (Ctrl/⌘+Shift+G)">Разгруппировать</button>' : '<button class="btn" data-a="group" title="Сгруппировать (Ctrl/⌘+G)">Группа</button>')
            + '<button class="btn" data-a="dup" title="Дублировать (Ctrl+D)">Копия</button><button class="btn danger" data-a="del" title="Удалить (Del)">Удалить</button>';
        insBody.innerHTML = `<div class="row">${grp ? `<label class="set">Группа <input type="text" id="grpName" value="${escA(grp.g.name)}" style="width:160px"></label>` : ''}<span class="spec">выбрано фигур: ${S.sel.length}${ns.length > 1 ? `, объектов: ${ns.length}` : ''}</span></div>
    ${ns.length >= 2 ? alignHtml('data-sal', SALIGN, 'Между собой', 'Выравнивание внутри выделения', k => (k === 'dh' || k === 'dv') && ns.length < 3) : ''}
    ${alignHtml('data-al', ALIGN, 'По экрану', 'Выравнивание по экрану')}
    ${ns.length >= 2 ? `<div class="row"><button class="btn" id="mkSprite" title="Каждый выбранный объект (фигура или группа) становится кадром, по порядку слоёв снизу вверх">Спрайт из выделения: ${ns.length} кадр${ns.length < 5 ? 'а' : 'ов'}</button></div>` : ''}${fxHtml(selShapes())}`;
        const gn = document.getElementById('grpName');
        if (gn) gn.addEventListener('change', () => { const v = gn.value.trim(); if (v && v !== grp.g.name) { push(); grp.g.name = v; } update(); });
        const mk = document.getElementById('mkSprite'); if (mk) mk.onclick = spriteFromSel;
        bindFx();
    }
    function textInspector(s) {
        const opts = fontGroups().map(([g, ks]) => `<optgroup label="${g}">${ks.map(k => `<option value="${k}"${k === s.font ? ' selected' : ''}>${fontLabel(k)}</option>`).join('')}</optgroup>`).join('');
        const seg = (id, key, items) => `<span class="seg" id="${id}">${items.map(([v, l, t]) => `<button data-v="${v}" title="${t}" aria-pressed="${s[key] === v}">${l}</button>`).join('')}</span>`;
        const fn = s.var ? (plan().shapes.get(s) || {}).fn || varFn(s.var) : '';
        const varRow = `<div class="row"><label class="set"><input type="checkbox" id="insVar"${s.var ? ' checked' : ''}> меняющийся текст</label>${s.var ? `<label class="set">id <input type="text" id="insVarId" value="${escA(s.var)}" style="width:96px" spellcheck="false"></label><span class="spec">${fn}(value)</span>` : ''}</div>`
            + (s.var ? `<div class="row"><span class="set">Стирать</span><span class="seg" id="insErase"><button data-v="bg" aria-pressed="${s.erase !== 'color'}" title="Перед выводом залить блок фоном экрана">фоном экрана</button><button data-v="color" aria-pressed="${s.erase === 'color'}" title="Перед выводом залить блок своим цветом">своим цветом</button></span>`
                + (s.erase === 'color' ? `<input type="color" id="insEc" value="${toHex(s.ec)}" aria-label="Цвет стирания">${S.palette.length ? `<select id="insEpc" aria-label="Цвет стирания из палитры"><option value="">—</option>${S.palette.map(p => `<option${p.n === s.epc ? ' selected' : ''}>${p.n}</option>`).join('')}</select>` : ''}` : '')
                + '</div><div class="msg">Текст в редакторе — пример значения, одна строка. Позиция считается на плате через getTextBounds по выравниванию блока.</div>' : '');
        return `<div class="txt">${varRow}
    <textarea id="insText" spellcheck="false" placeholder="${s.var ? 'Пример значения' : 'Введи текст. Enter — новая строка.'}">${esc(s.text || '')}</textarea>
    <div class="msg warn" id="txtWarn"></div>
    <div class="row">
      <select id="insFont" aria-label="Шрифт">${opts}</select>
      <label class="set">размер <input type="number" id="insSize" min="1" max="10" value="${s.size}" style="width:52px"></label>
    </div>
    <div class="row">
      ${seg('insAlign', 'align', [['left', '⇤', 'Влево'], ['center', '↔', 'По центру'], ['right', '⇥', 'Вправо']])}
      ${seg('insVAlign', 'valign', [['top', 'верх', 'Прижать к верху блока'], ['middle', 'центр', 'По центру блока по высоте'], ['bottom', 'низ', 'Прижать к низу блока']])}
      <button class="btn" id="fitH" title="Высота рамки = высота текста">Высота по тексту</button>
    </div>${s.var ? '' : `<div class="row"><label class="set" title="Одна строка без переносов, обрезается по рамке; сдвиг двигает её внутри рамки. Эффект «Бегущая строка» анимирует сдвиг"><input type="checkbox" id="insScroll"${s.scroll ? ' checked' : ''}> бегущая строка</label>${s.scroll ? `<label class="set">сдвиг <input type="number" data-k="sx" id="f-sx" value="${s.sx | 0}" style="width:64px"> px</label>` : ''}</div>`}</div>`;
    }
    function textWarn(s) {
        const bad = [...new Set([...(s.text || '')].filter(ch => ch !== '\n' && !supported(s.font, ch)))];
        const el = document.getElementById('txtWarn'); if (!el) return;
        const m = fontMetrics(s.font, s.size), over = m.block(wrapText(s).length) > s.h;
        el.textContent = (bad.length ? `Нет в шрифте и будут пропущены: ${bad.slice(0, 12).join(' ')}. ` : '') + (over ? 'Текст выше рамки — увеличь h или нажми «Высота по тексту».' : '');
    }
    // fill: plain colour or gradient (2–4 stops), plus smoothing where it applies
    function paintInspector(s) {
        const canGrad = GRAD_T.includes(s.t) && (!isPic(s) || s.mode === 'icon'), canAA = AA_T.includes(s.t);
        if (!canGrad && !canAA) return '';
        const g = s.grad, on = !!g && canGrad, aaDis = s.t === 'text' && !aaFont(s);
        let h = `<div class="paint"><div class="row">${canGrad ? `<span class="set">Заливка</span><span class="seg" id="pMode"><button data-v="solid" aria-pressed="${!on}">цвет</button><button data-v="grad" aria-pressed="${on}">градиент</button></span>` : ''}
      ${canAA ? `<label class="set" title="${aaDis ? 'Сглаживание текста — только для своих шрифтов из TTF (раздел «Шрифты с кириллицей»); шрифт, созданный до этой версии, нужно пересоздать' : 'Края считаются по 4×4 подвыборкам на пиксель и смешиваются с тем, что под ними'}"><input type="checkbox" id="pAA"${s.aa && !aaDis ? ' checked' : ''}${aaDis ? ' disabled' : ''}> сглаживание</label>` : ''}</div>`;
        if (on) {
            const ang = g.angle || 0;
            h += `<div class="row"><span class="seg" id="pType"><button data-v="linear" aria-pressed="${g.type !== 'radial'}">линейный</button><button data-v="radial" aria-pressed="${g.type === 'radial'}" title="От центра рамки к краям: радиус — половина большей стороны">радиальный</button></span>`
                + (g.type !== 'radial' ? `<label class="set" title="0° — слева направо, 90° — сверху вниз">угол <input type="number" id="pAngle" value="${ang}" style="width:56px">°</label><span class="seg" id="pAngles">${[[0, '→'], [90, '↓'], [45, '↘'], [135, '↙'], [180, '←'], [270, '↑']].map(([a, l]) => `<button data-v="${a}" title="${a}°" aria-pressed="${ang === a}">${l}</button>`).join('')}</span>` : '') + '</div>';
            h += g.stops.map((st, k) => `<div class="row stop" data-k="${k}"><input type="color" value="${toHex(st.c)}" data-f="c" aria-label="Цвет ${k + 1}">`
                + (S.palette.length ? `<select data-f="pc" aria-label="Цвет ${k + 1} из палитры"><option value="">${fmt565(st.c)}</option>${S.palette.map(p => `<option${p.n === st.pc ? ' selected' : ''}>${p.n}</option>`).join('')}</select>` : `<span class="spec">${fmt565(st.c)}</span>`)
                + `<label class="set"><input type="number" data-f="p" min="0" max="100" value="${st.p}" style="width:52px" aria-label="Позиция цвета ${k + 1}">%</label>${g.stops.length > 2 ? `<button class="btn" data-f="del" title="Убрать цвет" aria-label="Убрать цвет ${k + 1}">×</button>` : ''}</div>`).join('');
            h += `<div class="row">${g.stops.length < 4 ? '<button class="btn" id="pAdd">+ цвет</button>' : ''}<button class="btn" id="pRev" title="Развернуть градиент">⇄</button><label class="set" title="Упорядоченный дизеринг 4×4 сглаживает полосы RGB565"><input type="checkbox" id="pDither"${g.dither ? ' checked' : ''}> дизеринг</label></div>`;
        }
        return h + '</div>';
    }
    function bindPaintInspector(s, i) {
        const box = insBody.querySelector('.paint'); if (!box) return;
        const seg = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = e => { const b = e.target.closest('button'); if (b) fn(b.dataset.v); }; };
        seg('pMode', v => {
            push();
            if (v === 'solid') delete s.grad;
            else if (!s.grad) { const a = { c: s.c, p: 0 }; if (s.pc) a.pc = s.pc; s.grad = { type: 'linear', angle: 90, stops: [a, { c: s.c ? 0x0000 : 0xFFFF, p: 100 }], dither: false }; }
            update();
        });
        const aa = document.getElementById('pAA'); if (aa) aa.onchange = () => { push(); if (aa.checked) s.aa = true; else delete s.aa; update(); };
        const g = s.grad; if (!g) return;
        seg('pType', v => { push(); g.type = v; update(); });
        seg('pAngles', v => { push(); g.angle = +v; update(); });
        const an = document.getElementById('pAngle');
        if (an) an.addEventListener('input', () => { if (an.value === '' || isNaN(+an.value)) return; push('ang' + i); g.angle = ((Math.round(+an.value) % 360) + 360) % 360; update(true); });
        box.addEventListener('input', e => {
            const row = e.target.closest('.stop'), f = e.target.dataset.f; if (!row || !f) return; const st = g.stops[+row.dataset.k];
            if (f === 'c') { push('stc' + i + row.dataset.k); st.c = to565(e.target.value); delete st.pc; update(true); }
            if (f === 'p' && e.target.value !== '' && !isNaN(+e.target.value)) { push('stp' + i + row.dataset.k); st.p = Math.max(0, Math.min(100, Math.round(+e.target.value))); update(true); }
        });
        box.addEventListener('change', e => {
            const row = e.target.closest('.stop'); if (!row || e.target.dataset.f !== 'pc') return; const st = g.stops[+row.dataset.k], p = palEntry(e.target.value);
            push(); if (p) { st.pc = p.n; st.c = p.c; } else delete st.pc; update();
        });
        box.addEventListener('click', e => {
            const del = e.target.closest('[data-f=del]');
            if (del) { push(); g.stops.splice(+del.closest('.stop').dataset.k, 1); update(); return; }
            if (e.target.closest('#pAdd')) { push(); g.stops.sort((a, b) => a.p - b.p); const a = g.stops[g.stops.length - 2], b = g.stops[g.stops.length - 1]; g.stops.splice(g.stops.length - 1, 0, { c: a.c, p: Math.round((a.p + b.p) / 2) }); update(); return; }
            if (e.target.closest('#pRev')) { push(); g.stops = g.stops.map(st => ({ ...st, p: 100 - st.p })).reverse(); update(); }
        });
        const di = document.getElementById('pDither'); if (di) di.onchange = () => { push(); g.dither = di.checked; update(); };
    }
    // keys of the open animation: ◆ — a key at the playhead (click removes it), ◇ — animated, no key here (click adds one), plain — not animated yet
    function animInspector(s) {
        const a = openAnim(); if (!a) return '';
        const ps = animProps(s);
        if (!ps.length) return `<div class="msg anim-ins">${s.t === 'chart' ? 'График не анимируется ключами: он меняется вместе с данными в скетче.' : 'Меняющийся текст не анимируется: его функция рисует то значение, которое ей передали.'}</div>`;
        const btn = p => {
            const o = trackOf(s.id, p), st = !o ? 'no' : o.a !== a ? 'other' : o.tr.keys.some(k => k.t === AN.t) ? 'on' : 'tr';
            const tip = st === 'other' ? `Анимируется в «${o.a.name}»` : st === 'on' ? 'Убрать ключ на бегунке' : 'Поставить ключ на бегунке с текущим значением';
            return `<button class="kb" data-p="${p}" data-st="${st}" title="${escA(tip)}"${st === 'other' ? ' disabled' : ''}><span class="kd" aria-hidden="true"></span>${esc(propName(s, p))}</button>`;
        };
        return `<div class="anim-ins"><div class="row"><span class="set">Ключи «${esc(a.name)}» на ${a.mode === 'value' ? 'значении ' + tValue(a, AN.t) : AN.t + ' мс'}</span>
      <label class="set" title="Видимость на этом моменте — ставит ключ видимости"><input type="checkbox" id="insVis"${s.vis === 0 ? '' : ' checked'}> видна</label></div>
      <div class="row kbs">${ps.filter(p => p !== 'vis').map(btn).join('')}</div></div>`;
    }
    function bindAnimInspector(s) {
        const box = insBody.querySelector('.anim-ins'), a = openAnim(); if (!box || !a) return;
        box.addEventListener('click', e => {
            const b = e.target.closest('.kb'); if (!b || b.disabled) return; const p = b.dataset.p, o = trackOf(s.id, p);
            push();
            if (b.dataset.st === 'on') { o.tr.keys = o.tr.keys.filter(k => k.t !== AN.t); AN.sel = []; }
            else if (o) setKey(o.tr, AN.t, ...getP(s, p));
            else { const tr = { id: s.id, p, keys: [] }; tr.keys.push(newKey(tr, AN.t, ...getP(s, p))); a.tracks.push(tr); }
            update();
        });
        const vis = document.getElementById('insVis');
        if (vis) vis.onchange = () => {
            const o = trackOf(s.id, 'vis'); if (o && o.a !== a) { flash(`Видимость «${s.name}» анимируется в «${o.a.name}».`); vis.checked = s.vis !== 0; return; }
            push(); const v = vis.checked ? 1 : 0;
            if (o) setKey(o.tr, AN.t, v, ''); else addTrack(s, 'vis', [1, ''], [v, '']);
            update();
        };
    }
    function imgInspector(s) {
        const seg = (id, key, items) => `<span class="seg" id="${id}">${items.map(([v, l, t]) => `<button data-v="${v}" title="${t}" aria-pressed="${s[key] === v}">${l}</button>`).join('')}</span>`;
        const d = imgData(s), bw = (s.w + 7) >> 3, icon = s.mode === 'icon', n = s.t === 'sprite' ? s.frames.length : 1, holes = s.t === 'sprite' ? spriteMasked(s) : !!(d && d.mask);
        const bytes = n * (icon ? bw * s.h : s.w * s.h * 2 + (holes ? bw * s.h : 0));
        return `<div class="txt">
    <div class="row">${seg('imgMode', 'mode', [['color', 'цвет', 'RGB565-массив и drawRGBBitmap'], ['icon', 'иконка', '1-битная маска и drawBitmap цветом фигуры']])}
      ${seg('imgScale', 'scale', [['nearest', 'без сглаживания', 'Каждый пиксель берётся из ближайшего пикселя исходника'], ['avg', 'усреднение', 'Каждый пиксель — среднее по своей области исходника']])}</div>
    ${icon ? `<div class="row"><label class="set">порог <input type="range" id="imgThr" min="1" max="255" value="${s.thr}"></label><span class="spec" id="imgThrV">${s.thr}</span><label class="set"><input type="checkbox" id="imgInv"${s.inv ? ' checked' : ''}> инверсия</label></div>
    <div class="msg">Пиксель горит, если он темнее порога (прозрачное считается белым). Цвет иконки — в разделе «Цвет», можно из палитры.</div>` : ''}
    <div class="row"><button class="btn" id="imgRatio" title="Подогнать высоту под пропорции исходной картинки">Исходные пропорции</button><span class="spec">${d ? (!icon && holes ? 'с прозрачностью · ' : '') : 'загружается… · '}${bytes.toLocaleString('ru')} байт</span></div></div>`;
    }
    function bindImgInspector(s, i) {
        for (const [id, key] of [['imgMode', 'mode'], ['imgScale', 'scale']]) document.getElementById(id).onclick = e => { const b = e.target.closest('button'); if (!b || s[key] === b.dataset.v) return; push(); s[key] = b.dataset.v; update(); };
        const thr = document.getElementById('imgThr');
        if (thr) thr.addEventListener('input', () => { push('thr' + i); s.thr = +thr.value; document.getElementById('imgThrV').textContent = thr.value; update(true); });
        const inv = document.getElementById('imgInv');
        if (inv) inv.onchange = () => { push(); s.inv = inv.checked; update(); };
        document.getElementById('imgRatio').onclick = () => { if (!s.nw || !s.nh) return; push(); s.h = Math.max(1, Math.round(s.w * s.nh / s.nw)); update(); };
    }

    // ---------- charts in the panel ----------
    const chartNames = s => { const P = plan(true).shapes.get(s) || {}; const id = s.var[0].toUpperCase() + s.var.slice(1); return { arr: P.arr || s.var + 'Data', push: P.push || 'push' + id, fn: P.fn || 'draw' + id + 'Chart' }; };
    function chartInspector(s) {
        const N = chartNames(s), pie = s.kind === 'pie', line = s.kind === 'line' || s.kind === 'area';
        const seg = (id, key, items) => `<span class="seg" id="${id}">${items.map(([v, l, t]) => `<button data-v="${v}"${t ? ` title="${t}"` : ''} aria-pressed="${s[key] === v}">${l}</button>`).join('')}</span>`;
        const chk = (k, l, t) => `<label class="set"${t ? ` title="${t}"` : ''}><input type="checkbox" data-ck="${k}"${s[k] ? ' checked' : ''}> ${l}</label>`;
        const num = (k, l, w, t) => `<label class="set"${t ? ` title="${t}"` : ''}>${l} <input type="number" data-cn="${k}" value="${k === 'n' ? s.data.length : s[k] | 0}" style="width:${w}px"></label>`;
        const col = (k, l) => `<label class="set">${l} <input type="color" data-cc="${k}" value="${toHex(s[k])}"></label>`;
        return `<div class="txt chart">
    <div class="row">${seg('chKind', 'kind', CHART_KINDS.map(([v, l]) => [v, l]))}</div>
    <div class="row"><label class="set" title="Имя в скетче: массив данных и функции графика">id <input type="text" id="chId" value="${escA(s.var)}" style="width:96px" spellcheck="false"></label><span class="spec">${N.arr}[${s.data.length}] · ${N.push}(v) · ${N.fn}()</span></div>
    <div class="row">${num('n', 'точек', 52, 'Сколько значений хранит массив (2…120). pushИмя(v) сдвигает их влево и добавляет новое справа')}<span class="msg">${pie ? 'каждое значение — доля круга' : 'пример данных для превью — в скетче их заменит твой код'}</span></div>
    <textarea id="chData" spellcheck="false" rows="2" aria-label="Пример данных: целые числа через запятую">${s.data.join(', ')}</textarea>
    ${pie ? `<div class="row chart-cols"><span class="set">цвета долей</span>${s.cols.map((c, k) => `<input type="color" data-pc="${k}" value="${toHex(c)}" aria-label="Цвет доли ${k + 1}">`).join('')}${s.cols.length < 8 ? '<button class="btn" id="chColAdd" title="Ещё цвет">+</button>' : ''}${s.cols.length > 1 ? '<button class="btn" id="chColDel" title="Убрать последний цвет">−</button>' : ''}</div><div class="msg">Основной цвет фигуры не используется: доли берут цвета по кругу.</div>`
                : `<div class="row">${chk('auto', 'диапазон по данным', 'Минимум и максимум считаются на плате по текущим данным')}${s.auto ? '' : num('lo', 'от', 60) + num('hi', 'до', 60)}</div>
    <div class="row">${num('grid', 'линий сетки', 44)}${col('gc', 'цвет сетки')}${chk('border', 'рамка')}</div>
    <div class="row">${line ? chk('dots', 'точки') : num('gap', 'зазор', 44, 'Промежуток между столбцами, px')}${s.kind === 'area' ? col('fc', 'заливка') : ''}<span class="msg">${line ? 'линия' : 'столбцы'} — основным цветом</span></div>`}
    <div class="row"><span class="set">Стирать</span>${seg('chErase', 'erase', [['bg', 'фоном экрана', 'Перед рисованием залить рамку фоном экрана'], ['color', 'своим цветом', 'Залить рамку своим цветом'], ['none', 'не стирать', 'Рисовать поверх: годится, если экран и так перерисовывается целиком']])}${s.erase === 'color' ? `<input type="color" data-cc="ec" value="${toHex(s.ec)}" aria-label="Цвет фона графика">` : ''}</div>
  </div>`;
    }
    function bindChartInspector(s, i) {
        const box = insBody.querySelector('.chart'); if (!box) return;
        const seg = (id, key) => { const el = document.getElementById(id); if (el) el.onclick = e => { const b = e.target.closest('button'); if (!b || s[key] === b.dataset.v) return; push(); s[key] = b.dataset.v; if (key === 'erase' && s.ec == null) s.ec = S.bg; update(); }; };
        seg('chKind', 'kind'); seg('chErase', 'erase');
        box.addEventListener('change', e => {
            const t = e.target;
            if (t.dataset.ck) { push(); s[t.dataset.ck] = t.checked; update(); }
            if (t.dataset.cn) {
                const v = Math.round(+t.value); if (t.value === '' || isNaN(v)) { update(); return; } push();
                if (t.dataset.cn === 'n') { const n = Math.max(2, Math.min(120, v)); s.data = s.data.length >= n ? s.data.slice(s.data.length - n) : [...Array(n - s.data.length).fill(s.data[0] | 0), ...s.data]; }
                else if (t.dataset.cn === 'grid') s.grid = Math.max(0, Math.min(20, v));
                else if (t.dataset.cn === 'gap') s.gap = Math.max(0, Math.min(50, v));
                else s[t.dataset.cn] = Math.max(-32768, Math.min(32767, v));
                update();
            }
            if (t.id === 'chId') { const v = lead(t.value.trim().replace(/[^A-Za-z0-9_]/g, '_')); if (v && v !== s.var) { push(); s.var = v; } update(); }
            if (t.id === 'chData') { const vals = (t.value.match(/-?\d+/g) || []).map(v => Math.max(-32768, Math.min(32767, +v))).slice(0, 120); if (vals.length >= 2) { push(); s.data = vals; } update(); }
        });
        box.addEventListener('input', e => {
            const t = e.target;
            if (t.dataset.cc) { push('chc' + i + t.dataset.cc); s[t.dataset.cc] = to565(t.value); update(true); }
            if (t.dataset.pc) { push('chp' + i + t.dataset.pc); s.cols[+t.dataset.pc] = to565(t.value); update(true); }
        });
        box.addEventListener('click', e => {
            if (e.target.closest('#chColAdd')) { push(); s.cols.push(SWATCHES[(s.cols.length + 4) % SWATCHES.length]); update(); }
            if (e.target.closest('#chColDel')) { push(); s.cols.pop(); update(); }
        });
    }

    // ---------- sprites: frames of pictures or of shapes; the frame number is the animated property f ----------
    // a colour sprite with holes in any frame gets a mask for every frame: the sketch picks the frame and its mask by one index
    const spriteMasked = s => s.mode !== 'icon' && s.frames.some((_, k) => { const d = frameData(s, k); return !!(d && d.mask); });
    // durations become the keys of the f track (frame k from the sum of the durations before it); the animation is at least that long
    function rebuildSpriteKeys(s) {
        const o = trackOf(s.id, 'f'); if (!o) return false;
        let t = o.tr.keys.length ? o.tr.keys[0].t : 0;
        o.tr.keys = s.frames.map((fr, k) => { const key = { t, v: k, e: 'step' }; t += Math.max(1, fr.d | 0); return key; });
        const other = Math.max(0, ...o.a.tracks.filter(tr => tr !== o.tr).flatMap(tr => tr.keys.map(k => k.t)));
        o.a.dur = Math.max(1, Math.min(600000, Math.max(t, other))); return true;
    }
    function spriteInspector(s) {
        const o = trackOf(s.id, 'f'), cur = frameIdx(s);
        return `<div class="frames"><div class="row"><span class="set">Кадры</span><span class="spec">${o ? `анимация «${esc(o.a.name)}»` : 'не анимируется — показан кадр ' + (cur + 1)}</span><span class="grow"></span>`
            + `<button class="btn" id="frAdd" title="Добавить кадры-картинки (можно выбрать несколько файлов)">+ картинки</button><button class="btn" id="frSplit" title="Вернуть кадры на холст: картинки и группы «кадр N», видим текущий">Разобрать</button></div>`
            + s.frames.map((fr, k) => `<div class="row fr${k === cur ? ' on' : ''}" data-k="${k}"><button class="fr-th" data-a="show" title="Показать кадр ${k + 1}" aria-label="Показать кадр ${k + 1}"><canvas width="${Math.max(1, s.w)}" height="${Math.max(1, s.h)}"></canvas><span>${k + 1}</span></button>`
                + `<span class="spec">${fr.src ? 'картинка' : 'фигур: ' + fr.shapes.length}</span><span class="grow"></span><label class="set"><input type="number" data-fd min="1" max="60000" value="${fr.d}" style="width:62px" aria-label="Длительность кадра ${k + 1}"> мс</label>`
                + `<button class="btn" data-a="up" title="Раньше"${k ? '' : ' disabled'}>↑</button><button class="btn" data-a="down" title="Позже"${k < s.frames.length - 1 ? '' : ' disabled'}>↓</button><button class="btn" data-a="del" title="Убрать кадр"${s.frames.length > 1 ? '' : ' disabled'} aria-label="Убрать кадр ${k + 1}">×</button></div>`).join('')
            + `<div class="msg">${o ? 'Длительности — это ключи «кадр» на таймлайне: их можно доправить там, но правка длительности здесь расставит ключи заново.' : 'Чтобы кадры сменялись, нажми ◆ «кадр» в ключах открытой анимации или создай спрайт заново.'}</div></div>`;
    }
    function drawThumbs(s) {
        insBody.querySelectorAll('.fr').forEach(row => {
            const c = row.querySelector('canvas'), d = frameData(s, +row.dataset.k); if (!c || !d) return;
            const x = c.getContext('2d'), im = x.createImageData(s.w, s.h), u = new Uint32Array(im.data.buffer), bw = (s.w + 7) >> 3;
            for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) {
                const on = s.mode === 'icon' ? d.bits[j * bw + (i >> 3)] & (0x80 >> (i & 7)) : !d.mask || d.mask[j * bw + (i >> 3)] & (0x80 >> (i & 7));
                if (on) u[j * s.w + i] = toU32(s.mode === 'icon' ? s.c : d.px[j * s.w + i]);
            }
            x.putImageData(im, 0, 0);
        });
    }
    function bindSpriteInspector(s) {
        const box = insBody.querySelector('.frames'); if (!box) return; drawThumbs(s);
        box.addEventListener('click', e => {
            const b = e.target.closest('[data-a]'), row = e.target.closest('.fr'); if (!b || !row || b.disabled) return; const k = +row.dataset.k, o = trackOf(s.id, 'f');
            if (b.dataset.a === 'show') {
                // on the timeline: the playhead goes to the frame's first key; otherwise it becomes the frame the sprite shows
                if (o) { const key = o.tr.keys.find(x => x.v === k); if (key) { if (o.a !== openAnim()) { AN.k = anims().indexOf(o.a); } AN.t = Math.min(key.t, o.a.dur); update(); } return; }
                push(); s.f = k; update(); return;
            }
            push();
            if (b.dataset.a === 'del') { s.frames.splice(k, 1); s.f = Math.min(s.f | 0, s.frames.length - 1); }
            if (b.dataset.a === 'up' || b.dataset.a === 'down') { const j = b.dataset.a === 'up' ? k - 1 : k + 1; [s.frames[k], s.frames[j]] = [s.frames[j], s.frames[k]]; }
            rebuildSpriteKeys(s); update();
        });
        box.addEventListener('change', e => {
            if (!e.target.matches('[data-fd]')) return; const v = Math.round(+e.target.value);
            if (!(v >= 1)) { update(); return; }
            push(); s.frames[+e.target.closest('.fr').dataset.k].d = Math.min(60000, v); rebuildSpriteKeys(s); update();
        });
        document.getElementById('frAdd').onclick = () => { spriteFiles = s; fileIn.multiple = true; fileIn.click(); };
        document.getElementById('frSplit').onclick = () => splitSprite(s);
    }
    // a new sprite at x, y; with several frames it gets its own looping animation with one key per frame
    function addSprite(frames, x, y, nw, nh, w, h, at) {
        const s = { t: 'sprite', x, y, w: w || nw, h: h || nh, nw, nh, mode: 'color', scale: 'nearest', thr: 128, inv: false, c: S.color, f: 0, frames };
        s.name = shapeName('sprite'); if (S.colorPc) s.pc = S.colorPc;
        S.shapes.splice(at == null ? S.shapes.length : at, 0, s); ensureIds();
        if (frames.length > 1) {
            const as = anims(), a = newAnim(uniqueName(s.name, as.map(x => x.name)));
            a.tracks.push({ id: s.id, p: 'f', keys: [] }); as.push(a); rebuildSpriteKeys(s);
            AN.k = as.length - 1; AN.t = 0; AN.sel = [];
        }
        return s;
    }
    // every selected object (a shape or a whole group) is a frame, in draw order; frames are aligned by their top-left corners
    function spriteFromSel() {
        const ns = selNodes(); if (ns.length < 2) return;
        const frames = []; let W = 0, H = 0, X = 0, Y = 0;
        for (const n of ns) {
            const idx = nodeIdx(n).filter(i => !hiddenAt(i)); if (!idx.length) continue;
            if (idx.some(i => S.shapes[i].t === 'sprite')) { flash('Спрайт не может быть кадром другого спрайта.'); return; }
            const [bx, by, bw, bh] = boxOf(idx);
            const shapes = idx.map(i => { const c = JSON.parse(JSON.stringify(S.shapes[i])); for (const k of ['g', 'id', 'vis', 'locked', 'hidden', 'var', 'erase', 'ec', 'epc']) delete c[k]; moveShape(c, -bx, -by); return c; });
            if (!frames.length) { X = bx; Y = by; }
            frames.push({ d: 100, shapes }); W = Math.max(W, bw); H = Math.max(H, bh);
        }
        if (frames.length < 2) { flash('Для спрайта нужно хотя бы два видимых кадра.'); return; }
        push(); const at = Math.min(...S.sel); delSel(); const s = addSprite(frames, X, Y, W, H, 0, 0, at);
        normalize(); setSelObjs([s]); S.tool = 'select'; update();
    }
    // back onto the canvas: a picture frame → a picture, a frame of shapes → a group «… · кадр N»; only the frame shown stays visible
    function splitSprite(s) {
        push(); const at = S.shapes.indexOf(s), cur = frameIdx(s), out = [];
        s.frames.forEach((fr, k) => {
            const name = `${s.name} · кадр ${k + 1}`;
            if (fr.src) { const p = { t: 'img', x: s.x, y: s.y, w: s.w, h: s.h, src: fr.src, nw: fr.nw || s.w, nh: fr.nh || s.h, mode: s.mode, scale: s.scale, thr: s.thr, inv: s.inv, c: s.c, name }; if (s.pc) p.pc = s.pc; if (s.g != null) p.g = s.g; if (k !== cur) p.hidden = true; out.push(p); return; }
            const gid = S.nextG++; S.groups.push(Object.assign({ id: gid, name, parent: s.g ?? null }, k !== cur ? { hidden: true } : {}));
            for (const c0 of fr.shapes) { const c = JSON.parse(JSON.stringify(c0)); moveShape(c, s.x, s.y); c.g = gid; if (!c.name) c.name = shapeName(c.t); out.push(c); }
        });
        S.shapes.splice(at, 1, ...out); setSelObjs(out); normalize(); update();
    }

    // ---------- ready-made effects: each one becomes an ordinary animation with tracks that can be edited afterwards ----------
    // [key, menu label, what it does, which shapes, name of the animation it makes]
    const PULSE_T = ['rect', 'rrect', 'circle', 'line', 'tri'];
    const FX = [
        ['blink', 'Мигание', 'видимость: 500 мс видно, 500 мс нет', s => true, 'Мигание'],
        ['pulse', 'Пульс: размер', 'плавно больше на 20 % и обратно', s => PULSE_T.includes(s.t), 'Пульс'],
        ['pulsec', 'Пульс: цвет', 'цвет плавно светлеет и обратно', s => animProps(s).some(COLOR_P), 'Пульс цвета'],
        ['marquee', 'Бегущая строка', 'текст едет справа налево внутри рамки, 40 px/с', s => s.t === 'text' && !s.var, 'Бегущая строка'],
        ['spin', 'Спиннер', 'полный оборот за секунду; у нескольких фигур — вокруг общего центра', s => canRot(s), 'Спиннер'],
        ['bar', 'Прогресс-бар', 'заполнение по значению 0…100: setProgress(v)', s => s.t === 'rect' || s.t === 'rrect', 'Прогресс'],
    ];
    function fxHtml(ss) {
        const list = FX.filter(f => ss.length && ss.every(s => animProps(s).length && f[3](s)));
        if (!list.length) return '';
        return `<div class="row fx"><span class="set">Эффект</span><select id="fxSel" aria-label="Добавить готовый эффект" title="Эффект станет новой анимацией с обычными ключами — их можно доправить на таймлайне"><option value="">— добавить —</option>${list.map(([k, n, t]) => `<option value="${k}" title="${t}">${n}</option>`).join('')}</select></div>`;
    }
    function bindFx() { const sel = document.getElementById('fxSel'); if (sel) sel.onchange = () => { const k = sel.value; sel.value = ''; if (k) applyFx(k, selShapes()); }; }
    // a bigger copy of the geometry around its middle (pulse)
    function pulsed(s) {
        const k = v => Math.max(v + 2, Math.round(v * 1.2));
        if (s.t === 'circle') return { r: Math.max(s.r + 1, Math.round(s.r * 1.2)) };
        if (s.t === 'rect' || s.t === 'rrect') { const w = k(s.w), h = k(s.h); return { x: s.x - ((w - s.w) >> 1), y: s.y - ((h - s.h) >> 1), w, h }; }
        const [bx, by, bw, bh] = bbox({ ...s, rot: 0 }), cx = bx + (bw - 1) / 2, cy = by + (bh - 1) / 2, out = {};
        for (const p of ANIM_F[s.t]) out[p] = p[0] === 'x' ? Math.round(cx + (s[p] - cx) * 1.2) : Math.round(cy + (s[p] - cy) * 1.2);
        return out;
    }
    function applyFx(kind, ss) {
        const snap = snapshot(), fx = FX.find(f => f[0] === kind), as = anims(), a = newAnim(uniqueName(fx[4], as.map(x => x.name))), skipped = [];
        const track = (s, p, keys) => {
            const o = trackOf(s.id, p); if (o) { skipped.push(`«${propName(s, p)}» у «${s.name}» (в «${o.a.name}»)`); return; }
            const tr = { id: s.id, p, keys: [] }; tr.keys = keys.map(([t, v, e, pc]) => newKey(tr, t, v, pc, e)); a.tracks.push(tr);
        };
        if (kind === 'blink') for (const s of ss) track(s, 'vis', [[0, 1], [500, 0]]);
        if (kind === 'pulse') for (const s of ss) for (const [p, v] of Object.entries(pulsed(s))) track(s, p, [[0, s[p]], [500, v], [1000, s[p]]]);
        if (kind === 'pulsec') for (const s of ss) for (const p of animProps(s).filter(COLOR_P)) { const [c, pc] = getP(s, p); track(s, p, [[0, c, 'inout', pc], [500, mix565(c, 0xFFFF, 512)], [1000, c, 'inout', pc]]); }
        if (kind === 'marquee') {
            let dur = 1000;
            for (const s of ss) {
                const was = JSON.stringify(s); s.scroll = true; s.sx = 0; s.align = 'left';
                const tw = Math.max(1, measureStr(s.font, s.size, wrapText(s)[0] || '').w); dur = Math.max(dur, Math.round((s.w + tw) * 1000 / 40));
                track(s, 'sx', [[0, s.w, 'linear'], [dur, -tw, 'linear']]); if (!a.tracks.some(tr => tr.id === s.id)) Object.assign(s, JSON.parse(was));
            }
            a.dur = dur; for (const tr of a.tracks) tr.keys[1].t = dur; // texts of different length: all keys at the end of the longest
        }
        if (kind === 'spin') {
            const box = ss.length > 1 ? boxOf(S.sel) : null;
            for (const s of ss) {
                if (trackOf(s.id, 'rot')) { track(s, 'rot', []); continue; }
                enableRot(s); if (box) { s.ox = box[0] + ((box[2] - 1) >> 1); s.oy = box[1] + ((box[3] - 1) >> 1); }
                track(s, 'rot', [[0, s.rot, 'linear'], [1000, s.rot + 360, 'linear']]);
            }
        }
        if (kind === 'bar') {
            Object.assign(a, { mode: 'value', lo: 0, hi: 100, follow: 300 });
            for (const s of ss) {
                if (s.h > s.w) { track(s, 'y', [[0, s.y + s.h, 'linear'], [1000, s.y, 'linear']]); track(s, 'h', [[0, 0, 'linear'], [1000, s.h, 'linear']]); } // a tall bar fills from the bottom
                else track(s, 'w', [[0, 0, 'linear'], [1000, s.w, 'linear']]);
            }
        }
        if (skipped.length) flash('Уже анимируется в другой анимации, пропущено: ' + skipped.join(', ') + '.');
        if (!a.tracks.length) { restore(snap); update(); return; }
        push('', snap); as.push(a); stopPlay(); AN.k = as.length - 1; AN.t = 0; AN.sel = []; animBase = new Map(); update();
    }
    function bindTextInspector(s, i) {
        const ta = document.getElementById('insText');
        ta.addEventListener('input', () => { push('txt' + i); s.text = ta.value; textWarn(s); update(true); });
        document.getElementById('insFont').onchange = e => {
            push(); const wasBuiltin = !s.font; s.font = e.target.value; S.textFont = s.font;
            if (s.font && wasBuiltin && s.size > 1) { s.size = 1; S.textSize = 1; } else if (!s.font && !wasBuiltin && s.size === 1) { s.size = 2; S.textSize = 2; }
            update();
        };
        document.getElementById('insSize').addEventListener('input', e => { const v = Math.max(1, Math.min(10, +e.target.value | 0)); if (!e.target.value) return; push('sz' + i); s.size = v; S.textSize = v; textWarn(s); update(true); });
        document.getElementById('insAlign').onclick = e => { const b = e.target.closest('button'); if (!b) return; push(); s.align = b.dataset.v; update(); };
        document.getElementById('insVAlign').onclick = e => { const b = e.target.closest('button'); if (!b) return; push(); s.valign = b.dataset.v; update(); };
        document.getElementById('fitH').onclick = () => { push(); s.h = Math.max(1, s.var ? textBounds(s.font, s.size, varText(s)).h : fontMetrics(s.font, s.size).block(Math.max(1, wrapText(s).length))); update(); };
        document.getElementById('insVar').onchange = e => {
            push();
            if (e.target.checked) { s.var = uniqueVar('text', new Set(S.screens.flatMap(x => x.shapes.map(t => t.var)).filter(Boolean))); s.erase = 'bg'; s.ec = S.bg; s.text = (s.text || '').replace(/\n/g, ' '); delete s.scroll; delete s.sx; }
            else for (const k of ['var', 'erase', 'ec', 'epc']) delete s[k];
            update();
        };
        const sc = document.getElementById('insScroll');
        if (sc) sc.onchange = () => { push(); if (sc.checked) { s.scroll = true; s.sx = 0; } else { delete s.scroll; delete s.sx; } update(); };
        const vid = document.getElementById('insVarId');
        if (vid) vid.onchange = () => { const v = lead(vid.value.trim().replace(/[^A-Za-z0-9_]/g, '_')); if (v && v !== s.var) { push(); s.var = v; } update(); };
        const er = document.getElementById('insErase');
        if (er) er.onclick = e => { const b = e.target.closest('button'); if (!b) return; push(); s.erase = b.dataset.v; if (s.ec == null) s.ec = S.bg; update(); };
        const ec = document.getElementById('insEc');
        if (ec) ec.addEventListener('input', () => { push('ec' + i); s.ec = to565(ec.value); delete s.epc; update(true); });
        const epc = document.getElementById('insEpc');
        if (epc) epc.onchange = () => { push(); if (epc.value) s.epc = epc.value; else delete s.epc; update(); };
        textWarn(s);
    }
    insBody.addEventListener('click', e => { const b = e.target.closest('[data-al],[data-sal]'); if (!b) return; b.dataset.al ? alignScreen(b.dataset.al) : alignSel(b.dataset.sal); });
    // the whole selection moves as one block
    function alignScreen(k) {
        const b = boxOf(S.sel); if (!b) return;
        const [x, y, w, h] = b; let dx = 0, dy = 0;
        if (k === 'l') dx = -x; if (k === 'r') dx = S.W - w - x; if (k === 'cx' || k === 'c') dx = Math.round((S.W - w) / 2) - x;
        if (k === 't') dy = -y; if (k === 'b') dy = S.H - h - y; if (k === 'cy' || k === 'c') dy = Math.round((S.H - h) / 2) - y;
        if (!dx && !dy) return; push(); shiftSel(S.sel, dx, dy); update();
    }
    // align / distribute the selected objects (a whole group is one object) within the selection box
    function alignSel(k) {
        const ns = selNodes().map(n => { const idx = nodeIdx(n); return { idx, b: boxOf(idx) }; }); if (ns.length < 2) return;
        const [X, Y, W, H] = boxOf(S.sel), moves = [];
        if (k === 'dh' || k === 'dv') {
            if (ns.length < 3) return;
            const hz = k === 'dh', a = hz ? 0 : 1, sz = hz ? 2 : 3, start = hz ? X : Y, span = hz ? W : H;
            ns.sort((p, q) => p.b[a] - q.b[a] || p.b[sz] - q.b[sz]);
            const gap = (span - ns.reduce((t, n) => t + n.b[sz], 0)) / (ns.length - 1); let acc = 0;
            ns.forEach((n, j) => { const t = Math.round(start + acc + j * gap); acc += n.b[sz]; moves.push([n.idx, hz ? t - n.b[0] : 0, hz ? 0 : t - n.b[1]]); });
        } else ns.forEach(n => {
            const [x, y, w, h] = n.b; let dx = 0, dy = 0;
            if (k === 'l') dx = X - x; if (k === 'r') dx = X + W - w - x; if (k === 'cx') dx = X + Math.round((W - w) / 2) - x;
            if (k === 't') dy = Y - y; if (k === 'b') dy = Y + H - h - y; if (k === 'cy') dy = Y + Math.round((H - h) / 2) - y;
            moves.push([n.idx, dx, dy]);
        });
        if (!moves.some(m => m[1] || m[2])) return; push(); for (const [idx, dx, dy] of moves) shiftSel(idx, dx, dy); update();
    }
    insBtns.addEventListener('click', e => { const b = e.target.closest('button'); if (b) act(b.dataset.a); });
    function act(a) {
        if (!S.sel.length) return;
        if (a === 'del') { push(); delSel(); }
        if (a === 'dup') return dupSel();
        if (a === 'up') return stepSel(1);
        if (a === 'down') return stepSel(-1);
        if (a === 'group') { push(); groupSel(); }
        if (a === 'ungroup') { const snap = snapshot(); if (ungroupSel()) push('', snap); }
        update();
    }
    // internal clipboard (Ctrl/⌘+C, X, V): each paste of a copy goes +5/+5 further; after a cut the first paste lands in place
    let clip = null, clipN = 0;
    function copySel(cut) {
        if (!S.sel.length) return false;
        clip = JSON.stringify(clipSel()); clipN = cut ? -1 : 0; clipText = selectionCode();
        if (cut) { push(); delSel(); update(); }
        return true;
    }
    function paste() {
        if (!clip) return false;
        push(); clipN++; const at = S.sel.length ? Math.max(...S.sel) + 1 : S.shapes.length, parent = S.sel.length ? commonParent(selNodes()) : null;
        insertPiece(JSON.parse(clip), 5 * clipN, at, parent); S.tool = 'select'; triPts = null; preview = null; update();
        return true;
    }

    // layers: topmost first, groups fold; click selects, Shift+click adds, double click renames, drag reorders
    const layersEl = document.getElementById('layers');
    const EYE = '<svg viewBox="0 0 20 20"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="2.3" fill="currentColor"/></svg>';
    const EYE_OFF = '<svg viewBox="0 0 20 20"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 16.5l13-13" stroke="currentColor" stroke-width="1.5"/></svg>';
    const LOCK = '<svg viewBox="0 0 20 20"><rect x="4.5" y="9" width="11" height="8" rx="1.5" fill="currentColor"/><path d="M7 9V6.5a3 3 0 016 0V9" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    const UNLOCK = '<svg viewBox="0 0 20 20"><rect x="4.5" y="9" width="11" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7 9V6.5a3 3 0 015.8-1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    let layersSig = '';
    function renderLayers() {
        if (layersEl.querySelector('input')) return; // rename in progress
        const sel = new Set(S.sel), rows = [];
        const row = (key, d, on, off, fold, ic, name, hid, lck) => ({
            on, html: `<div class="ly${off ? ' off' : ''}" ${key} draggable="true" style="padding-left:${4 + d * 14}px"><span class="ly-caret">${fold}</span><svg class="ly-ic" viewBox="0 0 24 24">${ic}</svg><span class="ly-name">${esc(name || '')}</span>`
                + `<button class="ly-b${hid ? ' act' : ''}" data-act="eye" title="${hid ? 'Показать' : 'Скрыть'}" aria-label="${hid ? 'Показать' : 'Скрыть'}">${hid ? EYE_OFF : EYE}</button>`
                + `<button class="ly-b${lck ? ' act' : ''}" data-act="lock" title="${lck ? 'Разблокировать' : 'Заблокировать'}" aria-label="${lck ? 'Разблокировать' : 'Заблокировать'}">${lck ? LOCK : UNLOCK}</button></div>`
        });
        (function walk(n, d) {
            for (let k = n.kids.length - 1; k >= 0; k--) {
                const c = n.kids[k];
                if (c.i != null) { const s = S.shapes[c.i]; rows.push(row(`data-i="${c.i}"`, d, sel.has(c.i), hiddenAt(c.i), '', ICONS[s.t], s.name, s.hidden, s.locked)); continue; }
                const g = c.g, m = nodeIdx(c);
                rows.push(row(`data-g="${c.id}"`, d, m.every(i => sel.has(i)), hiddenAt(m[0]), `<button class="ly-tw" data-act="fold" aria-label="${g.collapsed ? 'Развернуть' : 'Свернуть'}">${g.collapsed ? '▸' : '▾'}</button>`, ICONS.group, g.name, g.hidden, g.locked));
                if (!g.collapsed) walk(c, d + 1);
            }
        })(buildTree(), 0);
        // same rows → only flip the highlight, so clicks and double clicks land on stable elements
        const sig = rows.map(r => r.html).join('');
        if (sig !== layersSig || layersEl.children.length !== rows.length) { layersSig = sig; layersEl.innerHTML = sig || '<div class="empty">Слоёв пока нет.</div>'; if (!rows.length) layersSig = ''; }
        rows.forEach((r, k) => layersEl.children[k] && layersEl.children[k].classList.toggle('on', r.on));
    }
    const rowObj = r => r.dataset.i != null ? S.shapes[+r.dataset.i] : gById(+r.dataset.g);
    const rowNode = (r, tree) => r.dataset.i != null ? { i: +r.dataset.i } : findNode(k => k.id === +r.dataset.g, tree);
    layersEl.addEventListener('click', e => {
        const r = e.target.closest('.ly'); if (!r) return; const b = e.target.closest('[data-act]'), obj = rowObj(r);
        if (b) {
            const a = b.dataset.act;
            if (a === 'fold') { obj.collapsed = !obj.collapsed; if (!obj.collapsed) delete obj.collapsed; update(); return; }
            push(); const k = a === 'eye' ? 'hidden' : 'locked'; if (obj[k]) delete obj[k]; else obj[k] = true; update(); return;
        }
        const idx = r.dataset.i != null ? [+r.dataset.i] : groupMembers(+r.dataset.g);
        if (e.shiftKey) { const all = idx.every(i => S.sel.includes(i)); setSel(all ? S.sel.filter(i => !idx.includes(i)) : S.sel.concat(idx)); }
        else setSel(idx);
        S.tool = 'select'; update();
    });
    layersEl.addEventListener('dblclick', e => {
        const nm = e.target.closest('.ly-name'); if (!nm) return; const obj = rowObj(nm.closest('.ly'));
        const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'ly-in'; inp.value = obj.name || ''; inp.setAttribute('aria-label', 'Имя');
        nm.replaceWith(inp); inp.focus(); inp.select();
        let done = false;
        const fin = ok => { if (done) return; done = true; const v = inp.value.trim(); if (ok && v && v !== obj.name) { push(); obj.name = v; } inp.remove(); layersSig = ''; update(); };
        inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') fin(true); if (ev.key === 'Escape') fin(false); });
        inp.addEventListener('blur', () => fin(true));
    });
    let dragRow = null;
    const dropWhere = (r, e) => { const b = r.getBoundingClientRect(), f = (e.clientY - b.top) / b.height; return r.dataset.g != null && f > .25 && f < .75 ? 'into' : f < .5 ? 'above' : 'below'; };
    const clearDrop = () => layersEl.querySelectorAll('.drop-above,.drop-below,.drop-into').forEach(x => x.classList.remove('drop-above', 'drop-below', 'drop-into'));
    layersEl.addEventListener('dragstart', e => { const r = e.target.closest('.ly'); if (!r) return; dragRow = r; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ''); });
    layersEl.addEventListener('dragover', e => { const r = e.target.closest('.ly'); if (!dragRow || !r) return; e.preventDefault(); clearDrop(); r.classList.add('drop-' + dropWhere(r, e)); });
    layersEl.addEventListener('dragleave', e => { if (!layersEl.contains(e.relatedTarget)) clearDrop(); });
    layersEl.addEventListener('dragend', () => { dragRow = null; clearDrop(); });
    layersEl.addEventListener('drop', e => {
        const r = e.target.closest('.ly'); clearDrop(); if (!dragRow || !r) return; e.preventDefault();
        const tree = buildTree(), node = rowNode(dragRow, tree), ref = rowNode(r, tree), snap = snapshot(); dragRow = null;
        if (node && ref && moveBlock(node, ref, dropWhere(r, e))) { push('', snap); update(); }
    });

    // code
    const codeEl = document.getElementById('code');
    function esc(t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
    const escA = t => esc(t).replace(/"/g, '&quot;');
    function hl(t) {
        if (/^\s*\/\//.test(t)) return `<span class="t-c">${esc(t)}</span>`;
        return esc(t).replace(/("(?:\\.|[^"\\])*")|(\/\/.*)$|\b(0x[0-9A-Fa-f]+|\d+)\b|(\b(?:canvas|lcd)\b(?:\.|-&gt;)\w+)/g, (m, q, c, n, f) => q ? `<span class="t-s">${q}</span>` : c ? `<span class="t-c">${c}</span>` : n ? `<span class="t-n">${n}</span>` : `<span class="t-fn">${f}</span>`);
    }
    // C++ names from element names: Russian is transliterated; constants UPPER_SNAKE, arrays lower_snake, functions drawPascal
    const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
    const words = n => [...String(n).toLowerCase()].map(ch => TR[ch] ?? ch).join('').split(/[^a-z0-9]+/).filter(Boolean);
    const lead = id => /^\d/.test(id) ? '_' + id : id;
    const upperId = n => lead(words(n).join('_').toUpperCase() || 'ITEM');
    const snakeId = n => lead(words(n).join('_') || 'image');
    const pascalId = n => lead(words(n).map(w => w[0].toUpperCase() + w.slice(1)).join('') || 'Screen');
    const varFn = id => 'draw' + id[0].toUpperCase() + id.slice(1);
    // only names the user gave count as names: «Прямоугольник 3» / «Группа 2» stay out of the code
    const customName = s => !!s.name && !new RegExp('^' + META[s.t].name + ' \\d+$').test(s.name);
    const customGroup = g => !!g.name && !/^Группа \d+$/.test(g.name);
    const FIELDS = { rect: ['x', 'y', 'w', 'h'], rrect: ['x', 'y', 'w', 'h', 'r'], text: ['x', 'y', 'w', 'h'], img: ['x', 'y', 'w', 'h'], circle: ['x', 'y', 'r'], line: ['x0', 'y0', 'x1', 'y1'], tri: ['x0', 'y0', 'x1', 'y1', 'x2', 'y2'], pixel: ['x', 'y'] };
    const bgExpr = sc => sc.bgPc && palEntry(sc.bgPc) ? sc.bgPc : fmt565(sc.bg);

    // every C++ name of the sketch, allocated in one pass so they stay unique: screen functions, constant prefixes, arrays, changing-text functions
    // anim: the whole sketch — animated properties become lcbKey(…) of their key arrays; without it every value is the shown frame
    // mgr: the whole sketch with several screens — the screen manager (enum Screen, goTo, lcbTick) instead of tick<Screen>()
    function plan(anim) {
        const used = new Set(['W', 'H', 'canvas', 'lcd', 'present', 'setup', 'loop', 'lcbNow', 'goTo', 'lcbTick', 'Screen', ...S.palette.map(p => p.n)]);
        const take = (base, sep = '_') => { let n = base, k = 2; while (used.has(n)) n = base + sep + k++; used.add(n); return n; };
        const P = { fns: S.screens.map(sc => take('draw' + pascalId(sc.name), '')), shapes: new Map(), vis: [], mgr: !!anim && S.screens.length > 1 && S.mgr !== false };
        P.scr = P.mgr ? S.screens.map(sc => take('SCR_' + upperId(sc.name))) : [];
        S.screens.forEach((sc, k) => withScreen(k, () => { // frames of shapes are drawn on their own screen's background
            const vis = S.shapes.filter((_, i) => !hiddenAt(i)); P.vis.push(vis);
            for (const s of vis) {
                const e = {};
                if (S.coordConsts && customName(s) && s.t !== 'chart') e.pre = take(upperId(s.name));
                // a chart: its data array, push<Id>(v) and draw<Id>Chart()
                if (s.t === 'chart') { const id = s.var[0].toUpperCase() + s.var.slice(1); e.arr = take(s.var + 'Data'); e.push = take('push' + id, ''); e.fn = take('draw' + id + 'Chart', ''); }
                if (s.t === 'img') { e.arr = take(snakeId(s.name)); const d = imgData(s); if (d && d.mask && s.mode !== 'icon') e.mask = take(e.arr + '_mask'); }
                // a sprite: one array per frame (sprite_1, sprite_2, …) and, in colour with holes, a mask for each
                if (s.t === 'sprite') { e.arr = take(snakeId(s.name)); e.frames = s.frames.map((_, n) => take(`${e.arr}_${n + 1}`)); if (spriteMasked(s)) e.masks = e.frames.map(n => take(n + '_mask')); }
                if (s.t === 'text' && s.var) e.fn = take(varFn(s.var), '');
                P.shapes.set(s, e);
            }
        }));
        // animations: anim<Name> state, start<Name>() / set<Name>(v), t<Name> local time, tick<Screen>(now), <anim>_<shape>_<prop> key arrays
        P.anim = !!anim; P.anims = S.screens.map(() => []); P.ticks = S.screens.map(() => '');
        if (anim) S.screens.forEach((sc, k) => {
            if (!sc.anims.length) return;
            const vis = new Map(P.vis[k].map(s => [s.id, s]));
            P.ticks[k] = P.mgr ? '' : take('tick' + pascalId(sc.name), '');
            for (const a of sc.anims) {
                const N = pascalId(a.name), A = { a, v: take('anim' + N, ''), fn: a.mode === 'once' ? take('start' + N, '') : a.mode === 'value' ? take('set' + N, '') : '', tv: take('t' + N, ''), tracks: [] };
                for (const tr of a.tracks) {
                    const s = vis.get(tr.id), e = s && P.shapes.get(s); if (!e) continue; // hidden shapes are not in the sketch
                    const T = { arr: take(`${snakeId(a.name)}_${snakeId(s.name)}_${tr.p === 'c' || tr.p[0] !== 'g' ? tr.p : 'g' + (s.grad.stops.findIndex(st => 'g' + st.id === tr.p) + 1)}`), tv: A.tv, tr, s };
                    (e.anim = e.anim || {})[tr.p] = T; A.tracks.push(T);
                    // an animated frame number picks the frame from tables of pointers: sprite_frames[f], sprite_masks[f]
                    if (tr.p === 'f') { e.tab = take(e.arr + '_frames'); if (e.masks) e.mtab = take(e.arr + '_masks'); }
                }
                P.anims[k].push(A);
            }
            // a changing text on an animated screen keeps its value: every frame redraws the whole screen
            if (!P.mgr) for (const s of P.vis[k]) if (s.t === 'text' && s.var) P.shapes.get(s).val = take(s.var + 'Value');
        });
        // with the manager every screen is redrawn when it is shown again, so every changing text keeps its value
        if (P.mgr) P.vis.forEach(v => { for (const s of v) if (s.t === 'text' && s.var) P.shapes.get(s).val = take(s.var + 'Value'); });
        return P;
    }
    // a coordinate: the number, or NAME_X when the element has constants
    const V = (s, e, k) => e && e.anim && e.anim[k] ? `lcbKey(${e.anim[k].arr}, ${e.anim[k].tv})` : e && e.pre && FIELDS[s.t].includes(k) ? `${e.pre}_${k.toUpperCase()}` : String(s[k]);
    // a property that is not a coordinate (angle, pivot, opacity, scroll shift, frame): its key array or its value
    const animated = (e, p) => !!(e && e.anim && e.anim[p]);
    const VA = (s, e, k) => animated(e, k) ? `lcbKey(${e.anim[k].arr}, ${e.anim[k].tv})` : String(k === 'o' ? opaOf(s) : s[k] | 0);
    // a + b as C++: folded when both are numbers
    const isNum = t => /^-?\d+$/.test(String(t));
    const addE = (a, b) => isNum(a) && isNum(b) ? String(+a + +b) : isNum(b) ? plus(String(a), +b) : `${a} + ${b}`;
    const halfE = t => isNum(t) ? String(Math.trunc(+t / 2)) : `${t} / 2`;
    const opaOn = (s, e) => opaOf(s) < 255 || animated(e, 'o');
    // turned on the board: a set angle, or an animated one (then also at 0°, which gives the same pixels as the plain call)
    const rotOn = (s, e) => canRot(s) && s.rot != null && (s.rot % 360 !== 0 || animated(e, 'rot'));
    // the colour: a palette name, a literal, or the colour key array of the animation
    const colE = (s, e, p = 'c') => e && e.anim && e.anim[p] ? `lcbKeyC(${e.anim[p].arr}, ${e.anim[p].tv})` : colStr(s);
    // a position derived from x / y (text lines): relative to the coordinate when that is a name or an animated value
    const at = (s, e, k, v) => e && (e.pre || (e.anim && e.anim[k])) ? plus(V(s, e, k), v - s[k]) : v;
    const plus = (base, d) => d ? `${base} ${d < 0 ? '-' : '+'} ${Math.abs(d)}` : base;
    function codeLine(s, e) {
        const c = colE(s, e), p = s.fill ? 'fill' : 'draw', v = k => V(s, e, k);
        switch (s.t) {
            case 'rect': return `canvas.${p}Rect(${v('x')}, ${v('y')}, ${v('w')}, ${v('h')}, ${c});`;
            case 'rrect': return `canvas.${p}RoundRect(${v('x')}, ${v('y')}, ${v('w')}, ${v('h')}, ${v('r')}, ${c});`;
            case 'circle': return `canvas.${p}Circle(${v('x')}, ${v('y')}, ${v('r')}, ${c});`;
            case 'line': return `canvas.drawLine(${v('x0')}, ${v('y0')}, ${v('x1')}, ${v('y1')}, ${c});`;
            case 'tri': return `canvas.${p}Triangle(${v('x0')}, ${v('y0')}, ${v('x1')}, ${v('y1')}, ${v('x2')}, ${v('y2')}, ${c});`;
            case 'pixel': return `canvas.drawPixel(${v('x')}, ${v('y')}, ${c});`;
        }
    }
    // a picture or a sprite: drawBitmap / drawRGBBitmap, through lcb… with a gradient or opacity, lcbRot…Bitmap when turned;
    // a sprite's array is its frame f, or sprite_frames[f] while f is animated
    function picCode(s, e) {
        const v = k => V(s, e, k), icon = s.mode === 'icon', lcb = usesLcb(s, e), rot = rotOn(s, e);
        let bmp = e.arr, mask = e.mask;
        if (s.t === 'sprite') {
            if (animated(e, 'f') && e.tab) { const f = VA(s, e, 'f'); bmp = `${e.tab}[${f}]`; mask = e.mtab ? `${e.mtab}[${f}]` : null; }
            else { const f = frameIdx(s); bmp = e.frames[f]; mask = e.masks ? e.masks[f] : null; }
        }
        const xy = `${v('x')}, ${v('y')}`, wh = `${v('w')}, ${v('h')}`, R = rot ? `, ${VA(s, e, 'ox')}, ${VA(s, e, 'oy')}, ${VA(s, e, 'rot')}` : '';
        if (icon) {
            if (lcb) return lcbWrap(s, e, P => [rot ? `lcbRotBitmap(${xy}, ${bmp}, ${wh}, ${P}${R});` : `lcbDrawBitmap(${xy}, ${bmp}, ${wh}, ${P});`]);
            return [rot ? `lcbRotBitmap(${xy}, ${bmp}, ${wh}, ${colE(s, e)}${R});` : `canvas.drawBitmap(${xy}, ${bmp}, ${wh}, ${colE(s, e)});`];
        }
        if (rot) return [`lcbRotRGBBitmap(${xy}, ${bmp}, ${mask || 'nullptr'}, ${wh}${R});`];
        if (lcb) return [`lcbDrawRGBBitmap(${xy}, ${bmp}, ${mask || 'nullptr'}, ${wh});`]; // opacity
        return [`canvas.drawRGBBitmap(${xy}, ${bmp}, ${mask ? mask + ', ' : ''}${wh});`];
    }
    // a turned shape: its points go through lcbRot(x, y, ox, oy, angle) on the board, then the usual call draws them;
    // a rectangle becomes its four corners (two triangles / four lines, lcbFillQuad / lcbDrawQuad with a gradient)
    function rotCode(s, e) {
        const v = k => V(s, e, k), R = (x, y) => `lcbRot(${x}, ${y}, ${VA(s, e, 'ox')}, ${VA(s, e, 'oy')}, ${VA(s, e, 'rot')})`;
        // the same shape with every coordinate already an expression; the turned ones become p….x / p….y
        const r = { ...s }, e2 = { ...e, pre: undefined, anim: e && e.anim ? Object.fromEntries(Object.entries(e.anim).filter(([k]) => !FIELDS[s.t].includes(k))) : undefined };
        for (const k of FIELDS[s.t]) r[k] = v(k);
        let pts, body;
        const call = () => usesLcb(s, e) ? lcbWrap(r, e2, P => [lcbCall(r, e2, P)]) : [codeLine(r, e2)];
        if (s.t === 'line' || s.t === 'tri') {
            pts = (s.t === 'line' ? [0, 1] : [0, 1, 2]).map(n => [`p${n}`, r['x' + n], r['y' + n]]);
            for (const [n] of pts) { r['x' + n[1]] = n + '.x'; r['y' + n[1]] = n + '.y'; }
            body = call();
        } else if (s.t === 'circle' || s.t === 'pixel') { pts = [['p', r.x, r.y]]; r.x = 'p.x'; r.y = 'p.y'; body = call(); }
        else if (s.t === 'rrect') { pts = [['p', addE(r.x, halfE(r.w)), addE(r.y, halfE(r.h))]]; r.x = isNum(r.w) ? plus('p.x', -Math.trunc(+r.w / 2)) : `p.x - ${r.w} / 2`; r.y = isNum(r.h) ? plus('p.y', -Math.trunc(+r.h / 2)) : `p.y - ${r.h} / 2`; body = call(); }
        else { // rect: corners TL, TR, BR, BL
            const x1 = addE(addE(r.x, r.w), -1), y1 = addE(addE(r.y, r.h), -1);
            pts = [['p0', r.x, r.y], ['p1', x1, r.y], ['p2', x1, y1], ['p3', r.x, y1]];
            const P = n => `p${n}.x, p${n}.y`, c = colE(s, e);
            if (usesLcb(s, e)) body = lcbWrap(r, e2, Pt => [`lcb${s.fill ? 'Fill' : 'Draw'}Quad(${P(0)}, ${P(1)}, ${P(2)}, ${P(3)}, ${Pt});`]);
            else body = s.fill ? [`canvas.fillTriangle(${P(0)}, ${P(1)}, ${P(2)}, ${c});`, `canvas.fillTriangle(${P(0)}, ${P(2)}, ${P(3)}, ${c});`]
                : [[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b]) => `canvas.drawLine(${P(a)}, ${P(b)}, ${c});`);
        }
        return [`{ const LcbPt ${pts.map(([n, x, y]) => `${n} = ${R(x, y)}`).join(', ')};`, ...body.map((l, k, a) => '  ' + l + (k === a.length - 1 ? ' }' : ''))];
    }
    // an animated text: every key's text is laid out by the editor, a switch picks the one of the moment
    // a scrolling text: one line moved by sx, cut by its box (lcbClip … lcbNoClip)
    function textCode(s, st, e) {
        const tt = e && e.anim && e.anim.text, texts = tt ? tt.tr.keys.map(k => k.v) : [s.text || ''], sc = scrolls(s);
        const lit = t => { const q = `"${cstr(t)}"`; return FONT_DATA[s.font] && FONT_DATA[s.font].cp && /[^\x00-\x7F]/.test(t) ? `cp1251(${q})` : q; };
        const cases = line => texts.map(t => layoutText({ ...s, text: t }).flatMap(l => line(sc ? addE(at(s, e, 'x', l.cx), VA(s, e, 'sx')) : at(s, e, 'x', l.cx), at(s, e, 'y', l.cy), lit(l.t))));
        const pick = cs => tt ? [`switch (lcbKey(${tt.arr}, ${tt.tv})) {`, ...cs.flatMap((c, k) => [`  case ${k}:  // «${texts[k].replace(/\n/g, ' ')}»`, ...c.map(l => '    ' + l), '    break;']), '}'] : cs[0];
        if (usesLcb(s, e)) { // gradient / smooth / see-through / scrolling text: drawn by lcbText, the canvas text settings are left alone
            if (cases(() => ['']).every(c => !c.length)) return [];
            const body = lcbWrap(s, e, P => pick(cases((cx, cy, q) => [lcbTextCall(s, e, P, cx, cy, q)])));
            return sc ? [`lcbClip(${V(s, e, 'x')}, ${V(s, e, 'y')}, ${V(s, e, 'w')}, ${V(s, e, 'h')});  // бегущая строка: только внутри рамки`, ...body, 'lcbNoClip();'] : body;
        }
        const out = [], col = colE(s, e);
        if (!st.wrap) { out.push('canvas.setTextWrap(false);  // переносы уже посчитаны редактором'); st.wrap = true; }
        if (st.font !== s.font) { out.push(s.font ? `canvas.setFont(&${s.font});` : 'canvas.setFont();  // встроенный 5×7'); st.font = s.font; }
        if (st.size !== s.size) { out.push(`canvas.setTextSize(${s.size});`); st.size = s.size; }
        if (st.color !== col) { out.push(`canvas.setTextColor(${col});`); st.color = col; }
        return [...out, ...pick(cases((cx, cy, q) => [`canvas.setCursor(${cx}, ${cy});`, `canvas.print(${q});`]))];
    }
    function shapeCode(s, e, st) {
        // the function sets font, size and colour itself, so the next static text must set them again
        if (s.t === 'chart') return [`${e.fn}();`];
        if (s.t === 'text' && s.var) { st.font = st.size = undefined; st.color = null; return [e.val ? `${e.fn}(${e.val}.c_str());` : `${e.fn}("${cstr(varText(s))}");`]; }
        const lines = s.t === 'text' ? textCode(s, st, e) : isPic(s) ? picCode(s, e) : rotOn(s, e) ? rotCode(s, e) : usesLcb(s, e) ? lcbWrap(s, e, P => [lcbCall(s, e, P)]) : [codeLine(s, e)];
        // see-through: lcbOpacity() for the shape's pixels, then back to opaque
        return opaOn(s, e) && lines.length ? [`lcbOpacity(${VA(s, e, 'o')});`, ...lines, 'lcbOpacity(255);'] : lines;
    }
    // drawing lines of screen k in draw order; named elements and groups get a «// name» comment; i/k point back at the shape
    function screenLines(k, P, unknown) {
        return withScreen(k, () => {
            const st = unknown ? { font: undefined, size: undefined, color: null, wrap: false } : { font: '', size: 1, color: null, wrap: false }, out = [];
            (function walk(n) {
                for (const c of n.kids) {
                    if (c.i == null) { if (nodeIdx(c).every(hiddenAt)) continue; if (customGroup(c.g)) out.push({ t: '// ' + c.g.name, i: -1, k }); walk(c); continue; }
                    const s = S.shapes[c.i], e = P.shapes.get(s); if (hiddenAt(c.i) || (!P.anim && s.vis === 0)) continue; // vis 0: off in the shown frame
                    if (customName(s)) out.push({ t: '// ' + s.name, i: c.i, k });
                    let lines = shapeCode(s, e, st); const vt = e && e.anim && e.anim.vis;
                    // shown only while its visibility key says so; text settings made inside may not have happened
                    if (vt) { lines = [`if (lcbKey(${vt.arr}, ${vt.tv})) {`, ...lines.map(l => '  ' + l), '}']; Object.assign(st, { font: undefined, size: undefined, color: null, wrap: false }); }
                    for (const t of lines) out.push({ t, i: c.i, k });
                }
            })(buildTree());
            return out;
        });
    }
    const constLines = (vis, P) => vis.flatMap(s => { const e = P.shapes.get(s); return e.pre ? FIELDS[s.t].filter(f => !(e.anim && e.anim[f])).map(f => `constexpr int ${e.pre}_${f.toUpperCase()} = ${s[f]};`) : []; });
    // PROGMEM arrays of a picture; data rows are marked so the panel can fold them
    const arrCache = new Map();
    function imgArrayLines(s, e) {
        if (s.t === 'sprite') return spriteArrayLines(s, e);
        const d = imgData(s); if (!d) return [{ t: `// ${s.name}: картинка ещё загружается` }];
        return arrayLines(s, d, s.src, e.arr, e.mask, s.name);
    }
    function arrayLines(s, d, srcKey, arr, mask, title) {
        const key = [srcKey, s.w, s.h, s.mode, s.scale, s.thr, s.inv, arr, mask, title].join('|'); let r = arrCache.get(key); if (r) return r;
        const rows = (vals, per, n) => { const o = []; for (let k = 0; k < vals.length; k += per) o.push({ t: '  ' + Array.from(vals.slice(k, k + per), v => '0x' + v.toString(16).toUpperCase().padStart(n, '0')).join(', ') + ',', data: true }); return o; };
        const icon = s.mode === 'icon';
        r = [{ t: `// ${title}: ${s.w}×${s.h}, ${icon ? '1 бит на пиксель, для drawBitmap' : 'RGB565, для drawRGBBitmap' + (mask ? ' + маска прозрачности' : '')}` }];
        if (icon) r.push({ t: `const uint8_t ${arr}[] PROGMEM = {` }, ...rows(d.bits, 16, 2), { t: '};' });
        else {
            r.push({ t: `const uint16_t ${arr}[] PROGMEM = {` }, ...rows(d.px, 12, 4), { t: '};' });
            if (mask) r.push({ t: `const uint8_t ${mask}[] PROGMEM = {` }, ...rows(d.mask || new Uint8Array(((s.w + 7) >> 3) * s.h).fill(0xFF), 16, 2), { t: '};' }); // a frame without holes: a full mask
        }
        if (arrCache.size > 256) arrCache.clear(); arrCache.set(key, r); return r;
    }
    // every frame as a picture; with an animated frame number also the tables the sketch indexes by it
    function spriteArrayLines(s, e) {
        const out = [];
        s.frames.forEach((fr, k) => {
            const d = frameData(s, k), title = `${s.name}, кадр ${k + 1} из ${s.frames.length}`;
            if (!d) { out.push({ t: `// ${title}: ещё загружается` }); return; }
            out.push(...arrayLines(s, d, fr.src || `${S.bg}|${JSON.stringify(fr.shapes)}`, e.frames[k], e.masks && e.masks[k], title), { t: '' });
        });
        const type = s.mode === 'icon' ? 'uint8_t' : 'uint16_t';
        if (e.tab) out.push({ t: `// кадры «${s.name}» по номеру — для анимации` }, { t: `const ${type}* const ${e.tab}[] = { ${e.frames.join(', ')} };` });
        if (e.mtab) out.push({ t: `const uint8_t* const ${e.mtab}[] = { ${e.masks.join(', ')} };` });
        if (out.length && out[out.length - 1].t === '') out.pop();
        return out;
    }
    // void drawTemp(const char* value): erase the block, set the style, place the value by getTextBounds and the block alignment
    function varFnLines(s, e, bg) {
        const v = k => V(s, e, k), x = v('x'), y = v('y'), w = v('w'), h = v('h');
        const er = s.erase === 'color' ? (s.epc && palEntry(s.epc) ? s.epc : fmt565(s.ec)) : bg;
        const cx = s.align === 'center' ? `${x} + (${w} - bw) / 2 - bx` : s.align === 'right' ? `${x} + ${w} - bw - bx` : `${x} - bx`;
        const cy = s.valign === 'middle' ? `${y} + (${h} - bh) / 2 - by` : s.valign === 'bottom' ? `${y} + ${h} - bh - by` : `${y} - by`;
        const lcb = usesLcb(s, e), o = opaOf(s);
        return [`// меняющийся текст «${s.var}»${customName(s) ? ' — ' + s.name : ''}`, `void ${e.fn}(const char* value) {`,
            `  canvas.fillRect(${x}, ${y}, ${w}, ${h}, ${er});  // стереть область блока`, ...(o < 255 ? [`  lcbOpacity(${o});`] : []),
            s.font ? `  canvas.setFont(&${s.font});` : '  canvas.setFont();  // встроенный 5×7', `  canvas.setTextSize(${s.size});`, ...(lcb ? [] : [`  canvas.setTextColor(${colStr(s)});`]), '  canvas.setTextWrap(false);',
            ...(FONT_DATA[s.font] && FONT_DATA[s.font].cp ? ['  value = cp1251(value);  // UTF-8 → CP1251 для шрифта с кириллицей'] : []),
            '  // выравнивание считается на плате через getTextBounds', '  int16_t bx, by; uint16_t bw, bh;', '  canvas.getTextBounds(value, 0, 0, &bx, &by, &bw, &bh);',
            ...(lcb ? [...(gradOk(s) ? [`  const LcbPaint p = ${paintLit(s, e)};`] : []), '  ' + lcbTextCall(s, e, gradOk(s) ? 'p' : `lcbSolid(${colStr(s)})`, cx, cy, 'value')]
                : [`  canvas.setCursor(${cx}, ${cy});`, '  canvas.print(value);']), ...(o < 255 ? ['  lcbOpacity(255);'] : []), '}'];
    }
    // ---------- lcb…: gradients, anti-aliasing, opacity in the sketch (C++ twin of paintColor / px / aa… above) ----------
    const usesLcb = (s, e) => gradOk(s) || aaOk(s) || opaOn(s, e) || scrolls(s);
    // alpha: lcbOpacity() and the per-pixel blend it needs (a buffer of W × H bits); clip: lcbClip() for scrolling text
    function lcbPutLines(alpha, clip) {
        const L = [];
        if (alpha) L.push('uint8_t lcbAlpha_ = 255;               // непрозрачность текущего элемента (lcbOpacity)', 'uint8_t lcbSeen_[(W * H + 7) / 8];     // пиксели, которые элемент уже смешал: каждый смешивается один раз',
            '// непрозрачность 0…255 для следующих фигур; меньше 255 — каждый пиксель смешивается с тем, что уже на холсте', 'inline void lcbOpacity(uint8_t a) { lcbAlpha_ = a; if (a < 255) memset(lcbSeen_, 0, sizeof(lcbSeen_)); }');
        if (clip) L.push('int16_t lcbCx0_ = 0, lcbCy0_ = 0, lcbCx1_ = 32767, lcbCy1_ = 32767;   // рамка, за которую не рисуем (бегущая строка)',
            'inline void lcbClip(int16_t x, int16_t y, int16_t w, int16_t h) { lcbCx0_ = x; lcbCy0_ = y; lcbCx1_ = x + w; lcbCy1_ = y + h; }', 'inline void lcbNoClip() { lcbCx0_ = lcbCy0_ = 0; lcbCx1_ = lcbCy1_ = 32767; }');
        if (L.length) L.push('');
        L.push(`// пиксель цвета c с покрытием a из 16${alpha ? ' и непрозрачностью lcbAlpha_' : ''}: если меньше полного — смешивается с тем, что уже на холсте`,
            'inline void lcbPut(int16_t x, int16_t y, uint16_t c, uint8_t a = 16) {', '  if (!a || x < 0 || y < 0 || x >= canvas.width() || y >= canvas.height()) return;');
        if (clip) L.push('  if (x < lcbCx0_ || y < lcbCy0_ || x >= lcbCx1_ || y >= lcbCy1_) return;');
        if (alpha) L.push('  int e = a * lcbAlpha_;   // из 16 × 255 = 4080', '  if (e < 4080) {', '    if (!e) return;',
            '    if (lcbAlpha_ < 255) { uint32_t i = (uint32_t)y * W + x; uint8_t m = 1 << (i & 7); if (lcbSeen_[i >> 3] & m) return; lcbSeen_[i >> 3] |= m; }',
            '    uint16_t b = canvas.getPixel(x, y);', '    int br = b >> 11, bg = (b >> 5) & 63, bb = b & 31, fr = c >> 11, fg = (c >> 5) & 63, fb = c & 31;',
            '    c = (br + (fr - br) * e / 4080) << 11 | (bg + (fg - bg) * e / 4080) << 5 | (bb + (fb - bb) * e / 4080);', '  }');
        else L.push('  if (a < 16) {', '    uint16_t b = canvas.getPixel(x, y);', '    int br = b >> 11, bg = (b >> 5) & 63, bb = b & 31, fr = c >> 11, fg = (c >> 5) & 63, fb = c & 31;',
            '    c = (br + (fr - br) * a / 16) << 11 | (bg + (fg - bg) * a / 16) << 5 | (bb + (fb - bb) * a / 16);', '  }');
        L.push('  canvas.drawPixel(x, y, c);', '}', '// пиксель цветом LcbPaint', 'inline void lcbPx(int16_t x, int16_t y, uint8_t a = 16) { if (x >= 0 && y >= 0 && x < canvas.width() && y < canvas.height()) lcbPut(x, y, lcbColor(x, y), a); }');
        return L.join('\n');
    }
    function lcbLib(glcd, alpha, clip) {
        const lib = `// ---------- LCD Canvas Builder: градиенты, сглаживание, непрозрачность ----------
// Свои функции рисования: те же алгоритмы, что у Adafruit GFX, но цвет каждого пикселя берётся из LcbPaint,
// а сглаженные фигуры смешиваются с тем, что уже нарисовано. Математика целочисленная и совпадает с превью.
enum : uint8_t { LCB_SOLID, LCB_LINEAR, LCB_RADIAL };
// градиент: направление (dx, dy) × 1024 для линейного; n опорных цветов c[] на позициях p[] (0…4096); дизеринг 4×4
struct LcbPaint { uint8_t type; int16_t dx, dy; uint8_t n; uint16_t c[4]; uint16_t p[4]; bool dither; };
inline LcbPaint lcbSolid(uint16_t c) { LcbPaint p = { LCB_SOLID, 0, 0, 1, { c, 0, 0, 0 }, { 0, 0, 0, 0 }, false }; return p; }
${lcbAlphaTypes().join('\n')}

const LcbPaint* lcbP_ = nullptr;
int16_t lcbBx_, lcbBy_, lcbBw_, lcbBh_;   // рамка элемента, по которой растягивается градиент
inline void lcbUse(const LcbPaint& p, int16_t x, int16_t y, int16_t w, int16_t h) { lcbP_ = &p; lcbBx_ = x; lcbBy_ = y; lcbBw_ = w; lcbBh_ = h; }

inline uint32_t lcbIsqrt(uint64_t n) {
  uint64_t r = 0, b = 1ULL << 62;
  while (b > n) b >>= 2;
  while (b) { if (n >= r + b) { n -= r + b; r = (r >> 1) + b; } else r >>= 1; b >>= 2; }
  return (uint32_t)r;
}

// цвет градиента в центре пикселя (x, y)
inline uint16_t lcbColor(int16_t x, int16_t y) {
  const LcbPaint& p = *lcbP_;
  if (p.type == LCB_SOLID || p.n < 2) return p.c[0];
  int64_t X = 2 * x + 1 - (2 * lcbBx_ + lcbBw_), Y = 2 * y + 1 - (2 * lcbBy_ + lcbBh_), t;
  if (p.type == LCB_LINEAR) {
    int64_t half = (int64_t)abs(p.dx) * lcbBw_ + (int64_t)abs(p.dy) * lcbBh_;
    t = half ? (X * p.dx + Y * p.dy + half) * 4096 / (2 * half) : 0;
  } else {
    int64_t R = lcbBw_ > lcbBh_ ? lcbBw_ : lcbBh_;
    t = R ? (int64_t)lcbIsqrt((uint64_t)(X * X + Y * Y) * 256) * 4096 / (R * 16) : 0;
  }
  if (t < 0) t = 0;
  if (t > 4096) t = 4096;
  int i = 0;
  while (i < p.n - 2 && t >= p.p[i + 1]) i++;
  int f = t <= p.p[i] ? 0 : t >= p.p[i + 1] ? 256 : (int)((t - p.p[i]) * 256 / (p.p[i + 1] - p.p[i]));
  static const uint8_t bayer[16] = { 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 };
  int d = p.dither ? bayer[(y & 3) * 4 + (x & 3)] * 16 + 8 : 128;
  uint16_t a = p.c[i], b = p.c[i + 1];
  int r = ((a >> 11) * 256 + ((b >> 11) - (a >> 11)) * f + d) >> 8;
  int g = (((a >> 5) & 63) * 256 + (((b >> 5) & 63) - ((a >> 5) & 63)) * f + d) >> 8;
  int bl = ((a & 31) * 256 + ((b & 31) - (a & 31)) * f + d) >> 8;
  if (r > 31) r = 31;
  if (g > 63) g = 63;
  if (bl > 31) bl = 31;
  return r << 11 | g << 5 | bl;
}

${lcbPutLines(alpha, clip)}

// ----- те же алгоритмы, что в Adafruit_GFX.cpp -----
inline void lcbH(int16_t x, int16_t y, int16_t w) { if (w < 0) { w = -w; x -= w - 1; } for (int16_t i = 0; i < w; i++) lcbPx(x + i, y); }
inline void lcbV(int16_t x, int16_t y, int16_t h) { if (h < 0) { h = -h; y -= h - 1; } for (int16_t i = 0; i < h; i++) lcbPx(x, y + i); }
inline void lcbLine(int16_t x0, int16_t y0, int16_t x1, int16_t y1) {
  bool steep = abs(y1 - y0) > abs(x1 - x0);
  int16_t t;
  if (steep) { t = x0; x0 = y0; y0 = t; t = x1; x1 = y1; y1 = t; }
  if (x0 > x1) { t = x0; x0 = x1; x1 = t; t = y0; y0 = y1; y1 = t; }
  int16_t dx = x1 - x0, dy = abs(y1 - y0), err = dx / 2, ys = y0 < y1 ? 1 : -1;
  for (; x0 <= x1; x0++) { if (steep) lcbPx(y0, x0); else lcbPx(x0, y0); err -= dy; if (err < 0) { y0 += ys; err += dx; } }
}
inline void lcbFR(int16_t x, int16_t y, int16_t w, int16_t h) { for (int16_t i = x; i < x + w; i++) lcbV(i, y, h); }
inline void lcbDR(int16_t x, int16_t y, int16_t w, int16_t h) { lcbH(x, y, w); lcbH(x, y + h - 1, w); lcbV(x, y, h); lcbV(x + w - 1, y, h); }
inline void lcbDC(int16_t x0, int16_t y0, int16_t r) {
  int16_t f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r;
  lcbPx(x0, y0 + r); lcbPx(x0, y0 - r); lcbPx(x0 + r, y0); lcbPx(x0 - r, y0);
  while (x < y) {
    if (f >= 0) { y--; ddy += 2; f += ddy; } x++; ddx += 2; f += ddx;
    lcbPx(x0 + x, y0 + y); lcbPx(x0 - x, y0 + y); lcbPx(x0 + x, y0 - y); lcbPx(x0 - x, y0 - y);
    lcbPx(x0 + y, y0 + x); lcbPx(x0 - y, y0 + x); lcbPx(x0 + y, y0 - x); lcbPx(x0 - y, y0 - x);
  }
}
inline void lcbCH(int16_t x0, int16_t y0, int16_t r, uint8_t c) {
  int16_t f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r;
  while (x < y) {
    if (f >= 0) { y--; ddy += 2; f += ddy; } x++; ddx += 2; f += ddx;
    if (c & 4) { lcbPx(x0 + x, y0 + y); lcbPx(x0 + y, y0 + x); }
    if (c & 2) { lcbPx(x0 + x, y0 - y); lcbPx(x0 + y, y0 - x); }
    if (c & 8) { lcbPx(x0 - y, y0 + x); lcbPx(x0 - x, y0 + y); }
    if (c & 1) { lcbPx(x0 - y, y0 - x); lcbPx(x0 - x, y0 - y); }
  }
}
inline void lcbFCH(int16_t x0, int16_t y0, int16_t r, uint8_t corners, int16_t delta) {
  int16_t f = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r, px = x, py = y;
  delta++;
  while (x < y) {
    if (f >= 0) { y--; ddy += 2; f += ddy; } x++; ddx += 2; f += ddx;
    if (x < y + 1) { if (corners & 1) lcbV(x0 + x, y0 - y, 2 * y + delta); if (corners & 2) lcbV(x0 - x, y0 - y, 2 * y + delta); }
    if (y != py) { if (corners & 1) lcbV(x0 + py, y0 - px, 2 * px + delta); if (corners & 2) lcbV(x0 - py, y0 - px, 2 * px + delta); py = y; }
    px = x;
  }
}
inline int16_t lcbClampR(int16_t w, int16_t h, int16_t r) { int16_t m = (w < h ? w : h) / 2; return r > m ? m : r; }
inline void lcbDRR(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r) {
  r = lcbClampR(w, h, r);
  lcbH(x + r, y, w - 2 * r); lcbH(x + r, y + h - 1, w - 2 * r); lcbV(x, y + r, h - 2 * r); lcbV(x + w - 1, y + r, h - 2 * r);
  lcbCH(x + r, y + r, r, 1); lcbCH(x + w - r - 1, y + r, r, 2); lcbCH(x + w - r - 1, y + h - r - 1, r, 4); lcbCH(x + r, y + h - r - 1, r, 8);
}
inline void lcbFRR(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r) {
  r = lcbClampR(w, h, r);
  lcbFR(x + r, y, w - 2 * r, h); lcbFCH(x + w - r - 1, y + r, r, 1, h - 2 * r - 1); lcbFCH(x + r, y + r, r, 2, h - 2 * r - 1);
}
inline void lcbFT(int16_t x0, int16_t y0, int16_t x1, int16_t y1, int16_t x2, int16_t y2) {
  int16_t a, b, y, last, t;
  if (y0 > y1) { t = y0; y0 = y1; y1 = t; t = x0; x0 = x1; x1 = t; }
  if (y1 > y2) { t = y2; y2 = y1; y1 = t; t = x2; x2 = x1; x1 = t; }
  if (y0 > y1) { t = y0; y0 = y1; y1 = t; t = x0; x0 = x1; x1 = t; }
  if (y0 == y2) {
    a = b = x0;
    if (x1 < a) a = x1; else if (x1 > b) b = x1;
    if (x2 < a) a = x2; else if (x2 > b) b = x2;
    lcbH(a, y0, b - a + 1); return;
  }
  int16_t dx01 = x1 - x0, dy01 = y1 - y0, dx02 = x2 - x0, dy02 = y2 - y0, dx12 = x2 - x1, dy12 = y2 - y1;
  int32_t sa = 0, sb = 0;
  last = y1 == y2 ? y1 : y1 - 1;
  for (y = y0; y <= last; y++) { a = x0 + sa / dy01; b = x0 + sb / dy02; sa += dx01; sb += dx02; if (a > b) { t = a; a = b; b = t; } lcbH(a, y, b - a + 1); }
  sa = (int32_t)dx12 * (y - y1); sb = (int32_t)dx02 * (y - y0);
  for (; y <= y2; y++) { a = x1 + sa / dy12; b = x0 + sb / dy02; sa += dx12; sb += dx02; if (a > b) { t = a; a = b; b = t; } lcbH(a, y, b - a + 1); }
}

// ----- сглаживание: покрытие по 4×4 подвыборкам, координаты в 1/8 пикселя -----
template <typename F> inline uint8_t lcbCover(int16_t x, int16_t y, F inside) {
  uint8_t n = 0;
  for (int j = 1; j < 8; j += 2) for (int i = 1; i < 8; i += 2) if (inside((int32_t)8 * x + i, (int32_t)8 * y + j)) n++;
  return n;
}
inline void lcbAACircle(int16_t cx, int16_t cy, int16_t r, bool ring) {
  int32_t C = 8 * cx + 4, D = 8 * cy + 4, ro = (8 * r + 4) * (8 * r + 4), ri = ring && r > 0 ? (8 * r - 4) * (8 * r - 4) : -1;
  auto in = [&](int32_t sx, int32_t sy) { int32_t d = (sx - C) * (sx - C) + (sy - D) * (sy - D); return d <= ro && d >= ri; };
  for (int16_t y = cy - r - 1; y <= cy + r + 1; y++) for (int16_t x = cx - r - 1; x <= cx + r + 1; x++) lcbPx(x, y, lcbCover(x, y, in));
}
inline bool lcbInRR(int32_t sx, int32_t sy, int16_t x, int16_t y, int16_t w, int16_t h, int16_t r) {
  if (w <= 0 || h <= 0 || sx < 8 * x || sy < 8 * y || sx >= 8 * (x + w) || sy >= 8 * (y + h)) return false;
  if (r <= 0) return true;
  int32_t l = 8 * (x + r) + 4, t = 8 * (y + r) + 4, rr = 8 * (x + w - r - 1) + 4, b = 8 * (y + h - r - 1) + 4, R = 8 * r + 4;
  int32_t dx = sx - (sx < l ? l : sx > rr ? rr : sx), dy = sy - (sy < t ? t : sy > b ? b : sy);
  return dx * dx + dy * dy <= R * R;
}
inline void lcbAARR(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r, bool ring) {
  r = lcbClampR(w, h, r);
  auto in = [&](int32_t sx, int32_t sy) { return lcbInRR(sx, sy, x, y, w, h, r) && !(ring && lcbInRR(sx, sy, x + 1, y + 1, w - 2, h - 2, r - 1)); };
  for (int16_t j = y; j < y + h; j++) for (int16_t i = x; i < x + w; i++) lcbPx(i, j, lcbCover(i, j, in));
}
inline void lcbAALine(int16_t x0, int16_t y0, int16_t x1, int16_t y1) {
  int32_t ax = 8 * x0 + 4, ay = 8 * y0 + 4, bx = 8 * x1 + 4, by = 8 * y1 + 4, dx = bx - ax, dy = by - ay;
  int64_t L = (int64_t)dx * dx + (int64_t)dy * dy;
  auto in = [&](int32_t sx, int32_t sy) {
    int64_t vx = sx - ax, vy = sy - ay, t = vx * dx + vy * dy;
    if (L == 0 || t <= 0) return vx * vx + vy * vy <= 16;
    if (t >= L) return (int64_t)(sx - bx) * (sx - bx) + (int64_t)(sy - by) * (sy - by) <= 16;
    return (vx * vx + vy * vy) * L - t * t <= 16 * L;
  };
  if (abs(x1 - x0) >= abs(y1 - y0)) {
    int16_t lo = x0 < x1 ? x0 : x1, hi = x0 < x1 ? x1 : x0;
    for (int16_t x = lo - 1; x <= hi + 1; x++) {
      int16_t xc = x < lo ? lo : x > hi ? hi : x, yc = x1 == x0 ? y0 : y0 + (int32_t)(xc - x0) * (y1 - y0) / (x1 - x0);
      for (int16_t y = yc - 2; y <= yc + 2; y++) lcbPx(x, y, lcbCover(x, y, in));
    }
  } else {
    int16_t lo = y0 < y1 ? y0 : y1, hi = y0 < y1 ? y1 : y0;
    for (int16_t y = lo - 1; y <= hi + 1; y++) {
      int16_t yc = y < lo ? lo : y > hi ? hi : y, xc = x0 + (int32_t)(yc - y0) * (x1 - x0) / (y1 - y0);
      for (int16_t x = xc - 2; x <= xc + 2; x++) lcbPx(x, y, lcbCover(x, y, in));
    }
  }
}
inline int64_t lcbEdge(int32_t px, int32_t py, int32_t qx, int32_t qy, int32_t sx, int32_t sy) { return (int64_t)(qx - px) * (sy - py) - (int64_t)(qy - py) * (sx - px); }
inline void lcbAATriangle(int16_t x0, int16_t y0, int16_t x1, int16_t y1, int16_t x2, int16_t y2) {
  int32_t ax = 8 * x0 + 4, ay = 8 * y0 + 4, bx = 8 * x1 + 4, by = 8 * y1 + 4, cx = 8 * x2 + 4, cy = 8 * y2 + 4;
  int64_t area = lcbEdge(ax, ay, bx, by, cx, cy);
  if (!area) { lcbAALine(x0, y0, x1, y1); lcbAALine(x1, y1, x2, y2); return; }
  int sg = area > 0 ? 1 : -1;
  auto in = [&](int32_t sx, int32_t sy) { return sg * lcbEdge(ax, ay, bx, by, sx, sy) >= 0 && sg * lcbEdge(bx, by, cx, cy, sx, sy) >= 0 && sg * lcbEdge(cx, cy, ax, ay, sx, sy) >= 0; };
  int16_t xa = min(x0, min(x1, x2)), xb = max(x0, max(x1, x2)), ya = min(y0, min(y1, y2)), yb = max(y0, max(y1, y2));
  for (int16_t y = ya; y <= yb; y++) for (int16_t x = xa; x <= xb; x++) lcbPx(x, y, lcbCover(x, y, in));
}

// ----- то, что вызывает код экрана -----
inline void lcbBoxRect(const LcbPaint& p, int16_t x, int16_t y, int16_t w, int16_t h) { lcbUse(p, w < 0 ? x + w : x, h < 0 ? y + h : y, abs(w), abs(h)); }
inline void lcbFillRect(int16_t x, int16_t y, int16_t w, int16_t h, const LcbPaint& p) { lcbBoxRect(p, x, y, w, h); lcbFR(x, y, w, h); }
inline void lcbDrawRect(int16_t x, int16_t y, int16_t w, int16_t h, const LcbPaint& p) { lcbBoxRect(p, x, y, w, h); lcbDR(x, y, w, h); }
inline void lcbFillRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r, const LcbPaint& p, bool aa) { lcbBoxRect(p, x, y, w, h); if (aa) lcbAARR(x, y, w, h, r, false); else lcbFRR(x, y, w, h, r); }
inline void lcbDrawRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r, const LcbPaint& p, bool aa) { lcbBoxRect(p, x, y, w, h); if (aa) lcbAARR(x, y, w, h, r, true); else lcbDRR(x, y, w, h, r); }
inline void lcbFillCircle(int16_t x, int16_t y, int16_t r, const LcbPaint& p, bool aa) { lcbUse(p, x - r, y - r, 2 * r + 1, 2 * r + 1); if (aa) lcbAACircle(x, y, r, false); else { lcbV(x, y - r, 2 * r + 1); lcbFCH(x, y, r, 3, 0); } }
inline void lcbDrawCircle(int16_t x, int16_t y, int16_t r, const LcbPaint& p, bool aa) { lcbUse(p, x - r, y - r, 2 * r + 1, 2 * r + 1); if (aa) lcbAACircle(x, y, r, true); else lcbDC(x, y, r); }
inline void lcbBoxPts(const LcbPaint& p, int16_t xa, int16_t xb, int16_t ya, int16_t yb) { lcbUse(p, xa, ya, xb - xa + 1, yb - ya + 1); }
inline void lcbDrawLine(int16_t x0, int16_t y0, int16_t x1, int16_t y1, const LcbPaint& p, bool aa) {
  lcbBoxPts(p, min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1));
  if (aa) lcbAALine(x0, y0, x1, y1); else lcbLine(x0, y0, x1, y1);
}
inline void lcbFillTriangle(int16_t x0, int16_t y0, int16_t x1, int16_t y1, int16_t x2, int16_t y2, const LcbPaint& p, bool aa) {
  lcbBoxPts(p, min(x0, min(x1, x2)), max(x0, max(x1, x2)), min(y0, min(y1, y2)), max(y0, max(y1, y2)));
  if (aa) lcbAATriangle(x0, y0, x1, y1, x2, y2); else lcbFT(x0, y0, x1, y1, x2, y2);
}
inline void lcbDrawTriangle(int16_t x0, int16_t y0, int16_t x1, int16_t y1, int16_t x2, int16_t y2, const LcbPaint& p, bool aa) {
  lcbBoxPts(p, min(x0, min(x1, x2)), max(x0, max(x1, x2)), min(y0, min(y1, y2)), max(y0, max(y1, y2)));
  if (aa) { lcbAALine(x0, y0, x1, y1); lcbAALine(x1, y1, x2, y2); lcbAALine(x2, y2, x0, y0); }
  else { lcbLine(x0, y0, x1, y1); lcbLine(x1, y1, x2, y2); lcbLine(x2, y2, x0, y0); }
}
// 1-битная картинка (тот же формат, что у drawBitmap)
inline void lcbDrawBitmap(int16_t x, int16_t y, const uint8_t* bitmap, int16_t w, int16_t h, const LcbPaint& p) {
  lcbUse(p, x, y, w, h);
  int16_t bw = (w + 7) / 8;
  for (int16_t j = 0; j < h; j++) {
    uint8_t b = 0;
    for (int16_t i = 0; i < w; i++) { if (i & 7) b <<= 1; else b = pgm_read_byte(&bitmap[j * bw + i / 8]); if (b & 0x80) lcbPx(x + i, y + j); }
  }
}
// картинка RGB565 (как drawRGBBitmap; mask — маска прозрачности или nullptr) — каждый пиксель через lcbPut
inline void lcbDrawRGBBitmap(int16_t x, int16_t y, const uint16_t* bitmap, const uint8_t* mask, int16_t w, int16_t h) {
  int16_t bw = (w + 7) / 8;
  for (int16_t j = 0; j < h; j++) {
    uint8_t b = 0;
    for (int16_t i = 0; i < w; i++) {
      if (mask) { if (i & 7) b <<= 1; else b = pgm_read_byte(&mask[j * bw + i / 8]); if (!(b & 0x80)) continue; }
      lcbPut(x + i, y + j, pgm_read_word(&bitmap[j * w + i]));
    }
  }
}
inline void lcbDrawPixel(int16_t x, int16_t y, const LcbPaint& p) { lcbUse(p, x, y, 1, 1); lcbPx(x, y); }
// повёрнутый прямоугольник по четырём углам (по кругу): два треугольника или четыре линии; градиент — по рамке углов
inline void lcbBoxQuad(const LcbPaint& p, int16_t x0, int16_t y0, int16_t x1, int16_t y1, int16_t x2, int16_t y2, int16_t x3, int16_t y3) {
  lcbBoxPts(p, min(min(x0, x1), min(x2, x3)), max(max(x0, x1), max(x2, x3)), min(min(y0, y1), min(y2, y3)), max(max(y0, y1), max(y2, y3)));
}
inline void lcbFillQuad(int16_t x0, int16_t y0, int16_t x1, int16_t y1, int16_t x2, int16_t y2, int16_t x3, int16_t y3, const LcbPaint& p) {
  lcbBoxQuad(p, x0, y0, x1, y1, x2, y2, x3, y3); lcbFT(x0, y0, x1, y1, x2, y2); lcbFT(x0, y0, x2, y2, x3, y3);
}
inline void lcbDrawQuad(int16_t x0, int16_t y0, int16_t x1, int16_t y1, int16_t x2, int16_t y2, int16_t x3, int16_t y3, const LcbPaint& p) {
  lcbBoxQuad(p, x0, y0, x1, y1, x2, y2, x3, y3); lcbLine(x0, y0, x1, y1); lcbLine(x1, y1, x2, y2); lcbLine(x2, y2, x3, y3); lcbLine(x3, y3, x0, y0);
}
// строка шрифтом GFXfont от курсора (x — начало, y — базовая линия), как print(); bx…bh — рамка текстового блока для градиента;
// aa — сглаженная копия шрифта (только для шрифтов проекта)
inline void lcbText(int16_t x, int16_t y, const char* s, const GFXfont* f, uint8_t size, const LcbPaint& p, int16_t bx, int16_t by, int16_t bw, int16_t bh, const LcbAlphaFont* aa = nullptr) {
  lcbUse(p, bx, by, bw, bh);
  for (; *s; s++) {
    uint8_t c = *s;
    if (c < f->first || c > f->last) continue;
    const GFXglyph* g = &f->glyph[c - f->first];
    if (aa) {
      const LcbAlphaGlyph* ag = &aa->glyph[c - f->first];
      for (int yy = 0; yy < ag->height; yy++) for (int xx = 0; xx < ag->width; xx++) {
        int n = yy * ag->width + xx;
        uint8_t v = pgm_read_byte(&aa->bitmap[ag->offset + (n >> 1)]), a4 = n & 1 ? v & 15 : v >> 4;
        if (!a4) continue;
        uint8_t a = (a4 * 16 + 7) / 15;
        if (size == 1) lcbPx(x + ag->xOffset + xx, y + ag->yOffset + yy, a);
        else for (int j = 0; j < size; j++) for (int i = 0; i < size; i++) lcbPx(x + (ag->xOffset + xx) * size + i, y + (ag->yOffset + yy) * size + j, a);
      }
    } else {
      uint16_t bo = g->bitmapOffset;
      uint8_t bits = 0, bit = 0;
      for (int yy = 0; yy < g->height; yy++) for (int xx = 0; xx < g->width; xx++) {
        if (!(bit++ & 7)) bits = pgm_read_byte(&f->bitmap[bo++]);
        if (bits & 0x80) { if (size == 1) lcbPx(x + g->xOffset + xx, y + g->yOffset + yy); else lcbFR(x + (g->xOffset + xx) * size, y + (g->yOffset + yy) * size, size, size); }
        bits <<= 1;
      }
    }
    x += g->xAdvance * size;
  }
}`;
        if (!glcd) return lib.split('\n');
        const rows = []; for (let k = 0; k < GLCD.length; k += 20) rows.push('  ' + Array.from(GLCD.slice(k, k + 20), v => '0x' + v.toString(16).toUpperCase().padStart(2, '0')).join(', ') + ',');
        return [...lib.split('\n'), '// встроенный шрифт 5×7 (копия glcdfont.c из Adafruit GFX: в библиотеке он недоступен скетчу)', 'const uint8_t lcbGlcd[] PROGMEM = {', ...rows, '};',
            '// строка встроенным шрифтом 5×7 от курсора (y — верх строки), как print()',
            'inline void lcbTextGlcd(int16_t x, int16_t y, const char* s, uint8_t size, const LcbPaint& p, int16_t bx, int16_t by, int16_t bw, int16_t bh) {',
            '  lcbUse(p, bx, by, bw, bh);',
            '  for (; *s; s++, x += 6 * size) {',
            '    uint8_t c = *s;',
            '    for (int8_t i = 0; i < 5; i++) {',
            '      uint8_t line = pgm_read_byte(&lcbGlcd[c * 5 + i]);',
            '      for (int8_t j = 0; j < 8; j++, line >>= 1) if (line & 1) { if (size == 1) lcbPx(x + i, y + j); else lcbFR(x + i * size, y + j * size, size, size); }',
            '    }', '  }', '}'];
    }
    // gradient as a C++ initialiser; colours keep palette names
    function paintLit(s, e) {
        const P = makePaint(s), st = [...s.grad.stops].sort((a, b) => a.p - b.p).slice(0, 4), pad = (a, z) => [...a, ...Array(4 - a.length).fill(z)]; // same order as makePaint
        const col = k => e && e.anim && e.anim['g' + st[k].id] ? colE(s, e, 'g' + st[k].id) : P.pc[k] && palEntry(P.pc[k]) ? P.pc[k] : fmt565(P.c[k]);
        return `{ ${P.type === 2 ? 'LCB_RADIAL' : 'LCB_LINEAR'}, ${P.dx}, ${P.dy}, ${P.n}, { ${pad(P.c.map((_, k) => col(k)), '0').join(', ')} }, { ${pad(P.p, 0).join(', ')} }, ${P.dither} }`;
    }
    function lcbCall(s, e, P) {
        const v = k => V(s, e, k), aa = aaOk(s) ? 'true' : 'false', F = s.fill ? 'Fill' : 'Draw';
        switch (s.t) {
            case 'rect': return `lcb${F}Rect(${v('x')}, ${v('y')}, ${v('w')}, ${v('h')}, ${P});`;
            case 'rrect': return `lcb${F}RoundRect(${v('x')}, ${v('y')}, ${v('w')}, ${v('h')}, ${v('r')}, ${P}, ${aa});`;
            case 'circle': return `lcb${F}Circle(${v('x')}, ${v('y')}, ${v('r')}, ${P}, ${aa});`;
            case 'line': return `lcbDrawLine(${v('x0')}, ${v('y0')}, ${v('x1')}, ${v('y1')}, ${P}, ${aa});`;
            case 'tri': return `lcb${F}Triangle(${v('x0')}, ${v('y0')}, ${v('x1')}, ${v('y1')}, ${v('x2')}, ${v('y2')}, ${P}, ${aa});`;
            case 'pixel': return `lcbDrawPixel(${v('x')}, ${v('y')}, ${P});`;
        }
    }
    // ---------- turning in the sketch (C++ twin of isin / rotPt / rotMap above) ----------
    // put: how a turned picture writes a pixel — lcbPut when the lcb drawing functions are there (opacity), otherwise straight to the canvas
    function lcbRotLib(map, paint) {
        const rows = []; for (let k = 0; k <= 90; k += 10) rows.push('  ' + SIN_T.slice(k, Math.min(91, k + 10)).join(', ') + (k + 10 <= 90 ? ',' : ''));
        const L = ['// ---------- LCD Canvas Builder: поворот ----------', '// sin целых градусов × 16384 (0…90°); точка поворачивается вокруг оси (ox, oy) по часовой стрелке, округление (v + 8192) >> 14',
            'const int16_t lcbSinT[91] = {', ...rows, '};',
            'inline int32_t lcbSin(int32_t a) { a %= 360; if (a < 0) a += 360; return a <= 90 ? lcbSinT[a] : a <= 180 ? lcbSinT[180 - a] : a <= 270 ? -lcbSinT[a - 180] : -lcbSinT[360 - a]; }',
            'inline LcbPt lcbRot(int32_t x, int32_t y, int32_t ox, int32_t oy, int32_t a) {', '  int32_t s = lcbSin(a), c = lcbSin(a + 90), dx = x - ox, dy = y - oy;',
            '  LcbPt p = { (int16_t)(ox + ((dx * c - dy * s + 8192) >> 14)), (int16_t)(oy + ((dx * s + dy * c + 8192) >> 14)) };', '  return p;', '}'];
        if (!map) return L;
        const put = paint ? 'lcbPut' : 'canvas.drawPixel';
        L.push('// повёрнутая картинка: каждый пиксель экрана вокруг повёрнутых углов берёт пиксель картинки, из которого он пришёл (ближайший)',
            'inline void lcbRotCorners(int16_t x, int16_t y, int16_t w, int16_t h, int16_t ox, int16_t oy, int32_t a, int16_t& xa, int16_t& xb, int16_t& ya, int16_t& yb) {',
            '  LcbPt q[4] = { lcbRot(x, y, ox, oy, a), lcbRot(x + w - 1, y, ox, oy, a), lcbRot(x + w - 1, y + h - 1, ox, oy, a), lcbRot(x, y + h - 1, ox, oy, a) };',
            '  xa = xb = q[0].x; ya = yb = q[0].y;',
            '  for (int k = 1; k < 4; k++) { if (q[k].x < xa) xa = q[k].x; if (q[k].x > xb) xb = q[k].x; if (q[k].y < ya) ya = q[k].y; if (q[k].y > yb) yb = q[k].y; }', '}',
            'template <typename F> inline void lcbRotMap(int16_t x, int16_t y, int16_t w, int16_t h, int16_t ox, int16_t oy, int32_t a, F put) {',
            '  int32_t s = lcbSin(a), c = lcbSin(a + 90);', '  int16_t xa, xb, ya, yb;', '  lcbRotCorners(x, y, w, h, ox, oy, a, xa, xb, ya, yb);',
            '  if (--xa < 0) xa = 0;', '  if (--ya < 0) ya = 0;', '  if (++xb > canvas.width() - 1) xb = canvas.width() - 1;', '  if (++yb > canvas.height() - 1) yb = canvas.height() - 1;',
            '  for (int16_t Y = ya; Y <= yb; Y++) for (int16_t X = xa; X <= xb; X++) {',
            '    int32_t dx = X - ox, dy = Y - oy, i = ox + ((dx * c + dy * s + 8192) >> 14) - x, j = oy + ((dy * c - dx * s + 8192) >> 14) - y;',
            '    if (i >= 0 && j >= 0 && i < w && j < h) put(X, Y, i, j);', '  }', '}',
            'inline void lcbRotRGBBitmap(int16_t x, int16_t y, const uint16_t* bitmap, const uint8_t* mask, int16_t w, int16_t h, int16_t ox, int16_t oy, int32_t a) {',
            '  int16_t bw = (w + 7) / 8;',
            '  lcbRotMap(x, y, w, h, ox, oy, a, [&](int16_t X, int16_t Y, int32_t i, int32_t j) {',
            '    if (mask && !(pgm_read_byte(&mask[j * bw + i / 8]) & (0x80 >> (i & 7)))) return;', `    ${put}(X, Y, pgm_read_word(&bitmap[j * w + i]));`, '  });', '}',
            'inline void lcbRotBitmap(int16_t x, int16_t y, const uint8_t* bitmap, int16_t w, int16_t h, uint16_t color, int16_t ox, int16_t oy, int32_t a) {',
            '  int16_t bw = (w + 7) / 8;',
            `  lcbRotMap(x, y, w, h, ox, oy, a, [&](int16_t X, int16_t Y, int32_t i, int32_t j) { if (pgm_read_byte(&bitmap[j * bw + i / 8]) & (0x80 >> (i & 7))) ${put}(X, Y, color); });`, '}');
        if (paint) L.push('// то же с градиентом или непрозрачностью: градиент — по рамке повёрнутых углов',
            'inline void lcbRotBitmap(int16_t x, int16_t y, const uint8_t* bitmap, int16_t w, int16_t h, const LcbPaint& p, int16_t ox, int16_t oy, int32_t a) {',
            '  int16_t bw = (w + 7) / 8, xa, xb, ya, yb;', '  lcbRotCorners(x, y, w, h, ox, oy, a, xa, xb, ya, yb);', '  lcbBoxPts(p, xa, xb, ya, yb);',
            '  lcbRotMap(x, y, w, h, ox, oy, a, [&](int16_t X, int16_t Y, int32_t i, int32_t j) { if (pgm_read_byte(&bitmap[j * bw + i / 8]) & (0x80 >> (i & 7))) lcbPx(X, Y); });', '}');
        return L;
    }
    // one call, or a block with the gradient as a local constant
    const lcbWrap = (s, e, body) => gradOk(s) ? [`{ const LcbPaint p = ${paintLit(s, e)};`, ...body('p').map((l, k, a) => '  ' + l + (k === a.length - 1 ? ' }' : ''))] : body(`lcbSolid(${colE(s, e)})`);
    // a text line through lcbText / lcbTextGlcd; the box is the text block
    function lcbTextCall(s, e, P, cx, cy, lit) {
        const v = k => V(s, e, k), F = FONT_DATA[s.font], box = `${v('x')}, ${v('y')}, ${v('w')}, ${v('h')}`;
        if (!s.font || !F) return `lcbTextGlcd(${cx}, ${cy}, ${lit}, ${s.size}, ${P}, ${box});`;
        return `lcbText(${cx}, ${cy}, ${lit}, &${s.font}, ${s.size}, ${P}, ${box}${aaOk(s) ? `, &${s.font}AA` : ''});`;
    }

    // ---------- animations in the sketch (C++ twin of ease / evalTrack / followV above) ----------
    // the types go above every function of the sketch: the Arduino IDE puts its generated prototypes before the first function
    function lcbAnimTypes() {
        return `// ---------- LCD Canvas Builder: анимации ----------
// Ключевые кадры: между двумя ключами значение идёт от левого к правому с плавностью левого ключа.
// Время — в мс, прогресс — целое 0…1024, поэтому плата считает те же значения, что и превью редактора.
enum : uint8_t { LCB_E_LINEAR, LCB_E_IN, LCB_E_OUT, LCB_E_INOUT, LCB_E_STEP };
enum : uint8_t { LCB_LOOP, LCB_PINGPONG, LCB_ONCE, LCB_VALUE };
struct LcbKey { uint32_t t; int16_t v; uint8_t e; };     // время (мс), значение, плавность до следующего ключа
struct LcbKeyC { uint32_t t; uint16_t c; uint8_t e; };   // то же для цвета RGB565: каналы меняются по отдельности
// режим и длительность (мс); для LCB_VALUE ещё диапазон значения lo…hi и догон follow (мс); остальное — состояние
struct LcbAnim {
  uint8_t mode; uint32_t dur; int32_t lo, hi; uint32_t follow;
  uint32_t start = 0; bool run = false; int32_t from = 0, to = 0; uint32_t t0 = 0;
  LcbAnim(uint8_t m, uint32_t d, int32_t l = 0, int32_t h = 1, uint32_t f = 0) : mode(m), dur(d), lo(l), hi(h), follow(f) {}
};
uint32_t lcbNow = 0;   // время кадра: его ставит tick…(now)`.split('\n');
    }
    function lcbAnimLib() {
        return `// ----- анимации: функции -----
inline int32_t lcbEase(uint8_t e, int32_t p) {   // p: 0…1024
  switch (e) {
    case LCB_E_IN: return p * p >> 10;
    case LCB_E_OUT: return 1024 - ((1024 - p) * (1024 - p) >> 10);
    case LCB_E_INOUT: return p < 512 ? p * p >> 9 : 1024 - ((1024 - p) * (1024 - p) >> 9);
    case LCB_E_STEP: return 0;
    default: return p;
  }
}
// значение дорожки в момент t
template <size_t N> inline int16_t lcbKey(const LcbKey (&k)[N], uint32_t t) {
  if (t <= k[0].t) return k[0].v;
  for (size_t i = 0; i + 1 < N; i++) {
    if (t >= k[i + 1].t) continue;
    int32_t e = lcbEase(k[i].e, (int64_t)(t - k[i].t) * 1024 / (k[i + 1].t - k[i].t));
    return k[i].v + (int32_t)(k[i + 1].v - k[i].v) * e / 1024;
  }
  return k[N - 1].v;
}
template <size_t N> inline uint16_t lcbKeyC(const LcbKeyC (&k)[N], uint32_t t) {
  if (t <= k[0].t) return k[0].c;
  for (size_t i = 0; i + 1 < N; i++) {
    if (t >= k[i + 1].t) continue;
    int32_t e = lcbEase(k[i].e, (int64_t)(t - k[i].t) * 1024 / (k[i + 1].t - k[i].t));
    int32_t a = k[i].c, b = k[i + 1].c;
    int32_t r = (a >> 11) + ((b >> 11) - (a >> 11)) * e / 1024;
    int32_t g = ((a >> 5) & 63) + (((b >> 5) & 63) - ((a >> 5) & 63)) * e / 1024;
    int32_t bl = (a & 31) + ((b & 31) - (a & 31)) * e / 1024;
    return r << 11 | g << 5 | bl;
  }
  return k[N - 1].c;
}
// LCB_VALUE: показанное значение — догоняет новое за follow мс с торможением
inline int32_t lcbValue(const LcbAnim& a, uint32_t now) {
  if (!a.run) return a.lo;
  int32_t dt = (int32_t)(now - a.t0);
  if (dt < 0) dt = 0;
  if (a.follow && (uint32_t)dt < a.follow) return a.from + (int64_t)(a.to - a.from) * lcbEase(LCB_E_OUT, (int64_t)dt * 1024 / a.follow) / 1024;
  return a.to;
}
inline void lcbStart(LcbAnim& a) { a.start = millis(); a.run = true; }
inline void lcbSet(LcbAnim& a, int32_t v) { uint32_t now = millis(); a.from = lcbValue(a, now); a.to = v; a.t0 = now; a.run = true; }
// момент анимации (мс от её начала) в кадре lcbNow
inline uint32_t lcbTime(const LcbAnim& a) {
  uint32_t now = lcbNow;
  switch (a.mode) {
    case LCB_LOOP: return (now - a.start) % a.dur;
    case LCB_PINGPONG: { uint32_t ph = (now - a.start) % (2 * a.dur); return ph <= a.dur ? ph : 2 * a.dur - ph; }
    case LCB_ONCE: {
      if (!a.run || (int32_t)(now - a.start) < 0) return 0;
      uint32_t e = now - a.start;
      return e < a.dur ? e : a.dur;
    }
    default: {
      int32_t v = lcbValue(a, now);
      if (v < a.lo) v = a.lo;
      if (v > a.hi) v = a.hi;
      return (uint32_t)((int64_t)(v - a.lo) * a.dur / (a.hi - a.lo));
    }
  }
}`.split('\n');
    }
    // one key array: { time, value, easing }; a text key's value is the number of its case in the switch
    function keyArrayLines(T) {
        const { tr, s } = T, c = COLOR_P(tr.p), E = k => STEP_P(tr.p) ? 'LCB_E_STEP' : EASES.find(x => x[0] === k.e)[2];
        const val = (k, i) => tr.p === 'text' ? i : c ? (k.pc && palEntry(k.pc) ? k.pc : fmt565(k.v)) : k.v;
        const items = tr.keys.map((k, i) => `{ ${k.t}, ${val(k, i)}, ${E(k)} }`), head = `const ${c ? 'LcbKeyC' : 'LcbKey'} ${T.arr}[] = {`, note = `// ${s.name}: ${propName(s, tr.p)}`;
        if (items.length <= 4 && tr.p !== 'text') return [`${head} ${items.join(', ')} };  ${note}`];
        return [`${head}  ${note}`, ...items.map((it, i) => `  ${it},${tr.p === 'text' ? `  // «${String(tr.keys[i].v).replace(/\n/g, ' ')}»` : ''}`), '};'];
    }
    function animBlockLines(sc, list) {
        const out = [`// ---------- анимации экрана «${sc.name}» ----------`];
        for (const A of list) {
            const a = A.a, m = MODES.find(x => x[0] === a.mode);
            out.push(`// «${a.name}»: ${m[1]}` + (a.mode === 'value' ? ` ${a.lo}…${a.hi} (вся шкала — ${a.dur} мс)${a.follow ? `, догон ${a.follow} мс` : ''} — ${A.fn}(v)` : `, ${a.dur} мс${a.mode === 'once' ? ` — запуск: ${A.fn}()` : ''}`));
            out.push(`LcbAnim ${A.v} = { ${m[2]}, ${a.dur}${a.mode === 'value' ? `, ${a.lo}, ${a.hi}, ${a.follow}` : ''} };`);
            if (a.mode === 'once') out.push(`void ${A.fn}() { lcbStart(${A.v}); }`);
            if (a.mode === 'value') out.push(`void ${A.fn}(int32_t v) { lcbSet(${A.v}, v); }`);
            for (const T of A.tracks) out.push(...keyArrayLines(T));
            out.push('');
        }
        return out;
    }

    // ---------- charts in the sketch (C++ twin of drawChart above) ----------
    function chartLines(s, e, bg, mgr) {
        const n = s.data.length, d = e.arr, c = colStr(s), pie = s.kind === 'pie', G = s.grid | 0, gc = fmt565(s.gc);
        const L = [`// график «${s.var}»${customName(s) ? ' — ' + s.name : ''}: ${CHART_KINDS.find(k => k[0] === s.kind)[1]}, ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'точка' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'точки' : 'точек'}${pie ? '' : s.auto ? ', диапазон по данным' : `, ${s.lo | 0}…${s.hi | 0}`}`,
            `int16_t ${d}[${n}] = { ${s.data.join(', ')} };   // данные: меняй их или добавляй через ${e.push}(v)`,
            `// новое значение справа, старые сдвигаются влево${mgr ? ' (экран перерисуется в lcbTick)' : `; потом ${e.fn}(); present();`}`,
            `void ${e.push}(int16_t v) {`, `  memmove(${d}, ${d} + 1, sizeof(${d}) - sizeof(${d}[0]));`, `  ${d}[${n - 1}] = v;`, ...(mgr ? ['  lcbDirty = true;'] : []), '}',
            `void ${e.fn}() {`, `  const int16_t x = ${s.x}, y = ${s.y}, w = ${s.w}, h = ${s.h}, n = ${n};`,
            ...(s.erase !== 'none' ? [`  canvas.fillRect(x, y, w, h, ${s.erase === 'color' ? fmt565(s.ec) : bg});  // стереть область`] : [])];
        if (pie) L.push(`  static const uint16_t cols[] = { ${s.cols.map(fmt565).join(', ')} };`,
            '  int32_t total = 0;', `  for (int i = 0; i < n; i++) if (${d}[i] > 0) total += ${d}[i];`, '  if (!total) return;',
            '  const int16_t cx = x + (w - 1) / 2, cy = y + (h - 1) / 2, r = (w < h ? w : h) / 2 - 1;', '  int32_t cum = 0;',
            '  for (int i = 0; i < n; i++) {', `    int32_t a = cum * 360 / total; cum += ${d}[i] > 0 ? ${d}[i] : 0; int32_t a1 = cum * 360 / total;`,
            '    while (a < a1) {   // доля — веер треугольников по 5°, углы от верха по часовой', '      int32_t b = a + 5 < a1 ? a + 5 : a1;',
            `      canvas.fillTriangle(cx, cy, cx + ((r * lcbSin(a) + 8192) >> 14), cy - ((r * lcbSin(a + 90) + 8192) >> 14), cx + ((r * lcbSin(b) + 8192) >> 14), cy - ((r * lcbSin(b + 90) + 8192) >> 14), cols[i % ${s.cols.length}]);`,
            '      a = b;', '    }', '  }');
        else {
            L.push(...(s.auto ? [`  int32_t lo = ${d}[0], hi = ${d}[0];`, `  for (int i = 1; i < n; i++) { if (${d}[i] < lo) lo = ${d}[i]; if (${d}[i] > hi) hi = ${d}[i]; }`] : [`  int32_t lo = ${s.lo | 0}, hi = ${s.hi | 0};`]),
                '  if (hi <= lo) hi = lo + 1;', ...(G ? [`  for (int g = 1; g <= ${G}; g++) canvas.drawFastHLine(x, y + (h - 1) * g / ${G + 1}, w, ${gc});`] : []),
                ...(s.border ? [`  canvas.drawRect(x, y, w, h, ${gc});`] : []), '  auto V = [&](int32_t v) { return v < lo ? lo : v > hi ? hi : v; };');
            if (s.kind === 'bar') L.push('  for (int i = 0; i < n; i++) {', `    int16_t bx = x + i * w / n, bw = x + (i + 1) * w / n - bx - ${s.gap | 0}, bh = (V(${d}[i]) - lo) * h / (hi - lo);`,
                '    if (bw < 1) bw = 1;', `    if (bh > 0) canvas.fillRect(bx, y + h - bh, bw, bh, ${c});`, '  }');
            else {
                L.push('  auto X = [&](int i) { return (int16_t)(x + i * (w - 1) / (n - 1)); };', '  auto Y = [&](int32_t v) { return (int16_t)(y + h - 1 - (V(v) - lo) * (h - 1) / (hi - lo)); };');
                if (s.kind === 'area') L.push('  for (int i = 1; i < n; i++) {   // заливка под линией', `    canvas.fillTriangle(X(i - 1), Y(${d}[i - 1]), X(i), Y(${d}[i]), X(i), y + h - 1, ${fmt565(s.fc)});`,
                    `    canvas.fillTriangle(X(i - 1), Y(${d}[i - 1]), X(i), y + h - 1, X(i - 1), y + h - 1, ${fmt565(s.fc)});`, '  }');
                L.push(`  for (int i = 1; i < n; i++) canvas.drawLine(X(i - 1), Y(${d}[i - 1]), X(i), Y(${d}[i]), ${c});`);
                if (s.dots) L.push(`  for (int i = 0; i < n; i++) canvas.fillCircle(X(i), Y(${d}[i]), 2, ${c});`);
            }
        }
        L.push('}');
        return L;
    }

    // ---------- screens and transitions in the sketch (C++ twin of transPixels below) ----------
    const TRANS = [['none', 'мгновенно', 'LCB_T_NONE'], ['slide-left', 'сдвиг влево', 'LCB_T_SLIDE_LEFT'], ['slide-right', 'сдвиг вправо', 'LCB_T_SLIDE_RIGHT'], ['slide-up', 'сдвиг вверх', 'LCB_T_SLIDE_UP'], ['slide-down', 'сдвиг вниз', 'LCB_T_SLIDE_DOWN'],
        ['wipe-left', 'шторка влево', 'LCB_T_WIPE_LEFT'], ['wipe-right', 'шторка вправо', 'LCB_T_WIPE_RIGHT'], ['wipe-up', 'шторка вверх', 'LCB_T_WIPE_UP'], ['wipe-down', 'шторка вниз', 'LCB_T_WIPE_DOWN'], ['fade', 'затухание через цвет', 'LCB_T_FADE']];
    // the transition onto a screen (screen.tr, set on its tab); absent → instant
    const trOf = sc => Object.assign({ type: 'none', dur: 300, ease: 'inout', c: 0x0000 }, sc.tr || {});
    const trColor = tr => tr.pc && palEntry(tr.pc) ? tr.pc : fmt565(tr.c);
    const trName = tr => tr.type === 'none' ? 'мгновенно' : `${TRANS.find(x => x[0] === tr.type)[1]}${tr.type === 'fade' ? ' ' + trColor(tr) : ''}, ${tr.dur} мс`;
    const easeC = e => EASES.find(x => x[0] === e)[2];
    // types go above every function of the sketch (the Arduino IDE puts its prototypes before the first one)
    function mgrTypes(P) {
        return ['// ---------- экраны и переходы: типы ----------', `enum : uint8_t { ${TRANS.map(x => x[2]).join(', ')} };`,
            'struct LcbTrans { uint8_t type, ease; uint32_t dur; uint16_t color; };   // переход: вид, плавность, длительность (мс), цвет затухания',
            `enum Screen : uint8_t { ${P.scr.join(', ')} };`, 'bool lcbDirty = true;   // текущий экран надо перерисовать в lcbTick'];
    }
    function mgrLines(P) {
        return `// ---------- LCD Canvas Builder: экраны и переходы ----------
// goTo(SCR_…) — переход по умолчанию этого экрана (задаётся на его вкладке в редакторе);
// goTo(SCR_…, LCB_T_…, мс) или goTo(SCR_…, LCB_T_…, мс, плавность, цвет) — любой другой.
// lcbTick(millis()) в loop() рисует текущий экран (с анимациями — каждый кадр, без них — только когда нужно)
// или кадр перехода и вызывает present(). Сдвигу и шторке нужен второй буфер кадра (W × H × 2 байт):
// он берётся в PSRAM, если она есть; если памяти не хватило, переход становится мгновенным.
void (*const lcbScreens[])() = { ${P.fns.join(', ')} };   // функции экранов по номеру Screen
const bool lcbLive[] = { ${S.screens.map(sc => String(sc.anims.some(a => a.tracks.length))).join(', ')} };   // экран с анимациями перерисовывается каждый кадр
const LcbTrans lcbTrDefault[] = {   // переход на экран по умолчанию
${S.screens.map((sc, k) => { const tr = trOf(sc); return `  { ${TRANS.find(x => x[0] === tr.type)[2]}, ${easeC(tr.ease)}, ${tr.dur}, ${trColor(tr)} },  // «${sc.name}»: ${trName(tr)}`; }).join('\n')}
};
Screen lcbScr = ${P.scr[0]}, lcbFrom = ${P.scr[0]};   // текущий экран и тот, с которого идёт переход
LcbTrans lcbTr = { LCB_T_NONE, LCB_E_INOUT, 0, 0 };
uint32_t lcbTrT0 = 0;
uint16_t* lcbPrev = nullptr;    // кадр, с которого начался сдвиг или шторка

// перерисовать текущий экран в следующем lcbTick (например, после нового значения меняющегося текста)
inline void lcbRedraw() { lcbDirty = true; }

void goTo(Screen s, uint8_t type, uint32_t ms, uint8_t ease, uint16_t color) {
  if (type != LCB_T_NONE && type != LCB_T_FADE && ms) {
    if (!lcbPrev) lcbPrev = (uint16_t*)(psramFound() ? ps_malloc((size_t)W * H * 2) : malloc((size_t)W * H * 2));
    if (lcbPrev) memcpy(lcbPrev, canvas.getBuffer(), (size_t)W * H * 2);
    else type = LCB_T_NONE;   // памяти не хватило — переход мгновенный
  }
  lcbFrom = lcbScr; lcbScr = s;
  lcbTr.type = ms ? type : (uint8_t)LCB_T_NONE; lcbTr.ease = ease; lcbTr.dur = ms; lcbTr.color = color;
  lcbTrT0 = millis(); lcbDirty = true;
}
void goTo(Screen s, uint8_t type, uint32_t ms) { goTo(s, type, ms, LCB_E_INOUT, 0x0000); }
void goTo(Screen s) { const LcbTrans& d = lcbTrDefault[s]; goTo(s, d.type, d.dur, d.ease, d.color); }

// RGB565 от a к b, k: 0…1024
inline uint16_t lcbMix(uint16_t a, uint16_t b, int32_t k) {
  int32_t r = (a >> 11) + ((b >> 11) - (a >> 11)) * k / 1024;
  int32_t g = ((a >> 5) & 63) + (((b >> 5) & 63) - ((a >> 5) & 63)) * k / 1024;
  int32_t bl = (a & 31) + ((b & 31) - (a & 31)) * k / 1024;
  return r << 11 | g << 5 | bl;
}
// кадр перехода, p: 0…1024 после плавности. Новый экран рисуется на холсте, старый берётся из lcbPrev;
// затухание: первая половина — старый экран к цвету, вторая — от цвета к новому (второй буфер не нужен)
void lcbTransFrame(int32_t p) {
  uint16_t* buf = canvas.getBuffer();
  if (lcbTr.type == LCB_T_FADE) {
    bool first = p < 512;
    lcbScreens[first ? lcbFrom : lcbScr]();
    int32_t k = first ? p * 2 : (1024 - p) * 2;
    for (uint32_t i = 0; i < (uint32_t)W * H; i++) buf[i] = lcbMix(buf[i], lcbTr.color, k);
    return;
  }
  lcbScreens[lcbScr]();
  int32_t dx = W * p / 1024, dy = H * p / 1024;
  switch (lcbTr.type) {
    case LCB_T_SLIDE_LEFT:   // новый въезжает справа
      for (int y = 0; y < H; y++) { uint16_t* r = buf + y * W; memmove(r + W - dx, r, dx * 2); memcpy(r, lcbPrev + y * W + dx, (W - dx) * 2); }
      break;
    case LCB_T_SLIDE_RIGHT:  // новый въезжает слева
      for (int y = 0; y < H; y++) { uint16_t* r = buf + y * W; memmove(r, r + W - dx, dx * 2); memcpy(r + dx, lcbPrev + y * W, (W - dx) * 2); }
      break;
    case LCB_T_SLIDE_UP:     // новый въезжает снизу
      memmove(buf + (H - dy) * W, buf, (size_t)dy * W * 2); memcpy(buf, lcbPrev + dy * W, (size_t)(H - dy) * W * 2);
      break;
    case LCB_T_SLIDE_DOWN:   // новый въезжает сверху
      memmove(buf, buf + (H - dy) * W, (size_t)dy * W * 2); memcpy(buf + dy * W, lcbPrev, (size_t)(H - dy) * W * 2);
      break;
    case LCB_T_WIPE_LEFT:    // новый открывается от правого края
      for (int y = 0; y < H; y++) memcpy(buf + y * W, lcbPrev + y * W, (W - dx) * 2);
      break;
    case LCB_T_WIPE_RIGHT:   // от левого края
      for (int y = 0; y < H; y++) memcpy(buf + y * W + dx, lcbPrev + y * W + dx, (W - dx) * 2);
      break;
    case LCB_T_WIPE_UP:      // от нижнего края
      memcpy(buf, lcbPrev, (size_t)(H - dy) * W * 2);
      break;
    case LCB_T_WIPE_DOWN:    // от верхнего края
      memcpy(buf + dy * W, lcbPrev + dy * W, (size_t)(H - dy) * W * 2);
      break;
  }
}
// вызывай в loop(): lcbTick(millis());
void lcbTick(uint32_t now) {
  lcbNow = now;
  if (lcbTr.type != LCB_T_NONE) {
    uint32_t e = now - lcbTrT0;
    if (e < lcbTr.dur) { lcbTransFrame(lcbEase(lcbTr.ease, (int64_t)e * 1024 / lcbTr.dur)); present(); return; }
    lcbTr.type = LCB_T_NONE; lcbDirty = true;   // переход закончился
  }
  if (!lcbDirty && !lcbLive[lcbScr]) return;
  lcbDirty = false;
  lcbScreens[lcbScr]();
  present();
}`.split('\n');
    }

    function buildLines(P = plan(S.codeMode === 'full')) {
        const L = t => ({ t, i: -1 }), ind = l => ({ ...l, t: l.t ? '  ' + l.t : l.t });
        const pal = S.palette.map(p => L(`constexpr uint16_t ${p.n} = ${fmt565(p.c)};`));
        const all = P.vis.flatMap((v, k) => v.map(s => ({ s, k, e: P.shapes.get(s) })));
        const imgs = all.filter(o => isPic(o.s)), vars = all.filter(o => o.s.t === 'text' && o.s.var), header = S.imgHeader && imgs.length > 0;
        const arrays = () => imgs.flatMap(o => [...withScreen(o.k, () => imgArrayLines(o.s, o.e)).map(l => ({ i: -1, ...l })), L('')]);
        if (S.codeMode === 'images' && header) return [L('// images.h — картинки для скетча'), L('#pragma once'), L('#include <Arduino.h>'), L(''), ...arrays()];
        if (S.codeMode === 'snippet') {
            const cur = P.vis[S.cur], notes = [], E = s => P.shapes.get(s);
            if (cur.some(isPic)) notes.push(L(`// массивы картинок — в режиме «весь скетч»${header ? ' (images.h)' : ''}`));
            if (cur.some(s => s.t === 'text' && s.var)) notes.push(L('// функции меняющегося текста — в режиме «весь скетч»'));
            if (cur.some(s => s.t === 'chart')) notes.push(L('// данные и функции графиков — в режиме «весь скетч»'));
            if (cur.some(s => usesLcb(s, E(s)))) notes.push(L(`// функции lcb… (градиенты и сглаживание${cur.some(s => opaOn(s, E(s)) || scrolls(s)) ? ', непрозрачность, бегущая строка' : ''}) — в режиме «весь скетч»`));
            if (cur.some(s => rotOn(s, E(s)))) notes.push(L('// поворот: LcbPt и lcbRot… — в режиме «весь скетч»'));
            if (S.screens[S.cur].anims.some(a => a.tracks.length)) notes.push(L('// анимации — в режиме «весь скетч»; здесь — кадр, на котором стоит бегунок'));
            const pre = [...pal, ...constLines(cur, P).map(L), ...notes], body = screenLines(S.cur, P, false);
            return pre.length ? [...pre, L(''), ...body] : body;
        }
        const fonts = [...new Set(all.filter(o => o.s.t === 'text' && o.s.font).map(o => o.s.font))], consts = all.flatMap(o => constLines([o.s], P)).map(L);
        const charts = all.filter(o => o.s.t === 'chart');
        const paint = all.some(o => usesLcb(o.s, o.e)), rot = all.some(o => rotOn(o.s, o.e)) || charts.some(o => o.s.kind === 'pie'), anim = P.mgr || P.ticks.some(Boolean), lib = t => ({ t, i: -1, lib: true });
        const out = [
            L('#include <Waveshare_LCD147.h>'), L('#include <Adafruit_GFX.h>'), ...fonts.map(f => L(FONT_DATA[f] && FONT_DATA[f].custom ? `#include "${f}.h"  // шрифт проекта, файл — в разделе «Шрифты»` : `#include <Fonts/${f}.h>`)), ...(header ? [L('#include "images.h"')] : []), L(''),
            L(`constexpr int W = ${S.W};   // ширина экрана`), L(`constexpr int H = ${S.H};   // высота экрана`), L(''),
            ...(pal.length ? [...pal, L('')] : []),
            ...(consts.length ? [L('// координаты именованных элементов'), ...consts, L('')] : []),
            L('St7789* lcd;                 // драйвер (твоя библиотека)'), L('GFXcanvas16 canvas(W, H);    // холст в памяти, на нём рисуем'), L(''),
            ...(header ? [] : arrays()),
            ...(anim ? [...lcbAnimTypes().map(lib), L('')] : []),
            ...(P.mgr ? [...mgrTypes(P).map(lib), L('')] : []),
            ...(rot ? [L('struct LcbPt { int16_t x, y; };   // точка после поворота lcbRot() (типы — выше всех функций скетча)'), L('')] : []),
            ...(paint ? [...lcbLib(all.some(o => o.s.t === 'text' && usesLcb(o.s, o.e) && !FONT_DATA[o.s.font]), all.some(o => opaOn(o.s, o.e)), all.some(o => scrolls(o.s))).map(t => ({ t, i: -1, lib: true })), L('')] : []),
            ...(rot ? [...lcbRotLib(all.some(o => isPic(o.s) && rotOn(o.s, o.e)), paint).map(t => ({ t, i: -1, lib: true })), L('')] : []),
            ...(anim ? [...lcbAnimLib().map(lib), L('')] : []),
            L('// Показать холст на экране'), L('void present() {'), L('  lcd->drawImage(0, 0, W, H, canvas.getBuffer());'), L('}'), L(''),
            ...vars.flatMap(o => [...(o.e.val ? [L(`String ${o.e.val} = "${cstr(varText(o.s))}";  // значение «${o.s.var}»: ${P.mgr ? 'экран перерисовывается целиком, когда его показывают' : 'экран с анимацией перерисовывается целиком каждый кадр'}`)] : []), ...varFnLines(o.s, o.e, bgExpr(S.screens[o.k])).map(L), L('')]),
            ...charts.flatMap(o => [...chartLines(o.s, o.e, bgExpr(S.screens[o.k]), P.mgr).map(L), L('')]),
            ...S.screens.flatMap((sc, k) => P.anims[k].length ? animBlockLines(sc, P.anims[k]).map(L) : []),
        ];
        // with several screens a screen can't rely on text settings left by another one; an animated screen can't rely on the previous frame
        const unknown = S.screens.length > 1;
        S.screens.forEach((sc, k) => {
            const used = P.anims[k].filter(A => A.tracks.length);
            out.push(L(`// Экран «${sc.name}»`), L(`void ${P.fns[k]}() {`), L(`  canvas.fillScreen(${bgExpr(sc)});  // фон`),
                ...(used.length ? [L(`  const uint32_t ${used.map(A => `${A.tv} = lcbTime(${A.v})`).join(', ')};  // момент анимаций, мс`)] : []),
                ...screenLines(k, P, unknown || !!P.ticks[k]).map(ind), L('}'), L(''));
            if (P.ticks[k]) out.push(L(`// Кадр экрана «${sc.name}» с анимациями: вызывай в loop() — ${P.ticks[k]}(millis());`), L(`void ${P.ticks[k]}(uint32_t now) {`), L('  lcbNow = now;'), L(`  ${P.fns[k]}();`), L('  present();'), L('}'), L(''));
        });
        if (P.mgr) out.push(...mgrLines(P).map(lib), L(''));
        out.push(L('void setup() {'), L('  Serial.begin(115200);'), L('  lcd = &Waveshare147::begin();'), L(''), ...(P.mgr ? [L(`  lcbTick(millis());  // первый экран «${S.screens[0].name}»`)] : [L(`  ${P.fns[0]}();`), L('  present();')]), L('}'), L(''), L('void loop() {'));
        if (P.mgr) {
            out.push(L('  lcbTick(millis());  // текущий экран с анимациями или кадр перехода'));
            S.screens.forEach((sc, k) => { if (k) out.push(L(`  // goTo(${P.scr[k]});  // на «${sc.name}»: ${trName(trOf(sc))}`)); });
            out.push(L(`  // goTo(${P.scr[0]}, LCB_T_FADE, 400, LCB_E_INOUT, 0x0000);  // или любой переход: вид, мс, плавность, цвет`));
        }
        if (P.ticks[0]) out.push(L(`  ${P.ticks[0]}(millis());  // кадр анимаций экрана «${S.screens[0].name}»`));
        S.screens.forEach((sc, k) => { if (k && P.ticks[k]) out.push(L(`  // ${P.ticks[k]}(millis());  // вместо него — когда показан экран «${sc.name}»`)); });
        for (const A of P.anims.flat()) {
            if (A.a.mode === 'once') out.push(L(`  // ${A.fn}();  // запустить «${A.a.name}»`));
            if (A.a.mode === 'value') out.push(L(`  // ${A.fn}(${Math.round((A.a.lo + A.a.hi) / 2)});  // «${A.a.name}»: значение ${A.a.lo}…${A.a.hi}`));
        }
        if (charts.length) { const o = charts[0]; out.push(L(`  // ${o.e.push}(analogRead(A0) / 40);  // новое значение графика «${o.s.var}»`)); if (!P.mgr) out.push(L(`  // ${o.e.fn}(); present();`)); }
        if (vars.length) {
            const o = vars[0];
            if (o.e.val && P.mgr) out.push(L('  // новое значение меняющегося текста (lcbRedraw — чтобы экран без анимаций перерисовался):'), L(`  // ${o.e.val} = "${cstr(varText(o.s))}"; lcbRedraw();`));
            else if (o.e.val) out.push(L('  // новое значение меняющегося текста (нарисуется со следующим кадром):'), L(`  // ${o.e.val} = "${cstr(varText(o.s))}";`));
            else out.push(L('  // пример обновления меняющегося текста:'), L(`  // ${o.e.fn}("${cstr(varText(o.s))}");`), L('  // present();'));
        }
        // the sketch allocates nothing per frame: the free heap printed here must stay the same
        if (P.mgr || P.ticks.some(Boolean)) out.push(L('  // Serial.printf("свободно: %u байт\\n", ESP.getFreeHeap());  // проверка памяти: число не должно уменьшаться'));
        out.push(L('}'));
        return out;
    }
    const hasHeaderMode = () => S.imgHeader && S.screens.some(sc => sc.shapes.some(isPic));
    function renderCode() {
        if (S.codeMode === 'images' && !hasHeaderMode()) S.codeMode = 'full';
        const lines = buildLines(), sel = new Set(S.sel), html = [];
        for (let n = 0; n < lines.length; n++) {
            const l = lines[n];
            if (l.data) { let m = n; while (m < lines.length && lines[m].data) m++; html.push(`<div class="t-c fold">  …  // ${m - n} строк данных — целиком при копировании</div>`); n = m - 1; continue; }
            if (l.lib) { let m = n; while (m < lines.length && lines[m].lib) m++; html.push(`<div>${hl(l.t)}</div><div class="t-c fold">…  // ещё ${m - n - 1} строк библиотеки lcb — целиком при копировании</div>`); n = m - 1; continue; }
            const k = l.k ?? S.cur, on = l.i >= 0 && k === S.cur && sel.has(l.i);
            html.push(`<div class="${l.i >= 0 ? 'shape' : ''}${on ? ' on' : ''}"${l.i >= 0 ? ` data-i="${l.i}" data-k="${k}"` : ''}>${hl(l.t) || ' '}</div>`);
        }
        codeEl.innerHTML = html.length ? html.join('') : '<div class="t-c">// холст пуст — нарисуй что-нибудь</div>';
        const on = codeEl.querySelector('.on'); if (on) { const r = on.offsetTop - codeEl.scrollTop; if (r < 0 || r > codeEl.clientHeight - 20) codeEl.scrollTop = on.offsetTop - codeEl.clientHeight / 2; }
        document.getElementById('modeImg').hidden = !hasHeaderMode();
        document.querySelectorAll('#codeMode button').forEach(b => b.setAttribute('aria-pressed', b.dataset.m === S.codeMode));
        document.getElementById('optConsts').checked = S.coordConsts; document.getElementById('optImgH').checked = S.imgHeader;
        document.getElementById('optMgrL').hidden = S.screens.length < 2; document.getElementById('optMgr').checked = S.mgr !== false;
    }
    codeEl.addEventListener('click', e => { const d = e.target.closest('[data-i]'); if (!d) return; if (+d.dataset.k !== S.cur) { S.cur = +d.dataset.k; triPts = null; preview = null; } setSel([+d.dataset.i]); S.tool = 'select'; update(); });
    document.getElementById('codeMode').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.codeMode = b.dataset.m; update(); } });
    document.getElementById('optConsts').addEventListener('change', e => { S.coordConsts = e.target.checked; update(); });
    document.getElementById('optMgr').addEventListener('change', e => { S.mgr = e.target.checked; update(); });
    document.getElementById('optImgH').addEventListener('change', e => { S.imgHeader = e.target.checked; if (!S.imgHeader && S.codeMode === 'images') S.codeMode = 'full'; update(); });
    const copyMsg = document.getElementById('copyMsg');
    document.getElementById('copyBtn').addEventListener('click', () => {
        const text = buildLines().map(l => l.t).join('\n');
        const fallback = () => { const r = document.createRange(); r.selectNodeContents(codeEl); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); copyMsg.textContent = 'Код выделен — нажми Ctrl+C / ⌘C (большие массивы в панели свёрнуты).'; };
        try { navigator.clipboard.writeText(text).then(() => { copyMsg.textContent = S.codeMode === 'images' ? 'Скопировано содержимое images.h.' : 'Скопировано.'; setTimeout(() => copyMsg.textContent = '', 2000); }, fallback); } catch (e) { fallback(); }
    });
    // code of the selected shapes, for the system clipboard on Ctrl/⌘+C
    function selectionCode() { const sel = new Set(S.sel); return screenLines(S.cur, plan(), false).filter(l => sel.has(l.i)).map(l => l.t).join('\n'); }

    // import
    // numbers, colours, palette names, W/H and int constants inside simple expressions
    function evalNum(expr, pal, vars) {
        expr = expr.trim(); if (pal && pal[expr] != null) return pal[expr];
        const c = parse565(expr);
        if (/^(0x|#)|^[A-Z_]*(BLACK|WHITE|RED|GREEN|BLUE|YELLOW|MAGENTA|CYAN|ORANGE)$/i.test(expr) && c != null) return c;
        const e = expr.replace(/\b[A-Za-z_]\w*\b/g, id => id === 'W' ? S.W : id === 'H' ? S.H : vars && vars[id] != null ? vars[id] : id);
        if (!/^[\d\s+\-*/().]+$/.test(e)) return null;
        try { const v = Function('return (' + e + ')')(); return Number.isFinite(v) ? Math.trunc(v) : null; } catch (_) { return null; }
    }
    const cunesc = t => t.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, e) => e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16)) : /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : { n: '\n', r: '\r', t: '\t' }[e] || e);
    // void name(params) { body } with braces matched outside string literals
    function splitFunctions(src) {
        const out = [], re = /\bvoid\s+(\w+)\s*\(([^)]*)\)\s*\{/g; let m;
        while ((m = re.exec(src))) {
            const i = blockEnd(src, re.lastIndex);
            out.push({ name: m[1], params: m[2].trim(), body: src.slice(re.lastIndex, i - 1), start: m.index, end: i }); re.lastIndex = i;
        }
        return out;
    }
    // a generated changing-text function → block geometry, style and alignment
    // arguments at the top level: commas inside strings and brackets don't split
    function splitArgs(raw) {
        const out = []; let cur = '', d = 0, q = false;
        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];
            if (q) { cur += ch; if (ch === '\\') cur += raw[++i]; else if (ch === '"') q = false; continue; }
            if (ch === '"') q = true; else if ('({['.includes(ch)) d++; else if (')}]'.includes(ch)) d--;
            if (ch === ',' && !d) { out.push(cur.trim()); cur = ''; } else cur += ch;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
    }
    // { LCB_LINEAR, dx, dy, n, { c… }, { p… }, dither } → grad of the model (angle back from dx, dy; positions back to %)
    function parsePaint(body, ctx) {
        const m = body.match(/^\s*(LCB_LINEAR|LCB_RADIAL)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(\d)\s*,\s*\{([^}]*)\}\s*,\s*\{([^}]*)\}\s*,\s*(true|false)\s*$/); if (!m) return null;
        const n = Math.min(4, +m[4]), cs = m[5].split(',').map(t => t.trim()), ps = m[6].split(',').map(t => +t.trim()), stops = [];
        for (let k = 0; k < n; k++) { const c = evalNum(cs[k], ctx.pal, ctx.vars); if (c == null) return null; const st = { c, p: Math.round(ps[k] * 100 / 4096) }; const pc = ctx.pcOf(cs[k]); if (pc) st.pc = pc; stops.push(st); }
        return { type: m[1] === 'LCB_RADIAL' ? 'radial' : 'linear', angle: m[1] === 'LCB_RADIAL' ? 0 : ((Math.round(Math.atan2(+m[3], +m[2]) * 180 / Math.PI) % 360) + 360) % 360, stops, dither: m[7] === 'true' };
    }
    // a paint argument: lcbSolid(colour) or the name of a LcbPaint constant
    function paintArg(t, ctx, paints) {
        t = (t || '').trim(); const so = t.match(/^lcbSolid\s*\((.*)\)$/);
        if (so) { const c = evalNum(so[1], ctx.pal, ctx.vars); return c == null ? null : { c, pc: ctx.pcOf(so[1]) }; }
        const g = paints[t]; return g ? { c: g.stops[0].c, pc: g.stops[0].pc || '', grad: g } : null;
    }
    const setPaint = (sh, P) => { sh.c = P.c; if (P.pc) sh.pc = P.pc; if (P.grad) sh.grad = JSON.parse(JSON.stringify(P.grad)); };
    const strArg = t => { const q = (t || '').match(/^"((?:\\.|[^"\\])*)"$/) || (t || '').match(/^cp1251\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)$/); return q ? cunesc(q[1]) : null; };
    function parseVarFn(f, ctx) {
        const v = { font: '', size: 1, c: 0xFFFF, pc: '', align: 'left', valign: 'top' }; let rect = false;
        for (const m of f.body.matchAll(/canvas\s*\.\s*(\w+)\s*\(([^;]*)\)\s*;/g)) {
            const fn = m[1], parts = m[2].split(',').map(t => t.trim()), num = t => evalNum(t, ctx.pal, ctx.vars);
            if (fn === 'fillRect' && !rect && parts.length === 5) { const a = parts.map(num); if (a.some(x => x == null)) return null; [v.x, v.y, v.w, v.h, v.ec] = a; v.epc = ctx.pcOf(parts[4]); v.eraseExpr = parts[4].replace(/\s/g, ''); rect = true; }
            if (fn === 'setFont') { const n = parts[0].replace(/^&/, ''); v.font = FONT_DATA[n] ? n : ''; }
            if (fn === 'setTextSize') v.size = Math.max(1, num(parts[0]) || 1);
            if (fn === 'setTextColor') { v.c = num(parts[0]) ?? 0xFFFF; v.pc = ctx.pcOf(parts[0]); }
            if (fn === 'setCursor') { v.align = !/\bbw\b/.test(parts[0]) ? 'left' : /\/\s*2/.test(parts[0]) ? 'center' : 'right'; v.valign = !/\bbh\b/.test(parts[1] || '') ? 'top' : /\/\s*2/.test(parts[1]) ? 'middle' : 'bottom'; }
        }
        // the gradient / smooth version: lcbText(cursor x, cursor y, value, font, size, paint, box…[, smooth font])
        const paints = {}; for (const m of f.body.matchAll(/const\s+LcbPaint\s+(\w+)\s*=\s*\{((?:[^{};]|\{[^{}]*\})*)\}\s*;/g)) { const g = parsePaint(m[2], ctx); if (g) paints[m[1]] = g; }
        const lt = f.body.match(/\blcbText(Glcd)?\s*\(([^;]*)\)\s*;/);
        if (lt) {
            const a = splitArgs(lt[2]), P = paintArg(a[lt[1] ? 4 : 5], ctx, paints);
            v.align = !/\bbw\b/.test(a[0]) ? 'left' : /\/\s*2/.test(a[0]) ? 'center' : 'right'; v.valign = !/\bbh\b/.test(a[1] || '') ? 'top' : /\/\s*2/.test(a[1]) ? 'middle' : 'bottom';
            if (P) { v.c = P.c; v.pc = P.pc; v.grad = P.grad; } v.aa = !lt[1] && a.length > 10;
        }
        const op = f.body.match(/\blcbOpacity\s*\(\s*(\d+)\s*\)/); if (op && +op[1] < 255) v.o = +op[1];
        return rect ? v : null;
    }
    // body of a block that starts at `from` (just after its '{'), braces matched outside string literals → index after the closing '}'
    function blockEnd(src, from) {
        let d = 1, i = from, q = false;
        for (; i < src.length && d; i++) { const ch = src[i]; if (q) { if (ch === '\\') i++; else if (ch === '"') q = false; } else if (ch === '"') q = true; else if (ch === '{') d++; else if (ch === '}') d--; }
        return i;
    }
    // an animated sketch → its frame at 0 ms: lcbKey(arr, t) is the first key of arr; if (N) / switch (N) keep only the branch that runs
    function staticFrame(src, pal, vars) {
        const first = {};
        for (const m of src.matchAll(/\bconst\s+LcbKeyC?\s+(\w+)\s*\[\s*\]\s*=\s*\{\s*\{\s*[^,{}]+,\s*([^,{}]+),/g)) { const v = evalNum(m[2], pal, vars); if (v != null) first[m[1]] = v; }
        const strs = {}; for (const m of src.matchAll(/\bString\s+(\w+)\s*=\s*("(?:\\.|[^"\\])*")\s*;/g)) strs[m[1]] = m[2];
        src = src.replace(/\blcbKeyC?\s*\(\s*(\w+)\s*,\s*\w+\s*\)/g, (m, n) => first[n] != null ? String(first[n]) : m).replace(/\b(\w+)\s*\.\s*c_str\s*\(\s*\)/g, (m, n) => strs[n] || m);
        const branches = src => {
            const re = /\b(if|switch)\s*\(\s*(-?\d+)\s*\)\s*\{/g; let m, out = '', last = 0;
            while ((m = re.exec(src))) {
                const end = blockEnd(src, re.lastIndex), body = src.slice(re.lastIndex, end - 1), n = +m[2]; let keep = '';
                if (m[1] === 'if') keep = n ? body : '';
                else { const cs = body.split(/\bcase\s+(-?\d+)\s*:/); for (let k = 1; k < cs.length; k += 2) if (+cs[k] === n) keep = cs[k + 1]; }
                out += src.slice(last, m.index) + ' ' + branches(keep) + ' '; last = end; re.lastIndex = end;
            }
            return out + src.slice(last);
        };
        return branches(src);
    }
    function parseCode(raw) {
        const names = {}; for (const m of raw.matchAll(/\/\/\s*Экран\s*«([^»\n]*)»\s*\n\s*void\s+(\w+)\s*\(/g)) names[m[2]] = m[1];
        let src = raw.replace(/("(?:\\.|[^"\\])*")|\/\/.*$|\/\*[\s\S]*?\*\//gm, (m, q) => q || '');
        const pal = {}, vars = {};
        for (const m of src.matchAll(/\b(?:constexpr|const)\s+uint16_t\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g)) { const v = evalNum(m[2], pal, vars); if (v != null) pal[m[1]] = v & 0xFFFF; }
        for (const m of src.matchAll(/\b(?:constexpr|const)\s+(?:int|int16_t|int32_t)\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g)) { if (m[1] === 'W' || m[1] === 'H') continue; const v = evalNum(m[2], pal, vars); if (v != null) vars[m[1]] = v; }
        const anim = /\bLcbAnim\b/.test(src); if (anim) src = staticFrame(src, pal, vars);
        const ctx = { pal, vars, varFns: {}, skipped: 0, imgSkipped: 0, anim, pcOf: a => a != null && pal[a.trim()] != null ? a.trim() : '' };
        const fns = splitFunctions(src);
        for (const f of fns) if (/^const\s+char\s*\*\s*\w+$/.test(f.params)) { const v = parseVarFn(f, ctx); if (v) ctx.varFns[f.name] = v; }
        // a chart function (drawИмяChart, starts with its box) is not a screen; its calls are counted for the warning
        const isChart = f => /^draw\w+Chart$/.test(f.name) && /^\s*const\s+int16_t\s+x\s*=/.test(f.body);
        ctx.chartSkipped = (src.match(/\bdraw\w+Chart\s*\(\s*\)\s*;/g) || []).length;
        const scr = fns.filter(f => !f.params && !['setup', 'loop', 'present'].includes(f.name) && !isChart(f) && /canvas\s*\./.test(f.body));
        if (scr.length) {
            const screens = scr.map(f => ({ name: names[f.name] || f.name.replace(/^draw(?=\w)/, ''), ...parseBody(f.body, ctx) }));
            // default transitions of the screen manager, in the order of the screens
            const td = src.match(/\blcbTrDefault\s*\[\s*\]\s*=\s*\{([\s\S]*?)\}\s*;/);
            if (td) [...td[1].matchAll(/\{\s*(LCB_T_\w+)\s*,\s*(LCB_E_\w+)\s*,\s*(\d+)\s*,\s*([^{}]+?)\s*\}/g)].forEach((m, k) => {
                const t = TRANS.find(x => x[2] === m[1]), e = EASES.find(x => x[2] === m[2]), c = evalNum(m[4], pal, vars); if (!screens[k] || !t || !e) return;
                screens[k].tr = { type: t[0], dur: +m[3], ease: e[0], c: c == null ? 0 : c }; if (ctx.pcOf(m[4])) screens[k].tr.pc = ctx.pcOf(m[4]);
            });
            return { ...ctx, multi: true, screens };
        }
        // no screen functions (a snippet or the old one-screen sketch): everything outside changing-text functions is one screen
        let rest = src; for (const f of fns.filter(f => ctx.varFns[f.name] || isChart(f)).reverse()) rest = rest.slice(0, f.start) + rest.slice(f.end);
        const screens = [parseBody(rest, ctx)]; return { ...ctx, multi: false, screens }; // counters are read after parsing
    }
    function parseBody(src, ctx) {
        const out = [], { pal, vars, pcOf } = ctx; let bg = null, bgPc = '', bgRaw = '';
        const T = { Rect: ['rect', ['x', 'y', 'w', 'h']], RoundRect: ['rrect', ['x', 'y', 'w', 'h', 'r']], Circle: ['circle', ['x', 'y', 'r']], Triangle: ['tri', ['x0', 'y0', 'x1', 'y1', 'x2', 'y2']], Line: ['line', ['x0', 'y0', 'x1', 'y1']], Pixel: ['pixel', ['x', 'y']] };
        const ts = { font: '', size: 1, c: 0xFFFF, pc: '', cx: 0, cy: 0 }; let group = null;
        const flush = () => {
            if (!group) return; const g = group; group = null;
            const x = Math.min(...g.lines.map(l => l.left)), r = Math.max(...g.lines.map(l => l.right));
            const align = g.lines.every(l => l.left === g.lines[0].left) ? 'left' : g.lines.every(l => l.right === g.lines[0].right) ? 'right' : 'center';
            const sh = { t: 'text', x, y: g.top, w: Math.max(1, r - x), h: fontMetrics(g.font, g.size).block(g.lines.length), text: g.lines.map(l => l.t).join('\n'), font: g.font, size: g.size, align, valign: 'top', c: g.c };
            if (g.pc) sh.pc = g.pc; add(sh);
        };
        // canvas.fn(args); or a call of a changing-text function: drawTemp("example");
        // canvas.fn(…); | const LcbPaint p = {…}; | lcbFill…/lcbDraw…/lcbText…(…); | a changing-text call drawTemp("example");
        // … | lcbOpacity(a); lcbClip(…); lcbRot…Bitmap(…); | const LcbPt p0 = lcbRot(…), p1 = …; (turned points: p0.x / p0.y in the calls after it)
        const re = /canvas\s*\.\s*(\w+)\s*\(((?:"(?:\\.|[^"\\])*"|[^;"])*)\)\s*;|const\s+LcbPaint\s+(\w+)\s*=\s*\{((?:[^{};]|\{[^{}]*\})*)\}\s*;|\b(lcb(?:Fill|Draw|Rot)\w+|lcbText\w*|lcbOpacity|lcbClip|lcbNoClip)\s*\(((?:"(?:\\.|[^"\\])*"|[^;"])*)\)\s*;|\b([A-Za-z_]\w*)\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)\s*;|const\s+LcbPt\s+([^;]*);/g; let m;
        const paints = {}, pts = {}; let tg = null, opaCur = 255;
        const sub = t => t && t.replace(/\b([A-Za-z_]\w*)\s*\.\s*([xy])\b/g, (q, n, k) => pts[n] ? String(pts[n][k === 'x' ? 0 : 1]) : q);
        const add = sh => { if (opaCur < 255) sh.o = opaCur; out.push(sh); };
        // consecutive lcbText lines of one block → one text block; its alignment is the one whose layout gives exactly these cursors
        const flushT = () => {
            if (!tg) return; const g = tg; tg = null;
            const sh = { t: 'text', x: g.X, y: g.Y, w: g.W, h: g.H, text: g.lines.map(l => l.t).join('\n'), font: g.font, size: g.size, align: 'left', valign: 'top' };
            search: for (const al of ['left', 'center', 'right']) for (const va of ['top', 'middle', 'bottom']) {
                const L = layoutText({ ...sh, align: al, valign: va });
                if (L.length === g.lines.length && L.every((l, k) => l.t === g.lines[k].t && l.cx === g.lines[k].cx && l.cy === g.lines[k].cy)) { sh.align = al; sh.valign = va; break search; }
            }
            setPaint(sh, g.P); if (g.aa) sh.aa = true; add(sh);
        };
        const lcbShape = (fn, a) => {
            const num = t => evalNum(t, pal, vars);
            if (/Bitmap$/.test(fn)) { ctx.imgSkipped++; return; }
            if (fn === 'lcbOpacity') { flush(); flushT(); const o = num(a[0] || ''); opaCur = o == null ? 255 : Math.max(0, Math.min(255, o)); return; }
            if (fn === 'lcbClip' || fn === 'lcbNoClip') return; // a scrolling text comes in as plain text where it stands
            if (fn === 'lcbDrawPixel') { const n = a.slice(0, 2).map(num), P = paintArg(a[2], ctx, paints); if (n.some(x => x == null) || !P) { ctx.skipped++; return; } flush(); flushT(); const sh = { t: 'pixel', x: n[0], y: n[1] }; setPaint(sh, P); delete sh.grad; add(sh); return; }
            // a turned rectangle: its four corners → two triangles / four lines
            const q = fn.match(/^lcb(Fill|Draw)Quad$/);
            if (q) {
                const n = a.slice(0, 8).map(num), P = paintArg(a[8], ctx, paints); if (n.length < 8 || n.some(x => x == null) || !P) { ctx.skipped++; return; }
                flush(); flushT(); const p = k => [n[2 * k], n[2 * k + 1]];
                const parts = q[1] === 'Fill' ? [[0, 1, 2], [0, 2, 3]].map(([i, j, k]) => ({ t: 'tri', fill: true, x0: p(i)[0], y0: p(i)[1], x1: p(j)[0], y1: p(j)[1], x2: p(k)[0], y2: p(k)[1] }))
                    : [[0, 1], [1, 2], [2, 3], [3, 0]].map(([i, j]) => ({ t: 'line', x0: p(i)[0], y0: p(i)[1], x1: p(j)[0], y1: p(j)[1] }));
                for (const sh of parts) { setPaint(sh, P); add(sh); } return;
            }
            if (fn === 'lcbText' || fn === 'lcbTextGlcd') {
                const glcd = fn === 'lcbTextGlcd', o = glcd ? 3 : 4, t = strArg(a[2]), font = glcd ? '' : (a[3] || '').replace(/^&/, '');
                const nums = [a[0], a[1], a[o], a[o + 2], a[o + 3], a[o + 4], a[o + 5]].map(num), P = paintArg(a[o + 1], ctx, paints);
                if (t == null || !P || nums.some(x => x == null) || (!glcd && !FONT_DATA[font])) { ctx.skipped++; return; }
                const [cx, cy, size, X, Y, W, H] = nums, aa = !glcd && a.length > 10, key = [X, Y, W, H, font, size, a[o + 1], aa].join('|');
                flush(); if (tg && tg.key !== key) flushT();
                if (!tg) tg = { key, X, Y, W, H, font, size: Math.max(1, size), P, aa, lines: [] };
                tg.lines.push({ t, cx, cy }); return;
            }
            const k = fn.match(/^lcb(Fill|Draw)(Rect|RoundRect|Circle|Line|Triangle)$/);
            const D = k && { Rect: ['rect', ['x', 'y', 'w', 'h']], RoundRect: ['rrect', ['x', 'y', 'w', 'h', 'r']], Circle: ['circle', ['x', 'y', 'r']], Line: ['line', ['x0', 'y0', 'x1', 'y1']], Triangle: ['tri', ['x0', 'y0', 'x1', 'y1', 'x2', 'y2']] }[k[2]];
            if (!D) { ctx.skipped++; return; }
            const nums = a.slice(0, D[1].length).map(num), P = paintArg(a[D[1].length], ctx, paints);
            if (nums.length < D[1].length || nums.some(x => x == null) || !P) { ctx.skipped++; return; }
            flush(); flushT();
            const sh = { t: D[0] }; if (META[D[0]].canFill) sh.fill = k[1] === 'Fill'; D[1].forEach((key, i) => sh[key] = nums[i]); setPaint(sh, P);
            if (/^\s*true\s*$/.test(a[D[1].length + 1] || '')) sh.aa = true;
            add(sh);
        };
        while ((m = re.exec(src))) {
            if (m[9]) { // turned points are worked out here, as lcbRot() does on the board
                for (const d of splitArgs(m[9])) {
                    const r = d.match(/^(\w+)\s*=\s*lcbRot\s*\((.*)\)$/s); if (!r) continue;
                    const a = splitArgs(sub(r[2])).map(t => evalNum(t, pal, vars)); if (a.length === 5 && a.every(x => x != null)) pts[r[1]] = rotPt(...a);
                }
                continue;
            }
            m[2] = sub(m[2]); m[6] = sub(m[6]);
            if (m[3]) { const g = parsePaint(m[4], ctx); if (g) paints[m[3]] = g; continue; }
            if (m[5]) { lcbShape(m[5], splitArgs(m[6])); continue; }
            if (m[7]) { m[3] = m[7]; m[4] = m[8]; }
            if (m[3]) {
                const v = ctx.varFns[m[3]]; if (!v) continue; flush(); flushT();
                const sh = { t: 'text', x: v.x, y: v.y, w: v.w, h: v.h, text: cunesc(m[4]), font: v.font, size: v.size, align: v.align, valign: v.valign, c: v.c, var: m[3].replace(/^draw(?=\w)/, '').replace(/^\w/, ch => ch.toLowerCase()) };
                if (v.pc) sh.pc = v.pc; if (v.grad) sh.grad = JSON.parse(JSON.stringify(v.grad)); if (v.aa) sh.aa = true; if (v.o != null) sh.o = v.o;
                if (v.eraseExpr === bgRaw) sh.erase = 'bg'; else { sh.erase = 'color'; sh.ec = v.ec; if (v.epc) sh.epc = v.epc; }
                add(sh); ts.font = v.font; ts.size = v.size; ts.c = v.c; ts.pc = v.pc; continue;
            }
            const fn = m[1], raw = m[2].trim(); flushT(); // keep the order of blocks
            if (fn === 'print' || fn === 'println') {
                const q = raw.match(/^"((?:\\.|[^"\\])*)"$/) || raw.match(/^cp1251\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)$/); if (!q && raw) { ctx.skipped++; continue; }
                const fm = fontMetrics(ts.font, ts.size);
                // '\n' (and println) works like Adafruit write('\n'): x = 0, y += line height
                (cunesc(q ? q[1] : '') + (fn === 'println' ? '\n' : '')).split('\n').forEach((t, k) => {
                    if (k) { ts.cx = 0; ts.cy += fm.pitch; }
                    t = t.replace(/\r/g, ''); if (!t) return;
                    const same = group && group.font === ts.font && group.size === ts.size && group.c === ts.c && group.pc === ts.pc;
                    if (same && ts.cy === group.lastCy && ts.cx === group.endCx) group.lines[group.lines.length - 1].t += t; // continues the previous print on the same line
                    else if (same && ts.cy === group.lastCy + fm.pitch) group.lines.push({ t, cx: ts.cx });
                    else { flush(); group = { font: ts.font, size: ts.size, c: ts.c, pc: ts.pc, top: ts.cy - fm.top, lines: [{ t, cx: ts.cx }] }; }
                    const l = group.lines[group.lines.length - 1], mm = measureStr(ts.font, ts.size, l.t);
                    l.left = l.cx + mm.l; l.right = l.left + mm.w;
                    ts.cx += advanceStr(ts.font, ts.size, t); group.lastCy = ts.cy; group.endCx = ts.cx;
                });
                continue;
            }
            if (/^draw(RGB|X|Grayscale)?Bitmap$/.test(fn)) { ctx.imgSkipped++; continue; }
            if (fn === 'setFont') { const f = raw.replace(/^&/, '').trim(); ts.font = FONT_DATA[f] ? f : ''; if (f && !FONT_DATA[f]) ctx.skipped++; continue; }
            if (fn === 'setTextWrap') continue;
            const parts = raw ? raw.split(',') : [], args = parts.map(a => evalNum(a, pal, vars));
            if (args.some(a => a == null)) { ctx.skipped++; continue; }
            if (fn === 'setTextSize') { ts.size = Math.max(1, args[0] || 1); continue; }
            if (fn === 'setTextColor') { ts.c = args[0]; ts.pc = pcOf(parts[0]); continue; }
            if (fn === 'setCursor') { ts.cx = args[0]; ts.cy = args[1]; continue; }
            if (fn === 'fillScreen') { bg = args[0]; bgPc = pcOf(parts[0]); bgRaw = parts[0].replace(/\s/g, ''); continue; }
            const k = fn.match(/^(draw|fill)(Rect|RoundRect|Circle|Triangle|Line|Pixel)$/);
            if (!k) { ctx.skipped++; continue; }
            const D = T[k[2]]; if (args.length !== D[1].length + 1) { ctx.skipped++; continue; }
            flush(); flushT();
            const sh = { t: D[0] }; if (META[D[0]].canFill) sh.fill = k[1] === 'fill'; D[1].forEach((key, i) => sh[key] = args[i]); sh.c = args[args.length - 1];
            const pc = pcOf(parts[parts.length - 1]); if (pc) sh.pc = pc; add(sh);
        }
        flush(); flushT();
        return { out, bg, bgPc };
    }
    const importMsg = document.getElementById('importMsg');
    // a snippet goes into the current screen; a sketch with screen functions replaces (or adds) whole screens
    function doImport(replace) {
        const r = parseCode(document.getElementById('importText').value), np = Object.keys(r.pal).length, n = r.screens.reduce((t, sc) => t + sc.out.length, 0);
        if (!n && r.screens.every(sc => sc.bg == null) && !np) { importMsg.textContent = 'Не нашёл вызовов canvas.* — проверь, что строки заканчиваются на «;».' + (r.imgSkipped ? ' Картинки (drawBitmap / drawRGBBitmap) не импортируются.' : ''); return; }
        push();
        for (const [k, c] of Object.entries(r.pal)) { const p = palEntry(k); if (p) p.c = c; else S.palette.push({ n: k, c }); }
        S.sel = [];
        if (r.multi) {
            const taken = replace ? [] : S.screens.map(sc => sc.name);
            const made = r.screens.map(sc => { const scr = blankScreen(uniqueName(sc.name || 'Экран', taken)); taken.push(scr.name); scr.shapes = sc.out; if (sc.bg != null) { scr.bg = sc.bg; scr.bgPc = sc.bgPc; } if (sc.tr) scr.tr = sc.tr; return scr; });
            if (replace) { S.screens = made; S.cur = 0; } else { S.screens.push(...made); S.cur = S.screens.length - made.length; }
        } else {
            const sc = r.screens[0];
            if (replace) { S.shapes = sc.out; S.groups = []; } else S.shapes.push(...sc.out);
            if (sc.bg != null) { S.bg = sc.bg; S.bgPc = sc.bgPc; }
        }
        S.screens.forEach((_, k) => withScreen(k, () => { ensureNames(); normalize(); }));
        importMsg.textContent = `Загружено фигур: ${n}${r.multi ? `, экранов: ${r.screens.length}` : ''}${np ? `, цветов палитры: ${np}` : ''}${r.skipped ? `, пропущено: ${r.skipped} (не разобрал аргументы)` : ''}${r.imgSkipped ? `. Картинки не импортируются — пропущено вызовов: ${r.imgSkipped}` : ''}${r.anim ? '. Анимации не импортируются — загружен кадр на 0 мс' : ''}${r.chartSkipped ? `. Графики не импортируются — пропущено: ${r.chartSkipped}` : ''}.`;
        syncSettings(); update();
    }
    const uniqueName = (base, taken) => { let n = base, k = 2; while (taken.includes(n)) n = base + ' ' + k++; return n; };
    document.getElementById('importBtn').onclick = () => doImport(true);
    document.getElementById('appendBtn').onclick = () => doImport(false);
    const clearBtn = document.getElementById('clearBtn'); let clearArm = 0;
    clearBtn.onclick = () => {
        if (Date.now() - clearArm < 3000) { push(); S.shapes = []; S.groups = []; S.sel = []; clearBtn.textContent = 'Очистить холст'; clearArm = 0; update(); return; }
        clearArm = Date.now(); clearBtn.textContent = 'Точно очистить?'; setTimeout(() => { if (clearArm && Date.now() - clearArm >= 2900) { clearBtn.textContent = 'Очистить холст'; clearArm = 0; } }, 3000);
    };

    // ---------- screens ----------
    const tabsEl = document.getElementById('tabs'); let tabsHtml = '';
    function renderTabs() {
        if (tabsEl.querySelector('input')) return; // rename in progress
        const html = S.screens.map((s, k) => `<button class="tab" data-k="${k}" aria-pressed="${k === S.cur}" title="Двойной клик — переименовать">${esc(s.name)}</button>`).join('')
            + '<button class="tab-b" data-a="cfg" title="Настройки экрана: фон и переход на него" aria-label="Настройки экрана">⚙</button><button class="tab-b" data-a="add" title="Новый экран" aria-label="Новый экран">+</button><button class="tab-b" data-a="dup" title="Дублировать экран" aria-label="Дублировать экран">⧉</button>'
            + `<button class="tab-b" data-a="del" title="Удалить экран" aria-label="Удалить экран"${S.screens.length < 2 ? ' disabled' : ''}>×</button>`;
        if (html !== tabsHtml) tabsEl.innerHTML = tabsHtml = html;
    }
    function switchScreen(k) { S.cur = k; S.sel = []; triPts = null; preview = null; update(); }
    tabsEl.addEventListener('click', e => {
        const t = e.target.closest('[data-k]'), b = e.target.closest('[data-a]');
        if (t) { if (+t.dataset.k !== S.cur) switchScreen(+t.dataset.k); return; }
        if (!b || b.disabled) return; const a = b.dataset.a, names = S.screens.map(sc => sc.name);
        if (a === 'cfg') { showScreenPanel(); return; }
        push();
        if (a === 'add') { const sc = blankScreen(uniqueName('Экран ' + (S.screens.length + 1), names)); sc.bg = S.bg; sc.bgPc = S.bgPc; S.screens.splice(S.cur + 1, 0, sc); S.cur++; }
        if (a === 'dup') {
            const sc = JSON.parse(JSON.stringify(S.screens[S.cur])); sc.name = uniqueName(sc.name + ' копия', names);
            const ids = new Set(S.screens.flatMap(x => x.shapes.map(s => s.var)).filter(Boolean));
            for (const s of sc.shapes) if (s.var) s.var = uniqueVar(s.var, ids); // a changing text needs its own function
            S.screens.splice(S.cur + 1, 0, sc); S.cur++;
        }
        if (a === 'del') { S.screens.splice(S.cur, 1); S.cur = Math.min(S.cur, S.screens.length - 1); }
        switchScreen(S.cur);
    });
    tabsEl.addEventListener('dblclick', e => {
        const t = e.target.closest('[data-k]'); if (!t) return; const sc = S.screens[+t.dataset.k];
        const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'tab-in'; inp.value = sc.name; inp.setAttribute('aria-label', 'Имя экрана');
        t.replaceWith(inp); inp.focus(); inp.select();
        let done = false;
        const fin = ok => {
            if (done) return; done = true; const v = inp.value.trim();
            if (ok && v && v !== sc.name) { push(); sc.name = uniqueName(v, S.screens.filter(x => x !== sc).map(x => x.name)); }
            inp.remove(); tabsHtml = ''; update();
        };
        inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') fin(true); if (ev.key === 'Escape') fin(false); });
        inp.addEventListener('blur', () => fin(true));
    });
    // ⚙: nothing selected → the panel shows this screen; its section is unfolded and scrolled into view
    function showScreenPanel() {
        S.sel = []; S.tool = 'select'; triPts = null; preview = null;
        const u = S.ui || (S.ui = {}); u.folded = (u.folded || []).filter(id => id !== 'shape'); applyLayout();
        update(); const sec = document.getElementById('inspector'); sec.scrollIntoView({ block: 'nearest' }); setArea(sec);
    }
    function uniqueVar(base, ids) { let n = base, k = 2; while (ids.has(n)) n = base + k++; ids.add(n); return n; }

    // ---------- timeline: animations of the current screen ----------
    // time is in ms everywhere; in the value mode the axis is labelled in values (value → moment: valueT)
    const tlEl = document.getElementById('tl'); let tlHtml = '';
    const INSET = 8; // px kept free at both ends of a lane, so that keys at 0 and at the end stay clickable
    // keep the open animation, the playhead and the selected keys valid after any change (undo, deleted shapes, a shorter animation)
    function animFix() {
        const as = anims(); if (!as[AN.k]) AN.k = Math.max(0, as.length - 1);
        const a = openAnim(); if (!a) { AN.rec = false; AN.sel = []; AN.t = 0; stopPlay(); return; }
        AN.t = Math.max(0, Math.min(a.dur, AN.t | 0));
        const live = new Set(a.tracks.flatMap(tr => tr.keys)); AN.sel = AN.sel.filter(k => live.has(k));
    }
    const trackOfKey = k => { const a = openAnim(); return a && a.tracks.find(tr => tr.keys.includes(k)); };
    const keyLabel = (a, t) => a.mode === 'value' ? String(tValue(a, t)) : t + ' мс';
    function niceStep(span, px, minPx) { const raw = span * minPx / Math.max(1, px), p = 10 ** Math.floor(Math.log10(raw || 1)); for (const m of [1, 2, 5, 10]) if (m * p >= raw) return Math.max(1, m * p); return 10 * p; }
    const tlPos = f => `calc(${INSET}px + (100% - ${2 * INSET}px) * ${Math.max(0, Math.min(1, f))})`;
    function renderTimeline() {
        if (tlEl.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]):not([type=range]),select')) { renderPlayhead(); return; } // don't rebuild under typing
        const as = anims(), a = openAnim(), sc = S.screens[S.cur];
        const chips = as.map((x, k) => `<button class="tl-a" data-k="${k}" aria-pressed="${k === AN.k}" title="Двойной клик — переименовать">${esc(x.name)}<span class="tl-n">${x.tracks.length}</span></button>`).join('');
        let h = `<div class="tl-head"><span class="tl-title">Анимации</span>${chips}<button class="tab-b" data-a="add" title="Новая анимация экрана" aria-label="Новая анимация">+</button>`;
        tlEl.toggleAttribute('data-folded', !!S.tlFolded && !!a); document.getElementById('splitTl').hidden = !a;
        if (!a) { tlEl.dataset.empty = ''; h += '<span class="msg">У этого экрана анимаций нет. Нажми +, двигай фигуры с включённой записью ● — получатся ключевые кадры.</span></div>'; }
        else {
            delete tlEl.dataset.empty;
            h += `<button class="tab-b" data-a="dup" title="Дублировать анимацию" aria-label="Дублировать анимацию">⧉</button><button class="tab-b" data-a="del" title="Удалить анимацию" aria-label="Удалить анимацию">×</button>
      <span class="seg" id="tlMode">${MODES.map(([m, l]) => `<button data-v="${m}" aria-pressed="${a.mode === m}">${l}</button>`).join('')}</span>
      <label class="set" title="Длительность, мс${a.mode === 'value' ? ': на весь диапазон значения' : ''}">длит. <input type="number" id="tlDur" min="1" max="600000" value="${a.dur}" style="width:72px"> мс</label>`
                + (a.mode === 'value' ? `<label class="set">от <input type="number" id="tlLo" value="${a.lo}" style="width:60px"></label><label class="set">до <input type="number" id="tlHi" value="${a.hi}" style="width:60px"></label>
      <label class="set" title="За сколько мс показ догоняет новое значение (0 — сразу)">догон <input type="number" id="tlFollow" min="0" max="60000" value="${a.follow}" style="width:60px"> мс</label>
      <label class="set" title="Проверить догон: задай значение, как setЗначение(v) на плате">значение <input type="number" id="tlVal" value="${tValue(a, AN.t)}" style="width:60px"></label>` : '')
                + `<span class="grow"></span><button class="btn tl-rec" id="tlRec" aria-pressed="${AN.rec}" title="Запись: любое изменение фигуры ставит ключ на бегунке">● запись</button>
      <button class="btn" id="tlPlay" title="Проиграть (пробел)" aria-label="${AN.play ? 'Пауза' : 'Проиграть'}">${AN.play ? '⏸' : '▶'}</button><span class="spec tl-time" id="tlTime"></span>
      <button class="tab-b" id="tlFold" title="${S.tlFolded ? 'Развернуть таймлайн' : 'Свернуть таймлайн: холсту больше места'}" aria-label="${S.tlFolded ? 'Развернуть таймлайн' : 'Свернуть таймлайн'}">${S.tlFolded ? '▴' : '▾'}</button></div>`;
            h += keyEditor(a);
            // ruler: ms, or values in the value mode
            const W = Math.max(100, (tlEl.clientWidth || 600) - 170), span = a.mode === 'value' ? a.hi - a.lo : a.dur, step = niceStep(span, W, 64), ticks = [];
            for (let u = 0; u <= span; u += step) ticks.push(`<span class="tl-tick" style="left:${tlPos(u / span)}">${a.mode === 'value' ? a.lo + u : u}</span>`);
            h += `<div class="tl-grid" id="tlGrid"><div class="tl-row tl-ruler"><div class="tl-lbl">${a.mode === 'value' ? 'значение' : 'мс'}</div><div class="tl-lane" data-lane>${ticks.join('')}</div></div>`;
            const sel = new Set(AN.sel), kf = (k, tr) => `<button class="kf${k.t > a.dur ? ' late' : ''}" data-tr="${a.tracks.indexOf(tr)}" data-kk="${tr.keys.indexOf(k)}" style="left:${tlPos(k.t / a.dur)}" aria-pressed="${sel.has(k)}" title="${escA(propName(S.shapes.find(s => s.id === tr.id), tr.p) + ' · ' + keyLabel(a, k.t) + ' · ' + keyValue(tr, k))}" aria-label="Ключ ${keyLabel(a, k.t)}"></button>`;
            const byShape = new Map(); for (const tr of a.tracks) { if (!byShape.has(tr.id)) byShape.set(tr.id, []); byShape.get(tr.id).push(tr); }
            for (const s of [...sc.shapes].reverse()) {
                const trs = byShape.get(s.id); if (!trs) continue;
                const fold = AN.fold.has(s.id), on = S.sel.some(i => S.shapes[i] === s), times = [...new Set(trs.flatMap(tr => tr.keys.map(k => k.t)))];
                h += `<div class="tl-row tl-shape${on ? ' on' : ''}" data-id="${s.id}"><div class="tl-lbl"><button class="ly-tw" data-a="fold" aria-label="${fold ? 'Развернуть' : 'Свернуть'}">${fold ? '▸' : '▾'}</button><svg class="ly-ic" viewBox="0 0 24 24">${ICONS[s.t]}</svg><span class="tl-nm">${esc(s.name || '')}</span></div><div class="tl-lane" data-lane>${times.map(t => `<span class="kf-sum${trs.every(tr => tr.keys.every(k => k.t !== t || sel.has(k))) ? ' on' : ''}" data-t="${t}" style="left:${tlPos(t / a.dur)}" title="${escA(`${s.name} · ${keyLabel(a, t)}: все ключи фигуры в этот момент`)}"></span>`).join('')}</div></div>`;
                if (!fold) for (const tr of trs.sort((p, q) => animProps(s).indexOf(p.p) - animProps(s).indexOf(q.p))) h += `<div class="tl-row"><div class="tl-lbl tl-prop">${esc(propName(s, tr.p))}</div><div class="tl-lane" data-lane>${tr.keys.map(k => kf(k, tr)).join('')}</div></div>`;
            }
            if (!a.tracks.length) h += `<div class="tl-row"><div class="tl-lbl"></div><div class="msg tl-empty">Ключей пока нет. ${AN.rec ? 'Запись включена: поставь бегунок и измени фигуру — двигай, тяни ручки, меняй цвет.' : 'Включи ● запись и измени фигуру или нажми ◆ у свойства в панели фигуры.'}</div></div>`;
            h += '<div class="tl-ph" id="tlPh"></div></div>';
        }
        if (h !== tlHtml) { tlEl.innerHTML = tlHtml = h; }
        renderPlayhead();
    }
    function keyValue(tr, k) { return tr.p === 'vis' ? (k.v ? 'видна' : 'скрыта') : tr.p === 'text' ? '«' + k.v + '»' : COLOR_P(tr.p) ? (k.pc || fmt565(k.v)) : tr.p === 'f' ? 'кадр ' + (k.v + 1) : String(k.v); }
    // selected keys: one → time, value and easing; several → common easing
    function keyEditor(a) {
        if (!AN.sel.length) return '';
        const ks = AN.sel, k = ks[0], tr = trackOfKey(k), s = tr && S.shapes.find(x => x.id === tr.id); if (!tr || !s) return '';
        const eSel = ks.every(x => !STEP_P(trackOfKey(x).p)) ? `<label class="set">плавность до следующего <select id="kfE">${EASES.map(([v, l]) => `<option value="${v}"${ks.every(x => x.e === v) ? ' selected' : ''}>${l}</option>`).join('')}${ks.some(x => x.e !== k.e) ? '<option value="" selected>—</option>' : ''}</select></label>` : '';
        if (ks.length > 1) return `<div class="tl-key"><span class="set">выбрано ключей: <b>${ks.length}</b></span>${eSel}<button class="btn danger" id="kfDel">Удалить</button><span class="msg">Рамка или Shift+клик — выбрать ещё, тяни или ← → — сдвинуть все (Shift — по 100 мс), ⌘/Ctrl+C / V — копировать на бегунок, ⌘/Ctrl+A — все ключи.</span></div>`;
        let val;
        if (tr.p === 'vis') val = `<label class="set"><input type="checkbox" id="kfVis"${k.v ? ' checked' : ''}> видна</label>`;
        else if (tr.p === 'text') val = `<input type="text" id="kfText" value="${escA(k.v)}" style="width:160px" aria-label="Текст">`;
        else if (COLOR_P(tr.p)) val = `<input type="color" id="kfC" value="${toHex(k.v)}" aria-label="Цвет">${S.palette.length ? `<select id="kfPc" aria-label="Из палитры"><option value="">${fmt565(k.v)}</option>${S.palette.map(p => `<option${p.n === k.pc ? ' selected' : ''}>${p.n}</option>`).join('')}</select>` : `<span class="spec">${fmt565(k.v)}</span>`}`;
        else val = `<input type="number" id="kfV" value="${tr.p === 'f' ? k.v + 1 : k.v}" style="width:64px" aria-label="${tr.p === 'f' ? 'Номер кадра' : 'Значение'}">`;
        return `<div class="tl-key"><span class="set"><b>${esc(s.name)}</b> · ${esc(propName(s, tr.p))}</span><label class="set">${a.mode === 'value' ? 'значение' : 'время, мс'} <input type="number" id="kfT" value="${a.mode === 'value' ? tValue(a, k.t) : k.t}" style="width:72px"></label>${val}${eSel}<button class="btn danger" id="kfDel">Удалить</button></div>`;
    }
    function renderPlayhead() {
        const a = openAnim(), ph = document.getElementById('tlPh'), tm = document.getElementById('tlTime'); if (!a) return;
        if (ph) ph.style.left = `calc(var(--lbl) + ${INSET}px + (100% - var(--lbl) - ${2 * INSET}px) * ${AN.t / a.dur})`;
        if (tm) tm.textContent = a.mode === 'value' ? `значение ${tValue(a, AN.t)} · ${AN.t} мс` : `${AN.t} / ${a.dur} мс`;
    }
    // a frame without the full update: playback and scrubbing
    function showFrame() { animApply(); render(); renderPlayhead(); }
    // lane x → ms (snapped to 10 ms unless Alt; near a key or the playhead it sticks to it)
    function laneT(e, r, a, keys) {
        const w = r.width - 2 * INSET, f = Math.max(0, Math.min(1, (e.clientX - r.left - INSET) / w));
        let t = Math.round(f * a.dur); if (!e.altKey) t = Math.min(a.dur, Math.round(t / 10) * 10);
        for (const kt of keys || []) if (Math.abs((kt - f * a.dur) / a.dur * w) <= 5) return kt;
        return t;
    }
    function stopPlay() { if (AN.play) { cancelAnimationFrame(AN.play.raf); AN.play = null; } if (AN.follow) { cancelAnimationFrame(AN.follow.raf); AN.follow = null; } }
    // playback in the editor: loop and ping-pong repeat, once stops at the end, the value mode sweeps there and back
    function togglePlay() {
        const a = openAnim(); if (!a) return;
        if (AN.play) { stopPlay(); update(); return; }
        stopPlay(); if (a.mode === 'once' && AN.t >= a.dur) AN.t = 0;
        const t0 = performance.now() - AN.t;
        const step = () => {
            const el = Math.floor(performance.now() - t0), d = a.dur;
            if (a.mode === 'loop') AN.t = el % d;
            else if (a.mode === 'once') AN.t = Math.min(el, d);
            else { const ph = el % (2 * d); AN.t = ph <= d ? ph : 2 * d - ph; }
            showFrame();
            if (a.mode === 'once' && AN.t >= d) { AN.play = null; update(); return; }
            AN.play.raf = requestAnimationFrame(step);
        };
        AN.play = { raf: requestAnimationFrame(step) }; renderTimeline();
    }
    // value mode: a new value is followed like lcbSet() does on the board
    function previewValue(a, v) {
        stopPlay(); const from = tValue(a, AN.t), f = { from, to: v, t0: performance.now() };
        if (!a.follow) { AN.t = valueT(a, v); update(); return; }
        const step = () => { AN.t = valueT(a, followV(a, f, performance.now())); showFrame(); if (performance.now() - f.t0 >= a.follow) { AN.follow = null; update(); return; } AN.follow.raf = requestAnimationFrame(step); };
        AN.follow = { raf: requestAnimationFrame(step) };
    }
    function newAnim(name) { return { name, mode: 'loop', dur: 1000, lo: 0, hi: 100, follow: 0, tracks: [] }; }
    tlEl.addEventListener('click', e => {
        const chip = e.target.closest('.tl-a'), b = e.target.closest('[data-a]'), a = openAnim();
        if (chip) { if (+chip.dataset.k !== AN.k) { stopPlay(); AN.k = +chip.dataset.k; AN.t = 0; AN.sel = []; update(); } return; }
        if (b && b.dataset.a === 'fold') { const id = +b.closest('[data-id]').dataset.id; AN.fold.has(id) ? AN.fold.delete(id) : AN.fold.add(id); renderTimeline(); return; }
        if (b) {
            const as = anims(), names = as.map(x => x.name); stopPlay(); push();
            if (b.dataset.a === 'add') { as.push(newAnim(uniqueName('Анимация ' + (as.length + 1), names))); AN.k = as.length - 1; AN.t = 0; AN.rec = true; }
            if (b.dataset.a === 'dup' && a) {
                const c = JSON.parse(JSON.stringify(a)); c.name = uniqueName(a.name + ' копия', names); c.tracks = []; // one property belongs to one animation: the copy starts empty but keeps the settings
                as.splice(AN.k + 1, 0, c); AN.k++; AN.t = 0;
            }
            if (b.dataset.a === 'del' && a) { as.splice(AN.k, 1); AN.k = Math.max(0, AN.k - 1); AN.t = 0; }
            AN.sel = []; update(); return;
        }
        const mode = e.target.closest('#tlMode button');
        if (mode && a && a.mode !== mode.dataset.v) { push(); a.mode = mode.dataset.v; update(); return; }
        if (e.target.closest('#tlRec')) { AN.rec = !AN.rec; renderTimeline(); renderInspector(); return; }
        if (e.target.closest('#tlPlay')) { togglePlay(); return; }
        if (e.target.closest('#tlFold')) { S.tlFolded = !S.tlFolded; update(); return; }
        if (e.target.closest('#kfDel')) { delKeys(); return; }
        const nm = e.target.closest('.tl-shape .tl-nm');
        if (nm) { const i = S.shapes.findIndex(s => s.id === +nm.closest('[data-id]').dataset.id); if (i >= 0) { setSel([i]); S.tool = 'select'; update(); } }
    });
    tlEl.addEventListener('dblclick', e => {
        const chip = e.target.closest('.tl-a'); if (!chip) return; const a = anims()[+chip.dataset.k];
        const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'tab-in'; inp.value = a.name; inp.setAttribute('aria-label', 'Имя анимации');
        chip.replaceWith(inp); inp.focus(); inp.select();
        let done = false;
        const fin = ok => { if (done) return; done = true; const v = inp.value.trim(); if (ok && v && v !== a.name) { push(); a.name = uniqueName(v, anims().filter(x => x !== a).map(x => x.name)); } inp.blur(); tlHtml = ''; update(); };
        inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') fin(true); if (ev.key === 'Escape') fin(false); });
        inp.addEventListener('blur', () => fin(true));
    });
    tlEl.addEventListener('change', e => {
        const a = openAnim(), id = e.target.id; if (!a) return;
        const num = (lo, hi) => { const v = Math.round(+e.target.value); return e.target.value === '' || isNaN(v) ? null : Math.max(lo, Math.min(hi, v)); };
        if (id === 'tlDur') { const v = num(1, 600000); if (v != null && v !== a.dur) { push(); a.dur = v; } }
        if (id === 'tlLo' || id === 'tlHi') {
            const v = num(-2e9, 2e9); if (v != null) { push(); if (id === 'tlLo') a.lo = v; else a.hi = v; if (a.hi <= a.lo) { if (id === 'tlLo') a.hi = a.lo + 1; else a.lo = a.hi - 1; } }
        }
        if (id === 'tlFollow') { const v = num(0, 60000); if (v != null) { push(); a.follow = v; } }
        if (id === 'tlVal') { const v = num(-2e9, 2e9); e.target.blur(); if (v != null) previewValue(a, v); return; }
        // key editor
        const k = AN.sel[0], tr = k && trackOfKey(k);
        if (id === 'kfE' && e.target.value) { push(); for (const x of AN.sel) if (!STEP_P(trackOfKey(x).p)) x.e = e.target.value; }
        if (tr && id === 'kfT') {
            let t = num(a.mode === 'value' ? Math.min(a.lo, a.hi) : 0, a.mode === 'value' ? Math.max(a.lo, a.hi) : a.dur);
            if (t != null) { if (a.mode === 'value') t = valueT(a, t); if (t !== k.t) { push(); moveKeys(new Map([[k, t]])); } }
        }
        if (tr && id === 'kfV') { const v = num(-32768, 32767); if (v != null) { push(); k.v = tr.p === 'f' ? Math.max(0, v - 1) : v; } }
        if (tr && id === 'kfText') { push(); k.v = e.target.value; }
        if (tr && id === 'kfVis') { push(); k.v = e.target.checked ? 1 : 0; }
        if (tr && id === 'kfPc') { const p = palEntry(e.target.value); push(); if (p) { k.v = p.c; k.pc = p.n; } else delete k.pc; }
        e.target.blur(); update();
    });
    tlEl.addEventListener('input', e => { const k = AN.sel[0]; if (e.target.id === 'kfC' && k) { push('kfc'); k.v = to565(e.target.value); delete k.pc; update(true); } });
    // new times for keys (Map key → t); a moved key takes the place of a key that was at that time
    function moveKeys(to) {
        const a = openAnim();
        for (const tr of a.tracks) {
            if (!tr.keys.some(k => to.has(k))) continue;
            for (const [k, t] of to) if (tr.keys.includes(k)) k.t = t;
            const taken = new Set(tr.keys.filter(k => to.has(k)).map(k => k.t));
            tr.keys = tr.keys.filter(k => to.has(k) || !taken.has(k.t)).sort((p, q) => p.t - q.t);
        }
    }
    function delKeys() { if (!AN.sel.length) return; push(); const del = new Set(AN.sel); for (const tr of openAnim().tracks) tr.keys = tr.keys.filter(k => !del.has(k)); AN.sel = []; update(); }
    // keys to the clipboard: track, offset from the first one, value
    function copyKeys() {
        const a = openAnim(); if (!a || !AN.sel.length) return false; const t0 = Math.min(...AN.sel.map(k => k.t));
        AN.clip = AN.sel.map(k => { const tr = trackOfKey(k); return { id: tr.id, p: tr.p, dt: k.t - t0, k: { ...k } }; }); return true;
    }
    function pasteKeys() {
        const a = openAnim(); if (!a || !AN.clip) return false; push(); const sel = [];
        for (const c of AN.clip) {
            const s = S.shapes.find(x => x.id === c.id); if (!s || !animProps(s).includes(c.p)) continue;
            const o = trackOf(c.id, c.p); if (o && o.a !== a) { flash(`«${propName(s, c.p)}» у «${s.name}» анимируется в «${o.a.name}».`); continue; }
            let tr = o && o.tr; if (!tr) { tr = { id: c.id, p: c.p, keys: [] }; a.tracks.push(tr); }
            const t = Math.min(a.dur, AN.t + c.dt), k = setKey(tr, t, c.k.v, c.k.pc); k.e = c.k.e; sel.push(k);
        }
        AN.sel = sel; update(); return true;
    }
    // pointer: a key — select (Shift adds) and drag all selected; a shape's summary diamond — all its keys at that moment;
    // the ruler — move the playhead; an empty lane — a frame selects the keys it touches (a plain click moves the playhead)
    let tlDrag = null;
    const sumKeys = (a, el) => { const id = +el.closest('[data-id]').dataset.id, t = +el.dataset.t; return a.tracks.filter(tr => tr.id === id).flatMap(tr => tr.keys.filter(k => k.t === t)); };
    const dragKeys = (e, a, k, lane) => { tlEl.setPointerCapture(e.pointerId); tlDrag = { mode: 'keys', r: lane.getBoundingClientRect(), k, x0: e.clientX, orig: new Map(AN.sel.map(x => [x, x.t])), snap: snapshot(), moved: false }; update(); };
    tlEl.addEventListener('pointerdown', e => {
        AN.focus = true; const a = openAnim(); if (!a || e.button !== 0) return;
        const kf = e.target.closest('.kf'), sum = e.target.closest('.kf-sum'), lane = e.target.closest('[data-lane]');
        if (kf) {
            const tr = a.tracks[+kf.dataset.tr], k = tr.keys[+kf.dataset.kk];
            if (e.shiftKey) { AN.sel = AN.sel.includes(k) ? AN.sel.filter(x => x !== k) : [...AN.sel, k]; update(); return; }
            if (!AN.sel.includes(k)) AN.sel = [k];
            dragKeys(e, a, k, kf.parentElement); return;
        }
        if (sum) {
            const ks = sumKeys(a, sum); if (!ks.length) return;
            const all = ks.every(k => AN.sel.includes(k));
            if (e.shiftKey) { AN.sel = all ? AN.sel.filter(k => !ks.includes(k)) : [...new Set([...AN.sel, ...ks])]; update(); return; }
            if (!all) AN.sel = ks;
            dragKeys(e, a, ks[0], sum.parentElement); return;
        }
        // a frame may start anywhere in the grid, also on the labels (but not on their buttons and names)
        if (!lane && (!e.target.closest('#tlGrid') || e.target.closest('button, .tl-nm'))) return;
        stopPlay(); tlEl.setPointerCapture(e.pointerId);
        const keys = [...new Set(a.tracks.flatMap(tr => tr.keys.map(k => k.t)))], r = (lane || tlEl.querySelector('.tl-ruler [data-lane]')).getBoundingClientRect(); // the lanes are rebuilt while dragging: keep the rectangle
        if (lane && lane.closest('.tl-ruler')) { tlDrag = { mode: 'scrub', r, keys }; if (!e.shiftKey) AN.sel = []; AN.t = laneT(e, r, a, keys); renderTimeline(); showFrame(); return; }
        tlDrag = { mode: 'box', r, keys, x0: e.clientX, y0: e.clientY, e0: e, onLane: !!lane, base: e.shiftKey ? AN.sel.slice() : [], sel: null, el: null };
    });
    // keys under the frame: diamonds of the property rows and the summary diamonds of the shape rows
    function boxSelect(d, e) {
        const a = openAnim(), grid = document.getElementById('tlGrid'); if (!a || !grid) return;
        const L = Math.min(d.x0, e.clientX), R = Math.max(d.x0, e.clientX), T = Math.min(d.y0, e.clientY), B = Math.max(d.y0, e.clientY), g = grid.getBoundingClientRect();
        if (!d.el) { d.el = document.createElement('div'); d.el.className = 'tl-box'; }
        if (d.el.parentElement !== grid) grid.appendChild(d.el);
        Object.assign(d.el.style, { left: L - g.left + 'px', top: T - g.top + 'px', width: R - L + 'px', height: B - T + 'px' });
        const hit = el => { const b = el.getBoundingClientRect(); return b.right >= L && b.left <= R && b.bottom >= T && b.top <= B; }, sel = new Set(d.base);
        tlEl.querySelectorAll('.kf').forEach(el => { if (hit(el)) sel.add(a.tracks[+el.dataset.tr].keys[+el.dataset.kk]); });
        tlEl.querySelectorAll('.kf-sum').forEach(el => { if (hit(el)) sumKeys(a, el).forEach(k => sel.add(k)); });
        d.sel = [...sel];
        tlEl.querySelectorAll('.kf').forEach(el => el.setAttribute('aria-pressed', sel.has(a.tracks[+el.dataset.tr].keys[+el.dataset.kk])));
    }
    tlEl.addEventListener('pointermove', e => {
        const a = openAnim(); if (!tlDrag || !a) return;
        if (tlDrag.mode === 'scrub') { AN.t = laneT(e, tlDrag.r, a, tlDrag.keys); showFrame(); return; }
        if (tlDrag.mode === 'box') { if (tlDrag.sel || Math.hypot(e.clientX - tlDrag.x0, e.clientY - tlDrag.y0) >= 4) boxSelect(tlDrag, e); return; }
        const w = tlDrag.r.width - 2 * INSET; let dt = Math.round((e.clientX - tlDrag.x0) / w * a.dur);
        if (!tlDrag.moved && Math.abs(e.clientX - tlDrag.x0) < 3) return;
        if (!e.altKey) { const t = tlDrag.orig.get(tlDrag.k) + dt, near = Math.abs((t - AN.t) / a.dur * w) <= 5 ? AN.t : Math.round(t / 10) * 10; dt = near - tlDrag.orig.get(tlDrag.k); }
        const lo = Math.min(...tlDrag.orig.values()), hi = Math.max(...tlDrag.orig.values()); dt = Math.max(-lo, Math.min(a.dur - hi, dt));
        if (!tlDrag.moved) { push('', tlDrag.snap); tlDrag.moved = true; }
        for (const [k, t] of tlDrag.orig) k.t = t + dt;
        for (const tr of a.tracks) tr.keys.sort((p, q) => p.t - q.t);
        showFrame(); renderTimeline();
    });
    const tlUp = () => {
        if (!tlDrag) return; const d = tlDrag, a = openAnim(); tlDrag = null;
        if (d.mode === 'keys' && d.moved) moveKeys(new Map([...d.orig.keys()].map(k => [k, k.t])));
        if (d.mode === 'box') {
            if (d.el) d.el.remove();
            if (d.sel) AN.sel = d.sel;
            else if (a) { if (!d.e0.shiftKey) AN.sel = []; if (d.onLane) AN.t = laneT(d.e0, d.r, a, d.keys); } // a click without a frame: the playhead goes there
        }
        update();
    };
    tlEl.addEventListener('pointerup', tlUp); tlEl.addEventListener('pointercancel', tlUp);
    // the timeline in focus: ← → move the selected keys by 10 ms (Shift — 100 ms), ⌘/Ctrl + A selects every key of the open animation
    function nudgeKeys(dt) {
        const a = openAnim(); if (!a || !AN.sel.length) return;
        const lo = Math.min(...AN.sel.map(k => k.t)), hi = Math.max(...AN.sel.map(k => k.t)); dt = Math.max(-lo, Math.min(a.dur - hi, dt)); if (!dt) return;
        push('knudge'); moveKeys(new Map(AN.sel.map(k => [k, k.t + dt]))); update();
    }
    document.addEventListener('pointerdown', e => { if (!tlEl.contains(e.target)) AN.focus = false; }, true);

    // ---------- transitions in the editor: the same frames lcbTick() / lcbTransFrame() give on the board ----------
    // a screen's own frame T ms after start-up: loop and ping-pong run from 0, once and value haven't been started (0 ms)
    const animAt = (a, T) => a.mode === 'loop' ? T % a.dur : a.mode === 'pingpong' ? (ph => ph <= a.dur ? ph : 2 * a.dur - ph)(T % (2 * a.dur)) : 0;
    // screen k at T ms as RGB565 words, without touching what the editor shows
    function screenPixels(k, T) {
        return withScreen(k, () => {
            const sc = S.screens[k], shapes = JSON.parse(JSON.stringify(sc.shapes)), byId = new Map(shapes.map(s => [s.id, s]));
            for (const s of shapes) delete s.vis;
            for (const a of sc.anims) { const t = animAt(a, T); for (const tr of a.tracks) { const s = byId.get(tr.id); if (s && tr.keys.length) setP(s, tr.p, ...evalTrack(tr, t)); } }
            const b = offscreen(S.W, S.H, sc.bg, () => shapes.forEach((s, i) => { if (!hiddenAt(i) && s.vis !== 0) raster(s, i); }));
            return Uint16Array.from(b.u32, from32);
        });
    }
    // e ms into the transition from screen `from` to `to`; prev — `from` when it started (what lcbPrev holds on the board)
    function transPixels(from, to, tr, e, prev) {
        const W = S.W, H = S.H;
        if (tr.type === 'none' || !tr.dur || e >= tr.dur) return screenPixels(to, e);
        const p = ease(tr.ease, Math.trunc(e * 1024 / tr.dur));
        if (tr.type === 'fade') { const first = p < 512, k = first ? p * 2 : (1024 - p) * 2; return screenPixels(first ? from : to, e).map(c => mix565(c, tr.c, k)); }
        const nw = screenPixels(to, e), out = new Uint16Array(W * H), dx = Math.trunc(W * p / 1024), dy = Math.trunc(H * p / 1024);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x; let v;
            switch (tr.type) {
                case 'slide-left': v = x < W - dx ? prev[i + dx] : nw[i - (W - dx)]; break;
                case 'slide-right': v = x < dx ? nw[i + W - dx] : prev[i - dx]; break;
                case 'slide-up': v = y < H - dy ? prev[i + dy * W] : nw[i - (H - dy) * W]; break;
                case 'slide-down': v = y < dy ? nw[i + (H - dy) * W] : prev[i - dy * W]; break;
                case 'wipe-left': v = x < W - dx ? prev[i] : nw[i]; break;
                case 'wipe-right': v = x < dx ? nw[i] : prev[i]; break;
                case 'wipe-up': v = y < H - dy ? prev[i] : nw[i]; break;
                default: v = y < dy ? nw[i] : prev[i]; // wipe-down
            }
            out[i] = v;
        }
        return out;
    }
    // the bar under the tabs: the transition onto the current screen, and its preview from another screen (canvas and board)
    const trBar = document.getElementById('trBar'); let trHtml = '', transView = null;
    const TV = { from: -1, e: 0, on: false, raf: 0, prev: null };
    // two parts: «what goTo(SCR_…) does» on the left (the default transition onto the current screen) and «try it» on the right
    function renderTrBar() {
        trBar.hidden = S.screens.length < 2; if (trBar.hidden) { trHtml = ''; return; }
        if (trBar.contains(document.activeElement) && document.activeElement.matches('input:not([type=range]),select')) return; // don't rebuild under typing
        const sc = S.screens[S.cur], tr = trOf(sc), on = tr.type !== 'none', scr = plan(true).scr[S.cur] || 'SCR_' + upperId(sc.name);
        if (TV.from === S.cur || !S.screens[TV.from]) TV.from = S.cur ? S.cur - 1 : 1;
        let h;
        if (S.mgr === false) h = `<div class="row"><span class="set">Переход сюда</span><span class="msg">нет: экраны переключает твой код (в «Коде» выключено «экраны через goTo()»)</span></div><div class="row"><button class="btn" id="trMgrOn">Включить goTo() и переходы</button></div>`;
        else {
            h = `<div class="row"><span class="set" title="Так экран появляется, когда скетч вызывает goTo(${scr}). «сразу» — без анимации">Переход сюда</span><select id="trType" aria-label="Переход на этот экран">${TRANS.map(([v, l]) => `<option value="${v}"${v === tr.type ? ' selected' : ''}>${v === 'none' ? 'сразу, без перехода' : l}</option>`).join('')}</select></div>`
                + (on ? `<div class="row"><label class="set">за <input type="number" id="trDur" min="1" max="60000" value="${tr.dur}" style="width:64px" aria-label="Длительность перехода, мс"> мс</label><select id="trEase" aria-label="Плавность перехода">${EASES.filter(x => x[0] !== 'step').map(([v, l]) => `<option value="${v}"${v === tr.ease ? ' selected' : ''}>${l}</option>`).join('')}</select>`
                    + (tr.type === 'fade' ? `<label class="set">через <input type="color" id="trC" value="${toHex(tr.c)}" aria-label="Цвет затухания"></label>${S.palette.length ? `<select id="trPc" aria-label="Цвет затухания из палитры"><option value="">${fmt565(tr.c)}</option>${S.palette.map(p => `<option${p.n === tr.pc ? ' selected' : ''}>${p.n}</option>`).join('')}</select>` : ''}` : '') + '</div>' : '')
                + `<div class="msg">Срабатывает, когда скетч вызывает <code>goTo(${esc(scr)})</code>.</div>`
                + (on ? `<div class="row trtry"><label class="set">проверить с экрана <select id="trFrom">${S.screens.map((x, k) => k === S.cur ? '' : `<option value="${k}"${k === TV.from ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`
                    + `<button class="btn primary" id="trPlay" title="Проиграть переход на холсте (и на плате, если подключена)"></button>`
                    + `<input type="range" id="trT" min="0" max="${tr.dur}" value="0" aria-label="Момент перехода, мс" title="Тяни — любой момент перехода"><span class="spec" id="trTime"></span></div>` : '');
        }
        if (h !== trHtml) trBar.innerHTML = trHtml = h;
        syncTrBar();
    }
    function syncTrBar() {
        const tr = trOf(S.screens[S.cur]), pl = document.getElementById('trPlay'), t = document.getElementById('trT'), tm = document.getElementById('trTime'); if (!pl) return;
        pl.textContent = TV.raf ? '⏸ пауза' : '▶ проиграть';
        if (t && document.activeElement !== t) t.value = TV.on ? Math.min(TV.e, tr.dur) : 0;
        tm.textContent = TV.on ? (tr.type === 'none' ? 'мгновенно' : `${Math.min(TV.e, tr.dur)} / ${tr.dur} мс`) : '';
    }
    // the canvas shows the transition e ms in (at the end — the new screen); any edit goes back to the normal view
    function showTrans(e) {
        if (!TV.prev) TV.prev = screenPixels(TV.from, 0);
        TV.on = true; TV.e = e; transView = transPixels(TV.from, S.cur, trOf(S.screens[S.cur]), e, TV.prev); render(); syncTrBar();
    }
    function stopTrans() { cancelAnimationFrame(TV.raf); TV.raf = 0; TV.on = false; TV.prev = null; transView = null; }
    function playTrans() {
        if (TV.raf) { cancelAnimationFrame(TV.raf); TV.raf = 0; syncTrBar(); return; }
        stopPlay(); const dur = trOf(S.screens[S.cur]).type === 'none' ? 0 : trOf(S.screens[S.cur]).dur, t0 = performance.now(); TV.prev = null;
        const step = () => { const e = Math.floor(performance.now() - t0); if (e >= dur) { TV.raf = 0; showTrans(dur); return; } showTrans(e); TV.raf = requestAnimationFrame(step); };
        TV.raf = requestAnimationFrame(step); syncTrBar();
    }
    trBar.addEventListener('change', e => {
        const sc = S.screens[S.cur], tr = trOf(sc), id = e.target.id, v = e.target.value;
        if (id === 'trFrom') { TV.from = +v; TV.prev = null; if (TV.on) showTrans(TV.e); return; }
        if (id === 'trT') return;
        push();
        if (id === 'trType') tr.type = v;
        if (id === 'trDur') { const d = Math.round(+v); if (d >= 1) tr.dur = Math.min(60000, d); }
        if (id === 'trEase') tr.ease = v;
        if (id === 'trPc') { const p = palEntry(v); if (p) { tr.pc = p.n; tr.c = p.c; } else delete tr.pc; }
        sc.tr = tr; e.target.blur(); update();
    });
    trBar.addEventListener('input', e => {
        if (e.target.id === 'trT') { cancelAnimationFrame(TV.raf); TV.raf = 0; showTrans(+e.target.value); }
        if (e.target.id === 'trC') { const sc = S.screens[S.cur], tr = trOf(sc); push('trc' + S.cur); tr.c = to565(e.target.value); delete tr.pc; sc.tr = tr; update(true); }
    });
    trBar.addEventListener('click', e => { if (e.target.closest('#trPlay')) playTrans(); if (e.target.closest('#trMgrOn')) { S.mgr = true; update(); } });

    // ---------- adding pictures: file button / I, drag and drop onto the stage, paste ----------
    const fileIn = document.getElementById('imgFile'), stageMsg = document.getElementById('stageMsg');
    let flashT = 0, saveBad = false;
    function flash(t) { stageMsg.textContent = t; clearTimeout(flashT); flashT = setTimeout(() => { stageMsg.textContent = saveBad ? SAVE_ERR : ''; }, 4000); }
    const SAVE_ERR = 'Не удалось сохранить в localStorage: не хватает места (скорее всего, из-за картинок). Изменения пропадут после перезагрузки.';
    function saveFailed(bad) { if (bad === saveBad) return; saveBad = bad; const el = document.getElementById('stageMsg'); if (el) el.textContent = bad ? SAVE_ERR : ''; }
    const readUrl = f => new Promise((ok, no) => { const rd = new FileReader(); rd.onload = () => ok(rd.result); rd.onerror = no; rd.readAsDataURL(f); });
    // → {id, nw, nh}: the picture becomes an asset; big rasters are kept downscaled so that localStorage holds them
    function loadPicture(url) {
        return new Promise((ok, no) => {
            const img = new Image();
            img.onload = () => {
                let nw = img.naturalWidth || 64, nh = img.naturalHeight || 64;
                if (!url.startsWith('data:image/svg') && Math.max(nw, nh) > 1024) {
                    const k = 1024 / Math.max(nw, nh), c = document.createElement('canvas'); c.width = Math.round(nw * k); c.height = Math.round(nh * k);
                    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); url = c.toDataURL('image/png'); nw = c.width; nh = c.height;
                }
                const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); S.assets[id] = url; assetsVer++;
                ok({ id, nw, nh });
            };
            img.onerror = no; img.src = url;
        });
    }
    // an animated GIF → its frames (composited) with their durations; null when it has one frame or the browser can't decode it
    async function gifFrames(file) {
        if (file.type !== 'image/gif' || !('ImageDecoder' in window)) return null;
        try {
            const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' }); await dec.tracks.ready;
            const n = Math.min(120, dec.tracks.selectedTrack.frameCount); if (n < 2) return null;
            const out = [];
            for (let k = 0; k < n; k++) {
                const { image } = await dec.decode({ frameIndex: k }), c = document.createElement('canvas'); c.width = image.displayWidth; c.height = image.displayHeight;
                c.getContext('2d').drawImage(image, 0, 0); out.push({ url: c.toDataURL('image/png'), d: Math.max(10, Math.round((image.duration || 100000) / 1000)) }); image.close();
            }
            return out;
        } catch (e) { return null; }
    }
    // one picture → a picture; several files or an animated GIF → a sprite (frames in file name order); spriteFiles: add them as frames to that sprite
    let spriteFiles = null;
    async function addImageFiles(files, at) {
        const target = spriteFiles; spriteFiles = null;
        files = files.filter(f => /^image\/(png|jpeg|svg\+xml|gif|webp)$/.test(f.type)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        if (!files.length) { flash('Нужна картинка PNG, JPG, GIF или SVG.'); return; }
        try {
            const gif = files.length === 1 ? await gifFrames(files[0]) : null;
            const srcs = gif || (await Promise.all(files.map(readUrl))).map(url => ({ url, d: 100 }));
            const pics = []; for (const f of srcs) pics.push({ ...(await loadPicture(f.url)), d: f.d });
            if (target && S.shapes.includes(target)) {
                push(); const d = target.frames.length ? target.frames[target.frames.length - 1].d : 100;
                target.frames.push(...pics.map(p => ({ d: gif ? p.d : d, src: p.id, nw: p.nw, nh: p.nh }))); rebuildSpriteKeys(target); update(); return;
            }
            const { nw, nh } = pics[0], k = Math.min(1, S.W / nw, S.H / nh), w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
            const x = at ? at.x - (w >> 1) : Math.round((S.W - w) / 2), y = at ? at.y - (h >> 1) : Math.round((S.H - h) / 2), base = files[0].name.replace(/\.[^.]*$/, '').trim();
            push(); let s;
            if (pics.length === 1) { s = { t: 'img', x, y, w, h, src: pics[0].id, nw, nh, mode: 'color', scale: 'avg', thr: 128, inv: false, c: S.color }; addShape(s); }
            else { s = addSprite(pics.map(p => ({ d: p.d, src: p.id, nw: p.nw, nh: p.nh })), x, y, nw, nh, w, h); s.scale = 'avg'; setSelObjs([s]); }
            if (base && (pics.length === 1 || gif)) s.name = base;
            S.tool = 'select'; update();
        } catch (e) { flash('Не удалось прочитать картинку.'); }
    }
    const addImageFile = (file, at) => addImageFiles(file ? [file] : [], at);
    fileIn.addEventListener('change', () => { const fs = [...fileIn.files]; fileIn.value = ''; fileIn.multiple = true; if (fs.length) addImageFiles(fs); else spriteFiles = null; });
    fileIn.addEventListener('cancel', () => { spriteFiles = null; });
    document.getElementById('imgBtn').addEventListener('click', () => { spriteFiles = null; fileIn.click(); });
    stage.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); stage.classList.add('drop'); } });
    stage.addEventListener('dragleave', e => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('drop'); });
    stage.addEventListener('drop', e => {
        stage.classList.remove('drop'); const fs = [...e.dataTransfer.files]; if (!fs.length) return; e.preventDefault(); spriteFiles = null;
        const r = view.getBoundingClientRect(), inside = e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
        addImageFiles(fs, inside ? { x: Math.floor((e.clientX - r.left) / scale), y: Math.floor((e.clientY - r.top) / scale) } : null);
    });
    // Ctrl/⌘+V pastes the internal clipboard at once; if the same keystroke brings an image from the system clipboard, that paste is taken back and the image wins
    let justPasted = false, sysCopy = false, clipText = '';
    document.addEventListener('paste', e => {
        if (e.target.matches && e.target.matches('input,textarea')) return;
        const f = [...(e.clipboardData ? e.clipboardData.files : [])].find(f => f.type.startsWith('image/'));
        if (!f) return; e.preventDefault();
        if (justPasted) { justPasted = false; undo(); future.pop(); }
        addImageFile(f);
    });
    // after an internal copy the system clipboard gets the code of the copied shapes (and an old image there no longer wins on paste)
    for (const ev of ['copy', 'cut']) document.addEventListener(ev, e => { if (!sysCopy || !e.clipboardData) return; e.preventDefault(); e.clipboardData.setData('text/plain', clipText); });

    // ---------- project fonts: TTF/OTF → GFXfont in CP1251 (0x20–0xFF), rasterised in the browser ----------
    const DPI = 141; // like Adafruit fontconvert: «9pt» means the same pixel size as FreeSans9pt7b
    const CP_DEC = new TextDecoder('windows-1251'), cpChar = b => CP_DEC.decode(Uint8Array.of(b));
    async function makeFont(file, name, pt) {
        const fam = 'lcbfont' + Date.now(), face = new FontFace(fam, await file.arrayBuffer());
        await face.load(); document.fonts.add(face);
        try {
            const px = Math.round(pt * DPI / 72), size = px * 4, ox = px, by = px * 3;
            const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d', { willReadFrequently: true });
            const draw = (ch, fb) => { x.clearRect(0, 0, size, size); x.font = `${px}px "${fam}", ${fb}`; x.fillStyle = '#000'; x.textBaseline = 'alphabetic'; x.fillText(ch, ox, by); return x.getImageData(0, 0, size, size).data; };
            x.font = `${px}px "${fam}"`; const m = x.measureText('Ag');
            const ya = Math.round((m.fontBoundingBoxAscent || px) + (m.fontBoundingBoxDescent || px / 4));
            const bytes = [], g = [], ab = [], ag = []; let missing = 0;
            // 4-bit alpha copy of every glyph for smooth text: rows of nibbles (high first), each glyph starts on a byte
            const alphaGlyph = a => {
                const q = i => Math.round(a[i * 4 + 3] * 15 / 255); let x0 = size, y0 = size, x1 = -1, y1 = -1;
                for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) if (q(yy * size + xx)) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
                if (x1 < 0) { ag.push([ab.length, 0, 0, 0, 0]); return; }
                const off = ab.length, w = x1 - x0 + 1, h = y1 - y0 + 1; let n = 0;
                for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++, n++) { const v = q(yy * size + xx); if (n & 1) ab[ab.length - 1] |= v; else ab.push(v << 4); }
                ag.push([off, w, h, x0 - ox, y0 - by]);
            };
            const empty = () => { g.push([bytes.length, 0, 0, 0, 0, 0]); ag.push([ab.length, 0, 0, 0, 0]); };
            for (let code = 0x20; code <= 0xFF; code++) {
                const ch = cpChar(code);
                if (!CP.has(ch) || code === 0xAD) { empty(); continue; } // no character at this code: empty glyph
                const a = draw(ch, 'monospace');
                // a glyph the font doesn't have comes from the fallback font: monospace and serif fallbacks then differ
                if (ch.trim()) { const b = draw(ch, 'serif'); let same = true; for (let i = 3; i < a.length; i += 4) if ((a[i] >= 128) !== (b[i] >= 128)) { same = false; break; } if (!same) { missing++; empty(); continue; } }
                x.font = `${px}px "${fam}", monospace`; const xa = Math.round(x.measureText(ch).width);
                alphaGlyph(a);
                let x0 = size, y0 = size, x1 = -1, y1 = -1;
                for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) if (a[(yy * size + xx) * 4 + 3] >= 128) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
                if (x1 < 0) { g.push([bytes.length, 0, 0, xa, 0, 0]); continue; }
                // GFXfont bitmap: rows packed one after another, MSB first, each glyph starts on a byte
                const off = bytes.length; let acc = 0, n = 0;
                for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { acc = (acc << 1) | (a[(yy * size + xx) * 4 + 3] >= 128 ? 1 : 0); if (++n === 8) { bytes.push(acc); acc = n = 0; } }
                if (n) bytes.push(acc << (8 - n));
                g.push([off, x1 - x0 + 1, y1 - y0 + 1, xa, x0 - ox, y0 - by]);
            }
            if (bytes.length > 65535 || ab.length > 65535) throw new Error('шрифт слишком большой (больше 64 КБ битмапов) — уменьши размер');
            if (!bytes.length) bytes.push(0); if (!ab.length) ab.push(0);
            const enc = arr => { let bin = ''; for (let k = 0; k < arr.length; k += 4096) bin += String.fromCharCode(...arr.slice(k, k + 4096)); return btoa(bin); };
            return { n: name, f: 0x20, l: 0xFF, y: ya, b: enc(bytes), g, ab: enc(ab), ag, pt, src: file.name, missing };
        } finally { document.fonts.delete(face); }
    }
    // cp1251(): UTF-8 → CP1251 on the board; lives in every font .h behind a guard
    function cp1251Helper() {
        const hi = []; for (let b = 0x80; b <= 0xBF; b++) { const ch = cpChar(b); hi.push(CP.has(ch) ? '0x' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') : '0'); }
        const rows = []; for (let k = 0; k < 64; k += 8) rows.push('    ' + hi.slice(k, k + 8).join(', ') + ',');
        return ['#ifndef LCB_CP1251_HELPER', '#define LCB_CP1251_HELPER',
            '// UTF-8 → CP1251: Adafruit GFX печатает по одному байту, а шрифт закодирован в CP1251.',
            '// canvas.print(cp1251("Привет")); — результат живёт до следующего вызова cp1251().',
            'inline const char* cp1251(const char* s) {', '  static char out[256];', '  static const uint16_t hi[64] = {  // символы 0x80–0xBF', ...rows, '  };',
            '  size_t n = 0;', '  while (*s && n < sizeof(out) - 1) {', '    uint8_t c = *s++; uint32_t u;',
            '    if (c < 0x80) u = c;', '    else if ((c & 0xE0) == 0xC0 && *s) u = ((c & 0x1F) << 6) | (*s++ & 0x3F);',
            '    else if ((c & 0xF0) == 0xE0 && s[0] && s[1]) { u = ((c & 0x0F) << 12) | ((s[0] & 0x3F) << 6) | (s[1] & 0x3F); s += 2; }',
            '    else { while ((*s & 0xC0) == 0x80) s++; out[n++] = \'?\'; continue; }',
            "    char r = '?';", '    if (u < 0x80) r = (char)u;', '    else if (u >= 0x410 && u <= 0x44F) r = (char)(0xC0 + (u - 0x410));',
            '    else for (int k = 0; k < 64; k++) if (hi[k] == u) { r = (char)(0x80 + k); break; }', '    out[n++] = r;', '  }', '  out[n] = 0;', '  return out;', '}', '#endif'];
    }
    // the 4-bit copy for smooth text: lcbText(…, &NameAA) draws it, blending each pixel by its alpha
    function alphaFontLines(f) {
        const N = f.n, bytes = b64(f.ab), rows = [];
        for (let k = 0; k < bytes.length; k += 16) rows.push('  ' + Array.from(bytes.slice(k, k + 16), v => '0x' + v.toString(16).toUpperCase().padStart(2, '0')).join(', ') + ',');
        return ['// Сглаженная копия для lcbText(): 4 бита альфы на пиксель, два пикселя в байте (старшая тетрада — левый).', ...lcbAlphaTypes(),
            `const uint8_t ${N}AlphaBitmaps[] PROGMEM = {`, ...rows, '};',
            `const LcbAlphaGlyph ${N}AlphaGlyphs[] PROGMEM = {`, '  // offset, w, h, xOffset, yOffset (xAdvance — из GFXfont)', ...f.ag.map(g => `  { ${g.join(', ')} },`), '};',
            `const LcbAlphaFont ${N}AA = { ${N}AlphaBitmaps, ${N}AlphaGlyphs, &${N} };`, ''];
    }
    const lcbAlphaTypes = () => ['#ifndef LCB_ALPHA_TYPES', '#define LCB_ALPHA_TYPES', 'struct LcbAlphaGlyph { uint16_t offset; uint8_t width, height; int8_t xOffset, yOffset; };',
        'struct LcbAlphaFont { const uint8_t* bitmap; const LcbAlphaGlyph* glyph; const GFXfont* font; };', '#endif'];
    function fontHeader(f) {
        const N = f.n, bytes = b64(f.b), hex = (v, n = 2) => '0x' + v.toString(16).toUpperCase().padStart(n, '0'), rows = [];
        for (let k = 0; k < bytes.length; k += 16) rows.push('  ' + Array.from(bytes.slice(k, k + 16), v => hex(v)).join(', ') + ',');
        const gl = f.g.map((g, k) => { const code = f.f + k, ch = cpChar(code); return `  { ${String(g[0]).padStart(5)}, ${String(g[1]).padStart(3)}, ${String(g[2]).padStart(3)}, ${String(g[3]).padStart(3)}, ${String(g[4]).padStart(4)}, ${String(g[5]).padStart(4)} },  // ${hex(code)}${CP.has(ch) && ch.trim() && code !== 0xAD ? ` '${ch}'` : ''}`; });
        return [`// ${N}: ${f.src || 'шрифт'}, ${f.pt}pt, кодировка CP1251 (0x20–0xFF). Создан в LCD Canvas Builder.`,
            `// Подключение: положи файл рядом со скетчем, #include "${N}.h", затем canvas.setFont(&${N});`,
            '// Строки с кириллицей печатай через cp1251(): canvas.print(cp1251("Привет"));',
            '#pragma once', '#include <Adafruit_GFX.h>', '',
            `const uint8_t ${N}Bitmaps[] PROGMEM = {`, ...rows, '};', '',
            `const GFXglyph ${N}Glyphs[] PROGMEM = {`, '  // offset, w, h, xAdvance, xOffset, yOffset', ...gl, '};', '',
            `const GFXfont ${N} PROGMEM = { (uint8_t *)${N}Bitmaps, (GFXglyph *)${N}Glyphs, ${hex(f.f)}, ${hex(f.l)}, ${f.y} };`, '',
            ...(f.ab ? alphaFontLines(f) : []),
            ...cp1251Helper(), ''].join('\n');
    }
    const fontFile = document.getElementById('fontFile'), fontName = document.getElementById('fontName'), fontPt = document.getElementById('fontPt'), fontMsg = document.getElementById('fontMsg'), fontList = document.getElementById('fontList');
    fontFile.addEventListener('change', () => { const f = fontFile.files[0]; if (f && !fontName.value.trim()) fontName.value = f.name.replace(/\.[^.]*$/, '').replace(/[-_ ]?(Regular|Roman)$/i, ''); });
    document.getElementById('fontMake').addEventListener('click', async () => {
        const file = fontFile.files[0], pt = Math.round(+fontPt.value);
        if (!file) { fontMsg.textContent = 'Выбери файл шрифта (TTF, OTF, WOFF).'; return; }
        if (!(pt >= 4 && pt <= 48)) { fontMsg.textContent = 'Размер — от 4 до 48 pt (у GFXfont смещения глифов в пределах ±127 px).'; return; }
        const taken = new Set([...Object.keys(FONT_DATA), 'cp1251']); let n = pascalId(fontName.value.trim() || file.name.replace(/\.[^.]*$/, '')) + pt + 'pt8b', k = 2;
        while (taken.has(n)) n = n.replace(/(_\d+)?$/, '_' + k++);
        fontMsg.textContent = 'Растрирую…';
        try {
            const f = await makeFont(file, n, pt); S.fonts.push(f); registerFont(f);
            const cyr = [...'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя'].filter(ch => !supported(n, ch)).length;
            fontMsg.textContent = `Готово: ${n}.` + (cyr ? ` В шрифте нет ${cyr} букв кириллицы — они будут пропущены.` : '') + (f.missing ? ` Пустых глифов: ${f.missing}.` : '');
            const s = one(); if (s && s.t === 'text') { push(); s.font = n; if (s.size > 1) s.size = 1; S.textFont = n; S.textSize = s.size; }
            update();
        } catch (e) { fontMsg.textContent = 'Не получилось: ' + (e && e.message || e); }
    });
    function renderFonts() {
        const html = S.fonts.map(f => `<div class="row font-row" data-f="${f.n}"><span class="spec">${f.n}</span><span class="msg">${f.src || ''} · ${b64(f.b).length.toLocaleString('ru')} Б</span><span class="grow"></span><button class="btn" data-a="dl" title="Скачать ${f.n}.h">.h</button><button class="btn" data-a="copy" title="Скопировать содержимое ${f.n}.h">Копировать</button><button class="btn danger" data-a="del">Удалить</button></div>`).join('');
        if (fontList.innerHTML !== html) fontList.innerHTML = html;
    }
    fontList.addEventListener('click', e => {
        const b = e.target.closest('[data-a]'), row = e.target.closest('[data-f]'); if (!b || !row) return;
        const f = S.fonts.find(x => x.n === row.dataset.f); if (!f) return;
        if (b.dataset.a === 'dl') download(f.n + '.h', fontHeader(f));
        if (b.dataset.a === 'copy') navigator.clipboard.writeText(fontHeader(f)).then(() => { fontMsg.textContent = `Скопировано: ${f.n}.h`; }, () => download(f.n + '.h', fontHeader(f)));
        if (b.dataset.a === 'del') {
            const used = S.screens.some(sc => deepShapes(sc.shapes).some(s => s.t === 'text' && s.font === f.n));
            if (used) { fontMsg.textContent = `${f.n} используется в тексте — сначала выбери там другой шрифт.`; return; }
            S.fonts = S.fonts.filter(x => x !== f); delete FONT_DATA[f.n]; if (S.textFont === f.n) S.textFont = ''; fontMsg.textContent = ''; update();
        }
    });
    function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

    // ---------- live preview on the board (Web Serial) ----------
    // frame, little-endian: "LCD3" | W u16 | H u16 | flags u8 (bit 0 = RLE) | seq u8 | y0 u16 | rows u16 | len u32 | payload[len] | Fletcher-16(payload) u16
    // payload: rows y0 … y0 + rows - 1 as RGB565 words in canvas.getBuffer() order; RLE: byte n, bit 7 set → the next word (n & 127) + 1 times, else n + 1 words as they are
    // only the band of rows that differs from the last frame the board confirmed is sent; nothing changed → nothing is sent; after an error, a reconnect or a new size → the whole screen
    // the payload goes in CHUNK-byte pieces: after each full piece the board says "N <seq>" and only then gets the next one,
    // because USB CDC on the ESP32-S3 drops bytes when its receive buffer overflows; the frame ends with "OK <seq>" or "ERR <seq> <reason>"
    // while a frame is on its way only the newest state waits; no answer for REPLY_MS → the board has reset its parser (after 500 ms of silence), start over
    const LIVE = { port: null, writer: null, reader: null, busy: false, dirty: false, seq: 0, last: 0, done: [], timer: 0, wait: null, errs: 0, err: '', note: '', noReply: false, prev: null, rows: 0 };
    const CHUNK = 4096, REPLY_MS = 1000;
    const FPS = 18;
    function frame565() {
        const n = S.W * S.H, out = new Uint16Array(n);
        for (let i = 0; i < n; i++) { const v = u32[i]; out[i] = ((v & 0xF8) << 8) | ((v >> 5) & 0x7E0) | ((v >> 19) & 0x1F); } // preview colours expand RGB565 losslessly, so this gives the exact words back
        return out;
    }
    function rle(px) {
        const out = new Uint8Array(px.length * 2 + Math.ceil(px.length / 128) + 8), n = px.length; let o = 0, i = 0;
        const word = v => { out[o++] = v & 255; out[o++] = v >> 8; };
        while (i < n) {
            let r = 1; while (i + r < n && r < 128 && px[i + r] === px[i]) r++;
            if (r >= 2) { out[o++] = 0x80 | (r - 1); word(px[i]); i += r; continue; }
            let L = 1; while (i + L < n && L < 128 && !(i + L + 1 < n && px[i + L] === px[i + L + 1])) L++;
            out[o++] = L - 1; for (let k = 0; k < L; k++) word(px[i + k]); i += L;
        }
        return out.subarray(0, o);
    }
    function fletcher16(b) { let s1 = 0, s2 = 0; for (let i = 0; i < b.length; i++) { s1 = (s1 + b[i]) % 255; s2 = (s2 + s1) % 255; } return (s2 << 8) | s1; }
    const HDR = 18;
    // → { bytes, px, rows } or null when the board already shows exactly this
    function buildFrame(seq) {
        const W = S.W, H = S.H, px = frame565(), prev = LIVE.prev;
        let y0 = 0, y1 = H;
        if (prev && prev.w === W && prev.h === H) {
            let a = 0, b = px.length - 1; const p = prev.px;
            while (a < px.length && px[a] === p[a]) a++;
            if (a === px.length) return null;
            while (px[b] === p[b]) b--;
            y0 = Math.floor(a / W); y1 = Math.floor(b / W) + 1;
        }
        const band = px.subarray(y0 * W, y1 * W), raw = new Uint8Array(band.buffer, band.byteOffset, band.byteLength), packed = rle(band);
        const useRle = packed.length < raw.length, data = useRle ? packed : raw;
        const f = new Uint8Array(HDR + data.length + 2), dv = new DataView(f.buffer);
        f.set([76, 67, 68, 51]); dv.setUint16(4, W, true); dv.setUint16(6, H, true); f[8] = useRle ? 1 : 0; f[9] = seq;
        dv.setUint16(10, y0, true); dv.setUint16(12, y1 - y0, true); dv.setUint32(14, data.length, true);
        f.set(data, HDR); dv.setUint16(HDR + data.length, fletcher16(data), true);
        return { bytes: f, px, w: W, h: H, rows: y1 - y0 };
    }
    // the board's next line for this frame: 'N', 'OK', 'ERR' or 'timeout'
    function reply(seq) {
        return new Promise(res => {
            const t = setTimeout(() => { LIVE.wait = null; res('timeout'); }, REPLY_MS);
            LIVE.wait = { seq, res: v => { clearTimeout(t); LIVE.wait = null; res(v); } };
        });
    }
    function onLine(l) {
        const m = l.match(/^(OK|ERR|N)\s+(\d+)\s*(.*)$/); if (!m || !LIVE.wait || +m[2] !== LIVE.wait.seq) return;
        if (m[1] === 'ERR') LIVE.err = m[3];
        LIVE.wait.res(m[1]);
    }
    async function sendFrame(fr, seq) {
        const f = fr.bytes, len = f.length - HDR - 2, cuts = [0];
        for (let k = CHUNK; k < len; k += CHUNK) cuts.push(HDR + k);
        cuts.push(f.length);
        for (let k = 0; k < cuts.length - 1; k++) {
            const r = reply(seq); // armed before writing, so a fast answer isn't missed
            await LIVE.writer.write(f.subarray(cuts[k], cuts[k + 1]));
            const v = await r; if (v !== (k < cuts.length - 2 ? 'N' : 'OK')) return v === 'N' || v === 'OK' ? 'ERR' : v; // an answer out of turn means the board lost track
        }
        return 'OK';
    }
    async function pump() {
        if (!LIVE.writer || LIVE.busy || !LIVE.dirty) return;
        const wait = LIVE.last + 1000 / FPS - performance.now();
        if (wait > 0) { clearTimeout(LIVE.timer); LIVE.timer = setTimeout(pump, wait); return; }
        LIVE.dirty = false;
        const seq = (LIVE.seq + 1) & 255, fr = buildFrame(seq); if (!fr) return; // the board already shows this
        const port = LIVE.port; LIVE.busy = true; LIVE.last = performance.now(); LIVE.seq = seq;
        let r; try { r = await sendFrame(fr, seq); } catch (e) { r = 'closed'; }
        if (LIVE.port !== port) return; if (r === 'closed') return lost();
        LIVE.busy = false;
        if (r === 'OK') { LIVE.done.push(performance.now()); LIVE.noReply = false; LIVE.prev = fr; LIVE.rows = fr.rows; }
        else { LIVE.prev = null; LIVE.dirty = true; if (r === 'timeout') LIVE.noReply = true; else { LIVE.errs++; LIVE.noReply = false; } } // the board's state is unknown: resend the whole screen
        renderLive(); pump();
    }
    async function readLoop(port) {
        const dec = new TextDecoder(); let buf = '';
        try {
            LIVE.reader = port.readable.getReader();
            for (;;) {
                const { value, done } = await LIVE.reader.read(); if (done) break;
                buf += dec.decode(value, { stream: true }); let k;
                while ((k = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, k).trim()); buf = buf.slice(k + 1); }
                if (buf.length > 4096) buf = buf.slice(-256);
            }
        } catch (e) { } finally { if (LIVE.port === port) lost(); }
    }
    async function connect() {
        if (!('serial' in navigator)) { LIVE.note = 'Web Serial есть только в Chrome и Edge на компьютере.'; renderLive(); return; }
        let port;
        try { port = await navigator.serial.requestPort(); } catch (e) { return; } // the chooser was closed
        try { await port.open({ baudRate: 921600 }); }
        catch (e) { LIVE.note = 'Порт не открылся: ' + e.message + ' Возможно, он занят Arduino IDE или монитором порта.'; renderLive(); return; }
        Object.assign(LIVE, { port, writer: port.writable.getWriter(), busy: false, dirty: true, done: [], errs: 0, err: '', note: '', noReply: false, prev: null, rows: 0 });
        readLoop(port); renderLive(); pump();
    }
    async function disconnect(note) {
        const { port, writer, reader } = LIVE; if (!port) return;
        clearTimeout(LIVE.timer); if (LIVE.wait) LIVE.wait.res('closed');
        Object.assign(LIVE, { port: null, writer: null, reader: null, busy: false, dirty: false, note: note || '' });
        renderLive();
        try { await reader?.cancel(); } catch (e) { } try { reader?.releaseLock(); } catch (e) { }
        try { writer?.releaseLock(); } catch (e) { }
        try { await port.close(); } catch (e) { }
    }
    function lost() { if (LIVE.port) disconnect('Плата отключилась (кабель вынут или плата перезагрузилась).'); }
    if ('serial' in navigator) navigator.serial.addEventListener('disconnect', e => { if (e.target === LIVE.port) lost(); });
    const liveBtn = document.getElementById('liveBtn'), liveStatus = document.getElementById('liveStatus'), liveDot = document.getElementById('liveDot'), liveWarn = document.getElementById('liveWarn');
    liveBtn.addEventListener('click', () => LIVE.port ? disconnect() : connect());
    function renderLive() {
        const on = !!LIVE.port, now = performance.now(); LIVE.done = LIVE.done.filter(t => now - t < 1000);
        liveBtn.textContent = on ? 'Отключить' : 'Подключить плату'; liveBtn.classList.toggle('primary', !on);
        liveDot.dataset.s = !on ? 'off' : LIVE.noReply ? 'warn' : 'on'; liveWarn.hidden = !on;
        liveStatus.textContent = !on ? (LIVE.note || 'не подключена')
            : LIVE.noReply ? 'плата не отвечает — залит ли свежий скетч-приёмник (протокол LCD3)?'
                : `подключена · ${LIVE.done.length} кадр/с · ${S.W}×${S.H}${LIVE.rows && LIVE.rows < S.H ? ` · последний кадр: ${LIVE.rows} строк` : ''}${LIVE.errs ? ` · ошибок: ${LIVE.errs} (${LIVE.err})` : ''}`;
    }
    setInterval(() => { if (LIVE.port) renderLive(); }, 500);
    function receiverSketch() {
        return `// LCD Canvas Builder — скетч-приёмник живого превью.
// Принимает кадры из редактора по USB (Web Serial) и показывает их на экране.
// Плата: Waveshare ESP32-S3-LCD-1.47B. В Arduino IDE: Tools → USB CDC On Boot → Enabled.
//
// Кадр (всё little-endian):
//   "LCD3" | W u16 | H u16 | flags u8 (бит 0 — RLE) | seq u8 | y0 u16 | rows u16 | len u32 | payload[len] | Fletcher-16(payload) u16
// payload — строки y0 … y0 + rows - 1 словами RGB565 в порядке canvas.getBuffer(): редактор шлёт только
// полосу строк, изменившихся с прошлого принятого кадра (после ошибки или смены размера — весь экран).
// RLE: байт n; если бит 7 = 1 —
// следующее слово повторить (n & 127) + 1 раз, иначе дальше идут n + 1 слов как есть.
// Payload идёт кусками по CHUNK байт: после каждого полного куска плата пишет "N <seq>",
// и только тогда редактор шлёт следующий (USB CDC теряет байты, если буфер приёма переполнен).
// В конце кадра плата отвечает "OK <seq>" или "ERR <seq> <причина>" (строкой).

#include <Waveshare_LCD147.h>
#include <Adafruit_GFX.h>

constexpr int W = ${S.W};   // размер по умолчанию; кадр другого размера пересоздаёт холст
constexpr int H = ${S.H};
constexpr uint32_t CHUNK = ${CHUNK};   // должен совпадать с редактором

St7789* lcd;
GFXcanvas16* canvas = nullptr;
uint16_t cw = 0, ch = 0;

enum State : uint8_t { WAIT_MAGIC, HEADER, PAYLOAD, CHECKSUM };
State state = WAIT_MAGIC;
uint8_t hdr[14], sum[2], got = 0;
uint16_t fw, fh, top, nrows;   // полоса строк кадра (имя y0 занято функцией из math.h)
uint8_t flags, seq;
uint32_t len, done;
uint16_t s1, s2;               // Fletcher-16
uint16_t* px = nullptr;
uint32_t pos, total;
uint8_t lo, left;
bool haveLo, run, bad;
const char* why = "";
uint32_t lastByte = 0;

bool resize(uint16_t w, uint16_t h) {
  if (canvas && w == cw && h == ch) return true;
  delete canvas; canvas = nullptr; cw = ch = 0;
  if (!w || !h || w > 1024 || h > 1024) return false;
  canvas = new GFXcanvas16(w, h);
  if (!canvas->getBuffer()) { delete canvas; canvas = nullptr; return false; }
  cw = w; ch = h;
  return true;
}

void startFrame() {
  fw = hdr[0] | hdr[1] << 8; fh = hdr[2] | hdr[3] << 8; flags = hdr[4]; seq = hdr[5];
  top = hdr[6] | hdr[7] << 8; nrows = hdr[8] | hdr[9] << 8;
  len = hdr[10] | hdr[11] << 8 | (uint32_t)hdr[12] << 16 | (uint32_t)hdr[13] << 24;
  done = 0; s1 = s2 = 0; pos = 0; left = 0; haveLo = false; bad = false; why = "";
  bool fresh = !canvas || fw != cw || fh != ch;
  if (resize(fw, fh) && nrows && top + nrows <= ch) { px = canvas->getBuffer() + (uint32_t)top * cw; total = (uint32_t)cw * nrows; }
  else { px = nullptr; total = 0; bad = true; why = "size"; }
  if (!bad && fresh && nrows != ch) { bad = true; why = "resync"; }   // новый холст: нужен полный кадр
  if (!bad && !(flags & 1) && len != total * 2) { bad = true; why = "length"; }
}

inline void put(uint16_t v) {
  if (pos < total) px[pos++] = v;
  else { bad = true; why = "overflow"; }
}

void payloadByte(uint8_t b) {
  s1 = (s1 + b) % 255; s2 = (s2 + s1) % 255;
  if (!px) return;
  if ((flags & 1) && left == 0) { run = b & 0x80; left = (b & 0x7F) + 1; return; }  // управляющий байт RLE
  if (!haveLo) { lo = b; haveLo = true; return; }
  haveLo = false;
  uint16_t v = lo | (uint16_t)b << 8;
  if (!(flags & 1)) put(v);
  else if (run) { while (left) { put(v); left--; } }
  else { put(v); left--; }
}

void endFrame() {
  if (!bad && (uint16_t)(sum[0] | sum[1] << 8) != (uint16_t)(s2 << 8 | s1)) { bad = true; why = "checksum"; }
  if (!bad && pos != total) { bad = true; why = "short"; }
  if (!bad) lcd->drawImage(0, top, cw, nrows, canvas->getBuffer() + (uint32_t)top * cw);   // выводим только пришедшую полосу
  if (bad) Serial.printf("ERR %u %s\\n", seq, why);
  else Serial.printf("OK %u\\n", seq);
}

void feed(uint8_t b) {
  static const uint8_t magic[4] = { 'L', 'C', 'D', '3' };
  switch (state) {
    case WAIT_MAGIC:
      if (b == magic[got]) { if (++got == 4) { state = HEADER; got = 0; } }
      else got = (b == magic[0]) ? 1 : 0;
      break;
    case HEADER:
      hdr[got++] = b;
      if (got == sizeof(hdr)) { startFrame(); got = 0; state = len ? PAYLOAD : CHECKSUM; }
      break;
    case PAYLOAD:
      payloadByte(b);
      if (++done == len) state = CHECKSUM;
      else if (done % CHUNK == 0) Serial.printf("N %u\\n", seq);   // кусок принят — можно слать следующий
      break;
    case CHECKSUM:
      sum[got++] = b;
      if (got == 2) { endFrame(); got = 0; state = WAIT_MAGIC; }
      break;
  }
}

void setup() {
  Serial.setRxBufferSize(32768);
  Serial.begin(921600);
  lcd = &Waveshare147::begin();
  if (resize(W, H)) {
    canvas->fillScreen(0x0000);
    canvas->setTextColor(0xFFFF);
    canvas->setCursor(4, 4); canvas->print("LCD Canvas Builder");
    canvas->setCursor(4, 16); canvas->print("waiting for frames...");
    lcd->drawImage(0, 0, cw, ch, canvas->getBuffer());
  }
}

void loop() {
  static uint8_t buf[1024];
  int n = Serial.available();
  if (n > 0) {
    n = Serial.read(buf, n < (int)sizeof(buf) ? n : (int)sizeof(buf));
    for (int i = 0; i < n; i++) feed(buf[i]);
    lastByte = millis();
  } else if (state != WAIT_MAGIC && millis() - lastByte > 500) {
    state = WAIT_MAGIC; got = 0;   // обрыв посреди кадра — ждём следующий
  }
}
`;
    }
    const rxDlg = document.getElementById('rxDlg');
    document.getElementById('rxBtn').addEventListener('click', () => { document.getElementById('rxCode').textContent = receiverSketch(); rxDlg.showModal(); });
    document.getElementById('rxCopy').addEventListener('click', () => navigator.clipboard.writeText(receiverSketch()).then(() => { document.getElementById('rxMsg').textContent = 'Скопировано.'; }, () => { document.getElementById('rxMsg').textContent = 'Не удалось скопировать — скачай файлом.'; }));
    document.getElementById('rxDl').addEventListener('click', () => download('lcd_canvas_receiver.ino', receiverSketch()));
    document.getElementById('rxClose').addEventListener('click', () => rxDlg.close());

    // status & keyboard
    const statusEl = document.getElementById('status'), hintEl = document.getElementById('hint');
    function status() {
        const p = hover;
        statusEl.innerHTML = `<span>x <b>${p ? p.x : '–'}</b></span><span>y <b>${p ? p.y : '–'}</b></span><span>${S.W} × ${S.H}</span><span>×${scale}</span><span>фигур: <b>${S.shapes.length}</b></span>${S.sel.length > 1 ? `<span>выбрано: <b>${S.sel.length}</b></span>` : ''}`;
    }
    document.addEventListener('keydown', e => {
        if (e.target.matches('input,textarea,select')) return;
        const k = e.key, mod = e.ctrlKey || e.metaKey;
        // the timeline was clicked last: Delete and ⌘/Ctrl+C / V work on its keys
        if (AN.focus && AN.sel.length && !mod && (k === 'Delete' || k === 'Backspace')) { e.preventDefault(); delKeys(); return; }
        if (AN.focus && mod && !e.altKey && e.code === 'KeyC' && getSelection().isCollapsed && copyKeys()) { e.preventDefault(); return; }
        if (AN.focus && mod && !e.altKey && e.code === 'KeyV' && AN.clip) { e.preventDefault(); pasteKeys(); return; }
        if (AN.focus && mod && e.code === 'KeyA' && openAnim()) { e.preventDefault(); AN.sel = openAnim().tracks.flatMap(tr => tr.keys); update(); return; }
        if (AN.focus && !mod && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); if (k === 'ArrowLeft' || k === 'ArrowRight') nudgeKeys((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 100 : 10)); return; }
        if (k === ' ' && !mod && openAnim()) { e.preventDefault(); togglePlay(); return; }
        // e.code, so shortcuts work with any keyboard layout
        if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
        if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
        if (mod && e.code === 'KeyD') { e.preventDefault(); dupSel(); return; }
        if (mod && e.code === 'KeyG') { e.preventDefault(); act(e.shiftKey ? 'ungroup' : 'group'); return; }
        if (mod && e.code === 'KeyA' && !e.target.closest('#code')) { e.preventDefault(); setSel(S.shapes.map((_, i) => i).filter(i => !hiddenAt(i) && !lockedAt(i))); S.tool = 'select'; update(); return; }
        // leave native copy alone while text is selected on the page; no preventDefault, so the copy/paste events still come
        const textSel = !getSelection().isCollapsed;
        if (mod && !e.altKey && !textSel && (e.code === 'KeyC' || e.code === 'KeyX') && copySel(e.code === 'KeyX')) { sysCopy = true; setTimeout(() => { sysCopy = false; }, 0); return; }
        if (mod && !e.altKey && e.code === 'KeyV') { if (paste()) { justPasted = true; setTimeout(() => { justPasted = false; }, 0); } return; }
        if (mod) return;
        const map = { v: 'select', r: 'rect', o: 'rrect', c: 'circle', l: 'line', y: 'tri', p: 'pixel', t: 'text', g: 'chart' };
        if (map[k.toLowerCase()]) { setTool(map[k.toLowerCase()]); return; }
        if (k.toLowerCase() === 'f') { toggleFill(); return; }
        if (e.code === 'KeyI') { spriteFiles = null; fileIn.click(); return; }
        if (k === 'Escape') { triPts = null; preview = null; S.sel = []; AN.sel = []; update(); return; }
        if ((k === 'Delete' || k === 'Backspace') && S.sel.length) { e.preventDefault(); act('del'); return; }
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (arrows[k] && S.sel.length) { e.preventDefault(); const n = e.shiftKey ? 10 : 1; push('nudge' + S.sel.join()); shiftSel(S.sel, arrows[k][0] * n, arrows[k][1] * n); update(); }
    });

    // ---------- layout: resizable areas (the sizes are kept with the project in S.ui) and the area in focus ----------
    const appEl = document.querySelector('.app'), splitSide = document.getElementById('splitSide'), splitTl = document.getElementById('splitTl'), sideOpen = document.getElementById('sideOpen');
    const ui = () => S.ui || (S.ui = {});
    const narrow = () => matchMedia('(max-width:980px)').matches;
    function applyLayout() {
        const u = ui(), folded = !!u.sideFolded && !narrow();
        appEl.style.setProperty('--side-w', (folded ? 28 : u.sideW || 380) + 'px'); appEl.toggleAttribute('data-side-folded', folded); sideOpen.hidden = !folded;
        if (u.tlH) tlEl.style.setProperty('--tl-h', u.tlH + 'px'); else tlEl.style.removeProperty('--tl-h');
        for (const el of document.querySelectorAll('[data-resize]')) { const box = el.previousElementSibling, h = u[el.dataset.resize]; box.style.height = h ? h + 'px' : ''; box.style.maxHeight = h ? 'none' : ''; }
        document.querySelectorAll('.side .sec[data-sec]').forEach(sec => sec.classList.toggle('folded', (u.folded || []).includes(sec.dataset.sec)));
    }
    // after a size change the canvas picks its scale again («авто») and the timeline its ruler
    function relayout() { applyLayout(); render(); renderTimeline(); save(); }
    let dragged = false;
    function splitter(el, move, dbl) {
        el.addEventListener('pointerdown', e => {
            if (e.button) return; e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('drag');
            const st = move.start(), mv = ev => { if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 2) dragged = true; move.to(st, ev.clientX - e.clientX, ev.clientY - e.clientY); relayout(); }; dragged = false;
            const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); relayout(); };
            el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
        });
        el.addEventListener('dblclick', () => { if (dragged) return; dbl(); relayout(); }); // a drag right after a click is not a double click
    }
    // the right panel: narrower than 220 px folds it into a strip with ‹
    splitter(splitSide, {
        start: () => ui().sideFolded ? 0 : document.querySelector('.side').getBoundingClientRect().width,
        to: (w0, dx) => { const w = w0 - dx, u = ui(); u.sideFolded = w < 220; if (!u.sideFolded) u.sideW = Math.round(Math.max(280, Math.min(window.innerWidth * .6, w))); else if (w0) u.sideW = Math.round(w0); }, // folded: it opens at the width it had
    }, () => { ui().sideFolded = !ui().sideFolded; });
    sideOpen.addEventListener('click', () => { ui().sideFolded = false; relayout(); });
    // the timeline: lower than 70 px folds it (as ▾ does)
    splitter(splitTl, {
        start: () => S.tlFolded ? 40 : tlEl.getBoundingClientRect().height,
        to: (h0, dx, dy) => { const h = h0 - dy; S.tlFolded = h < 70; if (!S.tlFolded) ui().tlH = Math.round(Math.max(110, Math.min(window.innerHeight * .75, h))); },
    }, () => { S.tlFolded = !S.tlFolded; });
    // the layer list and the code: any height; a double click goes back to the usual one
    for (const el of document.querySelectorAll('[data-resize]')) splitter(el, {
        start: () => el.previousElementSibling.getBoundingClientRect().height,
        to: (h0, dx, dy) => { ui()[el.dataset.resize] = Math.round(Math.max(60, Math.min(window.innerHeight * .85, h0 + dy))); },
    }, () => { delete ui()[el.dataset.resize]; });
    // a panel section folds by a click on its title (not on its buttons)
    document.querySelectorAll('.side .sec[data-sec] > h2').forEach(h => h.insertAdjacentHTML('afterbegin', '<span class="caret" aria-hidden="true">▾</span>'));
    document.querySelector('.side').addEventListener('click', e => {
        const h = e.target.closest('.sec[data-sec] > h2'); if (!h || e.target.closest('.r, button, input, select, label')) return;
        const u = ui(), id = h.parentElement.dataset.sec, f = new Set(u.folded || []); f.has(id) ? f.delete(id) : f.add(id); u.folded = [...f]; relayout();
    });
    // the area the keyboard works in: the canvas, the timeline or a panel section — the last one clicked, outlined
    let areaEl = null;
    function setArea(el) { if (el === areaEl) return; if (areaEl) areaEl.classList.remove('area-focus'); areaEl = el; if (el) el.classList.add('area-focus'); }
    const areaOf = t => t.closest('.rail') ? stage : t.closest('.stage, .tl, .side .sec');
    for (const ev of ['pointerdown', 'focusin']) document.addEventListener(ev, e => { if (e.target.closest && !e.target.closest('dialog')) { const a = areaOf(e.target); if (a) setArea(a); } }, true);
    setArea(stage);

    // ---------- update ----------
    function update(fast) {
        if (TV.on || TV.raf) stopTrans(); // any change ends the transition preview
        ensureIds();
        if (AN.play || AN.follow) stopPlay(); // any change pauses playback, so keys don't land at a random moment
        if (AN.scr !== S.cur) { stopPlay(); Object.assign(AN, { scr: S.cur, k: 0, t: 0, sel: [], follow: null }); animBase = new Map(); }
        animDetect(); syncPalette(); animClean(); animFix(); animApply();
        renderTimeline(); render(); status(); renderCode(); renderLayers(); renderPalette(); renderBgPc(); renderTabs(); renderTrBar(); renderFonts();
        if (!fast || !insBody.contains(document.activeElement)) renderInspector();
        else { const s = one(); if (s) insBody.querySelectorAll('input[data-k]').forEach(inp => { if (inp !== document.activeElement) inp.value = fieldVal(s, inp.dataset.k); }); }
        rail.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === S.tool));
        const ss = selShapes(), fb = document.getElementById('fillBtn'), f0 = ss.find(s => META[s.t].canFill), fillOn = f0 ? f0.fill : S.fill;
        fb.setAttribute('aria-pressed', !!fillOn); fb.textContent = fillOn ? 'fill' : 'draw';
        view.classList.toggle('sel', S.tool === 'select');
        const col = ss.length ? ss[0].c : S.color; inColor.value = toHex(col); if (document.activeElement !== inColor565) inColor565.value = fmt565(col);
        document.getElementById('hex565').textContent = ss.length > 1 ? `цвет ${ss.length} фигур` : ss.length ? 'цвет фигуры' : 'цвет новых фигур';
        sw.querySelectorAll('.sw').forEach(b => b.setAttribute('aria-pressed', +b.dataset.c === col));
        inBg.value = toHex(S.bg); if (document.activeElement !== inBg565) inBg565.value = fmt565(S.bg);
        document.getElementById('spec').textContent = `GFXcanvas16 · ${S.W}×${S.H} · RGB565`;
        hintEl.textContent = HINTS[S.tool]; hintEl.title = HINTS[S.tool];
        save();
    }
    window.addEventListener('resize', () => { syncSettings(); applyLayout(); render(); renderTimeline(); });
    ensureIds(); S.screens.forEach((_, k) => withScreen(k, () => { ensureNames(); normalize(); }));
    applyLayout(); syncSettings(); update();
})();
