const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ===== USE STEALTH PLUGIN =====
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// ===== FIX: Download Chrome at startup =====
const CHROME_CACHE_DIR = '/opt/render/.cache/puppeteer';
const CHROME_PATH = path.join(CHROME_CACHE_DIR, 'chrome/linux-127.0.6533.88/chrome-linux64/chrome');

console.log(`[${new Date().toISOString()}] Checking for Chrome at: ${CHROME_PATH}`);

if (!fs.existsSync(CHROME_PATH)) {
    console.log(`[${new Date().toISOString()}] Chrome not found, downloading...`);
    if (!fs.existsSync(CHROME_CACHE_DIR)) {
        fs.mkdirSync(CHROME_CACHE_DIR, { recursive: true });
    }
    try {
        console.log(`[${new Date().toISOString()}] Running: npx puppeteer browsers install chrome`);
        execSync('npx puppeteer browsers install chrome', {
            cwd: __dirname,
            stdio: 'inherit',
            env: { ...process.env, PUPPETEER_CACHE_DIR: CHROME_CACHE_DIR }
        });
        console.log(`[${new Date().toISOString()}] Chrome installed successfully`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Failed to install Chrome:`, error.message);
    }
}

if (fs.existsSync(CHROME_PATH)) {
    console.log(`[${new Date().toISOString()}] ✅ Chrome found at: ${CHROME_PATH}`);
} else {
    console.log(`[${new Date().toISOString()}] ⚠️ Chrome still not found, will try puppeteer default`);
}

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many requests, please try again later.' }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(limiter);

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'puppeteer-3ds-api',
        chrome_exists: fs.existsSync(CHROME_PATH),
        chrome_path: CHROME_PATH
    });
});

// ===== MAIN 3DS AUTOMATION ENDPOINT =====
app.post('/api/3ds-automate', async (req, res) => {
    const startTime = Date.now();
    let browser = null;

    try {
        const {
            url,
            proxy = null,
            timeout = 60000,
            userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            waitFor3DS = true,
            screenshot = false,
            autoSubmit = true,
            viewport = { width: 1366, height: 768 }
        } = req.body;

        console.log(`[${new Date().toISOString()}] === NEW REQUEST ===`);
        console.log(`[${new Date().toISOString()}] URL: ${url ? url.substring(0, 100) : 'NO URL'}`);

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // ===== LAUNCH PUPPETEER =====
        const chromeExists = fs.existsSync(CHROME_PATH);
        console.log(`[${new Date().toISOString()}] Chrome exists: ${chromeExists}`);

        const launchOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-ipc-flooding-protection',
                '--disable-hang-monitor',
                '--disable-prompt-on-repost',
                '--disable-sync',
                '--disable-translate',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-plugins',
                '--disable-infobars',
                '--disable-notifications',
                '--disable-popup-blocking',
                '--disable-component-extensions-with-background-pages',
                '--no-first-run',
                '--force-color-profile=srgb',
                '--metrics-recording-only',
                '--password-store=basic',
                '--use-mock-keychain',
                '--single-process',
                '--disable-accelerated-2d-canvas',
                '--disable-accelerated-jpeg-decoding',
                '--disable-accelerated-mjpeg-decode',
                '--disable-accelerated-video-decode',
                '--disable-accelerated-video-encode',
                // Extra stealth flags
                '--disable-features=BlockInsecurePrivateNetworkRequests',
                '--disable-features=IsolateOrigins',
                '--disable-site-isolation-trials',
                '--disable-features=BlockInsecurePrivateNetworkRequests',
                '--disable-web-resource'
            ],
            timeout: timeout
        };

        // ===== CONFIG PROTOCOL PROXY IF PROVIDED =====
        if (proxy) {
            try {
                let parsedProxy = proxy.trim();
                const parts = parsedProxy.split(':');
                if (parts.length >= 2) {
                    const host = parts[0];
                    const port = parts[1];
                    launchOptions.args.push(`--proxy-server=http://${host}:${port}`);
                    console.log(`[${new Date().toISOString()}] Added browser proxy server arg: http://${host}:${port}`);
                } else {
                    if (!parsedProxy.startsWith('http://') && !parsedProxy.startsWith('https://')) {
                        parsedProxy = 'http://' + parsedProxy;
                    }
                    const proxyUrl = new URL(parsedProxy);
                    launchOptions.args.push(`--proxy-server=http://${proxyUrl.host}`);
                    console.log(`[${new Date().toISOString()}] Added browser proxy server arg: http://${proxyUrl.host}`);
                }
            } catch (e) {
                console.log('Proxy launch arg config error:', e.message);
            }
        }

        if (chromeExists) {
            launchOptions.executablePath = CHROME_PATH;
            console.log(`[${new Date().toISOString()}] Using Chrome at: ${CHROME_PATH}`);
        } else {
            console.log(`[${new Date().toISOString()}] Chrome not found, letting puppeteer find it`);
        }

        browser = await puppeteer.launch(launchOptions);
        console.log(`[${new Date().toISOString()}] Browser launched successfully`);

        const page = await browser.newPage();
        console.log(`[${new Date().toISOString()}] New page created`);

        // ===== SET USER AGENT AND VIEWPORT =====
        await page.setUserAgent(userAgent);
        await page.setViewport(viewport);
        console.log(`[${new Date().toISOString()}] User agent and viewport set`);

        // ===== SET PROXY IF PROVIDED =====
        if (proxy) {
            try {
                let parsedProxy = proxy.trim();
                // Check if it's formatted as raw ip:port:user:pass
                const parts = parsedProxy.split(':');
                if (parts.length >= 4) {
                    const host = parts[0];
                    const port = parts[1];
                    const user = parts[2];
                    const pass = parts[3];
                    console.log(`[${new Date().toISOString()}] Configured proxy authentication for credentials: ${user}:******`);
                    await page.authenticate({
                        username: decodeURIComponent(user),
                        password: decodeURIComponent(pass)
                    });
                } else {
                    // Try parsing as standard URL
                    if (!parsedProxy.startsWith('http://') && !parsedProxy.startsWith('https://')) {
                        parsedProxy = 'http://' + parsedProxy;
                    }
                    const proxyUrl = new URL(parsedProxy);
                    if (proxyUrl.username && proxyUrl.password) {
                        console.log(`[${new Date().toISOString()}] Configured proxy credentials from URL: ${proxyUrl.username}:******`);
                        await page.authenticate({
                            username: decodeURIComponent(proxyUrl.username),
                            password: decodeURIComponent(proxyUrl.password)
                        });
                    }
                }
                console.log(`[${new Date().toISOString()}] Proxy authentication registered`);
            } catch (e) {
                console.log('Proxy authentication config warning:', e.message);
            }
        }

        // ===== ENHANCED STEALTH / ANTI-DETECTION =====
        await page.evaluateOnNewDocument(() => {
            // Remove webdriver
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

            // Override chrome object to look exactly like standard retail chrome
            window.chrome = {
                app: {
                    isInstalled: false,
                    InstallState: {
                        DISABLED: 'disabled',
                        INSTALLED: 'installed',
                        NOT_INSTALLED: 'not_installed'
                    },
                    RunningState: {
                        CANNOT_RUN: 'cannot_run',
                        READY_TO_RUN: 'ready_to_run',
                        RUNNING: 'running'
                    }
                },
                runtime: {
                    OnInstalledReason: {
                        CHROME_UPDATE: 'chrome_update',
                        INSTALL: 'install',
                        SHARED_MODULE_UPDATE: 'shared_module_update',
                        UPDATE: 'update'
                    },
                    OnRestartRequiredReason: {
                        APP_UPDATE: 'app_update',
                        OS_UPDATE: 'os_update',
                        PERIODIC: 'periodic'
                    },
                    PlatformArch: {
                        ARM: 'arm',
                        ARM64: 'arm64',
                        MIPS: 'mips',
                        MIPS64: 'mips64',
                        X86_32: 'x86-32',
                        X86_64: 'x86-64'
                    },
                    PlatformNaclArch: {
                        ARM: 'arm',
                        MIPS: 'mips',
                        MIPS64: 'mips64',
                        X86_32: 'x86-32',
                        X86_64: 'x86-64'
                    },
                    PlatformOs: {
                        ANDROID: 'android',
                        CROS: 'cros',
                        LINUX: 'linux',
                        MAC: 'mac',
                        OPENBSD: 'openbsd',
                        WIN: 'win'
                    },
                    RequestUpdateCheckStatus: {
                        NO_UPDATE: 'no_update',
                        THROTTLED: 'throttled',
                        UPDATE_AVAILABLE: 'update_available'
                    },
                    connect: () => { },
                    sendMessage: () => { }
                },
                loadTimes: function () { },
                csi: function () { }
            };

            // Fake plugins matching real browser standard layout
            const mockPlugins = [
                { name: 'PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
                { name: 'Chrome PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
                { name: 'Chromium PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
                { name: 'Microsoft Edge PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
                { name: 'WebKit built-in PDF', description: 'Portable Document Format', filename: 'internal-pdf-viewer' }
            ];

            Object.defineProperty(navigator, 'plugins', {
                get: () => {
                    const plugins = [...mockPlugins];
                    plugins.item = function (i) { return this[i] || null; };
                    plugins.namedItem = function (n) {
                        return this.find(p => p.name === n) || null;
                    };
                    plugins.refresh = function () { };
                    return plugins;
                }
            });

            // Fake MIME Types matching PDF viewer extension
            Object.defineProperty(navigator, 'mimeTypes', {
                get: () => {
                    const mimeTypes = [
                        { type: 'application/pdf', description: 'Portable Document Format', suffixes: 'pdf', enabledPlugin: mockPlugins[0] },
                        { type: 'text/pdf', description: 'Portable Document Format', suffixes: 'pdf', enabledPlugin: mockPlugins[0] }
                    ];
                    mimeTypes.item = function (i) { return this[i] || null; };
                    mimeTypes.namedItem = function (n) {
                        return this.find(m => m.type === n) || null;
                    };
                    return mimeTypes;
                }
            });

            // Override WebGL Vendor & Renderer to mock high-end desktop hardware
            const getParameter = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, attributes) {
                const ctx = getParameter.apply(this, arguments);
                if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
                    const origGetParameter = ctx.getParameter;
                    ctx.getParameter = function (parameter) {
                        // UNMASKED_VENDOR_WEBGL
                        if (parameter === 37445) {
                            return 'Google Inc. (NVIDIA)';
                        }
                        // UNMASKED_RENDERER_WEBGL
                        if (parameter === 37446) {
                            return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                        }
                        // VENDOR
                        if (parameter === 7936) {
                            return 'WebKit';
                        }
                        // RENDERER
                        if (parameter === 7937) {
                            return 'WebKit WebGL';
                        }
                        return origGetParameter.apply(this, arguments);
                    };
                }
                return ctx;
            };

            // Fake languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });

            // Fake permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );

            // Remove PhantomJS / Headless indicators
            if (window.callPhantom) delete window.callPhantom;
            if (window._phantom) delete window._phantom;

            // Override navigator properties
            Object.defineProperty(navigator, 'connection', {
                get: () => ({
                    effectiveType: '4g',
                    rtt: 50,
                    downlink: 10,
                    saveData: false
                })
            });

            Object.defineProperty(navigator, 'hardwareConcurrency', {
                get: () => 8
            });

            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => 8
            });

            Object.defineProperty(navigator, 'platform', {
                get: () => 'Win32'
            });

            // Override screen size to avoid standard 800x600 headless footprint
            Object.defineProperty(window.screen, 'availWidth', {
                get: () => 1920
            });
            Object.defineProperty(window.screen, 'availHeight', {
                get: () => 1080
            });
            Object.defineProperty(window.screen, 'width', {
                get: () => 1920
            });
            Object.defineProperty(window.screen, 'height', {
                get: () => 1080
            });
        });

        // ===== SET EXTRA HEADERS =====
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0'
        });

        // ===== NAVIGATE TO URL =====
        console.log(`[${new Date().toISOString()}] Navigating to URL...`);
        try {
            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: timeout
            });
        } catch (navError) {
            console.log(`[${new Date().toISOString()}] Navigation warning: ${navError.message}`);
            // Try to continue even if navigation partially failed
            try {
                await page.waitForSelector('body', { timeout: 5000 });
            } catch (bodyError) {
                throw new Error('Page navigation failed: ' + navError.message);
            }
        }

        console.log(`[${new Date().toISOString()}] Page loaded. Current URL: ${page.url()}`);

        // ===== AUTO-SUBMIT FORMS IF ENABLED =====
        if (autoSubmit) {
            console.log(`[${new Date().toISOString()}] Looking for submit buttons...`);
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 2000));
                    const buttons = await page.$$(
                        'button[type="submit"], input[type="submit"], ' +
                        '.btn-primary, .continue-btn, .submit-btn, .btn-continue, ' +
                        'button[role="button"], .btn:not([type="button"])'
                    );
                    for (const button of buttons) {
                        try {
                            const visible = await button.isVisible();
                            const enabled = await button.isEnabled();
                            if (visible && enabled) {
                                await button.click();
                                console.log(`[${new Date().toISOString()}] Clicked submit button (attempt ${attempt + 1})`);
                                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                                break;
                            }
                        } catch (e) { }
                    }
                } catch (e) {
                    console.log(`[${new Date().toISOString()}] Auto-submit attempt ${attempt + 1} failed`);
                }
            }
        }

        // ===== WAIT FOR 3DS COMPLETION =====
        if (waitFor3DS) {
            console.log(`[${new Date().toISOString()}] Waiting for 3DS completion...`);
            let completed = false;
            let attempts = 0;
            const maxAttempts = 90;

            while (!completed && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;

                try {
                    const currentUrl = page.url();

                    if (currentUrl.includes('checkout.stripe.com/return') ||
                        currentUrl.includes('hooks.stripe.com') ||
                        currentUrl.includes('payment_intent') ||
                        currentUrl.includes('succeeded') ||
                        currentUrl.includes('success_url') ||
                        currentUrl.includes('redirect_status=succeeded')) {
                        completed = true;
                        console.log(`[${new Date().toISOString()}] ✅ 3DS completed at: ${currentUrl}`);
                        break;
                    }

                    // Check for errors
                    const pageContent = await page.content();
                    if (pageContent.includes('error') || pageContent.includes('declined') ||
                        pageContent.includes('failed') || pageContent.includes('authentication_failure')) {
                        console.log(`[${new Date().toISOString()}] ❌ Error detected`);
                        break;
                    }

                    // Try clicking dynamic buttons
                    if (attempts % 5 === 0) {
                        try {
                            const dynamicButtons = await page.$$(
                                'button[type="submit"], input[type="submit"], .btn-primary, .continue-btn'
                            );
                            for (const button of dynamicButtons) {
                                if (await button.isVisible() && await button.isEnabled()) {
                                    await button.click();
                                    console.log(`[${new Date().toISOString()}] Clicked dynamic button`);
                                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                                    break;
                                }
                            }
                        } catch (e) { }
                    }

                    if (attempts % 10 === 0) {
                        console.log(`[${new Date().toISOString()}] Waiting... ${attempts}s/${maxAttempts}s`);
                        console.log(`[${new Date().toISOString()}] Current URL: ${currentUrl.substring(0, 100)}...`);
                    }
                } catch (e) {
                    console.error('Polling error:', e.message);
                }
            }
        }

        // Collect results
        console.log(`[${new Date().toISOString()}] Collecting results...`);
        const finalUrl = await page.url();
        const finalTitle = await page.title();
        const finalContent = await page.content();
        const finalCookies = await page.cookies();

        let screenshotData = null;
        if (screenshot) {
            screenshotData = await page.screenshot({
                encoding: 'base64',
                fullPage: true,
                type: 'png'
            });
            console.log(`[${new Date().toISOString()}] Screenshot captured`);
        }

        // Parse URL parameters
        const urlParams = new URLSearchParams(new URL(finalUrl).search);
        const params = {};
        for (const [key, value] of urlParams) {
            params[key] = value;
        }

        await browser.close();
        console.log(`[${new Date().toISOString()}] Browser closed`);

        const result = {
            success: true,
            completed: true,
            url: finalUrl,
            title: finalTitle,
            cookies: finalCookies,
            params: params,
            screenshot: screenshotData || null,
            html: finalContent,
            source: params.source || null,
            payment_intent: params.payment_intent || null,
            redirect_status: params.redirect_status || null,
            client_secret: params.client_secret || null,
            processing_time: Date.now() - startTime
        };

        console.log(`[${new Date().toISOString()}] ✅ Success! Time: ${result.processing_time}ms`);
        res.json(result);

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ ERROR:`, error.message);
        console.error(`[${new Date().toISOString()}] Stack:`, error.stack);

        if (browser) {
            try {
                await browser.close();
                console.log(`[${new Date().toISOString()}] Browser closed after error`);
            } catch (e) {
                console.log(`[${new Date().toISOString()}] Error closing browser: ${e.message}`);
            }
        }

        res.status(500).json({
            success: false,
            error: error.message,
            processing_time: Date.now() - startTime
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Puppeteer 3DS API Server running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   API endpoint: http://localhost:${PORT}/api/3ds-automate`);
});