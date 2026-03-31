require('dotenv').config();
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EMAIL = process.env.CB_EMAIL;
const PASSWORD = process.env.CB_PASSWORD;
const BROWSER_PATH = process.env.BROWSER_PATH;
const IMG2PDF = process.env.IMG2PDF_PATH || 'img2pdf';
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || './output');
const PAGES_DIR = path.join(OUTPUT_DIR, '_pages');
const BASE_URL = 'https://www.consumentenbond.nl';
const PAGE_WIDTH = parseInt(process.env.PAGE_WIDTH, 10) || 2400;
const LATEST_ONLY = process.argv.includes('--latest');

if (!EMAIL || !PASSWORD) {
    console.error('Missing CB_EMAIL or CB_PASSWORD. Copy .env.example to .env and fill in your credentials.');
    process.exit(1);
}
if (!BROWSER_PATH) {
    console.error('Missing BROWSER_PATH. Set the path to a Chromium-based browser in .env.');
    process.exit(1);
}

let browser;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function dismissCookies(page) {
    await sleep(2000);
    try {
        await page.evaluate(() => {
            document.querySelectorAll('button').forEach(b => {
                if (b.textContent.includes('Accepteer alle cookies')) b.click();
            });
        });
    } catch (e) {}
    await sleep(1000);
}

async function login(page) {
    await page.goto(`${BASE_URL}/boeken-en-bladen/online-lezen`, {
        waitUntil: 'networkidle2', timeout: 60000,
    });
    await dismissCookies(page);

    const title = await page.title();
    if (!title.includes('Inloggen') && !title.includes('Login')) return true;

    const csrf = await page.evaluate(() => {
        const f = document.querySelector('form#loginCredentials, form[action*="login"]');
        const c = f ? f.querySelector('input[name="_csrf"]') : null;
        return c ? c.value : null;
    });

    if (!csrf) { console.error('Could not find CSRF token on login page'); return false; }

    const result = await page.evaluate(async (email, password, csrf) => {
        const fd = new URLSearchParams();
        fd.append('_csrf', csrf);
        fd.append('originalReferer', '/boeken-en-bladen/online-lezen');
        fd.append('email', email);
        fd.append('username', email);
        fd.append('password', password);
        fd.append('makeCookie', 'on');
        const res = await fetch('/login.do', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: fd.toString(),
            redirect: 'follow',
        });
        return { url: res.url };
    }, EMAIL, PASSWORD, csrf);

    if (result.url.includes('online-lezen') && !result.url.includes('login')) {
        await page.goto(`${BASE_URL}/boeken-en-bladen/online-lezen`, {
            waitUntil: 'networkidle2', timeout: 60000,
        });
        console.log('Logged in');
        return true;
    }

    console.error('Login failed — check your credentials in .env');
    return false;
}

async function getPublications(page) {
    const all = [];
    for (let pg = 1; pg <= 10; pg++) {
        const data = await page.evaluate(async (p) => {
            const res = await fetch(`/restservices/public/leeshoek/products?limit=20&page=${p}`, {
                headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            });
            return res.ok ? await res.json() : null;
        }, pg);
        if (!data?.products?.length) break;
        all.push(...data.products);
        if (pg >= data.pagination.last) break;
    }
    return all;
}

async function waitForPspdfkit(page, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ready = await page.evaluate(() =>
            typeof window.instance !== 'undefined' && window.instance?.totalPageCount > 0
        );
        if (ready) return true;
        await sleep(1000);
    }
    return false;
}

async function renderPage(page, pageIdx) {
    return await page.evaluate(async (idx, width) => {
        try {
            const blobUrl = await window.instance.renderPageAsImageURL({ width }, idx);
            const res = await fetch(blobUrl);
            const blob = await res.blob();
            const buf = await blob.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length)));
            }
            URL.revokeObjectURL(blobUrl);
            return { base64: btoa(binary), size: buf.byteLength, type: blob.type };
        } catch (e) {
            return { error: e.message };
        }
    }, pageIdx, PAGE_WIDTH);
}

function combinePagesToPdf(pageDir, pdfPath, imageFiles) {
    try {
        execFileSync(IMG2PDF, [...imageFiles, '-o', path.resolve(pdfPath)], {
            timeout: 300000,
            stdio: 'pipe',
            cwd: pageDir,
        });
        return true;
    } catch (e) {
        const msg = e.stderr?.toString() || e.message;
        console.log(`  Combine error: ${msg.substring(0, 200)}`);
        return false;
    }
}

function cleanupPages(pageDir) {
    try {
        fs.readdirSync(pageDir).forEach(f => fs.unlinkSync(path.join(pageDir, f)));
        fs.rmdirSync(pageDir);
    } catch (e) {}
}

function parsePubTitle(title) {
    // "Consumentengids 3 2026" → { name: "Consumentengids", issue: "03", year: "2026" }
    // "Consumentengids 7/8 2025" → { name: "Consumentengids", issue: "07-08", year: "2025" }
    const match = title.match(/^(.+?)\s+(\d+(?:\/\d+)?)\s+(\d{4})$/);
    if (!match) return null;
    const [, name, rawIssue, year] = match;
    const issue = rawIssue
        .split('/')
        .map(n => n.padStart(2, '0'))
        .join('-');
    return { name, issue, year };
}

