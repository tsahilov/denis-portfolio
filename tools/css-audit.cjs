/* Optional local audit: playwright + sharp; no runtime dependencies for the site. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sharp = require(process.env.SHARP_MODULE || 'sharp');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const baseRef = process.argv[2] || 'a24caa5';
const base = execFileSync('git', ['show', `${baseRef}:style.css`], { cwd: root });
const current = fs.readFileSync(path.join(root, 'style.css'));
const out = path.join(root, '.performance-results', 'css-refactor');
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + decodeURI(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.mp4': 'video/mp4', '.webp': 'image/webp', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream');
    const size = fs.statSync(file).size;
    if (req.headers.range) {
        const [, start, end] = req.headers.range.match(/bytes=(\d+)-(\d*)/) || [];
        if (start !== undefined) {
            const first = +start, last = end ? Math.min(+end, size - 1) : size - 1;
            res.writeHead(206, { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${first}-${last}/${size}`, 'Content-Length': last - first + 1 });
            fs.createReadStream(file, { start: first, end: last }).pipe(res); return;
        }
    }
    res.setHeader('Content-Length', size); fs.createReadStream(file).pipe(res);
});

// Local 8×8 luminance SSIM distinguishes subpixel raster noise from changed content.
function similarity(a, b, width, height) {
    const luma = (data, i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    let sum = 0, blocks = 0;
    for (let y = 0; y < height; y += 8) for (let x = 0; x < width; x += 8) {
        let sa = 0, sb = 0, aa = 0, bb = 0, ab = 0, n = 0;
        for (let dy = y; dy < Math.min(y + 8, height); dy++) for (let dx = x; dx < Math.min(x + 8, width); dx++) {
            const i = (dy * width + dx) * 4, av = luma(a, i), bv = luma(b, i);
            sa += av; sb += bv; aa += av * av; bb += bv * bv; ab += av * bv; n++;
        }
        const ma = sa / n, mb = sb / n;
        const va = Math.max(0, aa / n - ma * ma), vb = Math.max(0, bb / n - mb * mb), cov = ab / n - ma * mb;
        sum += ((2 * ma * mb + 6.5025) * (2 * cov + 58.5225)) / ((ma * ma + mb * mb + 6.5025) * (va + vb + 58.5225)); blocks++;
    }
    return sum / blocks;
}

async function snapshot(browser, url, variant, width, page) {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    if (page.url() === 'about:blank') {
        await page.route('**/style.css', route => route.fulfill({ contentType: 'text/css', body: base }));
        // Freeze clips at their real posters for deterministic CSS comparisons.
        // Actual playback, policy fallbacks and lazy loading are tested separately.
        await page.addInitScript(() => HTMLMediaElement.prototype.play = function () { return new Promise(() => {}); });
        await page.goto(url);
    }
    await page.mouse.move(0, 0);
    await page.evaluate(css => {
        let style = document.getElementById('audit-css');
        if (!style) { style = document.createElement('style'); style.id = 'audit-css'; document.querySelector('link[href="style.css"]').replaceWith(style); }
        style.textContent = css;
        document.querySelectorAll('.work-gallery--mobile-scroll, .experience-list').forEach(el => el.scrollLeft = 0);
        scrollTo(0, 0);
    }, (variant === 'base' ? base : current).toString());
    await page.evaluate(async () => {
        await document.fonts.ready;
        // Normalize lazy media only for deterministic whole-page visual comparison.
        document.querySelectorAll('img').forEach(img => img.loading = 'eager');
        document.querySelectorAll('video').forEach(video => video.poster = video.dataset.poster);
        await Promise.all([...document.images].map(img => img.decode()));
    });
    // Let Chrome rasterize decoded images at their final font/layout size before comparing.
    const warmHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < warmHeight; y += 850) {
        await page.evaluate(y => scrollTo(0, y), y); await page.waitForTimeout(35);
    }
    await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(500);
    const inventory = await page.evaluate(() => {
        const selectors = [];
        function rules(list) { for (const rule of list) {
            if (rule.selectorText) {
                let matches = null;
                try { matches = document.querySelectorAll(rule.selectorText.replace(/::[\w-]+(?:\([^)]*\))?/g, '').replace(/:(hover|focus|focus-visible|active)/g, '')).length; } catch {}
                selectors.push({ selector: rule.selectorText, matches });
            }
            if (rule.cssRules) rules(rule.cssRules);
        }}
        rules(document.getElementById('audit-css').sheet.cssRules);
        return selectors;
    });
    const images = [];
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 850) {
        await page.evaluate(y => scrollTo(0, y), y); await page.waitForTimeout(500);
        const file = `${variant}-${width}-tile-${y}.png`;
        await page.screenshot({ path: path.join(out, file), animations: 'disabled' }); images.push(file);
    }
    const carousels = await page.locator('.work-gallery--mobile-scroll, .experience-list').evaluateAll(els => els.map(el => {
        const max = el.scrollWidth - el.clientWidth;
        el.style.scrollBehavior = 'auto'; el.scrollLeft = max;
        return { max, scroll: el.scrollLeft, snap: getComputedStyle(el).scrollSnapType, items: el.children.length };
    }));
    await page.waitForTimeout(120);
    const scrolled = await page.locator('.work-gallery--mobile-scroll, .experience-list').evaluateAll(els => els.map(el => el.scrollLeft));
    if (width === 390) assert(carousels.every((c, i) => c.max > 0 && scrolled[i] > 0), 'All mobile galleries and experience must scroll');
    // Include each carousel after scrolling, not only its first card.
    for (let i = 0; i < 3; i++) {
        const file = `${variant}-${width}-carousel-${i}.png`;
        await page.locator('.work-gallery--mobile-scroll').nth(i).screenshot({ path: path.join(out, file), animations: 'disabled' }); images.push(file);
    }
    await page.evaluate(() => { document.querySelectorAll('.work-gallery--mobile-scroll, .experience-list').forEach(el => el.scrollLeft = 0); scrollTo(0, 0); });
    await page.waitForTimeout(100);
    const file = `${variant}-${width}-header.png`;
    await page.screenshot({ path: path.join(out, file) }); images.push(file);
    const geometry = await page.evaluate(() => {
        function style(el, pseudo) {
            const s = getComputedStyle(el, pseudo);
            return Object.fromEntries([...s].filter(p => !p.startsWith('--')).map(p => [p, s.getPropertyValue(p)]));
        }
        return [...document.body.querySelectorAll('*')].map((el, index) => {
            const r = el.getBoundingClientRect();
            return { index, tag: el.tagName, class: el.className, rect: [r.x, r.y + scrollY, r.width, r.height], style: style(el), before: style(el, '::before'), after: style(el, '::after') };
        });
    });
    const hover = [];
    for (const link of await page.locator('.profile-links a').all()) {
        await link.hover(); await page.waitForTimeout(40);
        hover.push(await link.evaluate(el => ({ color: getComputedStyle(el).color, decoration: getComputedStyle(el).textDecorationColor })));
    }
    const broken = await page.locator('img').evaluateAll(imgs => imgs.filter(i => !i.complete || !i.naturalWidth).map(i => i.src));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(errors.length, 0); assert.equal(broken.length, 0); assert(!overflow);
    const result = { width, errors, inventory, geometry, hover, carousels, scrolled, images, broken, overflow };
    fs.writeFileSync(path.join(out, `${variant}-${width}.json`), JSON.stringify(result));
    return result;
}

