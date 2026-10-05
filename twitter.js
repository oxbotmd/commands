/**
 * twitter.js — Twitter/X Video Downloader
 * Aliases: .twitter, .tweet, .tw
 * Uses centralized Lecay yt-dlp API
 */

const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/download.php';
const OXBOT_STREAM_URL = 'https://lecay.oxbot.name.ng/api/stream.php';

// ─── URL Validation ──────────────────────────────────────────────────────

// Only matches actual tweet status links (e.g. x.com/user/status/123)
const TWITTER_REGEX = /https?:\/\/(www\.)?(twitter\.com|x\.com)\/\w+\/status\/\d+/i;

// ═══════════════════════════════════════════════════════════════
// MAIN EXECUTE
// ═══════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `🐦 *TWITTER/X DOWNLOADER*\n\n_Usage: .twitter <tweet URL>_`;
    }

    const url = args[0].trim();

    if (!TWITTER_REGEX.test(url)) {
        return `❌ *Invalid Twitter/X link*\n\n_Must be a tweet status link (e.g., x.com/user/status/123)_`;
    }

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '⬇️', key: msg.key } }); } catch {}

    // 1. Try to get metadata (title/uploader) - optional but nice for caption
    let title = 'Twitter/X Video';
    try {
        const { data } = await axios.get(OXBOT_API_URL, {
            params: { api_key: OXBOT_API_KEY, url },
            timeout: 30000,
        });
        if (data.ok && data.title) {
            title = data.title;
        }
    } catch (err) {
        console.log('[TW] Metadata fetch failed, proceeding without title.');
    }

    // 2. Download video via stream.php (yt-dlp bypasses Twitter's protections)
    try {
        const streamUrl = `${OXBOT_STREAM_URL}?api_key=${OXBOT_API_KEY}&video_url=${encodeURIComponent(url)}&filename=twitter_video`;
        console.log('[TW] Requesting stream proxy...');
        console.log('[TW] Original URL:', url);

        const response = await axios.get(streamUrl, {
            responseType: 'arraybuffer',
            timeout: 180000, // 3 minutes
            maxContentLength: 150 * 1024 * 1024, // 150MB max
            validateStatus: () => true, // Handle errors manually
        });

        const buf = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || '';
        
        console.log(`[TW] stream.php replied: Status=${response.status}, Type=${contentType}, Size=${buf.length} bytes`);

        // ─── ERROR CHECKS ───

        if (response.status >= 400) {
            let errorMsg = `HTTP ${response.status}`;
            try {
                const errObj = JSON.parse(buf.toString('utf-8'));
                errorMsg = errObj.error || errorMsg;
            } catch {}
            throw new Error(errorMsg);
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

        console.log(`[TW] ✓ Valid video buffer: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);

        const caption = `🐦 *${title}*\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;

        // 3. Send video to WhatsApp
        await sock.sendMessage(chatId, {
            video: buf,
            mimetype: 'video/mp4',
            caption,
        }, { quoted: msg });

        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;

    } catch (err) {
        console.error('[TW] Final Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        
        return `❌ *Failed to download video*\n\n_${err.message}_`;
    }
}

module.exports = {
    name: 'twitter',
    aliases: ['tweet', 'tw'],
    desc: 'Download Twitter/X videos',
    category: 'downloader',
    execute,
};
