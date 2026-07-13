const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// ===== FIX: Download Chrome at startup =====
const CHROME_CACHE_DIR = '/opt/render/.cache/puppeteer';
const CHROME_PATH = path.join(CHROME_CACHE_DIR, 'chrome/linux-127.0.6533.88/chrome-linux64/chrome');

console.log(`[${new Date().toISOString()}] Checking for Chrome at: ${CHROME_PATH}`);

// Check if Chrome exists, if not, download it
if (!fs.existsSync(CHROME_PATH)) {
    console.log(`[${new Date().toISOString()}] Chrome not found, downloading...`);
    
    // Create cache directory
    if (!fs.existsSync(CHROME_CACHE_DIR)) {
        fs.mkdirSync(CHROME_CACHE_DIR, { recursive: true });
    }
    
    try {
        // Use npx to install Chrome
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

// Check again after installation
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

// Test endpoint to check Chrome
app.get('/test-chrome', (req, res) => {
    const chromePaths = [
        CHROME_PATH,
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

    // List cache directory
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

// Main 3DS automation endpoint
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
            viewport = { width: 1280, height: 720 }
        } = req.body;

        console.log(`[${new Date().toISOString()}] === NEW REQUEST ===`);
        console.log(`[${new Date().toISOString()}] URL: ${url ? url.substring(0, 100) : 'NO URL'}`);

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // ===== CHECK CHROME =====
        console.log(`[${new Date().toISOString()}] Checking Chrome at: ${CHROME_PATH}`);
        const chromeExists = fs.existsSync(CHROME_PATH);
        console.log(`[${new Date().toISOString()}] Chrome exists: ${chromeExists}`);

        // If Chrome doesn't exist, try to install it
        if (!chromeExists) {
            console.log(`[${new Date().toISOString()}] Chrome not found, attempting to install...`);
            try {
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

        // ===== LAUNCH PUPPETEER =====
        console.log(`[${new Date().toISOString()}] Launching browser...`);

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
                '--single-process'
            ],
            timeout: timeout
        };

        // Only add executablePath if Chrome exists
        if (fs.existsSync(CHROME_PATH)) {
            launchOptions.executablePath = CHROME_PATH;
            console.log(`[${new Date().toISOString()}] Using Chrome at: ${CHROME_PATH}`);
        } else {
            console.log(`[${new Date().toISOString()}] Chrome not found, letting puppeteer find it`);
        }

        browser = await puppeteer.launch(launchOptions);
        console.log(`[${new Date().toISOString()}] Browser launched successfully`);

        const page = await browser.newPage();
        console.log(`[${new Date().toISOString()}] New page created`);

        await page.setUserAgent(userAgent);
        await page.setViewport(viewport);
        console.log(`[${new Date().toISOString()}] User agent and viewport set`);

        // Set proxy if provided
        if (proxy) {
            try {
                const proxyUrl = new URL(proxy);
                if (proxyUrl.username && proxyUrl.password) {
                    await page.authenticate({
                        username: decodeURIComponent(proxyUrl.username),
                        password: decodeURIComponent(proxyUrl.password)
                    });
                    console.log(`[${new Date().toISOString()}] Proxy set`);
                }
            } catch (e) {
                console.log('Proxy parse error:', e.message);
            }
        }

        // Stealth / Anti-detection
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });
        });
        console.log(`[${new Date().toISOString()}] Anti-detection applied`);

        // Navigate to URL
        console.log(`[${new Date().toISOString()}] Navigating to URL...`);
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: timeout
        });
        console.log(`[${new Date().toISOString()}] Navigation complete`);

        // Auto-submit if enabled
        if (autoSubmit) {
            console.log(`[${new Date().toISOString()}] Looking for submit buttons...`);
            try {
                await page.waitForSelector('button[type="submit"], input[type="submit"], .btn-primary, .continue-btn, .submit-btn', {
                    timeout: 5000
                });
                await page.click('button[type="submit"], input[type="submit"], .btn-primary, .continue-btn, .submit-btn');
                console.log(`[${new Date().toISOString()}] Submit button clicked`);
            } catch (e) {
                console.log(`[${new Date().toISOString()}] No submit button found, continuing...`);
            }
        }

        // Wait for 3DS completion
        if (waitFor3DS) {
            console.log(`[${new Date().toISOString()}] Waiting for 3DS completion...`);
            let completed = false;
            let attempts = 0;
            const maxAttempts = 60;

            while (!completed && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;

                try {
                    const currentUrl = page.url();

                    if (currentUrl.includes('checkout.stripe.com/return') ||
                        currentUrl.includes('hooks.stripe.com') ||
                        currentUrl.includes('payment_intent') ||
                        currentUrl.includes('succeeded') ||
                        currentUrl.includes('success_url')) {
                        completed = true;
                        console.log(`[${new Date().toISOString()}] ✅ 3DS completed at: ${currentUrl}`);
                        break;
                    }

                    if (attempts % 10 === 0) {
                        console.log(`[${new Date().toISOString()}] Waiting... ${attempts}s/${maxAttempts}s`);
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
            stack: error.stack,
            processing_time: Date.now() - startTime
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Puppeteer 3DS API Server running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   Test Chrome: http://localhost:${PORT}/test-chrome`);
    console.log(`   API endpoint: http://localhost:${PORT}/api/3ds-automate`);
});