async function measure(browser, url, variant, width) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); const session = await context.newCDPSession(page);
    await page.route('**/style.css', route => route.fulfill({ contentType: 'text/css', body: variant === 'base' ? base : current }));
    await session.send('Performance.enable'); await session.send('Network.enable');
    await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await session.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 93750 });
    await page.addInitScript(() => {
        window.audit = { lcp: 0, cls: 0 };
        new PerformanceObserver(list => list.getEntries().forEach(e => window.audit.lcp = e.startTime)).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver(list => list.getEntries().forEach(e => { if (!e.hadRecentInput) window.audit.cls += e.value; })).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
    const metrics = Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const result = { variant, width, ...await page.evaluate(() => window.audit), recalcMs: metrics.RecalcStyleDuration * 1000, layoutMs: metrics.LayoutDuration * 1000, scriptMs: metrics.ScriptDuration * 1000 };
    await context.close(); return result;
}

async function checkVideos(browser, url, width) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); const clips = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    assert.equal(await page.locator('video[src]').count(), 0, 'Video URLs must remain lazy on the first screen');
    const count = await page.locator('video').count();
    for (let i = 0; i < count; i++) {
        const video = page.locator('video').nth(i);
        await video.scrollIntoViewIfNeeded();
        await page.waitForFunction(i => { const v = document.querySelectorAll('video')[i]; return !v.paused && v.readyState >= 2; }, i, { timeout: 20000 });
        clips.push(await video.evaluate(v => ({ file: v.querySelector('source').dataset.src, width: v.videoWidth, height: v.videoHeight, controls: v.controls })));
        assert(!clips.at(-1).controls);
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForFunction(i => document.querySelectorAll('video')[i].paused, i);
    }
    assert.equal(errors.length, 0); await context.close(); return { width, clips, errors };
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), headless: true });
    const comparisons = [], performance = [], media = [];
    for (const width of (process.argv.includes('--media-only') ? [] : [390, 768, 1440, 1920])) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        const before = process.argv.includes('--reuse-visual') ? JSON.parse(fs.readFileSync(path.join(out, `base-${width}.json`))) : await snapshot(browser, url, 'base', width, page);
        const after = process.argv.includes('--reuse-visual') ? JSON.parse(fs.readFileSync(path.join(out, `current-${width}.json`))) : await snapshot(browser, url, 'current', width, page);
        const differences = [];
        for (let i = 0; i < before.geometry.length; i++) {
            for (const key of ['rect', 'style', 'before', 'after']) {
                if (JSON.stringify(before.geometry[i][key]) !== JSON.stringify(after.geometry[i][key])) differences.push({ index: i, tag: before.geometry[i].tag, class: before.geometry[i].class, key,
                    properties: key === 'rect' ? [before.geometry[i].rect, after.geometry[i].rect] : Object.keys(before.geometry[i][key]).filter(p => before.geometry[i][key][p] !== after.geometry[i][key][p]).map(p => [p, before.geometry[i][key][p], after.geometry[i][key][p]]) });
            }
        }
        const pixels = [];
        for (let i = 0; i < before.images.length; i++) {
            const a = await sharp(path.join(out, before.images[i])).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            const b = await sharp(path.join(out, after.images[i])).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            let changed = 0;
            if (a.data.length === b.data.length) {
                for (let j = 0; j < a.data.length; j += 4) if (!a.data.subarray(j, j + 4).equals(b.data.subarray(j, j + 4))) changed++;
            } else changed = -1;
            pixels.push({ image: before.images[i], changed, ssim: changed === 0 ? 1 : changed < 0 ? 0 : similarity(a.data, b.data, a.info.width, a.info.height) });
        }
        assert.deepEqual(before.hover, after.hover); assert.deepEqual(before.carousels, after.carousels); assert.deepEqual(before.scrolled, after.scrolled);
        comparisons.push({ width, differences, pixels });
        console.log(JSON.stringify({ width, styleDifferences: differences.length, changedImages: pixels.filter(p => p.changed !== 0) }));
        await context.close();
    }
    for (const width of (process.argv.includes('--visual-only') || process.argv.includes('--media-only') ? [] : [390, 768, 1440, 1920])) {
        for (let i = 0; i < 3; i++) for (const variant of (i % 2 ? ['current', 'base'] : ['base', 'current'])) performance.push(await measure(browser, url, variant, width));
        console.log('Measured', width);
    }
    if (process.argv.includes('--media-only')) for (const width of [390, 768, 1440, 1920]) {
        media.push(await checkVideos(browser, url, width)); console.log('Videos checked', width, media.at(-1).clips.length);
    }
    const size = data => ({ lines: data.toString().trimEnd().split(/\r?\n/).length, bytes: data.length, gzip: zlib.gzipSync(data).length, brotli: zlib.brotliCompressSync(data).length });
    const summary = { baseRef, size: { before: size(base), after: size(current) }, comparisons, performance, media };
    fs.writeFileSync(path.join(out, process.argv.includes('--media-only') ? 'media.json' : 'summary.json'), JSON.stringify(summary, null, 2));
    await browser.close(); server.close();
    assert(comparisons.every(c => c.differences.length === 0 && c.pixels.every(p => p.ssim >= 0.995)), 'Visual or computed style differences found; inspect summary.json');
})().catch(error => { console.error(error); process.exit(1); });
