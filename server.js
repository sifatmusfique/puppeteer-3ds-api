const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// ===== USE STEALTH PLUGIN =====
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// ===== RATE LIMITING =====
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many requests, please try again later.' }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(limiter);

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'puppeteer-3ds-api'
    });
});

// ===== TEST CHROME ENDPOINT =====
app.get('/test-chrome', (req, res) => {
    const chromePaths = [
        '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    ];

    const results = {};
    for (const p of chromePaths) {
        if (p) {
            results[p] = fs.existsSync(p);
        }
    }

    let cacheContents = [];
    try {
        const cacheDir = '/opt/render/.cache/puppeteer/chrome/';
        if (fs.existsSync(cacheDir)) {
            cacheContents = fs.readdirSync(cacheDir);
        }
    } catch (e) {
        cacheContents = ['Error reading: ' + e.message];
    }

    res.json({
        chrome_paths: results,
        cache_contents: cacheContents,
        env: {
            CHROME_PATH: process.env.CHROME_PATH || 'not set',
            PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR || 'not set'
        },
        cache_dir_exists: fs.existsSync('/opt/render/.cache/puppeteer'),
        cache_dir_contents: fs.existsSync('/opt/render/.cache/puppeteer') ?
            fs.readdirSync('/opt/render/.cache/puppeteer') : []
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
            viewport = { width: 1280, height: 720 },
            is_fingerprint = false
        } = req.body;

        console.log(`[${new Date().toISOString()}] === NEW REQUEST ===`);
        console.log(`[${new Date().toISOString()}] URL: ${url ? url.substring(0, 150) : 'NO URL'}...`);
        console.log(`[${new Date().toISOString()}] Is fingerprint: ${is_fingerprint}`);
        console.log(`[${new Date().toISOString()}] Proxy: ${proxy ? 'Yes' : 'No'}`);

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // ===== LAUNCH PUPPETEER =====
        const chromePath = '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome';
        const chromeExists = fs.existsSync(chromePath);

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
                '--disable-accelerated-video-encode'
            ],
            timeout: timeout
        };

        if (chromeExists) {
            launchOptions.executablePath = chromePath;
        }

        browser = await puppeteer.launch(launchOptions);
        console.log(`[${new Date().toISOString()}] Browser launched successfully`);

        const page = await browser.newPage();
        console.log(`[${new Date().toISOString()}] New page created`);

        // ===== SET USER AGENT AND VIEWPORT =====
        await page.setUserAgent(userAgent);
        await page.setViewport(viewport);

        // ===== SET PROXY IF PROVIDED =====
        if (proxy) {
            try {
                const proxyUrl = new URL(proxy);
                if (proxyUrl.username && proxyUrl.password) {
                    await page.authenticate({
                        username: decodeURIComponent(proxyUrl.username),
                        password: decodeURIComponent(proxyUrl.password)
                    });
                    console.log(`[${new Date().toISOString()}] Proxy authentication set`);
                }
            } catch (e) {
                console.log('Proxy parse error:', e.message);
            }
        }

        // ===== STEALTH / ANTI-DETECTION =====
        await page.evaluateOnNewDocument(() => {
            // Remove webdriver
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

            // Fake plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => {
                    const plugins = [
                        { name: 'Chrome PDF Plugin' },
                        { name: 'Chrome PDF Viewer' },
                        { name: 'Native Client' }
                    ];
                    plugins.item = function(i) { return this[i] || null; };
                    plugins.namedItem = function(n) {
                        return this.find(p => p.name === n) || null;
                    };
                    plugins.refresh = function() {};
                    return plugins;
                }
            });

            // Fake languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });

            // Remove PhantomJS detection
            if (window.callPhantom) delete window.callPhantom;
            if (window._phantom) delete window._phantom;

            // Override chrome object
            if (window.chrome) {
                window.chrome.runtime = {};
                window.chrome.loadTimes = function() {};
                window.chrome.csi = function() {};
            }
        });

        // ===== SET EXTRA HEADERS =====
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        });

        // ===== NAVIGATE TO URL =====
        console.log(`[${new Date().toISOString()}] Navigating to URL...`);
        
        try {
            await page.goto(url, {
                waitUntil: is_fingerprint ? 'networkidle0' : 'networkidle2',
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
            console.log(`[${new Date().toISOString()}] Looking for forms to submit...`);

            // Try multiple times to catch dynamically loaded buttons
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    // Wait a bit for forms to load
                    if (attempt > 0) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }

                    // Find and click submit buttons
                    const buttons = await page.$$(
                        'button[type="submit"], input[type="submit"], ' +
                        '.btn-primary, .continue-btn, .submit-btn, .btn-continue, ' +
                        'button[role="button"], input[role="button"], ' +
                        '.btn, button:not([type="button"])'
                    );

                    for (const button of buttons) {
                        try {
                            const visible = await button.isVisible();
                            const enabled = await button.isEnabled();
                            if (visible && enabled) {
                                await button.click();
                                console.log(`[${new Date().toISOString()}] Clicked submit button (attempt ${attempt + 1})`);
                                await page.waitForNavigation({
                                    waitUntil: 'networkidle2',
                                    timeout: 5000
                                }).catch(() => {});
                                break;
                            }
                        } catch (e) {
                            // Continue to next button
                        }
                    }
                } catch (e) {
                    console.log(`[${new Date().toISOString()}] Auto-submit attempt ${attempt + 1} failed: ${e.message}`);
                }
            }
        }

        // ===== WAIT FOR 3DS COMPLETION =====
        if (waitFor3DS) {
            console.log(`[${new Date().toISOString()}] Waiting for 3DS completion...`);
            let completed = false;
            let attempts = 0;
            const maxAttempts = 90;
            let lastUrl = '';

            while (!completed && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;

                try {
                    const currentUrl = page.url();

                    // ===== CHECK FOR COMPLETION INDICATORS =====
                    const completionIndicators = [
                        'checkout.stripe.com/return',
                        'hooks.stripe.com',
                        'payment_intent',
                        'succeeded',
                        'success_url',
                        'redirect_status=succeeded',
                        'source=',
                        'client_secret=',
                        'thank_you',
                        'order-confirmation',
                        'complete'
                    ];

                    for (const indicator of completionIndicators) {
                        if (currentUrl.includes(indicator)) {
                            completed = true;
                            console.log(`[${new Date().toISOString()}] ✅ 3DS completed at: ${currentUrl}`);
                            break;
                        }
                    }

                    if (completed) break;

                    // ===== CHECK FOR ERROR INDICATORS =====
                    const errorIndicators = ['error', 'declined', 'failed', 'authentication_failure', 'card_declined'];
                    const pageContent = await page.content();
                    let hasError = false;
                    for (const indicator of errorIndicators) {
                        if (pageContent.includes(indicator) || currentUrl.includes(indicator)) {
                            console.log(`[${new Date().toISOString()}] ❌ Error detected: ${indicator}`);
                            hasError = true;
                            break;
                        }
                    }

                    if (hasError) break;

                    // ===== AUTO-SUBMIT DYNAMIC FORMS =====
                    // Some 3DS flows load forms after JavaScript execution
                    if (attempts % 5 === 0) {
                        try {
                            const dynamicButtons = await page.$$(
                                'button[type="submit"], input[type="submit"], ' +
                                '.btn-primary, .continue-btn, .submit-btn'
                            );
                            for (const button of dynamicButtons) {
                                const visible = await button.isVisible();
                                const enabled = await button.isEnabled();
                                if (visible && enabled) {
                                    await button.click();
                                    console.log(`[${new Date().toISOString()}] Clicked dynamic submit button`);
                                    await page.waitForNavigation({
                                        waitUntil: 'networkidle2',
                                        timeout: 5000
                                    }).catch(() => {});
                                    break;
                                }
                            }
                        } catch (e) {
                            // No dynamic buttons
                        }
                    }

                    // ===== CHECK FOR OTP FIELDS =====
                    if (attempts % 10 === 0) {
                        try {
                            const otpInputs = await page.$$(
                                'input[type="text"], input[type="password"], ' +
                                'input[name*="otp"], input[name*="code"], input[name*="token"], ' +
                                'input[id*="otp"], input[id*="code"], input[id*="token"]'
                            );
                            for (const input of otpInputs) {
                                const visible = await input.isVisible();
                                if (visible) {
                                    console.log(`[${new Date().toISOString()}] ⚠️ OTP field detected - waiting for input`);
                                    // We'll keep waiting - user might have entered it
                                    break;
                                }
                            }
                        } catch (e) {
                            // No OTP fields
                        }
                    }

                    // ===== CHECK FOR PAGE CHANGE =====
                    if (currentUrl !== lastUrl) {
                        console.log(`[${new Date().toISOString()}] URL changed to: ${currentUrl.substring(0, 100)}...`);
                        lastUrl = currentUrl;
                    }

                    if (attempts % 10 === 0) {
                        console.log(`[${new Date().toISOString()}] Waiting... ${attempts}s/${maxAttempts}s`);
                    }

                } catch (e) {
                    console.error('Polling error:', e.message);
                }
            }

            if (!completed) {
                console.log(`[${new Date().toISOString()}] ⏰ 3DS not completed within timeout (${maxAttempts}s)`);
            }
        }

        // ===== COLLECT RESULTS =====
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

        // ===== BUILD RESULT =====
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
        console.log(`[${new Date().toISOString()}] Final URL: ${finalUrl.substring(0, 150)}...`);
        console.log(`[${new Date().toISOString()}] === REQUEST COMPLETED ===`);

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

// ===== START SERVER =====
app.listen(PORT, () => {
    console.log(`✅ Puppeteer 3DS API Server running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   Test Chrome: http://localhost:${PORT}/test-chrome`);
    console.log(`   API endpoint: http://localhost:${PORT}/api/3ds-automate`);
});

// ===== HANDLE UNCAUGHT EXCEPTIONS =====
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});