function getPdfPath(pub) {
    const parsed = parsePubTitle(pub.title);
    if (parsed) {
        const yearDir = path.join(OUTPUT_DIR, parsed.year);
        if (!fs.existsSync(yearDir)) fs.mkdirSync(yearDir, { recursive: true });
        return path.join(yearDir, `${parsed.name} ${parsed.issue}.pdf`);
    }
    // Fallback for unparseable titles
    const safeName = pub.title.replace(/[/\\?%*:|"<>]/g, '-');
    return path.join(OUTPUT_DIR, `${safeName}.pdf`);
}

async function downloadPublication(page, pub, idx, total) {
    const pdfPath = getPdfPath(pub);
    const displayName = path.relative(OUTPUT_DIR, pdfPath).replace(/\\/g, '/');

    if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 50000) {
        console.log(`[${idx}/${total}] SKIP ${displayName}`);
        return;
    }

    console.log(`[${idx}/${total}] ${displayName}`);

    const safeName = pub.title.replace(/[/\\?%*:|"<>]/g, '-');
    const pageDir = path.join(PAGES_DIR, safeName);
    if (!fs.existsSync(pageDir)) fs.mkdirSync(pageDir, { recursive: true });

    await page.goto(`${BASE_URL}${pub.link.href}`, {
        waitUntil: 'networkidle2', timeout: 60000,
    });

    try {
        await page.waitForSelector('#pspdfkit', { timeout: 15000 });
    } catch (e) {
        const t = await page.title();
        if (t.includes('Inloggen') || t.includes('Login')) {
            if (!(await login(page))) throw new Error('Re-login failed');
            await page.goto(`${BASE_URL}${pub.link.href}`, {
                waitUntil: 'networkidle2', timeout: 60000,
            });
            await page.waitForSelector('#pspdfkit', { timeout: 15000 });
        } else {
            console.log('  No reader, skipping');
            return;
        }
    }

    if (!(await waitForPspdfkit(page))) {
        console.log('  PSPDFKit did not load, skipping');
        return;
    }

    const pageCount = await page.evaluate(() => window.instance.totalPageCount);
    console.log(`  ${pageCount} pages`);

    // Render pages (skips already cached ones)
    for (let p = 0; p < pageCount; p++) {
        const base = `page_${String(p + 1).padStart(3, '0')}`;
        const pngPath = path.join(pageDir, `${base}.png`);
        const jpgPath = path.join(pageDir, `${base}.jpg`);

        if (fs.existsSync(pngPath) || fs.existsSync(jpgPath)) continue;

        const result = await renderPage(page, p);
        if (result.error) {
            console.log(`  Page ${p + 1} error: ${result.error}`);
            continue;
        }

        const buffer = Buffer.from(result.base64, 'base64');
        const ext = result.type?.includes('jpeg') ? 'jpg' : 'png';
        fs.writeFileSync(ext === 'jpg' ? jpgPath : pngPath, buffer);

        if ((p + 1) % 10 === 0 || p === 0 || p === pageCount - 1) {
            console.log(`  Page ${p + 1}/${pageCount} (${(buffer.length / 1024).toFixed(0)} KB)`);
        }
    }

    // Combine into PDF
    const imageFiles = fs.readdirSync(pageDir)
        .filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
        .sort();

    if (imageFiles.length === 0) { console.log('  No pages to combine'); return; }

    console.log(`  Combining ${imageFiles.length} pages...`);

    if (combinePagesToPdf(pageDir, pdfPath, imageFiles)) {
        const size = (fs.statSync(pdfPath).size / 1024 / 1024).toFixed(1);
        console.log(`  -> ${size} MB`);
        cleanupPages(pageDir);
    }
}

async function main() {
    for (const dir of [OUTPUT_DIR, PAGES_DIR]) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    console.log(`Browser: ${BROWSER_PATH}`);
    console.log(`Output:  ${OUTPUT_DIR}`);
    console.log(`Width:   ${PAGE_WIDTH}px\n`);

    browser = await puppeteer.launch({
        executablePath: BROWSER_PATH,
        headless: false,
        protocolTimeout: 300000,
        args: ['--no-sandbox', '--window-size=1200,1600'],
        defaultViewport: { width: 1200, height: 1600 },
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(120000);

    if (!(await login(page))) {
        await browser.close();
        process.exit(1);
    }

    const publications = await getPublications(page);
    console.log(`\n${publications.length} publications found\n`);

    const toDownload = LATEST_ONLY ? publications.slice(0, 1) : publications;
    if (LATEST_ONLY) console.log(`Downloading latest only: ${toDownload[0]?.title}\n`);

    for (let i = 0; i < toDownload.length; i++) {
        await downloadPublication(page, toDownload[i], i + 1, toDownload.length);
    }

    // Remove _pages dir if empty
    try { fs.rmdirSync(PAGES_DIR); } catch (e) {}

    await browser.close();
    console.log('\nDone!');
}

process.on('SIGINT', async () => {
    console.log('\nInterrupted, closing browser...');
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
});

main().catch(async err => {
    console.error(err);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
});
