/**
 * ss.js — Screenshot any website
 * Aliases: .ss, .ssweb, .screenshot
 * Uses the centralized OXBOT API
 */

const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_SS_API = 'https://lecay.oxbot.name.ng/api/ss.php';

// ═══════════════════════════════════════════════════
// MAIN EXECUTE
// ═══════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    // ═══════════════════════════════════════════════════
    // NO URL PROVIDED — SHOW USAGE
    // ═══════════════════════════════════════════════════
    if (!args || args.length === 0) {
        return await sock.sendMessage(chatId, {
            text: `*🖥️ SCREENSHOT TOOL*

*.ss <url>* — Take a screenshot of any website

*Options:*
• *.ss <url> mobile* — Mobile view
• *.ss <url> tablet* — Tablet view
• *.ss <url> dark* — Dark mode

*Examples:*
• \`.ss https://google.com\`
• \`.ss youtube.com mobile\`
• \`.ss github.com dark\`

_Supports any public website._`
        }, { quoted: msg });
    }

    let url = args[0].trim();

    // ═══════════════════════════════════════════════════
    // PARSE OPTIONS FROM ARGUMENTS
    // ═══════════════════════════════════════════════════
    let device = 'desktop';
    let theme = 'light';

    const lowerArgs = args.map(a => a.toLowerCase());

    if (lowerArgs.includes('mobile')) {
        device = 'mobile';
    } else if (lowerArgs.includes('tablet')) {
        device = 'tablet';
    }

    if (lowerArgs.includes('dark')) {
        theme = 'dark';
    }

    // Auto-add https:// if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }

    // Basic URL validation
    try {
        new URL(url);
    } catch {
        return await sock.sendMessage(chatId, {
            text: `❌ Invalid URL: *${url}*\n\nMake sure it's a valid website link.\n\nExample: \`.ss https://google.com\``
        }, { quoted: msg });
    }

    // ═══════════════════════════════════════════════════
    // SHOW WORKING INDICATORS
    // ═══════════════════════════════════════════════════
    try {
        await sock.presenceSubscribe(chatId);
        await sock.sendPresenceUpdate('composing', chatId);
        await sock.sendMessage(chatId, { react: { text: '📸', key: msg.key } });
    } catch {}

    // Send "please wait" message
    let waitMsg = null;
    try {
        const deviceLabel = device !== 'desktop' ? ` (${device} view)` : '';
        const themeLabel = theme === 'dark' ? ' 🌙' : '';

        waitMsg = await sock.sendMessage(chatId, {
            text: `📸 Taking screenshot${deviceLabel}${themeLabel}...\n\n🌐 *${url}*\n\n_Please wait..._`,
        }, { quoted: msg });
    } catch {}

    // ═══════════════════════════════════════════════════
    // FETCH SCREENSHOT FROM OXBOT API
    // ═══════════════════════════════════════════════════
    try {
        const response = await axios.get(OXBOT_SS_API, {
            params: {
                api_key: OXBOT_API_KEY,
                url: url,
                device: device,
                theme: theme,
                width: device === 'mobile' ? 390 : device === 'tablet' ? 768 : 1280,
                height: device === 'mobile' ? 844 : device === 'tablet' ? 1024 : 720,
                quality: 85,
            },
            responseType: 'arraybuffer',
            timeout: 35000, // 35s timeout for slow sites
            headers: {
                'Accept': '*/*',
            },
        });

        // Check response content type to determine if it's an image or error JSON
        const contentType = response.headers['content-type'] || '';
        const isImage = contentType.includes('image/') ||
                        (response.headers['x-image-response'] === 'true');

        if (isImage) {
            // ═══════════════════════════════════════════════════
            // SUCCESS — SEND SCREENSHOT
            // ═══════════════════════════════════════════════════
            const imageBuffer = Buffer.from(response.data);

            if (imageBuffer.length < 2000) {
                throw new Error('Screenshot returned empty or corrupted image');
            }

            // Build caption
            const deviceEmoji = device === 'mobile' ? '📱' : device === 'tablet' ? '📟' : '🖥️';
            const themeEmoji = theme === 'dark' ? ' 🌙' : '';

            const caption = `📸 *Screenshot*${themeEmoji}\n${deviceEmoji} ${device.charAt(0).toUpperCase() + device.slice(1)} view\n🌐 ${url}`;

            await sock.sendMessage(chatId, {
                image: imageBuffer,
                caption: caption,
            }, { quoted: msg });

            // Delete "please wait" message
            await deleteMessage(sock, chatId, waitMsg);

            // Success reaction
            try {
                await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } });
            } catch {}

            return null;

        } else {
            // ═══════════════════════════════════════════════════
            // ERROR RESPONSE (JSON)
            // ═══════════════════════════════════════════════════
            const errorData = JSON.parse(Buffer.from(response.data).toString('utf-8'));
            throw new Error(errorData.error || 'Unknown API error');
        }

    } catch (err) {
        console.error('[SS] Error:', err.message);

        // Delete "please wait" message
        await deleteMessage(sock, chatId, waitMsg);

        // Error reaction
        try {
            await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } });
        } catch {}

        // Handle different error types
        let errorMessage = err.message;

        if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
            errorMessage = 'Request timed out. The website took too long to respond.';
        } else if (err.code === 'ENOTFOUND') {
            errorMessage = 'Could not connect to the screenshot service.';
        } else if (err.response) {
            // Axios error with response
            try {
                const errorData = JSON.parse(Buffer.from(err.response.data).toString('utf-8'));
                errorMessage = errorData.error || errorMessage;
            } catch {
                errorMessage = `Server error (${err.response.status})`;
            }
        }

        return await sock.sendMessage(chatId, {
            text: `❌ *Screenshot failed*

*URL:* ${url}

*Error:* ${errorMessage}

*Possible fixes:*
• Make sure the URL is correct and public
• Try without options: \`.ss ${args[0]}\`
• Some sites block automated screenshots
• Try a different website`
        }, { quoted: msg });
    }
}

// ═══════════════════════════════════════════════════
// HELPER: Safely delete a message
// ═══════════════════════════════════════════════════
async function deleteMessage(sock, chatId, msg) {
    if (!msg || !msg.key) return;
    try {
        await sock.sendMessage(chatId, { delete: msg.key });
    } catch {}
}

module.exports = {
    name:     'ss',
    aliases:  ['ssweb', 'screenshot', 'web'],
    desc:     'Take a screenshot of any website',
    category: 'utility',
    execute,
};
