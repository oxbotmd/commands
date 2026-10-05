const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/download.php';
const OXBOT_STREAM_URL = 'https://lecay.oxbot.name.ng/api/stream.php';

// ─── URL Validation ──────────────────────────────────────────────────────

// Matches facebook.com, m.facebook.com, fb.watch, etc.
const FB_REGEX = /https?:\/\/(www\.|m\.)?(facebook\.com|fb\.watch)\/.+/i;

function isValidFacebookUrl(url) {
    return FB_REGEX.test(url);
}

// ═══════════════════════════════════════════════════════════════
// PROXY BUFFER DOWNLOADER (Via stream.php using yt-dlp)
// ═══════════════════════════════════════════════════════════════

async function downloadVideoBuffer(originalUrl) {
    const streamUrl = `${OXBOT_STREAM_URL}?api_key=${OXBOT_API_KEY}&video_url=${encodeURIComponent(originalUrl)}&filename=facebook_video`;
    
    console.log('[FB] Requesting yt-dlp proxy from stream.php...');
    console.log('[FB] Original URL:', originalUrl.substring(0, 80) + '...');

    let response;
    try {
        response = await axios.get(streamUrl, {
            responseType: 'arraybuffer',
            timeout: 180000, // 3 minutes
            maxContentLength: 150 * 1024 * 1024, // 150MB max
            validateStatus: () => true, // Handle all status codes manually
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*',
            },
        });
    } catch (err) {
        throw new Error(`Network error: ${err.code || err.message}`);
    }

    const buf = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || '';
    
    console.log(`[FB] stream.php replied: Status=${response.status}, Type=${contentType}, Size=${buf.length} bytes`);

    // ─── ERROR CHECKS ───
    if (response.status >= 400) {
        let errorMsg = `HTTP ${response.status}`;
        let errorCode = '';
        try {
            const errObj = JSON.parse(buf.toString('utf-8'));
            errorMsg = errObj.error || errorMsg;
            errorCode = errObj.error_code || '';
            console.log('[FB] PHP Error:', errorCode, errorMsg);
        } catch {}
        
        if (response.status === 401) throw new Error('API key invalid or expired');
        if (response.status === 502) throw new Error(errorMsg); // Pass the yt-dlp error directly
        throw new Error(`Proxy error: ${errorMsg}`);
    }

    if (contentType.includes('application/json')) {
        const errorText = buf.toString('utf-8');
        try {
            const errorObj = JSON.parse(errorText);
            throw new Error(errorObj.error || 'Unexpected API response');
        } catch (e) {
            if (e.message !== errorText) throw e;
            throw new Error('Unexpected JSON response from proxy');
        }
    }

    if (buf.length < 10000) {
        throw new Error(`Response too small (${buf.length} bytes). Not a valid video.`);
    }

    console.log(`[FB] ✓ Valid video buffer: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
    return buf;
}

// ═══════════════════════════════════════════════════════════════
// MAIN EXECUTE
// ═══════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `*📘 FACEBOOK DOWNLOADER*\n\n*.fb <link>* — Download Facebook video\n\n*Aliases:* .facebook  .fbdl`;
    }

    const url = args[0].trim();

    if (!isValidFacebookUrl(url)) {
        return `❌ *Invalid Facebook link*\n\n_Ensure it's a valid facebook.com or fb.watch link_`;
    }

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '⬇️', key: msg.key } }); } catch {}

    // 1. Try to get video info (title) from API - optional, but nice for caption
    let videoTitle = 'Facebook Video';
    try {
        const res = await axios.get(OXBOT_API_URL, {
            params: { api_key: OXBOT_API_KEY, url },
            timeout: 30000,
        });
        if (res.data.ok && res.data.title) {
            videoTitle = res.data.title;
        }
    } catch (err) {
        console.log('[FB] Could not fetch title, will proceed without it.');
    }

    const caption = `📘 *${videoTitle}*\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;

    // 2. Download video directly using stream.php (yt-dlp)
    try {
        const buf = await downloadVideoBuffer(url);
        
        await sock.sendMessage(chatId, {
            video: buf,
            mimetype: 'video/mp4',
            caption,
        }, { quoted: msg });

        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;

    } catch (err) {
        console.error('[FB] Final Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        
        // Friendly error messages based on yt-dlp failures
        if (err.message.includes('private') || err.message.includes('unavailable')) {
            return `❌ *Video unavailable*\n\n_${err.message}_\n\n_Make sure the video is public._`;
        }
        
        return `❌ *Failed to download video*\n\n_${err.message}_`;
    }
}

module.exports = {
    name:     'facebook',
    aliases:  ['fb', 'fbdl'],
    desc:     'Download Facebook videos',
    category: 'downloader', // Changed to 'downloader' to match tiktok
    execute,
};
