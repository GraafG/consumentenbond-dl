const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const puppeteer = require('puppeteer-core');
const { WebSocketServer } = createRequire(require.resolve('puppeteer-core'))('ws');

const source = readFileSync(path.join(__dirname, '..', 'download.js'), 'utf8');

test('Puppeteer loads from CommonJS and accepts the application launch options', async () => {
    assert.equal(typeof puppeteer.launch, 'function');
    const args = await puppeteer.defaultArgs({
        headless: false,
        args: ['--no-sandbox', '--window-size=1200,1600'],
    });
    assert.ok(args.includes('--window-size=1200,1600'));
    assert.ok(!args.some(arg => arg.startsWith('--headless')));
    await assert.rejects(
        puppeteer.launch({ executablePath: path.join(__filename, 'missing-browser') }),
        /Browser was not found/,
    );
});

test('Puppeteer communicates with a loopback CDP browser fixture', { timeout: 10000 }, async t => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    t.after(async () => {
        for (const client of server.clients) client.terminate();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    const responses = {
        'Target.getBrowserContexts': { browserContextIds: [] },
        'Target.setDiscoverTargets': {},
        'Target.setAutoAttach': {},
        'Browser.getVersion': { product: 'Chrome/fixture', userAgent: 'fixture' },
        'Browser.close': {},
    };
    const methods = [];
    server.on('connection', socket => {
        socket.on('message', data => {
            const { id, method } = JSON.parse(data);
            methods.push(method);
            socket.send(JSON.stringify(Object.hasOwn(responses, method)
                ? { id, result: responses[method] }
                : { id, error: { code: -32601, message: `Unexpected method: ${method}` } }));
        });
    });
    await once(server, 'listening');
    const browser = await puppeteer.connect({
        browserWSEndpoint: `ws://127.0.0.1:${server.address().port}`,
        protocolTimeout: 3000,
    });
    t.after(() => browser.disconnect());
    assert.equal(await browser.version(), 'Chrome/fixture');
    assert.deepEqual(await browser.pages(), []);
    await browser.close();
    assert.deepEqual(methods, Object.keys(responses));
    assert.equal(browser.connected, false);
});

async function runDownload({ latest = false, launchError = false, missing = [] } = {}) {
    const files = new Map();
    const calls = { visits: [], writes: [], combines: [], closed: 0, errors: [], exits: [] };
    const env = {
        CB_EMAIL: 'fixture@example.com',
        CB_PASSWORD: 'fixture',
        BROWSER_PATH: 'fixture-browser',
        OUTPUT_DIR: path.resolve('fixture-output'),
    };
    for (const name of missing) delete env[name];
    const publications = [
        { title: 'Consumentengids 3 2026', link: { href: '/fixture-1' } },
        { title: 'Consumentengids 7/8 2025', link: { href: '/fixture-2' } },
    ];
    const evaluations = [undefined, { products: publications, pagination: { last: 1 } }];
    for (const pub of latest ? publications.slice(0, 1) : publications) {
        evaluations.push(true, 1, {
            base64: Buffer.from(pub.title).toString('base64'),
            type: 'image/png',
        });
    }
    const page = {
        async goto(url, options) {
            calls.visits.push(url);
            assert.equal(options.waitUntil, 'networkidle2');
        },
        async title() { return 'Leeshoek'; },
        async evaluate() {
            assert.ok(evaluations.length, 'unexpected browser evaluation');
            return evaluations.shift();
        },
        async waitForSelector(selector) { assert.equal(selector, '#pspdfkit'); },
        setDefaultTimeout(timeout) { assert.equal(timeout, 120000); },
    };
    const modules = {
        dotenv: { config() {} },
        'puppeteer-core': {
            async launch(options) {
                calls.launch = options;
                if (launchError) throw new Error('fixture launch failure');
                return {
                    async newPage() { return page; },
                    async close() { calls.closed++; },
                };
            },
        },
        path,
        fs: {
            existsSync(file) { return files.has(file); },
            mkdirSync() {},
            writeFileSync(file, data) {
                calls.writes.push(file);
                files.set(file, data);
            },
            readdirSync(dir) {
                return [...files.keys()].filter(file => path.dirname(file) === dir).map(file => path.basename(file));
            },
            statSync(file) {
                assert.ok(files.has(file));
                return { size: files.get(file).length };
            },
            unlinkSync(file) { files.delete(file); },
            rmdirSync() {},
        },
        child_process: {
            execFileSync(command, args, options) {
                assert.equal(command, 'img2pdf');
                assert.equal(options.timeout, 300000);
                assert.equal(args[0], 'page_001.png');
                assert.equal(args[1], '-o');
                calls.combines.push(args[2]);
                files.set(args[2], Buffer.alloc(60000));
            },
        },
    };
    const exit = new Error('fixture process exit');
    try {
        await vm.runInNewContext(source, {
            require(name) {
                assert.ok(Object.hasOwn(modules, name), `unexpected module: ${name}`);
                return modules[name];
            },
            process: {
                env,
                argv: latest ? ['node', 'download.js', '--latest'] : ['node', 'download.js'],
                on() {},
                exit(code) { calls.exits.push(code); throw exit; },
            },
            console: { log() {}, error(message) { calls.errors.push(String(message)); } },
            Buffer,
            setTimeout(callback) { callback(); },
        }, { filename: 'download.js' });
    } catch (error) {
        if (error !== exit) throw error;
    }
    if (!missing.length && !launchError) assert.equal(evaluations.length, 0);
    return calls;
}

for (const latest of [false, true]) {
    test(`offline publication flow (${latest ? '--latest' : 'all'})`, async () => {
        const calls = await runDownload({ latest });
        assert.equal(calls.launch.executablePath, 'fixture-browser');
        assert.equal(calls.launch.headless, false);
        assert.equal(calls.launch.protocolTimeout, 300000);
        assert.equal(calls.launch.defaultViewport.width, 1200);
        assert.equal(calls.launch.defaultViewport.height, 1600);
        assert.equal(calls.writes.length, latest ? 1 : 2);
        assert.equal(calls.combines.length, latest ? 1 : 2);
        assert.equal(calls.combines[0], path.resolve('fixture-output', '2026', 'Consumentengids 03.pdf'));
        if (!latest) {
            assert.equal(calls.combines[1], path.resolve('fixture-output', '2025', 'Consumentengids 07-08.pdf'));
        }
        assert.equal(calls.visits.length, latest ? 2 : 3);
        assert.equal(calls.closed, 1);
        assert.deepEqual(calls.errors, []);
        assert.deepEqual(calls.exits, []);
    });
}

for (const missing of [['CB_EMAIL'], ['CB_PASSWORD'], ['BROWSER_PATH']]) {
    test(`missing ${missing[0]} fails before launching a browser`, async () => {
        const calls = await runDownload({ missing });
        assert.equal(calls.launch, undefined);
        assert.deepEqual(calls.exits, [1]);
        assert.match(calls.errors[0], /Missing/);
    });
}

test('browser launch failures exit unsuccessfully', async () => {
    const calls = await runDownload({ launchError: true });
    assert.deepEqual(calls.exits, [1]);
    assert.match(calls.errors[0], /fixture launch failure/);
    assert.equal(calls.closed, 0);
});
