const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const puppeteer = require('puppeteer-core');
const { WebSocketServer } = createRequire(require.resolve('puppeteer-core'))('ws');

const script = path.join(__dirname, '..', 'download.js');
const source = readFileSync(script, 'utf8');

function fixtureDirectory(t) {
    const dir = mkdtempSync(path.join(tmpdir(), 'cb-offline-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function fixtureEnvironment(extra = {}) {
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'HOME', 'TEMP', 'TMP']) {
        if (process.env[key]) env[key] = process.env[key];
    }
    return { ...env, ...extra };
}

function runConfig(cwd, env = {}, configLine = source.split('\n')[0]) {
    return spawnSync(process.execPath, ['-e', `
        const fixtureRequire = require('node:module').createRequire(${JSON.stringify(script)});
        (function (require) { ${configLine} })(fixtureRequire);
        console.log(JSON.stringify(Object.fromEntries(
            ['CB_EMAIL', 'CB_PASSWORD', 'BROWSER_PATH', 'OUTPUT_DIR', 'PAGE_WIDTH']
                .filter(key => process.env[key] !== undefined)
                .map(key => [key, process.env[key]])
        )));
    `], { cwd, env: fixtureEnvironment(env), encoding: 'utf8', timeout: 10000 });
}

test('dotenv discovers the working-directory .env without expanding dollar expressions', t => {
    const cwd = fixtureDirectory(t);
    writeFileSync(path.join(cwd, '.env'), [
        'CB_EMAIL=fixture@example.com',
        'CB_PASSWORD="fixture-$CB_EMAIL-${CB_EMAIL}#literal"',
        'BROWSER_PATH="C:\\Program Files\\Fixture\\browser.exe"',
        'OUTPUT_DIR=${CB_EMAIL}/output',
        'PAGE_WIDTH=1200 # comment',
    ].join('\n'));
    const result = runConfig(cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
        CB_EMAIL: 'fixture@example.com',
        CB_PASSWORD: 'fixture-$CB_EMAIL-${CB_EMAIL}#literal',
        BROWSER_PATH: 'C:\\Program Files\\Fixture\\browser.exe',
        OUTPUT_DIR: '${CB_EMAIL}/output',
        PAGE_WIDTH: '1200',
    });
});

test('dotenv preserves existing environment values, including empty values', t => {
    const cwd = fixtureDirectory(t);
    writeFileSync(path.join(cwd, '.env'), 'CB_EMAIL=file@example.com\nCB_PASSWORD=fixture\nPAGE_WIDTH=1200\n');
    const result = runConfig(cwd, { CB_EMAIL: 'env@example.com', CB_PASSWORD: '', PAGE_WIDTH: '3600' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        CB_EMAIL: 'env@example.com', CB_PASSWORD: '', PAGE_WIDTH: '3600',
    });
});

test('dotenv 17 default startup logging is suppressed by the application', t => {
    const cwd = fixtureDirectory(t);
    writeFileSync(path.join(cwd, '.env'), 'CB_EMAIL=fixture@example.com\n');
    const noisy = runConfig(cwd, {}, "require('dotenv').config();");
    assert.equal(noisy.status, 0, noisy.stderr);
    assert.match(noisy.stdout, /injected env \(1\) from \.env/);
    const quiet = runConfig(cwd);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stdout.trim(), '{"CB_EMAIL":"fixture@example.com"}');
    assert.equal(quiet.stderr, '');
});

test('missing .env is silent and the real CLI retains its credential error and exit status', t => {
    const cwd = fixtureDirectory(t);
    const config = runConfig(cwd);
    assert.equal(config.status, 0, config.stderr);
    assert.equal(config.stdout.trim(), '{}');
    assert.equal(config.stderr, '');
    const cli = spawnSync(process.execPath, [script], {
        cwd, env: fixtureEnvironment(), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout, '');
    assert.equal(cli.stderr.trim(),
        'Missing CB_EMAIL or CB_PASSWORD. Copy .env.example to .env and fill in your credentials.');
});

test('Puppeteer 24 loads from CommonJS and accepts the application launch options', async () => {
    assert.equal(typeof puppeteer.launch, 'function');
    const args = puppeteer.defaultArgs({
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

test('basic-ftp rejects control-character command injection before sending', async t => {
    const { Client } = require('basic-ftp');
    for (const separator of ['\r\n', '\r', '\n', '\0']) {
        const client = new Client(1000);
        t.after(() => client.close());
        await assert.rejects(client.send(`USER fixture${separator}NOOP`), /Contains control characters/);
    }
});

test('basic-ftp bounds multiline control responses on loopback', { timeout: 10000 }, async t => {
    const { Client } = require('basic-ftp');
    const sockets = new Set();
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.end(`220-${'x'.repeat(65536)}`);
    });
    const client = new Client(2000);
    t.after(async () => {
        client.close();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await assert.rejects(
        client.connect('127.0.0.1', server.address().port),
        /FTP control response exceeded maximum allowed size/,
    );
});

test('ip-address rejects ambiguous leading-zero IPv4 octets', () => {
    const { Address4, Address6 } = require('ip-address');
    assert.equal(new Address4('127.0.0.1').correctForm(), '127.0.0.1');
    assert.equal(new Address6('::1').correctForm(), '::1');
    for (const input of ['0177.0.0.1', '127.00.0.1', '127.0.0.01']) {
        assert.equal(Address4.isValid(input), false);
        assert.throws(() => new Address4(input), /leading zeroes/);
    }
});

async function runDownload({ latest = false, launchError = false, missing = [] } = {}) {
    const files = new Map();
    const calls = { visits: [], writes: [], combines: [], closed: 0, errors: [], exits: [], logs: [] };
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
        dotenv: { config(options) { assert.equal(options.quiet, true); } },
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
            console: {
                log(message) { calls.logs.push(String(message)); },
                error(message) { calls.errors.push(String(message)); },
            },
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
        assert.equal(calls.logs[0], 'Browser: fixture-browser');
        assert.equal(calls.logs.at(-1), '\nDone!');
        assert.ok(!calls.logs.join('\n').includes('fixture@example.com'));
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
