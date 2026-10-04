(() => {
    // ---------- state ----------
    // screens: [{name, shapes, groups, bg, bgPc}]; S.shapes / S.groups / S.bg / S.bgPc always mean the current screen S.screens[S.cur]
    // shapes: flat list in draw order; shape.g = id of its group; groups: {id, name, parent, collapsed, hidden, locked}, members of a group are kept contiguous
    // palette (shared by all screens): [{n: 'C_BG', c}]; shape.pc / shape.epc / screen.bgPc / S.colorPc = palette name the color comes from (the number is kept in sync)
    // assets: {id: dataURL} of uploaded pictures, shape.src points here; not part of undo snapshots, so history stays small
    const START = [];
    const blankScreen = name => ({ name, shapes: [], groups: [], bg: 0x0000, bgPc: '' });
    const S = { W: 172, H: 320, screens: [Object.assign(blankScreen('Main'), { shapes: START })], cur: 0, palette: [], assets: {}, nextG: 1, sel: [], tool: 'select', fill: false, color: 0xFFFF, colorPc: '', radius: 8, zoom: 'auto', grid: true, codeMode: 'snippet', textFont: '', textSize: 2, coordConsts: false, imgHeader: false, fonts: [] };
    for (const k of ['shapes', 'groups', 'bg', 'bgPc']) Object.defineProperty(S, k, { get: () => S.screens[S.cur][k], set: v => { S.screens[S.cur][k] = v; }, enumerable: false });
    const KEY = 'lcd-canvas-builder-v3', OLD_KEYS = ['lcd-canvas-builder-v2', 'lcd-canvas-builder-v1'];
    try {
        let d = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (!d) for (const k of OLD_KEYS) { const o = JSON.parse(localStorage.getItem(k) || 'null'); if (o && Array.isArray(o.shapes)) { d = migrate(o); break; } }
        if (d && Array.isArray(d.screens) && d.screens.length) { delete d.sel; Object.assign(S, d); S.cur = Math.min(Math.max(0, S.cur | 0), S.screens.length - 1); }
    } catch (e) { }
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
            const { sel, assets, ...rest } = S, used = new Set(S.screens.flatMap(sc => sc.shapes.filter(s => s.t === 'img').map(s => s.src)));
            const key = assetsVer + ':' + [...used].sort().join();
            if (key !== assetsKey) { assetsJson = JSON.stringify(Object.fromEntries(Object.entries(assets).filter(([k]) => used.has(k)))); assetsKey = key; }
            localStorage.setItem(KEY, '{"assets":' + assetsJson + ',' + JSON.stringify(rest).slice(1));
            saveFailed(false);
        } catch (e) { saveFailed(true); }
    }

    // history
    let hist = [], future = [], lastPushKey = '', lastPushT = 0;
    function snapshot() { return JSON.stringify({ screens: S.screens, cur: S.cur, palette: S.palette, nextG: S.nextG, W: S.W, H: S.H }); }
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
    let img, u32, idb, curCol = 0, curId = -1;
    function px(x, y) { if (x < 0 || y < 0 || x >= S.W || y >= S.H) return; const i = y * S.W + x; u32[i] = curCol; if (curId !== -3) idb[i] = curId; } // id -3: locked, keeps what is below clickable
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
        FONT_DATA[f.n] = { first: f.f, last: f.l, ya: f.y, bmp: b64(f.b), g: f.g, asc, desc, cp: true, custom: true };
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

    function raster(s, id) {
        curCol = toU32(s.c); curId = id;
        switch (s.t) {
            case 'text': if (s.var) drawVarText(s); else for (const l of layoutText(s)) drawStr(s.font, s.size, l.t, l.cx, l.cy); break;
            case 'img': drawImg(s); break;
            case 'rect': s.fill ? fillRect(s.x, s.y, s.w, s.h) : drawRect(s.x, s.y, s.w, s.h); break;
            case 'rrect': s.fill ? fillRoundRect(s.x, s.y, s.w, s.h, s.r) : drawRoundRect(s.x, s.y, s.w, s.h, s.r); break;
            case 'circle': s.fill ? fillCircle(s.x, s.y, s.r) : drawCircle(s.x, s.y, s.r); break;
            case 'line': line(s.x0, s.y0, s.x1, s.y1); break;
            case 'tri': if (s.fill) fillTriangle(s.x0, s.y0, s.x1, s.y1, s.x2, s.y2); else { line(s.x0, s.y0, s.x1, s.y1); line(s.x1, s.y1, s.x2, s.y2); line(s.x2, s.y2, s.x0, s.y0); } break;
            case 'pixel': px(s.x, s.y); break;
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
    function drawVarText(s) {
        const col = curCol; curCol = toU32(s.erase === 'color' ? s.ec : S.bg); fillRect(s.x, s.y, s.w, s.h); curCol = col;
        const l = varLayout(s); drawStr(s.font, s.size, l.t, l.cx, l.cy);
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
    function imgData(s) {
        if (!(s.w >= 1 && s.h >= 1)) return null;
        const e = srcImage(s.src); if (!e) return null;
        const key = [s.src, s.w, s.h, s.mode, s.scale, s.thr, s.inv].join('|'); let r = processed.get(key); if (r) return r;
        const rgba = resample(sourcePixels(e, s.w, s.h), s.w, s.h, s.scale === 'avg');
        r = s.mode === 'icon' ? toBits(rgba, s.w, s.h, s.thr, s.inv) : toRGB(rgba, s.w, s.h);
        if (processed.size > 64) processed.clear(); processed.set(key, r); return r;
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
                curCol = toU32(d.px[j * s.w + i]); px(s.x + i, s.y + j);
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
    };
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
    function handles(s) {
        const setR = (s, nx, ny) => { s.r = Math.round(Math.hypot(nx - s.x, ny - s.y)); };
        switch (s.t) {
            case 'rect': case 'rrect': case 'text': case 'img': return boxHandles(s);
            case 'circle': return [{ x: s.x + s.r, y: s.y, cur: 'ew-resize', set: setR }, { x: s.x - s.r, y: s.y, cur: 'ew-resize', set: setR }, { x: s.x, y: s.y - s.r, cur: 'ns-resize', set: setR }, { x: s.x, y: s.y + s.r, cur: 'ns-resize', set: setR }];
            case 'line': return [{ x: s.x0, y: s.y0, cur: 'move', pt: true, set: (s, a, b) => { s.x0 = a; s.y0 = b; } }, { x: s.x1, y: s.y1, cur: 'move', pt: true, set: (s, a, b) => { s.x1 = a; s.y1 = b; } }];
            case 'tri': return [0, 1, 2].map(i => ({ x: s['x' + i], y: s['y' + i], cur: 'move', pt: true, set: (s, a, b) => { s['x' + i] = a; s['y' + i] = b; } }));
            default: return [];
        }
    }
    function bbox(s) {
        switch (s.t) {
            case 'rect': case 'rrect': case 'text': case 'img': return [Math.min(s.x, s.x + s.w), Math.min(s.y, s.y + s.h), Math.abs(s.w), Math.abs(s.h)];
            case 'circle': return [s.x - s.r, s.y - s.r, 2 * s.r + 1, 2 * s.r + 1];
            case 'pixel': return [s.x, s.y, 1, 1];
            default: {
                const xs = [s.x0, s.x1, s.x2].filter(v => v != null), ys = [s.y0, s.y1, s.y2].filter(v => v != null);
                const x = Math.min(...xs), y = Math.min(...ys); return [x, y, Math.max(...xs) - x + 1, Math.max(...ys) - y + 1];
            }
        }
    }
    function moveShape(s, dx, dy) { for (const k of ['x', 'x0', 'x1', 'x2']) if (k in s) s[k] += dx; for (const k of ['y', 'y0', 'y1', 'y2']) if (k in s) s[k] += dy; }
    // union bbox of several shapes → [x, y, w, h] or null
    function boxOf(idx) {
        let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
        for (const i of idx) { const [x, y, w, h] = bbox(S.shapes[i]); L = Math.min(L, x); T = Math.min(T, y); R = Math.max(R, x + w); B = Math.max(B, y + h); }
        return L === Infinity ? null : [L, T, R - L, B - T];
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
        for (const sc of S.screens) { for (const s of sc.shapes) { fix(s, 'c', 'pc'); fix(s, 'ec', 'epc'); } if (sc.bgPc) { const p = palEntry(sc.bgPc); if (p) sc.bg = p.c; else sc.bgPc = ''; } }
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
    // the selection as a self-contained piece {shapes, groups}: only groups that are selected as a whole come along
    function clipSel() {
        const idx = new Set(S.sel), full = new Set(S.groups.filter(g => groupMembers(g.id).every(i => idx.has(i))).map(g => g.id));
        const shapes = selShapes().map(s => { const c = JSON.parse(JSON.stringify(s)); if (!full.has(c.g)) delete c.g; return c; });
        const groups = S.groups.filter(g => full.has(g.id)).map(g => ({ ...g, parent: full.has(g.parent) ? g.parent : null }));
        return { shapes, groups };
    }
    function insertPiece(piece, off, at, parent) {
        const map = new Map(piece.groups.map(g => [g.id, S.nextG++]));
        S.groups.push(...piece.groups.map(g => ({ ...g, id: map.get(g.id), parent: g.parent != null ? map.get(g.parent) : parent })));
        const shapes = piece.shapes.map(s => { const c = JSON.parse(JSON.stringify(s)); if (c.g != null) c.g = map.get(c.g); else if (parent != null) c.g = parent; moveShape(c, off, off); return c; });
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
    function calcScale() {
        if (S.zoom !== 'auto') return +S.zoom;
        const narrow = matchMedia('(max-width:980px)').matches;
        const aw = stage.clientWidth - 32 - 28, ah = (narrow ? window.innerHeight * 0.72 : stage.clientHeight - 40) - 44 - 80;
        return Math.max(1, Math.min(8, Math.floor(Math.min(aw / S.W, ah / S.H))));
    }
    const rectAB = (a, b) => [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x) + 1, Math.abs(b.y - a.y) + 1];
    function render() {
        const W = S.W, H = S.H;
        if (!img || img.width !== W || img.height !== H) { off.width = W; off.height = H; img = offx.createImageData(W, H); u32 = new Uint32Array(img.data.buffer); idb = new Int32Array(W * H); }
        u32.fill(toU32(S.bg)); idb.fill(-1);
        S.shapes.forEach((s, i) => { if (!hiddenAt(i)) raster(s, lockedAt(i) ? -3 : i); });
        if (preview) raster(preview, -2);
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
        const sel = S.sel.filter(i => S.shapes[i]);
        if (sel.length > 1) { vx.lineWidth = 1; vx.strokeStyle = 'rgba(47,95,208,.9)'; for (const i of sel) { const [x, y, w, h] = bbox(S.shapes[i]); vx.strokeRect(x * scale + .5, y * scale + .5, w * scale - 1, h * scale - 1); } }
        const sb = boxOf(sel);
        if (sb) {
            const [x, y, w, h] = sb;
            vx.setLineDash([5, 4]); vx.lineWidth = 1.5; vx.strokeStyle = '#ffffff'; vx.strokeRect(x * scale - 1.5, y * scale - 1.5, w * scale + 3, h * scale + 3);
            vx.lineDashOffset = 5; vx.strokeStyle = '#2f5fd0'; vx.strokeRect(x * scale - 1.5, y * scale - 1.5, w * scale + 3, h * scale + 3); vx.setLineDash([]); vx.lineDashOffset = 0;
            const s = one();
            if (s && !lockedAt(sel[0])) for (const hd of handles(s)) { const X = (hd.x + .5) * scale, Y = (hd.y + .5) * scale; vx.fillStyle = '#fff'; vx.strokeStyle = '#2f5fd0'; vx.lineWidth = 1.5; vx.fillRect(X - 4, Y - 4, 8, 8); vx.strokeRect(X - 4, Y - 4, 8, 8); }
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
        for (let i = S.shapes.length - 1; i >= 0; i--) { const s = S.shapes[i]; if ((s.t !== 'text' && s.t !== 'img') || hiddenAt(i) || lockedAt(i)) continue; const [bx, by, bw, bh] = bbox(s); if (x >= bx && y >= by && x < bx + bw && y < by + bh) { box = i; break; } }
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
            case 'line': { let x1 = b.x, y1 = b.y; if (drag && drag.shift) { if (Math.abs(x1 - a.x) > Math.abs(y1 - a.y)) y1 = a.y; else x1 = a.x; } return { t, x0: a.x, y0: a.y, x1, y1, c }; }
        }
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
    const TOOLS = [['select', 'Выбор и перемещение', 'V'], ['rect', 'Прямоугольник', 'R'], ['rrect', 'Скруглённый прямоугольник', 'O'], ['circle', 'Круг', 'C'], ['line', 'Линия', 'L'], ['tri', 'Треугольник', 'Y'], ['pixel', 'Пиксель', 'P'], ['text', 'Текст', 'T']];
    const HINTS = {
        select: 'Клик — выбрать (фигуру в группе — вместе с группой, двойной клик — саму фигуру). Shift+клик — добавить к выделению, рамка по пустому месту — выделить несколько. Тяни — двигать, края и центры прилипают, с Ctrl/⌘ без привязки. Стрелки — 1 px, с Shift 10. Option (Alt) — расстояния.',
        rect: 'Тяни от угла до угла. Shift — квадрат. Просто клик ставит 40×30. Ctrl/⌘ — без привязки.',
        rrect: 'Тяни от угла до угла. Радиус настраивается в панели фигуры.',
        circle: 'Нажми в центре и тяни наружу — это радиус. Привязка у круга по центру.',
        line: 'Тяни от начала до конца. Shift — строго по горизонтали или вертикали.',
        tri: 'Три клика — три вершины. Esc отменяет.',
        text: 'Тяни рамку текстового блока (или просто кликни). Текст переносится по словам внутри рамки. Двойной клик по блоку — редактировать текст.',
        pixel: 'Клик ставит один пиксель.',
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
            push(); for (const sc of S.screens) { for (const s of sc.shapes) { if (s.pc === p.n) s.pc = v; if (s.epc === p.n) s.epc = v; } if (sc.bgPc === p.n) sc.bgPc = v; } if (S.colorPc === p.n) S.colorPc = v; p.n = v; warn.textContent = ''; update();
        }
    });
    palEl.addEventListener('focusout', () => setTimeout(() => { renderPalette(); renderBgPc(); }, 0));

    // screen size presets and orientation
    const PRESETS = [[172, 320, 'Waveshare 1.47″'], [135, 240, '1.14″'], [240, 240, '1.3″ / 1.54″'], [240, 280, '1.69″'], [240, 320, '2.0–2.8″'], [320, 480, '3.5″'], [128, 160, '1.8″'], [128, 128, '']];
    const inW = document.getElementById('inW'), inH = document.getElementById('inH'), inZoom = document.getElementById('inZoom'), inGrid = document.getElementById('inGrid'), inPreset = document.getElementById('inPreset');
    inPreset.innerHTML = '<option value="">свой</option>' + PRESETS.map(([w, h, n], k) => `<option value="${k}">${w}×${h}${n ? ' · ' + n : ''}</option>`).join('');
    function syncSettings() {
        inW.value = S.W; inH.value = S.H; inZoom.value = S.zoom; inGrid.checked = S.grid;
        const k = PRESETS.findIndex(([w, h]) => Math.min(S.W, S.H) === Math.min(w, h) && Math.max(S.W, S.H) === Math.max(w, h)); inPreset.value = k < 0 ? '' : k;
    }
    inW.addEventListener('change', () => { const v = Math.max(1, Math.min(1024, +inW.value | 0)); push(); S.W = v; syncSettings(); update(); });
    inH.addEventListener('change', () => { const v = Math.max(1, Math.min(1024, +inH.value | 0)); push(); S.H = v; syncSettings(); update(); });
    inPreset.addEventListener('change', () => { if (inPreset.value === '') return; const [w, h] = PRESETS[+inPreset.value], land = S.W > S.H; push(); S.W = land ? h : w; S.H = land ? w : h; syncSettings(); update(); });
    document.getElementById('rotBtn').addEventListener('click', () => { push(); [S.W, S.H] = [S.H, S.W]; syncSettings(); update(); });
    inZoom.addEventListener('change', () => { S.zoom = inZoom.value; update(); });
    inGrid.addEventListener('change', () => { S.grid = inGrid.checked; update(); });

    // inspector
    const insBody = document.getElementById('insBody'), insBtns = document.getElementById('insBtns');
    const alignHtml = (attr, list, label, aria, dis) => `<div class="align" role="group" aria-label="${aria}"><span class="set">${label}</span>${list.map(([k, n, ic]) => `<button class="ab${k === 'c' ? ' wide' : ''}" ${attr}="${k}" title="${n}" aria-label="${n}"${dis && dis(k) ? ' disabled' : ''}><svg viewBox="0 0 20 20">${ic}</svg>${k === 'c' ? 'центр' : ''}</button>`).join('')}</div>`;
    const stepBtns = '<button class="btn" data-a="up" title="Выше (рисуется позже)">↑</button><button class="btn" data-a="down" title="Ниже (рисуется раньше)">↓</button>';
    function renderInspector() {
        const s = one();
        if (!S.sel.length) {
            insBtns.innerHTML = '';
            insBody.innerHTML = `<div class="empty">Ничего не выбрано. Новые фигуры: <b>${S.fill ? 'заливка' : 'контур'}</b>, цвет ${S.colorPc || fmt565(S.color)}.</div>
      <div class="row" style="margin-top:8px"><span class="set">Радиус для новых скруглённых</span><input type="number" id="inRad" value="${S.radius}" style="width:60px"></div>`;
            document.getElementById('inRad').onchange = e => { S.radius = Math.max(0, +e.target.value | 0); save(); };
            return;
        }
        if (!s) return renderMulti();
        const m = META[s.t], i = S.sel[0];
        insBtns.innerHTML = `${stepBtns}<button class="btn" data-a="dup" title="Дублировать (Ctrl+D)">Копия</button><button class="btn danger" data-a="del" title="Удалить (Del)">Удалить</button>`;
        insBody.innerHTML = `<div class="row" style="justify-content:space-between"><span><span class="chip" style="background:${toHex(s.c)}"></span><b>${esc(s.name || m.name)}</b> <span class="spec">${[(s.name || '').startsWith(m.name) ? '' : m.name, s.pc].filter(Boolean).join(' · ')}</span></span>
    ${m.canFill ? `<span class="seg" id="insFill"><button data-f="0" aria-pressed="${!s.fill}">draw</button><button data-f="1" aria-pressed="${!!s.fill}">fill</button></span>` : ''}</div>
    <div class="fields" style="margin-top:10px">${m.f.map(([k, l]) => `<label>${l}<input type="number" data-k="${k}" id="f-${k}" value="${s[k]}"></label>`).join('')}</div>
    ${s.t === 'text' ? textInspector(s) : ''}${s.t === 'img' ? imgInspector(s) : ''}
    ${alignHtml('data-al', ALIGN, 'По экрану', 'Выравнивание по экрану')}`;
        insBody.querySelectorAll('input[data-k]').forEach(inp => inp.addEventListener('input', () => {
            if (inp.value === '' || isNaN(+inp.value)) return; push('f' + i + inp.dataset.k); S.shapes[i][inp.dataset.k] = Math.trunc(+inp.value); update(true);
        }));
        if (s.t === 'text') bindTextInspector(s, i);
        if (s.t === 'img') bindImgInspector(s, i);
        const f = document.getElementById('insFill');
        if (f) f.onclick = e => { const b = e.target.closest('button'); if (!b) return; push(); s.fill = b.dataset.f === '1'; S.fill = s.fill; update(); };
    }
    function renderMulti() {
        const ns = selNodes(), grp = selGroup();
        insBtns.innerHTML = (ns.length === 1 ? stepBtns : '')
            + (grp ? '<button class="btn" data-a="ungroup" title="Разгруппировать (Ctrl/⌘+Shift+G)">Разгруппировать</button>' : '<button class="btn" data-a="group" title="Сгруппировать (Ctrl/⌘+G)">Группа</button>')
            + '<button class="btn" data-a="dup" title="Дублировать (Ctrl+D)">Копия</button><button class="btn danger" data-a="del" title="Удалить (Del)">Удалить</button>';
        insBody.innerHTML = `<div class="row">${grp ? `<label class="set">Группа <input type="text" id="grpName" value="${escA(grp.g.name)}" style="width:160px"></label>` : ''}<span class="spec">выбрано фигур: ${S.sel.length}${ns.length > 1 ? `, объектов: ${ns.length}` : ''}</span></div>
    ${ns.length >= 2 ? alignHtml('data-sal', SALIGN, 'Между собой', 'Выравнивание внутри выделения', k => (k === 'dh' || k === 'dv') && ns.length < 3) : ''}
    ${alignHtml('data-al', ALIGN, 'По экрану', 'Выравнивание по экрану')}`;
        const gn = document.getElementById('grpName');
        if (gn) gn.addEventListener('change', () => { const v = gn.value.trim(); if (v && v !== grp.g.name) { push(); grp.g.name = v; } update(); });
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
    </div></div>`;
    }
    function textWarn(s) {
        const bad = [...new Set([...(s.text || '')].filter(ch => ch !== '\n' && !supported(s.font, ch)))];
        const el = document.getElementById('txtWarn'); if (!el) return;
        const m = fontMetrics(s.font, s.size), over = m.block(wrapText(s).length) > s.h;
        el.textContent = (bad.length ? `Нет в шрифте и будут пропущены: ${bad.slice(0, 12).join(' ')}. ` : '') + (over ? 'Текст выше рамки — увеличь h или нажми «Высота по тексту».' : '');
    }
    function imgInspector(s) {
        const seg = (id, key, items) => `<span class="seg" id="${id}">${items.map(([v, l, t]) => `<button data-v="${v}" title="${t}" aria-pressed="${s[key] === v}">${l}</button>`).join('')}</span>`;
        const d = imgData(s), bw = (s.w + 7) >> 3, icon = s.mode === 'icon', bytes = icon ? bw * s.h : s.w * s.h * 2 + (d && d.mask ? bw * s.h : 0);
        return `<div class="txt">
    <div class="row">${seg('imgMode', 'mode', [['color', 'цвет', 'RGB565-массив и drawRGBBitmap'], ['icon', 'иконка', '1-битная маска и drawBitmap цветом фигуры']])}
      ${seg('imgScale', 'scale', [['nearest', 'без сглаживания', 'Каждый пиксель берётся из ближайшего пикселя исходника'], ['avg', 'усреднение', 'Каждый пиксель — среднее по своей области исходника']])}</div>
    ${icon ? `<div class="row"><label class="set">порог <input type="range" id="imgThr" min="1" max="255" value="${s.thr}"></label><span class="spec" id="imgThrV">${s.thr}</span><label class="set"><input type="checkbox" id="imgInv"${s.inv ? ' checked' : ''}> инверсия</label></div>
    <div class="msg">Пиксель горит, если он темнее порога (прозрачное считается белым). Цвет иконки — в разделе «Цвет», можно из палитры.</div>` : ''}
    <div class="row"><button class="btn" id="imgRatio" title="Подогнать высоту под пропорции исходной картинки">Исходные пропорции</button><span class="spec">${d ? (!icon && d.mask ? 'с прозрачностью · ' : '') : 'загружается… · '}${bytes.toLocaleString('ru')} байт</span></div></div>`;
    }
    function bindImgInspector(s, i) {
        for (const [id, key] of [['imgMode', 'mode'], ['imgScale', 'scale']]) document.getElementById(id).onclick = e => { const b = e.target.closest('button'); if (!b || s[key] === b.dataset.v) return; push(); s[key] = b.dataset.v; update(); };
        const thr = document.getElementById('imgThr');
        if (thr) thr.addEventListener('input', () => { push('thr' + i); s.thr = +thr.value; document.getElementById('imgThrV').textContent = thr.value; update(true); });
        const inv = document.getElementById('imgInv');
        if (inv) inv.onchange = () => { push(); s.inv = inv.checked; update(); };
        document.getElementById('imgRatio').onclick = () => { if (!s.nw || !s.nh) return; push(); s.h = Math.max(1, Math.round(s.w * s.nh / s.nw)); update(); };
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
            if (e.target.checked) { s.var = uniqueVar('text', new Set(S.screens.flatMap(x => x.shapes.map(t => t.var)).filter(Boolean))); s.erase = 'bg'; s.ec = S.bg; s.text = (s.text || '').replace(/\n/g, ' '); }
            else for (const k of ['var', 'erase', 'ec', 'epc']) delete s[k];
            update();
        };
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
    function plan() {
        const used = new Set(['W', 'H', 'canvas', 'lcd', 'present', 'setup', 'loop', ...S.palette.map(p => p.n)]);
        const take = (base, sep = '_') => { let n = base, k = 2; while (used.has(n)) n = base + sep + k++; used.add(n); return n; };
        const P = { fns: S.screens.map(sc => take('draw' + pascalId(sc.name), '')), shapes: new Map(), vis: [] };
        S.screens.forEach((sc, k) => {
            const vis = withScreen(k, () => S.shapes.filter((_, i) => !hiddenAt(i))); P.vis.push(vis);
            for (const s of vis) {
                const e = {};
                if (S.coordConsts && customName(s)) e.pre = take(upperId(s.name));
                if (s.t === 'img') { e.arr = take(snakeId(s.name)); const d = imgData(s); if (d && d.mask && s.mode !== 'icon') e.mask = take(e.arr + '_mask'); }
                if (s.t === 'text' && s.var) e.fn = take(varFn(s.var), '');
                P.shapes.set(s, e);
            }
        });
        return P;
    }
    // a coordinate: the number, or NAME_X when the element has constants
    const V = (s, e, k) => e && e.pre ? `${e.pre}_${k.toUpperCase()}` : String(s[k]);
    const plus = (base, d) => d ? `${base} ${d < 0 ? '-' : '+'} ${Math.abs(d)}` : base;
    function codeLine(s, e) {
        const c = colStr(s), p = s.fill ? 'fill' : 'draw', v = k => V(s, e, k);
        switch (s.t) {
            case 'rect': return `canvas.${p}Rect(${v('x')}, ${v('y')}, ${v('w')}, ${v('h')}, ${c});`;
            case 'rrect': return `canvas.${p}RoundRect(${v('x')}, ${v('y')}, ${v('w')}, ${v('h')}, ${v('r')}, ${c});`;
            case 'circle': return `canvas.${p}Circle(${v('x')}, ${v('y')}, ${v('r')}, ${c});`;
            case 'line': return `canvas.drawLine(${v('x0')}, ${v('y0')}, ${v('x1')}, ${v('y1')}, ${c});`;
            case 'tri': return `canvas.${p}Triangle(${v('x0')}, ${v('y0')}, ${v('x1')}, ${v('y1')}, ${v('x2')}, ${v('y2')}, ${c});`;
            case 'pixel': return `canvas.drawPixel(${v('x')}, ${v('y')}, ${c});`;
            case 'img': return s.mode === 'icon' ? `canvas.drawBitmap(${v('x')}, ${v('y')}, ${e.arr}, ${v('w')}, ${v('h')}, ${c});`
                : `canvas.drawRGBBitmap(${v('x')}, ${v('y')}, ${e.arr}, ${e.mask ? e.mask + ', ' : ''}${v('w')}, ${v('h')});`;
        }
    }
    function textCode(s, st, e) {
        const out = [], col = colStr(s);
        if (!st.wrap) { out.push('canvas.setTextWrap(false);  // переносы уже посчитаны редактором'); st.wrap = true; }
        if (st.font !== s.font) { out.push(s.font ? `canvas.setFont(&${s.font});` : 'canvas.setFont();  // встроенный 5×7'); st.font = s.font; }
        if (st.size !== s.size) { out.push(`canvas.setTextSize(${s.size});`); st.size = s.size; }
        if (st.color !== col) { out.push(`canvas.setTextColor(${col});`); st.color = col; }
        for (const l of layoutText(s)) {
            const cx = e && e.pre ? plus(V(s, e, 'x'), l.cx - s.x) : l.cx, cy = e && e.pre ? plus(V(s, e, 'y'), l.cy - s.y) : l.cy;
            const lit = `"${cstr(l.t)}"`, cp = FONT_DATA[s.font] && FONT_DATA[s.font].cp && /[^\x00-\x7F]/.test(l.t);
            out.push(`canvas.setCursor(${cx}, ${cy});`); out.push(`canvas.print(${cp ? `cp1251(${lit})` : lit});`);
        }
        return out;
    }
    function shapeCode(s, e, st) {
        // the function sets font, size and colour itself, so the next static text must set them again
        if (s.t === 'text' && s.var) { st.font = st.size = undefined; st.color = null; return [`${e.fn}("${cstr(varText(s))}");`]; }
        return s.t === 'text' ? textCode(s, st, e) : [codeLine(s, e)];
    }
    // drawing lines of screen k in draw order; named elements and groups get a «// name» comment; i/k point back at the shape
    function screenLines(k, P, unknown) {
        return withScreen(k, () => {
            const st = unknown ? { font: undefined, size: undefined, color: null, wrap: false } : { font: '', size: 1, color: null, wrap: false }, out = [];
            (function walk(n) {
                for (const c of n.kids) {
                    if (c.i == null) { if (nodeIdx(c).every(hiddenAt)) continue; if (customGroup(c.g)) out.push({ t: '// ' + c.g.name, i: -1, k }); walk(c); continue; }
                    const s = S.shapes[c.i]; if (hiddenAt(c.i)) continue;
                    if (customName(s)) out.push({ t: '// ' + s.name, i: c.i, k });
                    for (const t of shapeCode(s, P.shapes.get(s), st)) out.push({ t, i: c.i, k });
                }
            })(buildTree());
            return out;
        });
    }
    const constLines = (vis, P) => vis.flatMap(s => { const e = P.shapes.get(s); return e.pre ? FIELDS[s.t].map(f => `constexpr int ${e.pre}_${f.toUpperCase()} = ${s[f]};`) : []; });
    // PROGMEM arrays of a picture; data rows are marked so the panel can fold them
    const arrCache = new Map();
    function imgArrayLines(s, e) {
        const d = imgData(s); if (!d) return [{ t: `// ${s.name}: картинка ещё загружается` }];
        const key = [s.src, s.w, s.h, s.mode, s.scale, s.thr, s.inv, e.arr, e.mask, s.name].join('|'); let r = arrCache.get(key); if (r) return r;
        const rows = (vals, per, n) => { const o = []; for (let k = 0; k < vals.length; k += per) o.push({ t: '  ' + Array.from(vals.slice(k, k + per), v => '0x' + v.toString(16).toUpperCase().padStart(n, '0')).join(', ') + ',', data: true }); return o; };
        const icon = s.mode === 'icon';
        r = [{ t: `// ${s.name}: ${s.w}×${s.h}, ${icon ? '1 бит на пиксель, для drawBitmap' : 'RGB565, для drawRGBBitmap' + (e.mask ? ' + маска прозрачности' : '')}` }];
        if (icon) r.push({ t: `const uint8_t ${e.arr}[] PROGMEM = {` }, ...rows(d.bits, 16, 2), { t: '};' });
        else {
            r.push({ t: `const uint16_t ${e.arr}[] PROGMEM = {` }, ...rows(d.px, 12, 4), { t: '};' });
            if (e.mask) r.push({ t: `const uint8_t ${e.mask}[] PROGMEM = {` }, ...rows(d.mask, 16, 2), { t: '};' });
        }
        if (arrCache.size > 32) arrCache.clear(); arrCache.set(key, r); return r;
    }
    // void drawTemp(const char* value): erase the block, set the style, place the value by getTextBounds and the block alignment
    function varFnLines(s, e, bg) {
        const v = k => V(s, e, k), x = v('x'), y = v('y'), w = v('w'), h = v('h');
        const er = s.erase === 'color' ? (s.epc && palEntry(s.epc) ? s.epc : fmt565(s.ec)) : bg;
        const cx = s.align === 'center' ? `${x} + (${w} - bw) / 2 - bx` : s.align === 'right' ? `${x} + ${w} - bw - bx` : `${x} - bx`;
        const cy = s.valign === 'middle' ? `${y} + (${h} - bh) / 2 - by` : s.valign === 'bottom' ? `${y} + ${h} - bh - by` : `${y} - by`;
        return [`// меняющийся текст «${s.var}»${customName(s) ? ' — ' + s.name : ''}`, `void ${e.fn}(const char* value) {`,
            `  canvas.fillRect(${x}, ${y}, ${w}, ${h}, ${er});  // стереть область блока`,
            s.font ? `  canvas.setFont(&${s.font});` : '  canvas.setFont();  // встроенный 5×7', `  canvas.setTextSize(${s.size});`, `  canvas.setTextColor(${colStr(s)});`, '  canvas.setTextWrap(false);',
            ...(FONT_DATA[s.font] && FONT_DATA[s.font].cp ? ['  value = cp1251(value);  // UTF-8 → CP1251 для шрифта с кириллицей'] : []),
            '  // выравнивание считается на плате через getTextBounds', '  int16_t bx, by; uint16_t bw, bh;', '  canvas.getTextBounds(value, 0, 0, &bx, &by, &bw, &bh);',
            `  canvas.setCursor(${cx}, ${cy});`, '  canvas.print(value);', '}'];
    }
    function buildLines(P = plan()) {
        const L = t => ({ t, i: -1 }), ind = l => ({ ...l, t: l.t ? '  ' + l.t : l.t });
        const pal = S.palette.map(p => L(`constexpr uint16_t ${p.n} = ${fmt565(p.c)};`));
        const all = P.vis.flatMap((v, k) => v.map(s => ({ s, k, e: P.shapes.get(s) })));
        const imgs = all.filter(o => o.s.t === 'img'), vars = all.filter(o => o.s.t === 'text' && o.s.var), header = S.imgHeader && imgs.length > 0;
        const arrays = () => imgs.flatMap(o => [...imgArrayLines(o.s, o.e).map(l => ({ i: -1, ...l })), L('')]);
        if (S.codeMode === 'images' && header) return [L('// images.h — картинки для скетча'), L('#pragma once'), L('#include <Arduino.h>'), L(''), ...arrays()];
        if (S.codeMode === 'snippet') {
            const cur = P.vis[S.cur], notes = [];
            if (cur.some(s => s.t === 'img')) notes.push(L(`// массивы картинок — в режиме «весь скетч»${header ? ' (images.h)' : ''}`));
            if (cur.some(s => s.t === 'text' && s.var)) notes.push(L('// функции меняющегося текста — в режиме «весь скетч»'));
            const pre = [...pal, ...constLines(cur, P).map(L), ...notes], body = screenLines(S.cur, P, false);
            return pre.length ? [...pre, L(''), ...body] : body;
        }
        const fonts = [...new Set(all.filter(o => o.s.t === 'text' && o.s.font).map(o => o.s.font))], consts = all.flatMap(o => constLines([o.s], P)).map(L);
        const out = [
            L('#include <Waveshare_LCD147.h>'), L('#include <Adafruit_GFX.h>'), ...fonts.map(f => L(FONT_DATA[f] && FONT_DATA[f].custom ? `#include "${f}.h"  // шрифт проекта, файл — в разделе «Шрифты»` : `#include <Fonts/${f}.h>`)), ...(header ? [L('#include "images.h"')] : []), L(''),
            L(`constexpr int W = ${S.W};   // ширина экрана`), L(`constexpr int H = ${S.H};   // высота экрана`), L(''),
            ...(pal.length ? [...pal, L('')] : []),
            ...(consts.length ? [L('// координаты именованных элементов'), ...consts, L('')] : []),
            L('St7789* lcd;                 // драйвер (твоя библиотека)'), L('GFXcanvas16 canvas(W, H);    // холст в памяти, на нём рисуем'), L(''),
            ...(header ? [] : arrays()),
            L('// Показать холст на экране'), L('void present() {'), L('  lcd->drawImage(0, 0, W, H, canvas.getBuffer());'), L('}'), L(''),
            ...vars.flatMap(o => [...varFnLines(o.s, o.e, bgExpr(S.screens[o.k])).map(L), L('')]),
        ];
        // with several screens a screen can't rely on text settings left by another one
        const unknown = S.screens.length > 1;
        S.screens.forEach((sc, k) => out.push(L(`// Экран «${sc.name}»`), L(`void ${P.fns[k]}() {`), L(`  canvas.fillScreen(${bgExpr(sc)});  // фон`), ...screenLines(k, P, unknown).map(ind), L('}'), L('')));
        out.push(L('void setup() {'), L('  Serial.begin(115200);'), L('  lcd = &Waveshare147::begin();'), L(''), L(`  ${P.fns[0]}();`), L('  present();'), L('}'), L(''), L('void loop() {'));
        if (vars.length) { const o = vars[0]; out.push(L('  // пример обновления меняющегося текста:'), L(`  // ${o.e.fn}("${cstr(varText(o.s))}");`), L('  // present();')); }
        out.push(L('}'));
        return out;
    }
    const hasHeaderMode = () => S.imgHeader && S.screens.some(sc => sc.shapes.some(s => s.t === 'img'));
    function renderCode() {
        if (S.codeMode === 'images' && !hasHeaderMode()) S.codeMode = 'full';
        const lines = buildLines(), sel = new Set(S.sel), html = [];
        for (let n = 0; n < lines.length; n++) {
            const l = lines[n];
            if (l.data) { let m = n; while (m < lines.length && lines[m].data) m++; html.push(`<div class="t-c fold">  …  // ${m - n} строк данных — целиком при копировании</div>`); n = m - 1; continue; }
            const k = l.k ?? S.cur, on = l.i >= 0 && k === S.cur && sel.has(l.i);
            html.push(`<div class="${l.i >= 0 ? 'shape' : ''}${on ? ' on' : ''}"${l.i >= 0 ? ` data-i="${l.i}" data-k="${k}"` : ''}>${hl(l.t) || ' '}</div>`);
        }
        codeEl.innerHTML = html.length ? html.join('') : '<div class="t-c">// холст пуст — нарисуй что-нибудь</div>';
        const on = codeEl.querySelector('.on'); if (on) { const r = on.offsetTop - codeEl.scrollTop; if (r < 0 || r > codeEl.clientHeight - 20) codeEl.scrollTop = on.offsetTop - codeEl.clientHeight / 2; }
        document.getElementById('modeImg').hidden = !hasHeaderMode();
        document.querySelectorAll('#codeMode button').forEach(b => b.setAttribute('aria-pressed', b.dataset.m === S.codeMode));
        document.getElementById('optConsts').checked = S.coordConsts; document.getElementById('optImgH').checked = S.imgHeader;
    }
    codeEl.addEventListener('click', e => { const d = e.target.closest('[data-i]'); if (!d) return; if (+d.dataset.k !== S.cur) { S.cur = +d.dataset.k; triPts = null; preview = null; } setSel([+d.dataset.i]); S.tool = 'select'; update(); });
    document.getElementById('codeMode').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.codeMode = b.dataset.m; update(); } });
    document.getElementById('optConsts').addEventListener('change', e => { S.coordConsts = e.target.checked; update(); });
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
            let d = 1, i = re.lastIndex, q = false;
            for (; i < src.length && d; i++) { const ch = src[i]; if (q) { if (ch === '\\') i++; else if (ch === '"') q = false; } else if (ch === '"') q = true; else if (ch === '{') d++; else if (ch === '}') d--; }
            out.push({ name: m[1], params: m[2].trim(), body: src.slice(re.lastIndex, i - 1), start: m.index, end: i }); re.lastIndex = i;
        }
        return out;
    }
    // a generated changing-text function → block geometry, style and alignment
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
        return rect ? v : null;
    }
    function parseCode(raw) {
        const names = {}; for (const m of raw.matchAll(/\/\/\s*Экран\s*«([^»\n]*)»\s*\n\s*void\s+(\w+)\s*\(/g)) names[m[2]] = m[1];
        const src = raw.replace(/("(?:\\.|[^"\\])*")|\/\/.*$|\/\*[\s\S]*?\*\//gm, (m, q) => q || '');
        const pal = {}, vars = {};
        for (const m of src.matchAll(/\b(?:constexpr|const)\s+uint16_t\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g)) { const v = evalNum(m[2], pal, vars); if (v != null) pal[m[1]] = v & 0xFFFF; }
        for (const m of src.matchAll(/\b(?:constexpr|const)\s+(?:int|int16_t|int32_t)\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g)) { if (m[1] === 'W' || m[1] === 'H') continue; const v = evalNum(m[2], pal, vars); if (v != null) vars[m[1]] = v; }
        const ctx = { pal, vars, varFns: {}, skipped: 0, imgSkipped: 0, pcOf: a => a != null && pal[a.trim()] != null ? a.trim() : '' };
        const fns = splitFunctions(src);
        for (const f of fns) if (/^const\s+char\s*\*\s*\w+$/.test(f.params)) { const v = parseVarFn(f, ctx); if (v) ctx.varFns[f.name] = v; }
        const scr = fns.filter(f => !f.params && !['setup', 'loop', 'present'].includes(f.name) && /canvas\s*\./.test(f.body));
        if (scr.length) { const screens = scr.map(f => ({ name: names[f.name] || f.name.replace(/^draw(?=\w)/, ''), ...parseBody(f.body, ctx) })); return { ...ctx, multi: true, screens }; }
        // no screen functions (a snippet or the old one-screen sketch): everything outside changing-text functions is one screen
        let rest = src; for (const f of fns.filter(f => ctx.varFns[f.name]).reverse()) rest = rest.slice(0, f.start) + rest.slice(f.end);
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
            if (g.pc) sh.pc = g.pc; out.push(sh);
        };
        // canvas.fn(args); or a call of a changing-text function: drawTemp("example");
        const re = /canvas\s*\.\s*(\w+)\s*\(((?:"(?:\\.|[^"\\])*"|[^;"])*)\)\s*;|\b([A-Za-z_]\w*)\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)\s*;/g; let m;
        while ((m = re.exec(src))) {
            if (m[3]) {
                const v = ctx.varFns[m[3]]; if (!v) continue; flush();
                const sh = { t: 'text', x: v.x, y: v.y, w: v.w, h: v.h, text: cunesc(m[4]), font: v.font, size: v.size, align: v.align, valign: v.valign, c: v.c, var: m[3].replace(/^draw(?=\w)/, '').replace(/^\w/, ch => ch.toLowerCase()) };
                if (v.pc) sh.pc = v.pc;
                if (v.eraseExpr === bgRaw) sh.erase = 'bg'; else { sh.erase = 'color'; sh.ec = v.ec; if (v.epc) sh.epc = v.epc; }
                out.push(sh); ts.font = v.font; ts.size = v.size; ts.c = v.c; ts.pc = v.pc; continue;
            }
            const fn = m[1], raw = m[2].trim();
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
            flush();
            const sh = { t: D[0] }; if (META[D[0]].canFill) sh.fill = k[1] === 'fill'; D[1].forEach((key, i) => sh[key] = args[i]); sh.c = args[args.length - 1];
            const pc = pcOf(parts[parts.length - 1]); if (pc) sh.pc = pc; out.push(sh);
        }
        flush();
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
            const made = r.screens.map(sc => { const scr = blankScreen(uniqueName(sc.name || 'Экран', taken)); taken.push(scr.name); scr.shapes = sc.out; if (sc.bg != null) { scr.bg = sc.bg; scr.bgPc = sc.bgPc; } return scr; });
            if (replace) { S.screens = made; S.cur = 0; } else { S.screens.push(...made); S.cur = S.screens.length - made.length; }
        } else {
            const sc = r.screens[0];
            if (replace) { S.shapes = sc.out; S.groups = []; } else S.shapes.push(...sc.out);
            if (sc.bg != null) { S.bg = sc.bg; S.bgPc = sc.bgPc; }
        }
        S.screens.forEach((_, k) => withScreen(k, () => { ensureNames(); normalize(); }));
        importMsg.textContent = `Загружено фигур: ${n}${r.multi ? `, экранов: ${r.screens.length}` : ''}${np ? `, цветов палитры: ${np}` : ''}${r.skipped ? `, пропущено: ${r.skipped} (не разобрал аргументы)` : ''}${r.imgSkipped ? `. Картинки не импортируются — пропущено вызовов: ${r.imgSkipped}` : ''}.`;
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
            + '<button class="tab-b" data-a="add" title="Новый экран" aria-label="Новый экран">+</button><button class="tab-b" data-a="dup" title="Дублировать экран" aria-label="Дублировать экран">⧉</button>'
            + `<button class="tab-b" data-a="del" title="Удалить экран" aria-label="Удалить экран"${S.screens.length < 2 ? ' disabled' : ''}>×</button>`;
        if (html !== tabsHtml) tabsEl.innerHTML = tabsHtml = html;
    }
    function switchScreen(k) { S.cur = k; S.sel = []; triPts = null; preview = null; update(); }
    tabsEl.addEventListener('click', e => {
        const t = e.target.closest('[data-k]'), b = e.target.closest('[data-a]');
        if (t) { if (+t.dataset.k !== S.cur) switchScreen(+t.dataset.k); return; }
        if (!b || b.disabled) return; const a = b.dataset.a, names = S.screens.map(sc => sc.name);
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
    function uniqueVar(base, ids) { let n = base, k = 2; while (ids.has(n)) n = base + k++; ids.add(n); return n; }

    // ---------- adding pictures: file button / I, drag and drop onto the stage, paste ----------
    const fileIn = document.getElementById('imgFile'), stageMsg = document.getElementById('stageMsg');
    let flashT = 0, saveBad = false;
    function flash(t) { stageMsg.textContent = t; clearTimeout(flashT); flashT = setTimeout(() => { stageMsg.textContent = saveBad ? SAVE_ERR : ''; }, 4000); }
    const SAVE_ERR = 'Не удалось сохранить в localStorage: не хватает места (скорее всего, из-за картинок). Изменения пропадут после перезагрузки.';
    function saveFailed(bad) { if (bad === saveBad) return; saveBad = bad; const el = document.getElementById('stageMsg'); if (el) el.textContent = bad ? SAVE_ERR : ''; }
    function addImageFile(file, at) {
        if (!file || !/^image\/(png|jpeg|svg\+xml|gif|webp)$/.test(file.type)) { flash('Нужна картинка PNG, JPG или SVG.'); return; }
        const rd = new FileReader(); rd.onload = () => addImageUrl(rd.result, file.name, at); rd.readAsDataURL(file);
    }
    function addImageUrl(url, fname, at) {
        const img = new Image();
        img.onload = () => {
            let nw = img.naturalWidth || 64, nh = img.naturalHeight || 64;
            // big rasters are kept downscaled so that localStorage holds them
            if (!url.startsWith('data:image/svg') && Math.max(nw, nh) > 1024) {
                const k = 1024 / Math.max(nw, nh), c = document.createElement('canvas'); c.width = Math.round(nw * k); c.height = Math.round(nh * k);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); url = c.toDataURL('image/png'); nw = c.width; nh = c.height;
            }
            const k = Math.min(1, S.W / nw, S.H / nh), w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
            const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); S.assets[id] = url; assetsVer++;
            const x = at ? at.x - (w >> 1) : Math.round((S.W - w) / 2), y = at ? at.y - (h >> 1) : Math.round((S.H - h) / 2);
            push(); const s = { t: 'img', x, y, w, h, src: id, nw, nh, mode: 'color', scale: 'avg', thr: 128, inv: false, c: S.color }; addShape(s);
            const base = (fname || '').replace(/\.[^.]*$/, '').trim(); if (base) s.name = base;
            S.tool = 'select'; update();
        };
        img.onerror = () => flash('Не удалось прочитать картинку.');
        img.src = url;
    }
    fileIn.addEventListener('change', () => { if (fileIn.files[0]) addImageFile(fileIn.files[0]); fileIn.value = ''; });
    document.getElementById('imgBtn').addEventListener('click', () => fileIn.click());
    stage.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); stage.classList.add('drop'); } });
    stage.addEventListener('dragleave', e => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('drop'); });
    stage.addEventListener('drop', e => {
        stage.classList.remove('drop'); const f = [...e.dataTransfer.files][0]; if (!f) return; e.preventDefault();
        const r = view.getBoundingClientRect(), inside = e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
        addImageFile(f, inside ? { x: Math.floor((e.clientX - r.left) / scale), y: Math.floor((e.clientY - r.top) / scale) } : null);
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
            const bytes = [], g = []; let missing = 0;
            for (let code = 0x20; code <= 0xFF; code++) {
                const ch = cpChar(code);
                if (!CP.has(ch) || code === 0xAD) { g.push([bytes.length, 0, 0, 0, 0, 0]); continue; } // no character at this code: empty glyph
                const a = draw(ch, 'monospace');
                // a glyph the font doesn't have comes from the fallback font: monospace and serif fallbacks then differ
                if (ch.trim()) { const b = draw(ch, 'serif'); let same = true; for (let i = 3; i < a.length; i += 4) if ((a[i] >= 128) !== (b[i] >= 128)) { same = false; break; } if (!same) { missing++; g.push([bytes.length, 0, 0, 0, 0, 0]); continue; } }
                x.font = `${px}px "${fam}", monospace`; const xa = Math.round(x.measureText(ch).width);
                let x0 = size, y0 = size, x1 = -1, y1 = -1;
                for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) if (a[(yy * size + xx) * 4 + 3] >= 128) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
                if (x1 < 0) { g.push([bytes.length, 0, 0, xa, 0, 0]); continue; }
                // GFXfont bitmap: rows packed one after another, MSB first, each glyph starts on a byte
                const off = bytes.length; let acc = 0, n = 0;
                for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { acc = (acc << 1) | (a[(yy * size + xx) * 4 + 3] >= 128 ? 1 : 0); if (++n === 8) { bytes.push(acc); acc = n = 0; } }
                if (n) bytes.push(acc << (8 - n));
                g.push([off, x1 - x0 + 1, y1 - y0 + 1, xa, x0 - ox, y0 - by]);
            }
            if (bytes.length > 65535) throw new Error('шрифт слишком большой для GFXfont (больше 64 КБ битмапов) — уменьши размер');
            if (!bytes.length) bytes.push(0);
            let bin = ''; for (let k = 0; k < bytes.length; k += 4096) bin += String.fromCharCode(...bytes.slice(k, k + 4096));
            return { n: name, f: 0x20, l: 0xFF, y: ya, b: btoa(bin), g, pt, src: file.name, missing };
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
            const used = S.screens.some(sc => sc.shapes.some(s => s.t === 'text' && s.font === f.n));
            if (used) { fontMsg.textContent = `${f.n} используется в тексте — сначала выбери там другой шрифт.`; return; }
            S.fonts = S.fonts.filter(x => x !== f); delete FONT_DATA[f.n]; if (S.textFont === f.n) S.textFont = ''; fontMsg.textContent = ''; update();
        }
    });
    function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

    // ---------- live preview on the board (Web Serial) ----------
    // frame, little-endian: "LCD2" | W u16 | H u16 | flags u8 (bit 0 = RLE) | seq u8 | len u32 | payload[len] | Fletcher-16(payload) u16
    // payload: RGB565 words in canvas.getBuffer() order; RLE: byte n, bit 7 set → the next word (n & 127) + 1 times, else n + 1 words as they are
    // the payload goes in CHUNK-byte pieces: after each full piece the board says "N <seq>" and only then gets the next one,
    // because USB CDC on the ESP32-S3 drops bytes when its receive buffer overflows; the frame ends with "OK <seq>" or "ERR <seq> <reason>"
    // while a frame is on its way only the newest state waits; no answer for REPLY_MS → the board has reset its parser (after 500 ms of silence), start over
    const LIVE = { port: null, writer: null, reader: null, busy: false, dirty: false, seq: 0, last: 0, done: [], timer: 0, wait: null, errs: 0, err: '', note: '', noReply: false };
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
    function buildFrame(seq) {
        const px = frame565(), raw = new Uint8Array(px.buffer), packed = rle(px), useRle = packed.length < raw.length, data = useRle ? packed : raw;
        const f = new Uint8Array(14 + data.length + 2), dv = new DataView(f.buffer);
        f.set([76, 67, 68, 50]); dv.setUint16(4, S.W, true); dv.setUint16(6, S.H, true); f[8] = useRle ? 1 : 0; f[9] = seq; dv.setUint32(10, data.length, true);
        f.set(data, 14); dv.setUint16(14 + data.length, fletcher16(data), true);
        return f;
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
    async function sendFrame(seq) {
        const f = buildFrame(seq), len = f.length - 16, cuts = [0];
        for (let k = CHUNK; k < len; k += CHUNK) cuts.push(14 + k);
        cuts.push(f.length);
        for (let k = 0; k < cuts.length - 1; k++) {
            const r = reply(seq); // armed before writing, so a fast answer isn't missed
            await LIVE.writer.write(f.subarray(cuts[k], cuts[k + 1]));
            const v = await r; if (v !== (k < cuts.length - 2 ? 'N' : 'OK')) return v === 'N' ? 'ERR' : v;
        }
        return 'OK';
    }
    async function pump() {
        if (!LIVE.writer || LIVE.busy || !LIVE.dirty) return;
        const wait = LIVE.last + 1000 / FPS - performance.now();
        if (wait > 0) { clearTimeout(LIVE.timer); LIVE.timer = setTimeout(pump, wait); return; }
        const port = LIVE.port; LIVE.dirty = false; LIVE.busy = true; LIVE.last = performance.now(); LIVE.seq = (LIVE.seq + 1) & 255;
        let r; try { r = await sendFrame(LIVE.seq); } catch (e) { r = 'closed'; }
        if (LIVE.port !== port) return; if (r === 'closed') return lost();
        LIVE.busy = false;
        if (r === 'OK') { LIVE.done.push(performance.now()); LIVE.noReply = false; }
        else if (r === 'timeout') { LIVE.noReply = true; LIVE.dirty = true; }
        else { LIVE.errs++; LIVE.noReply = false; LIVE.dirty = true; } // a broken frame is sent again
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
        Object.assign(LIVE, { port, writer: port.writable.getWriter(), busy: false, dirty: true, done: [], errs: 0, err: '', note: '', noReply: false });
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
            : LIVE.noReply ? 'плата не отвечает — залит ли свежий скетч-приёмник (протокол LCD2)?'
                : `подключена · ${LIVE.done.length} кадр/с · ${S.W}×${S.H}${LIVE.errs ? ` · ошибок: ${LIVE.errs} (${LIVE.err})` : ''}`;
    }
    setInterval(() => { if (LIVE.port) renderLive(); }, 500);
    function receiverSketch() {
        return `// LCD Canvas Builder — скетч-приёмник живого превью.
// Принимает кадры из редактора по USB (Web Serial) и показывает их на экране.
// Плата: Waveshare ESP32-S3-LCD-1.47B. В Arduino IDE: Tools → USB CDC On Boot → Enabled.
//
// Кадр (всё little-endian):
//   "LCD2" | W u16 | H u16 | flags u8 (бит 0 — RLE) | seq u8 | len u32 | payload[len] | Fletcher-16(payload) u16
// payload — слова RGB565 в порядке canvas.getBuffer(). RLE: байт n; если бит 7 = 1 —
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
uint8_t hdr[10], sum[2], got = 0;
uint16_t fw, fh;
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
  len = hdr[6] | hdr[7] << 8 | (uint32_t)hdr[8] << 16 | (uint32_t)hdr[9] << 24;
  done = 0; s1 = s2 = 0; pos = 0; left = 0; haveLo = false; bad = false; why = "";
  if (resize(fw, fh)) { px = canvas->getBuffer(); total = (uint32_t)cw * ch; }
  else { px = nullptr; total = 0; bad = true; why = "size"; }
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
  if (!bad) lcd->drawImage(0, 0, cw, ch, canvas->getBuffer());
  if (bad) Serial.printf("ERR %u %s\\n", seq, why);
  else Serial.printf("OK %u\\n", seq);
}

void feed(uint8_t b) {
  static const uint8_t magic[4] = { 'L', 'C', 'D', '2' };
  switch (state) {
    case WAIT_MAGIC:
      if (b == magic[got]) { if (++got == 4) { state = HEADER; got = 0; } }
      else got = (b == magic[0]) ? 1 : 0;
      break;
    case HEADER:
      hdr[got++] = b;
      if (got == 10) { startFrame(); got = 0; state = len ? PAYLOAD : CHECKSUM; }
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
        const map = { v: 'select', r: 'rect', o: 'rrect', c: 'circle', l: 'line', y: 'tri', p: 'pixel', t: 'text' };
        if (map[k.toLowerCase()]) { setTool(map[k.toLowerCase()]); return; }
        if (k.toLowerCase() === 'f') { toggleFill(); return; }
        if (e.code === 'KeyI') { fileIn.click(); return; }
        if (k === 'Escape') { triPts = null; preview = null; S.sel = []; update(); return; }
        if ((k === 'Delete' || k === 'Backspace') && S.sel.length) { e.preventDefault(); act('del'); return; }
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (arrows[k] && S.sel.length) { e.preventDefault(); const n = e.shiftKey ? 10 : 1; push('nudge' + S.sel.join()); shiftSel(S.sel, arrows[k][0] * n, arrows[k][1] * n); update(); }
    });

    // ---------- update ----------
    function update(fast) {
        syncPalette();
        render(); status(); renderCode(); renderLayers(); renderPalette(); renderBgPc(); renderTabs(); renderFonts();
        if (!fast || !insBody.contains(document.activeElement)) renderInspector();
        else { const s = one(); if (s) insBody.querySelectorAll('input[data-k]').forEach(inp => { if (inp !== document.activeElement) inp.value = s[inp.dataset.k]; }); }
        rail.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === S.tool));
        const ss = selShapes(), fb = document.getElementById('fillBtn'), f0 = ss.find(s => META[s.t].canFill), fillOn = f0 ? f0.fill : S.fill;
        fb.setAttribute('aria-pressed', !!fillOn); fb.textContent = fillOn ? 'fill' : 'draw';
        view.classList.toggle('sel', S.tool === 'select');
        const col = ss.length ? ss[0].c : S.color; inColor.value = toHex(col); if (document.activeElement !== inColor565) inColor565.value = fmt565(col);
        document.getElementById('hex565').textContent = ss.length > 1 ? `цвет ${ss.length} фигур` : ss.length ? 'цвет фигуры' : 'цвет новых фигур';
        sw.querySelectorAll('.sw').forEach(b => b.setAttribute('aria-pressed', +b.dataset.c === col));
        inBg.value = toHex(S.bg); if (document.activeElement !== inBg565) inBg565.value = fmt565(S.bg);
        document.getElementById('spec').textContent = `GFXcanvas16 · ${S.W}×${S.H} · RGB565`;
        hintEl.textContent = HINTS[S.tool];
        save();
    }
    window.addEventListener('resize', () => render());
    S.screens.forEach((_, k) => withScreen(k, () => { ensureNames(); normalize(); }));
    syncSettings(); update();
})();
