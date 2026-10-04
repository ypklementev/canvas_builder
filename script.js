(() => {
    // ---------- state ----------
    const START = [];
    const S = { W: 172, H: 320, bg: 0x0000, shapes: START, sel: -1, tool: 'select', fill: false, color: 0xFFFF, radius: 8, zoom: 'auto', grid: true, codeMode: 'snippet', textFont: '', textSize: 2 };
    const KEY = 'lcd-canvas-builder-v1';
    try { const d = JSON.parse(localStorage.getItem(KEY) || 'null'); if (d && Array.isArray(d.shapes)) Object.assign(S, d, { sel: -1 }); } catch (e) { }
    function save() { try { const { sel, ...rest } = S; localStorage.setItem(KEY, JSON.stringify(rest)); } catch (e) { } }

    // history
    let hist = [], future = [], lastPushKey = '', lastPushT = 0;
    function snapshot() { return JSON.stringify({ shapes: S.shapes, bg: S.bg, W: S.W, H: S.H }); }
    function push(key) { const now = Date.now(); if (key && key === lastPushKey && now - lastPushT < 800) { lastPushT = now; return; } lastPushKey = key || ''; lastPushT = now; hist.push(snapshot()); if (hist.length > 200) hist.shift(); future = []; }
    function restore(js) { const d = JSON.parse(js); Object.assign(S, d); if (S.sel >= S.shapes.length) S.sel = -1; }
    function undo() { if (!hist.length) return; future.push(snapshot()); restore(hist.pop()); lastPushKey = ''; syncSettings(); update(); }
    function redo() { if (!future.length) return; hist.push(snapshot()); restore(future.pop()); lastPushKey = ''; syncSettings(); update(); }

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
    function px(x, y) { if (x < 0 || y < 0 || x >= S.W || y >= S.H) return; const i = y * S.W + x; u32[i] = curCol; idb[i] = curId; }
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
    const GLCD = b64(GFX_FONTS.__glcd);
    const FONT_DATA = {};
    for (const k in GFX_FONTS) {
        if (k === '__glcd') continue; const f = GFX_FONTS[k]; let asc = 0, desc = 0;
        for (const g of f.g) if (g[1] && g[2]) { asc = Math.max(asc, -g[5]); desc = Math.max(desc, g[5] + g[2]); }
        FONT_DATA[k] = { first: f.f, last: f.l, ya: f.y, bmp: b64(f.b), g: f.g, asc, desc };
    }
    function supported(font, ch) { const c = ch.charCodeAt(0); if (!font || !FONT_DATA[font]) return c >= 32 && c <= 126; const F = FONT_DATA[font]; return c >= F.first && c <= F.last; }
    function cleanText(font, t) { return [...t].filter(ch => ch === '\n' || supported(font, ch)).join(''); }
    function measureStr(font, size, str) {
        if (!str.length) return { l: 0, w: 0 };
        if (!font || !FONT_DATA[font]) return { l: 0, w: str.length * 6 * size - size };
        const F = FONT_DATA[font]; let x = 0, mn = Infinity, mx = -Infinity;
        for (const ch of str) { const g = F.g[ch.charCodeAt(0) - F.first]; if (!g) continue; if (g[1] && g[2]) { mn = Math.min(mn, x + g[4]); mx = Math.max(mx, x + g[4] + g[1]); } x += g[3]; }
        return mn === Infinity ? { l: 0, w: 0 } : { l: mn * size, w: (mx - mn) * size };
    }
    // how far print() moves the cursor: write() gets UTF-8 bytes; built-in font: 6 × size per byte, GFXfont: xAdvance × size, bytes outside first..last don't move it; '\r' is ignored
    const utf8 = new TextEncoder();
    function advanceStr(font, size, str) {
        const bytes = utf8.encode(str.replace(/\r/g, ''));
        if (!font || !FONT_DATA[font]) return bytes.length * 6 * size;
        const F = FONT_DATA[font]; let x = 0;
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
            const g = F.g[ch.charCodeAt(0) - F.first]; if (!g) continue;
            const [bo0, w, h, xa, xo, yo] = g; let bo = bo0, bits = 0, bit = 0;
            for (let yy = 0; yy < h; yy++)for (let xx = 0; xx < w; xx++) {
                if (!(bit++ & 7)) bits = F.bmp[bo++];
                if (bits & 0x80) { size === 1 ? px(x + xo + xx, cy + yo + yy) : fillRect(x + (xo + xx) * size, cy + (yo + yy) * size, size, size); } bits <<= 1;
            }
            x += xa * size;
        }
    }
    const cstr = t => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    function textCode(s, st) {
        const out = [];
        if (!st.wrap) { out.push('canvas.setTextWrap(false);  // переносы уже посчитаны редактором'); st.wrap = true; }
        if (st.font !== s.font) { out.push(s.font ? `canvas.setFont(&${s.font});` : 'canvas.setFont();  // встроенный 5×7'); st.font = s.font; }
        if (st.size !== s.size) { out.push(`canvas.setTextSize(${s.size});`); st.size = s.size; }
        if (st.color !== s.c) { out.push(`canvas.setTextColor(${fmt565(s.c)});`); st.color = s.c; }
        for (const l of layoutText(s)) { out.push(`canvas.setCursor(${l.cx}, ${l.cy});`); out.push(`canvas.print("${cstr(l.t)}");`); }
        return out;
    }
    const FONT_GROUPS = [['Встроенный', ['']], ['Pixel', ['Picopixel', 'TomThumb', 'Org_01', 'Tiny3x3a2pt7b']],
    ['Sans', Object.keys(FONT_DATA).filter(k => k.startsWith('FreeSans'))], ['Mono', Object.keys(FONT_DATA).filter(k => k.startsWith('FreeMono'))],
    ['Serif', Object.keys(FONT_DATA).filter(k => k.startsWith('FreeSerif'))]];
    const fontLabel = k => !k ? 'Встроенный 5×7' : k.replace(/(\d+)pt7b$/, ' $1pt').replace(/^Tiny3x3a2pt7b$/, 'Tiny3x3');
    const ptOf = k => +((k.match(/(\d+)pt7b$/) || [0, 0])[1]);
    FONT_GROUPS.slice(2).forEach(g => g[1].sort((a, b) => a.replace(/\d+pt7b/, '').localeCompare(b.replace(/\d+pt7b/, '')) || ptOf(a) - ptOf(b)));

    function raster(s, id) {
        curCol = toU32(s.c); curId = id;
        switch (s.t) {
            case 'text': for (const l of layoutText(s)) drawStr(s.font, s.size, l.t, l.cx, l.cy); break;
            case 'rect': s.fill ? fillRect(s.x, s.y, s.w, s.h) : drawRect(s.x, s.y, s.w, s.h); break;
            case 'rrect': s.fill ? fillRoundRect(s.x, s.y, s.w, s.h, s.r) : drawRoundRect(s.x, s.y, s.w, s.h, s.r); break;
            case 'circle': s.fill ? fillCircle(s.x, s.y, s.r) : drawCircle(s.x, s.y, s.r); break;
            case 'line': line(s.x0, s.y0, s.x1, s.y1); break;
            case 'tri': if (s.fill) fillTriangle(s.x0, s.y0, s.x1, s.y1, s.x2, s.y2); else { line(s.x0, s.y0, s.x1, s.y1); line(s.x1, s.y1, s.x2, s.y2); line(s.x2, s.y2, s.x0, s.y0); } break;
            case 'pixel': px(s.x, s.y); break;
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
    };
    function codeLine(s) {
        const c = fmt565(s.c), p = s.fill ? 'fill' : 'draw';
        switch (s.t) {
            case 'rect': return `canvas.${p}Rect(${s.x}, ${s.y}, ${s.w}, ${s.h}, ${c});`;
            case 'rrect': return `canvas.${p}RoundRect(${s.x}, ${s.y}, ${s.w}, ${s.h}, ${s.r}, ${c});`;
            case 'circle': return `canvas.${p}Circle(${s.x}, ${s.y}, ${s.r}, ${c});`;
            case 'line': return `canvas.drawLine(${s.x0}, ${s.y0}, ${s.x1}, ${s.y1}, ${c});`;
            case 'tri': return `canvas.${p}Triangle(${s.x0}, ${s.y0}, ${s.x1}, ${s.y1}, ${s.x2}, ${s.y2}, ${c});`;
            case 'pixel': return `canvas.drawPixel(${s.x}, ${s.y}, ${c});`;
        }
    }
    function boxHandles(s) {
        const L = Math.min(s.x, s.x + s.w - 1), T = Math.min(s.y, s.y + s.h - 1), R = Math.max(s.x, s.x + s.w - 1), B = Math.max(s.y, s.y + s.h - 1), mx = Math.floor((L + R) / 2), my = Math.floor((T + B) / 2);
        const mk = (x, y, cur, fx, fy) => ({
            x, y, cur, set: (s, nx, ny) => {
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
            case 'rect': case 'rrect': case 'text': return boxHandles(s);
            case 'circle': return [{ x: s.x + s.r, y: s.y, cur: 'ew-resize', set: setR }, { x: s.x - s.r, y: s.y, cur: 'ew-resize', set: setR }, { x: s.x, y: s.y - s.r, cur: 'ns-resize', set: setR }, { x: s.x, y: s.y + s.r, cur: 'ns-resize', set: setR }];
            case 'line': return [{ x: s.x0, y: s.y0, cur: 'move', set: (s, a, b) => { s.x0 = a; s.y0 = b; } }, { x: s.x1, y: s.y1, cur: 'move', set: (s, a, b) => { s.x1 = a; s.y1 = b; } }];
            case 'tri': return [0, 1, 2].map(i => ({ x: s['x' + i], y: s['y' + i], cur: 'move', set: (s, a, b) => { s['x' + i] = a; s['y' + i] = b; } }));
            default: return [];
        }
    }
    function bbox(s) {
        switch (s.t) {
            case 'rect': case 'rrect': case 'text': return [Math.min(s.x, s.x + s.w), Math.min(s.y, s.y + s.h), Math.abs(s.w), Math.abs(s.h)];
            case 'circle': return [s.x - s.r, s.y - s.r, 2 * s.r + 1, 2 * s.r + 1];
            case 'pixel': return [s.x, s.y, 1, 1];
            default: {
                const xs = [s.x0, s.x1, s.x2].filter(v => v != null), ys = [s.y0, s.y1, s.y2].filter(v => v != null);
                const x = Math.min(...xs), y = Math.min(...ys); return [x, y, Math.max(...xs) - x + 1, Math.max(...ys) - y + 1];
            }
        }
    }
    function moveShape(s, dx, dy) { for (const k of ['x', 'x0', 'x1', 'x2']) if (k in s) s[k] += dx; for (const k of ['y', 'y0', 'y1', 'y2']) if (k in s) s[k] += dy; }

    // ---------- view ----------
    const view = document.getElementById('view'), vx = view.getContext('2d'), stage = document.getElementById('stage'), emptyHint = document.getElementById('emptyHint');
    let scale = 2, preview = null, hover = null, triPts = null;
    function calcScale() {
        if (S.zoom !== 'auto') return +S.zoom;
        const narrow = matchMedia('(max-width:980px)').matches;
        const aw = stage.clientWidth - 32 - 28, ah = (narrow ? window.innerHeight * 0.72 : stage.clientHeight - 40) - 44 - 80;
        return Math.max(1, Math.min(8, Math.floor(Math.min(aw / S.W, ah / S.H))));
    }
    function render() {
        const W = S.W, H = S.H;
        if (!img || img.width !== W || img.height !== H) { off.width = W; off.height = H; img = offx.createImageData(W, H); u32 = new Uint32Array(img.data.buffer); idb = new Int32Array(W * H); }
        u32.fill(toU32(S.bg)); idb.fill(-1);
        S.shapes.forEach((s, i) => raster(s, i));
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
        const s = S.shapes[S.sel];
        if (s) {
            const [x, y, w, h] = bbox(s);
            vx.setLineDash([5, 4]); vx.lineWidth = 1.5; vx.strokeStyle = '#ffffff'; vx.strokeRect(x * scale - 1.5, y * scale - 1.5, w * scale + 3, h * scale + 3);
            vx.lineDashOffset = 5; vx.strokeStyle = '#2f5fd0'; vx.strokeRect(x * scale - 1.5, y * scale - 1.5, w * scale + 3, h * scale + 3); vx.setLineDash([]); vx.lineDashOffset = 0;
            for (const hd of handles(s)) { const X = (hd.x + .5) * scale, Y = (hd.y + .5) * scale; vx.fillStyle = '#fff'; vx.strokeStyle = '#2f5fd0'; vx.lineWidth = 1.5; vx.fillRect(X - 4, Y - 4, 8, 8); vx.strokeRect(X - 4, Y - 4, 8, 8); }
        }
        if (alt) drawMeasure();
    }

    // ---------- Option/Alt distance overlay ----------
    let alt = false, hoverShape = -1;
    const MC = '#f24822';
    function drawMeasure() {
        const ai = S.sel >= 0 ? S.sel : hoverShape; if (ai < 0 || !S.shapes[ai]) return;
        const A = bbox(S.shapes[ai]);
        const bi = hoverShape >= 0 && hoverShape !== ai ? hoverShape : -1;
        const B = bi >= 0 ? bbox(S.shapes[bi]) : [0, 0, S.W, S.H];
        const [ax, ay, aw, ah] = A, [bx, by, bw, bh] = B, ar = ax + aw, ab = ay + ah, br = bx + bw, bb = by + bh;
        const segs = []; // {o:'h'|'v', a, b, at} in pixel-edge units
        const cy = ay + ah / 2, cx = ax + aw / 2;
        const inside = (ax >= bx && ay >= by && ar <= br && ab <= bb), contains = bi >= 0 && (bx >= ax && by >= ay && br <= ar && bb <= ab);
        if (inside || bi < 0) {
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
        if (bi >= 0) { vx.strokeStyle = MC; vx.lineWidth = 1; vx.strokeRect(bx * scale + .5, by * scale + .5, bw * scale - 1, bh * scale - 1); }
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
    function pick(x, y) {
        let box = -1;
        for (let i = S.shapes.length - 1; i >= 0; i--) { const s = S.shapes[i]; if (s.t !== 'text') continue; const [bx, by, bw, bh] = bbox(s); if (x >= bx && y >= by && x < bx + bw && y < by + bh) { box = i; break; } }
        for (let rad = 0; rad <= 3; rad++) {
            let best = -1;
            for (let dy = -rad; dy <= rad; dy++)for (let dx = -rad; dx <= rad; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= S.W || Y >= S.H) continue; const v = idb[Y * S.W + X]; if (v > best) best = v; }
            if (best >= 0) return Math.max(best, box);
        }
        return box;
    }
    function hitHandle(p) {
        const s = S.shapes[S.sel]; if (!s || S.tool !== 'select') return null;
        for (const hd of handles(s)) { const X = (hd.x + .5) * scale, Y = (hd.y + .5) * scale; if (Math.abs(p.sx - X) <= 7 && Math.abs(p.sy - Y) <= 7) return hd; }
        return null;
    }
    function focusText(sel) { setTimeout(() => { const ta = document.getElementById('insText'); if (ta) { ta.focus(); if (sel) ta.select(); } }, 0); }
    view.addEventListener('dblclick', e => { const s = S.shapes[S.sel]; if (s && s.t === 'text') focusText(true); });
    function newShape(t, a, b) {
        const c = S.color, f = S.fill;
        switch (t) {
            case 'text': { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { t: 'text', x, y, w: Math.abs(b.x - a.x) + 1, h: Math.abs(b.y - a.y) + 1, text: 'Text', font: S.textFont, size: S.textSize, align: 'left', valign: 'top', c }; }
            case 'rect': case 'rrect': { let w = b.x - a.x, h = b.y - a.y; const s = { t, fill: f, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(w) + 1, h: Math.abs(h) + 1, c }; if (drag && drag.shift) { const m = Math.max(s.w, s.h); s.w = s.h = m; s.x = w < 0 ? a.x - m + 1 : a.x; s.y = h < 0 ? a.y - m + 1 : a.y; } if (t === 'rrect') s.r = S.radius; return s; }
            case 'circle': return { t, fill: f, x: a.x, y: a.y, r: Math.round(Math.hypot(b.x - a.x, b.y - a.y)), c };
            case 'line': { let x1 = b.x, y1 = b.y; if (drag && drag.shift) { if (Math.abs(x1 - a.x) > Math.abs(y1 - a.y)) y1 = a.y; else x1 = a.x; } return { t, x0: a.x, y0: a.y, x1, y1, c }; }
        }
    }
    view.addEventListener('pointerdown', e => {
        const p = ptr(e); view.setPointerCapture(e.pointerId);
        if (S.tool === 'select') {
            const hd = hitHandle(p);
            if (hd) { push(); drag = { mode: 'handle', hd }; return; }
            const i = pick(p.x, p.y); S.sel = i;
            if (i >= 0) { push(); drag = { mode: 'move', last: p }; }
            update(); return;
        }
        if (S.tool === 'tri') {
            triPts = triPts || []; triPts.push({ x: p.x, y: p.y });
            if (triPts.length === 3) { push(); const [a, b, c] = triPts; S.shapes.push({ t: 'tri', fill: S.fill, x0: a.x, y0: a.y, x1: b.x, y1: b.y, x2: c.x, y2: c.y, c: S.color }); S.sel = S.shapes.length - 1; triPts = null; update(); }
            else render();
            return;
        }
        if (S.tool === 'pixel') { push(); S.shapes.push({ t: 'pixel', x: p.x, y: p.y, c: S.color }); S.sel = S.shapes.length - 1; update(); return; }
        drag = { mode: 'create', a: { x: p.x, y: p.y }, shift: e.shiftKey, moved: false };
        preview = newShape(S.tool, drag.a, drag.a); render();
    });
    view.addEventListener('pointermove', e => {
        const p = ptr(e); hover = { x: p.x, y: p.y }; status();
        const prevHS = hoverShape, prevAlt = alt; alt = e.altKey;
        if (!drag || drag.mode !== 'move') { hoverShape = pick(p.x, p.y); }
        if (!drag && S.tool === 'select') { const hd = hitHandle(p); view.style.cursor = hd ? hd.cur : hoverShape >= 0 ? 'move' : ''; }
        else if (S.tool !== 'select') view.style.cursor = S.tool === 'text' ? 'text' : '';
        if (!drag) { if (triPts || alt && (hoverShape !== prevHS || !prevAlt) || prevAlt !== alt) render(); return; }
        if (drag.mode === 'create') { drag.shift = e.shiftKey; if (p.x !== drag.a.x || p.y !== drag.a.y) drag.moved = true; preview = newShape(S.tool, drag.a, p); render(); }
        else if (drag.mode === 'move') { const dx = p.x - drag.last.x, dy = p.y - drag.last.y; if (dx || dy) { moveShape(S.shapes[S.sel], dx, dy); drag.last = p; update(true); } }
        else if (drag.mode === 'handle') { drag.hd.set(S.shapes[S.sel], p.x, p.y); update(true); }
    });
    function endDrag() {
        if (drag && drag.mode === 'create') {
            let s = preview;
            if (!drag.moved) {
                const a = drag.a;
                if (S.tool === 'rect' || S.tool === 'rrect') s = Object.assign(s, { w: 40, h: 30 });
                else if (S.tool === 'text') { const m = fontMetrics(s.font, s.size); s.w = Math.min(120, Math.max(20, S.W - s.x)); s.h = m.block(1); }
                else if (S.tool === 'circle') s.r = 10;
                else if (S.tool === 'line') { s.x1 = a.x + 30; }
            }
            push(); S.shapes.push(s); S.sel = S.shapes.length - 1; preview = null;
            if (s.t === 'text') { S.tool = 'select'; drag = null; update(); focusText(true); return; }
        }
        drag = null; update();
    }
    view.addEventListener('pointerup', endDrag);
    view.addEventListener('pointercancel', () => { drag = null; preview = null; render(); });
    view.addEventListener('pointerleave', () => { hover = null; hoverShape = -1; status(); render(); });
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
    const TOOLS = [['select', 'Выбор и перемещение', 'V'], ['rect', 'Прямоугольник', 'R'], ['rrect', 'Скруглённый прямоугольник', 'O'], ['circle', 'Круг', 'C'], ['line', 'Линия', 'L'], ['tri', 'Треугольник', 'Y'], ['pixel', 'Пиксель', 'P'], ['text', 'Текст', 'T']];
    const HINTS = {
        select: 'Клик — выбрать фигуру, тяни — двигать. Квадратные маркеры меняют размер. Стрелки сдвигают на 1 px, с Shift на 10. Зажми Option (Alt) — увидишь расстояния до краёв, а при наведении на другую фигуру — до неё.',
        rect: 'Тяни от угла до угла. Shift — квадрат. Просто клик ставит 40×30.',
        rrect: 'Тяни от угла до угла. Радиус настраивается в панели фигуры.',
        circle: 'Нажми в центре и тяни наружу — это радиус. Привязка у круга по центру.',
        line: 'Тяни от начала до конца. Shift — строго по горизонтали или вертикали.',
        tri: 'Три клика — три вершины. Esc отменяет.',
        text: 'Тяни рамку текстового блока (или просто кликни). Текст переносится по словам внутри рамки. Двойной клик по блоку — редактировать текст.',
        pixel: 'Клик ставит один пиксель.',
    };
    const rail = document.getElementById('rail');
    rail.innerHTML = TOOLS.map(([t, n, k]) => `<button class="tool" data-tool="${t}" title="${n} (${k})" aria-label="${n}"><svg viewBox="0 0 24 24">${ICONS[t]}</svg><kbd>${k}</kbd></button>`).join('')
        + '<hr><button class="tool fillbtn" id="fillBtn" title="Заливка для новых фигур (F)">fill</button>'
        + '<button class="tool" id="undoBtn" title="Отменить (Ctrl+Z)" aria-label="Отменить"><svg viewBox="0 0 24 24"><path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" transform="translate(0,-3)"/></svg></button>';
    rail.addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
    document.getElementById('fillBtn').onclick = toggleFill;
    document.getElementById('undoBtn').onclick = undo;
    function setTool(t) { S.tool = t; triPts = null; preview = null; update(); }
    function toggleFill() { const s = S.shapes[S.sel]; if (s && META[s.t].canFill) { push(); s.fill = !s.fill; S.fill = s.fill; } else S.fill = !S.fill; update(); }

    const sw = document.getElementById('swatches');
    sw.innerHTML = SWATCHES.map(c => `<button class="sw" data-c="${c}" style="background:${toHex(c)}" title="${fmt565(c)}" aria-label="${fmt565(c)}"></button>`).join('');
    sw.addEventListener('click', e => { const b = e.target.closest('.sw'); if (b) setColor(+b.dataset.c); });
    const inColor = document.getElementById('inColor'), inColor565 = document.getElementById('inColor565');
    inColor.addEventListener('input', () => setColor(to565(inColor.value), 'color'));
    inColor565.addEventListener('change', () => { const c = parse565(inColor565.value); if (c != null) setColor(c); });
    function setColor(c, key) { S.color = c; const s = S.shapes[S.sel]; if (s) { push(key ? 'col' + S.sel : ''); s.c = c; } update(); }
    const inBg = document.getElementById('inBg'), inBg565 = document.getElementById('inBg565');
    inBg.addEventListener('input', () => { push('bg'); S.bg = to565(inBg.value); update(); });
    inBg565.addEventListener('change', () => { const c = parse565(inBg565.value); if (c != null) { push(); S.bg = c; } update(); });

    const inW = document.getElementById('inW'), inH = document.getElementById('inH'), inZoom = document.getElementById('inZoom'), inGrid = document.getElementById('inGrid');
    function syncSettings() { inW.value = S.W; inH.value = S.H; inZoom.value = S.zoom; inGrid.checked = S.grid; }
    inW.addEventListener('change', () => { const v = Math.max(1, Math.min(1024, +inW.value | 0)); push(); S.W = v; update(); });
    inH.addEventListener('change', () => { const v = Math.max(1, Math.min(1024, +inH.value | 0)); push(); S.H = v; update(); });
    inZoom.addEventListener('change', () => { S.zoom = inZoom.value; update(); });
    inGrid.addEventListener('change', () => { S.grid = inGrid.checked; update(); });

    // inspector
    const insBody = document.getElementById('insBody'), insBtns = document.getElementById('insBtns');
    function renderInspector() {
        const s = S.shapes[S.sel];
        if (!s) {
            insBtns.innerHTML = '';
            insBody.innerHTML = `<div class="empty">Ничего не выбрано. Новые фигуры: <b>${S.fill ? 'заливка' : 'контур'}</b>, цвет ${fmt565(S.color)}${S.tool === 'rrect' ? '' : ''}.</div>
      <div class="row" style="margin-top:8px"><span class="set">Радиус для новых скруглённых</span><input type="number" id="inRad" value="${S.radius}" style="width:60px"></div>`;
            document.getElementById('inRad').onchange = e => { S.radius = Math.max(0, +e.target.value | 0); save(); };
            return;
        }
        const m = META[s.t];
        insBtns.innerHTML = `<button class="btn" data-a="up" title="Выше (рисуется позже)">↑</button><button class="btn" data-a="down" title="Ниже (рисуется раньше)">↓</button><button class="btn" data-a="dup" title="Дублировать (Ctrl+D)">Копия</button><button class="btn danger" data-a="del" title="Удалить (Del)">Удалить</button>`;
        insBody.innerHTML = `<div class="row" style="justify-content:space-between"><span><span class="chip" style="background:${toHex(s.c)}"></span>${m.name} <span class="spec">#${S.sel + 1}</span></span>
    ${m.canFill ? `<span class="seg" id="insFill"><button data-f="0" aria-pressed="${!s.fill}">draw</button><button data-f="1" aria-pressed="${!!s.fill}">fill</button></span>` : ''}</div>
    <div class="fields" style="margin-top:10px">${m.f.map(([k, l]) => `<label>${l}<input type="number" data-k="${k}" id="f-${k}" value="${s[k]}"></label>`).join('')}</div>
    ${s.t === 'text' ? textInspector(s) : ''}
    <div class="align" role="group" aria-label="Выравнивание по экрану"><span class="set">По экрану</span>${ALIGN.map(([k, n, ic]) => `<button class="ab${k === 'c' ? ' wide' : ''}" data-al="${k}" title="${n}" aria-label="${n}">${k === 'c' ? '<svg viewBox="0 0 20 20">' + ic + '</svg>центр' : '<svg viewBox="0 0 20 20">' + ic + '</svg>'}</button>`).join('')}</div>`;
        insBody.querySelectorAll('input[data-k]').forEach(inp => inp.addEventListener('input', () => {
            if (inp.value === '' || isNaN(+inp.value)) return; push('f' + S.sel + inp.dataset.k); S.shapes[S.sel][inp.dataset.k] = Math.trunc(+inp.value); update(true);
        }));
        if (s.t === 'text') bindTextInspector(s);
        const f = document.getElementById('insFill');
        if (f) f.onclick = e => { const b = e.target.closest('button'); if (!b) return; push(); s.fill = b.dataset.f === '1'; S.fill = s.fill; update(); };
    }
    function textInspector(s) {
        const opts = FONT_GROUPS.map(([g, ks]) => `<optgroup label="${g}">${ks.map(k => `<option value="${k}"${k === s.font ? ' selected' : ''}>${fontLabel(k)}</option>`).join('')}</optgroup>`).join('');
        const seg = (id, key, items) => `<span class="seg" id="${id}">${items.map(([v, l, t]) => `<button data-v="${v}" title="${t}" aria-pressed="${s[key] === v}">${l}</button>`).join('')}</span>`;
        return `<div class="txt">
    <textarea id="insText" spellcheck="false" placeholder="Введи текст. Enter — новая строка.">${esc(s.text || '')}</textarea>
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
        const L = layoutText(s), m = fontMetrics(s.font, s.size), over = m.block(wrapText(s).length) > s.h;
        el.textContent = (bad.length ? `Нет в шрифте и будут пропущены: ${bad.slice(0, 12).join(' ')}. ` : '') + (over ? 'Текст выше рамки — увеличь h или нажми «Высота по тексту».' : '');
    }
    function bindTextInspector(s) {
        const ta = document.getElementById('insText');
        ta.addEventListener('input', () => { push('txt' + S.sel); s.text = ta.value; textWarn(s); update(true); });
        document.getElementById('insFont').onchange = e => {
            push(); const wasBuiltin = !s.font; s.font = e.target.value; S.textFont = s.font;
            if (s.font && wasBuiltin && s.size > 1) { s.size = 1; S.textSize = 1; } else if (!s.font && !wasBuiltin && s.size === 1) { s.size = 2; S.textSize = 2; }
            update();
        };
        document.getElementById('insSize').addEventListener('input', e => { const v = Math.max(1, Math.min(10, +e.target.value | 0)); if (!e.target.value) return; push('sz' + S.sel); s.size = v; S.textSize = v; textWarn(s); update(true); });
        document.getElementById('insAlign').onclick = e => { const b = e.target.closest('button'); if (!b) return; push(); s.align = b.dataset.v; update(); };
        document.getElementById('insVAlign').onclick = e => { const b = e.target.closest('button'); if (!b) return; push(); s.valign = b.dataset.v; update(); };
        document.getElementById('fitH').onclick = () => { push(); s.h = Math.max(1, fontMetrics(s.font, s.size).block(Math.max(1, wrapText(s).length))); update(); };
        textWarn(s);
    }
    insBody.addEventListener('click', e => { const b = e.target.closest('[data-al]'); if (b) align(b.dataset.al); });
    function align(k) {
        const s = S.shapes[S.sel]; if (!s) return;
        const [x, y, w, h] = bbox(s); let dx = 0, dy = 0;
        if (k === 'l') dx = -x; if (k === 'r') dx = S.W - w - x; if (k === 'cx' || k === 'c') dx = Math.round((S.W - w) / 2) - x;
        if (k === 't') dy = -y; if (k === 'b') dy = S.H - h - y; if (k === 'cy' || k === 'c') dy = Math.round((S.H - h) / 2) - y;
        if (!dx && !dy) return; push(); moveShape(s, dx, dy); update();
    }
    insBtns.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; act(b.dataset.a); });
    function act(a) {
        const i = S.sel, s = S.shapes[i]; if (!s) return; push();
        if (a === 'del') { S.shapes.splice(i, 1); S.sel = Math.min(i, S.shapes.length - 1); if (S.sel < 0) S.sel = -1; }
        if (a === 'dup') { const c = JSON.parse(JSON.stringify(s)); moveShape(c, 5, 5); S.shapes.splice(i + 1, 0, c); S.sel = i + 1; }
        if (a === 'up' && i < S.shapes.length - 1) { [S.shapes[i], S.shapes[i + 1]] = [S.shapes[i + 1], S.shapes[i]]; S.sel = i + 1; }
        if (a === 'down' && i > 0) { [S.shapes[i], S.shapes[i - 1]] = [S.shapes[i - 1], S.shapes[i]]; S.sel = i - 1; }
        update();
    }
    // internal clipboard (Ctrl/⌘+C, X, V): each paste of a copy goes +5/+5 further; after a cut the first paste lands in place
    let clip = null, clipN = 0;
    function copySel(cut) {
        const s = S.shapes[S.sel]; if (!s) return false;
        clip = JSON.stringify(s); clipN = cut ? -1 : 0;
        if (cut) act('del');
        return true;
    }
    function paste() {
        if (!clip) return false;
        push(); clipN++; const c = JSON.parse(clip); moveShape(c, 5 * clipN, 5 * clipN);
        S.shapes.push(c); S.sel = S.shapes.length - 1; S.tool = 'select'; triPts = null; preview = null; update();
        return true;
    }

    // code
    const codeEl = document.getElementById('code');
    function esc(t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
    function hl(t) {
        if (/^\s*\/\//.test(t)) return `<span class="t-c">${esc(t)}</span>`;
        return esc(t).replace(/("(?:\\.|[^"\\])*")|(\/\/.*)$|\b(0x[0-9A-Fa-f]+|\d+)\b|(\b(?:canvas|lcd)\b(?:\.|-&gt;)\w+)/g, (m, q, c, n, f) => q ? `<span class="t-s">${q}</span>` : c ? `<span class="t-c">${c}</span>` : n ? `<span class="t-n">${n}</span>` : `<span class="t-fn">${f}</span>`);
    }
    function buildLines() {
        const st = { font: '', size: 1, color: null, wrap: false };
        const shapeLines = S.shapes.flatMap((s, i) => s.t === 'text' ? textCode(s, st).map(t => ({ t, i })) : [{ t: codeLine(s), i }]);
        const fonts = [...new Set(S.shapes.filter(s => s.t === 'text' && s.font).map(s => s.font))];
        if (S.codeMode === 'snippet') return shapeLines;
        const L = t => ({ t, i: -1 });
        return [
            L('#include <Waveshare_LCD147.h>'), L('#include <Adafruit_GFX.h>'), ...fonts.map(f => L(`#include <Fonts/${f}.h>`)), L(''),
            L(`constexpr int W = ${S.W};   // ширина экрана`), L(`constexpr int H = ${S.H};   // высота экрана`), L(''),
            L('St7789* lcd;                 // драйвер (твоя библиотека)'), L('GFXcanvas16 canvas(W, H);    // холст в памяти, на нём рисуем'), L(''),
            L('// Показать холст на экране'), L('void present() {'), L('  lcd->drawImage(0, 0, W, H, canvas.getBuffer());'), L('}'), L(''),
            L('void setup() {'), L('  Serial.begin(115200);'), L('  lcd = &Waveshare147::begin();'), L(''),
            L(`  canvas.fillScreen(${fmt565(S.bg)});  // фон`),
            ...shapeLines.map(l => ({ t: '  ' + l.t, i: l.i })),
            L('  present();'), L('}'), L(''), L('void loop() {'), L('}'),
        ];
    }
    function renderCode() {
        const lines = buildLines();
        codeEl.innerHTML = lines.length ? lines.map(l => `<div class="${l.i >= 0 ? 'shape' : ''}${l.i === S.sel && l.i >= 0 ? ' on' : ''}" ${l.i >= 0 ? `data-i="${l.i}"` : ''}>${hl(l.t) || ' '}</div>`).join('') : '<div class="t-c">// холст пуст — нарисуй что-нибудь</div>';
        const on = codeEl.querySelector('.on'); if (on) { const r = on.offsetTop - codeEl.scrollTop; if (r < 0 || r > codeEl.clientHeight - 20) codeEl.scrollTop = on.offsetTop - codeEl.clientHeight / 2; }
        document.querySelectorAll('#codeMode button').forEach(b => b.setAttribute('aria-pressed', b.dataset.m === S.codeMode));
    }
    codeEl.addEventListener('click', e => { const d = e.target.closest('[data-i]'); if (d) { S.sel = +d.dataset.i; S.tool = 'select'; update(); } });
    document.getElementById('codeMode').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.codeMode = b.dataset.m; update(); } });
    const copyMsg = document.getElementById('copyMsg');
    document.getElementById('copyBtn').addEventListener('click', () => {
        const text = buildLines().map(l => l.t).join('\n');
        const fallback = () => { const r = document.createRange(); r.selectNodeContents(codeEl); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); copyMsg.textContent = 'Код выделен — нажми Ctrl+C / ⌘C.'; };
        try { navigator.clipboard.writeText(text).then(() => { copyMsg.textContent = 'Скопировано.'; setTimeout(() => copyMsg.textContent = '', 2000); }, fallback); } catch (e) { fallback(); }
    });

    // import
    function evalNum(expr) {
        expr = expr.trim(); const c = parse565(expr);
        if (/^(0x|#)|^[A-Z_]*(BLACK|WHITE|RED|GREEN|BLUE|YELLOW|MAGENTA|CYAN|ORANGE)$/i.test(expr) && c != null) return c;
        const e = expr.replace(/\bW\b/g, S.W).replace(/\bH\b/g, S.H);
        if (!/^[\d\s+\-*/().]+$/.test(e)) return null;
        try { const v = Function('return (' + e + ')')(); return Number.isFinite(v) ? Math.trunc(v) : null; } catch (_) { return null; }
    }
    const cunesc = t => t.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, e) => e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16)) : /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : { n: '\n', r: '\r', t: '\t' }[e] || e);
    function parseCode(src) {
        const out = []; let bg = null, skipped = 0;
        src = src.replace(/("(?:\\.|[^"\\])*")|\/\/.*$/gm, (m, q) => q || '');
        const T = { Rect: ['rect', ['x', 'y', 'w', 'h']], RoundRect: ['rrect', ['x', 'y', 'w', 'h', 'r']], Circle: ['circle', ['x', 'y', 'r']], Triangle: ['tri', ['x0', 'y0', 'x1', 'y1', 'x2', 'y2']], Line: ['line', ['x0', 'y0', 'x1', 'y1']], Pixel: ['pixel', ['x', 'y']] };
        const ts = { font: '', size: 1, c: 0xFFFF, cx: 0, cy: 0 }; let group = null;
        const flush = () => {
            if (!group) return; const g = group; group = null;
            const x = Math.min(...g.lines.map(l => l.left)), r = Math.max(...g.lines.map(l => l.right));
            const align = g.lines.every(l => l.left === g.lines[0].left) ? 'left' : g.lines.every(l => l.right === g.lines[0].right) ? 'right' : 'center';
            out.push({ t: 'text', x, y: g.top, w: Math.max(1, r - x), h: fontMetrics(g.font, g.size).block(g.lines.length), text: g.lines.map(l => l.t).join('\n'), font: g.font, size: g.size, align, valign: 'top', c: g.c });
        };
        const re = /canvas\s*\.\s*(\w+)\s*\(((?:"(?:\\.|[^"\\])*"|[^;"])*)\)\s*;/g; let m;
        while ((m = re.exec(src))) {
            const fn = m[1], raw = m[2].trim();
            if (fn === 'print' || fn === 'println') {
                const q = raw.match(/^"((?:\\.|[^"\\])*)"$/); if (!q && raw) { skipped++; continue; }
                const fm = fontMetrics(ts.font, ts.size);
                // '\n' (and println) works like Adafruit write('\n'): x = 0, y += line height
                (cunesc(q ? q[1] : '') + (fn === 'println' ? '\n' : '')).split('\n').forEach((t, k) => {
                    if (k) { ts.cx = 0; ts.cy += fm.pitch; }
                    t = t.replace(/\r/g, ''); if (!t) return;
                    const same = group && group.font === ts.font && group.size === ts.size && group.c === ts.c;
                    if (same && ts.cy === group.lastCy && ts.cx === group.endCx) group.lines[group.lines.length - 1].t += t; // continues the previous print on the same line
                    else if (same && ts.cy === group.lastCy + fm.pitch) group.lines.push({ t, cx: ts.cx });
                    else { flush(); group = { font: ts.font, size: ts.size, c: ts.c, top: ts.cy - fm.top, lines: [{ t, cx: ts.cx }] }; }
                    const l = group.lines[group.lines.length - 1], mm = measureStr(ts.font, ts.size, l.t);
                    l.left = l.cx + mm.l; l.right = l.left + mm.w;
                    ts.cx += advanceStr(ts.font, ts.size, t); group.lastCy = ts.cy; group.endCx = ts.cx;
                });
                continue;
            }
            if (fn === 'setFont') { const f = raw.replace(/^&/, '').trim(); ts.font = FONT_DATA[f] ? f : ''; if (f && !FONT_DATA[f]) skipped++; continue; }
            if (fn === 'setTextWrap') continue;
            const args = raw ? raw.split(',').map(evalNum) : [];
            if (args.some(a => a == null)) { skipped++; continue; }
            if (fn === 'setTextSize') { ts.size = Math.max(1, args[0] || 1); continue; }
            if (fn === 'setTextColor') { ts.c = args[0]; continue; }
            if (fn === 'setCursor') { ts.cx = args[0]; ts.cy = args[1]; continue; }
            if (fn === 'fillScreen') { bg = args[0]; continue; }
            const k = fn.match(/^(draw|fill)(Rect|RoundRect|Circle|Triangle|Line|Pixel)$/);
            if (!k) { skipped++; continue; }
            const D = T[k[2]]; if (args.length !== D[1].length + 1) { skipped++; continue; }
            flush();
            const sh = { t: D[0] }; if (META[D[0]].canFill) sh.fill = k[1] === 'fill'; D[1].forEach((key, i) => sh[key] = args[i]); sh.c = args[args.length - 1]; out.push(sh);
        }
        flush();
        return { out, bg, skipped };
    }
    const importMsg = document.getElementById('importMsg');
    function doImport(replace) {
        const { out, bg, skipped } = parseCode(document.getElementById('importText').value);
        if (!out.length && bg == null) { importMsg.textContent = 'Не нашёл вызовов canvas.* — проверь, что строки заканчиваются на «;».'; return; }
        push(); if (replace) S.shapes = out; else S.shapes.push(...out); if (bg != null) S.bg = bg; S.sel = -1;
        importMsg.textContent = `Загружено фигур: ${out.length}${skipped ? `, пропущено: ${skipped} (не разобрал аргументы)` : ''}.`; update();
    }
    document.getElementById('importBtn').onclick = () => doImport(true);
    document.getElementById('appendBtn').onclick = () => doImport(false);
    const clearBtn = document.getElementById('clearBtn'); let clearArm = 0;
    clearBtn.onclick = () => {
        if (Date.now() - clearArm < 3000) { push(); S.shapes = []; S.sel = -1; clearBtn.textContent = 'Очистить холст'; clearArm = 0; update(); return; }
        clearArm = Date.now(); clearBtn.textContent = 'Точно очистить?'; setTimeout(() => { if (clearArm && Date.now() - clearArm >= 2900) { clearBtn.textContent = 'Очистить холст'; clearArm = 0; } }, 3000);
    };

    // status & keyboard
    const statusEl = document.getElementById('status'), hintEl = document.getElementById('hint');
    function status() {
        const p = hover;
        statusEl.innerHTML = `<span>x <b>${p ? p.x : '–'}</b></span><span>y <b>${p ? p.y : '–'}</b></span><span>${S.W} × ${S.H}</span><span>×${scale}</span><span>фигур: <b>${S.shapes.length}</b></span>`;
    }
    document.addEventListener('keydown', e => {
        if (e.target.matches('input,textarea,select')) return;
        const k = e.key, mod = e.ctrlKey || e.metaKey;
        if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
        if (mod && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
        if (mod && k.toLowerCase() === 'd') { e.preventDefault(); act('dup'); return; }
        // e.code, so it works with any keyboard layout; leave native copy alone while text is selected on the page
        const textSel = !getSelection().isCollapsed;
        if (mod && !e.altKey && !textSel && (e.code === 'KeyC' || e.code === 'KeyX') && copySel(e.code === 'KeyX')) { e.preventDefault(); return; }
        if (mod && !e.altKey && e.code === 'KeyV' && paste()) { e.preventDefault(); return; }
        if (mod) return;
        const map = { v: 'select', r: 'rect', o: 'rrect', c: 'circle', l: 'line', y: 'tri', p: 'pixel', t: 'text' };
        if (map[k.toLowerCase()]) { setTool(map[k.toLowerCase()]); return; }
        if (k.toLowerCase() === 'f') { toggleFill(); return; }
        if (k === 'Escape') { triPts = null; preview = null; S.sel = -1; update(); return; }
        if ((k === 'Delete' || k === 'Backspace') && S.sel >= 0) { e.preventDefault(); act('del'); return; }
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (arrows[k] && S.sel >= 0) { e.preventDefault(); const n = e.shiftKey ? 10 : 1; push('nudge' + S.sel); moveShape(S.shapes[S.sel], arrows[k][0] * n, arrows[k][1] * n); update(); }
    });

    // ---------- update ----------
    function update(fast) {
        render(); status(); renderCode();
        if (!fast || !insBody.contains(document.activeElement)) renderInspector();
        else { const s = S.shapes[S.sel]; if (s) insBody.querySelectorAll('input[data-k]').forEach(inp => { if (inp !== document.activeElement) inp.value = s[inp.dataset.k]; }); }
        rail.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === S.tool));
        const fb = document.getElementById('fillBtn'); const sel = S.shapes[S.sel]; const fillOn = sel && META[sel.t].canFill ? sel.fill : S.fill;
        fb.setAttribute('aria-pressed', !!fillOn); fb.textContent = fillOn ? 'fill' : 'draw';
        view.classList.toggle('sel', S.tool === 'select');
        const col = sel ? sel.c : S.color; inColor.value = toHex(col); if (document.activeElement !== inColor565) inColor565.value = fmt565(col);
        document.getElementById('hex565').textContent = sel ? 'цвет фигуры' : 'цвет новых фигур';
        sw.querySelectorAll('.sw').forEach(b => b.setAttribute('aria-pressed', +b.dataset.c === col));
        inBg.value = toHex(S.bg); if (document.activeElement !== inBg565) inBg565.value = fmt565(S.bg);
        document.getElementById('spec').textContent = `GFXcanvas16 · ${S.W}×${S.H} · RGB565`;
        hintEl.textContent = HINTS[S.tool];
        save();
    }
    window.addEventListener('resize', () => render());
    syncSettings(); update();
})();