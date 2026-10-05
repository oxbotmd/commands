/**
 * snapchat.js — Snapchat Video Downloader
 * Aliases: .snapchat, .snap, 'sc'
 * Uses centralized Lecay yt-dlp API
 * Works best for Spotlight links and Public Stories
 */

const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/snapchat.php';
const OXBOT_STREAM_URL = 'https://lecay.oxbot.name.ng/api/stream.php';

// ─── URL Validation ──────────────────────────────────────────────────────

// Matches snapchat.com/p/ (Spotlight) and snapchat.com/t/ (Stories)
const SNAP_REGEX = /https?:\/\/(www\.)?snapchat\.com\/(p|t)\/\w+/i;

function isValidSnapUrl(url) {
    return SNAP_REGEX.test(url);
}

// ═══════════════════════════════════════════════════════════════
// MAIN EXECUTE
// ═══════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `👻 *SNAPCHAT DOWNLOADER*\n\n_Usage: .snapchat <Spotlight or Story URL>_\n\n*Aliases:* .snap  .sc\n\n_Supported: Public Spotlight videos & Stories_\n\n_⚠️ Private direct snaps are not supported._`;
    }

    const url = args[0].trim();

    if (!isValidSnapUrl(url)) {
        return `❌ *Invalid Snapchat link*\n\n_Must be a public Spotlight (/p/) or Story (/t/) link._`;
    }

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '👻', key: msg.key } }); } catch {}

    let title = 'Snapchat Video';
    let uploader = '';

    // ── Step 1: Get Metadata ──────────────────────────────────────────────
    try {
        const { data } = await axios.get(OXBOT_API_URL, {
            params: { api_key: OXBOT_API_KEY, url },
            timeout: 30000,
        });
        if (data.ok) {
            title = data.title || title;
            uploader = data.uploader || '';
        }
    } catch (err) {
        console.log('[SC] Metadata fetch failed, proceeding without title.');
    }

    // ── Step 2: Download Video via stream.php (yt-dlp) ──────────────────
    try {
        console.log(`[SC] Requesting stream proxy for: ${url.substring(0, 60)}...`);
        
        const streamUrl = `${OXBOT_STREAM_URL}?api_key=${OXBOT_API_KEY}&video_url=${encodeURIComponent(url)}&filename=snapchat_video`;
        
        const response = await axios.get(streamUrl, {
            responseType: 'arraybuffer',
            timeout: 180000, // 3 minutes
            maxContentLength: 150 * 1024 * 1024,
            validateStatus: () => true,
        });

        const buf = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || '';
        
        console.log(`[SC] stream.php replied: Status=${response.status}, Type=${contentType}, Size=${buf.length} bytes`);

        // ─── ERROR CHECKS ───
        if (response.status >= 400) {
            let errorMsg = `HTTP ${response.status}`;
            try { const errObj = JSON.parse(buf.toString('utf-8')); errorMsg = errObj.error || errorMsg; } catch {}
            throw new Error(errorMsg);
        }

        if (contentType.includes('application/json')) {
            const errorText = buf.toString('utf-8');
            try { const errorObj = JSON.parse(errorText); throw new Error(errorObj.error || 'API Error'); } 
            catch (e) { if (e.message !== errorText) throw e; throw new Error('Unexpected API response'); }
        }

        if (buf.length < 10000) {
            throw new Error(`File too small (${buf.length} bytes). Not a valid video.`);
        }

        console.log(`[SC] ✓ Valid video buffer: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);

        // ── Step 3: Send to WhatsApp ─────────────────────────────────────
        const captionParts = [`👻 *${title}*`];
        if (uploader) captionParts.push(`👤 *${uploader}*`);
        captionParts.push(`\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`);
        const caption = captionParts.join('\n');

        await sock.sendMessage(chatId, {
            video: buf,
            mimetype: 'video/mp4',
            caption,
        }, { quoted: msg });

        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;

    } catch (err) {
        console.error('[SC] Final Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        
        return `❌ *Failed to download video*\n\n_${err.message}_\n\n_⚠️ Make sure the story is still active and public. Private snaps cannot be downloaded._`;
    }
}

module.exports = {
    name: 'snapchat',
    aliases: ['snap', 'sc'],
    desc: 'Download Snapchat Spotlight & Story videos',
    category: 'downloader',
    execute,
};