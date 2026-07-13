const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

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
        service: 'puppeteer-3ds-api'
    });
});

// Main 3DS automation endpoint
app.post('/api/3ds-automate', async (req, res) => {
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

        console.log(`[${new Date().toISOString()}] Processing 3DS URL: ${url ? url.substring(0, 100) : 'NO URL'}...`);

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Launch Puppeteer
        const browser = await puppeteer.launch({
            headless: 'new',
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
                '--use-mock-keychain'
            ],
            timeout: timeout
        });

        try {
            const page = await browser.newPage();
            
            await page.setUserAgent(userAgent);
            await page.setViewport(viewport);

            // Set proxy if provided
            if (proxy) {
                try {
                    const proxyUrl = new URL(proxy);
                    if (proxyUrl.username && proxyUrl.password) {
                        await page.authenticate({
                            username: decodeURIComponent(proxyUrl.username),
                            password: decodeURIComponent(proxyUrl.password)
                        });
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

            // Navigate to URL
            console.log(`[${new Date().toISOString()}] Navigating to URL...`);
            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: timeout
            });

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
            }

            // Parse URL parameters
            const urlParams = new URLSearchParams(new URL(finalUrl).search);
            const params = {};
            for (const [key, value] of urlParams) {
                params[key] = value;
            }

            await browser.close();

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
                client_secret: params.client_secret || null
            };

            console.log(`[${new Date().toISOString()}] ✅ Success! Final URL: ${finalUrl.substring(0, 100)}...`);
            res.json(result);

        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error:`, error.message);
            await browser.close();
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Fatal error:`, error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Puppeteer 3DS API Server running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   API endpoint: http://localhost:${PORT}/api/3ds-automate`);
});