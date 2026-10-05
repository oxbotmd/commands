/**
 * instagram.js — Instagram Media Downloader (Knight API)
 * Aliases: .instagram, .ig, .igdl, .reels
 *
 * Uses Knight endpoint: /api/download/instagram
 * Handles Posts, Reels, IGTV, Images + Carousels (multiple items)
 */

const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────

const KNIGHT_API_URL = 'https://knightbotapi.stream/api/download/instagram';
const KNIGHT_API_KEY = 'knight';

const MAX_ITEMS       = 5;                      // max carousel items to send
const MAX_FILE_SIZE   = 150 * 1024 * 1024;      // 150MB per file
const API_TIMEOUT     = 30000;
const DL_TIMEOUT      = 120000;

// ─── URL Validation ──────────────────────────────────────────────────────

const IG_REGEX = /https?:\/\/(www\.)?(instagram\.com|instagr\.am)\/(p|reel|reels|tv)\//i;

function isValidIgUrl(url) {
    return IG_REGEX.test(url);
}

// ─── Knight API Call ─────────────────────────────────────────────────────

async function fetchKnightMedia(igUrl) {
    const { data } = await axios.get(KNIGHT_API_URL, {
        params: {
            apikey: KNIGHT_API_KEY,
            url: igUrl,   // axios URL-encodes automatically
        },
        timeout: API_TIMEOUT,
    });

    // Normalize: result.download can be a string OR an array (carousel)
    const raw = data?.result?.download || data?.download || data?.url;

    if (!raw) {
        throw new Error(data?.message || data?.error || 'Knight API returned no download link');
    }

    const items = Array.isArray(raw) ? raw : [raw];

    return {
        items,                                                    // array of media URLs
        title:     data?.result?.title     || data?.title     || 'Instagram Media',
        thumbnail: data?.result?.thumbnail || data?.result?.thumb || data?.thumb || null,
    };
}

// ─── Media Download ──────────────────────────────────────────────────────

async function downloadMediaBuffer(mediaUrl) {
    const response = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        timeout: DL_TIMEOUT,
        maxContentLength: MAX_FILE_SIZE,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Referer': 'https://www.instagram.com/',
        },
    });

    const buf = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || '';

    if (contentType.includes('application/json') || contentType.includes('text/html')) {
        throw new Error('Media link expired or is private');
    }
    if (buf.length < 5000) {
        throw new Error(`File too small (${buf.length} bytes), not valid media`);
    }

    return { buf, contentType };
}

// ═══════════════════════════════════════════════════════════════
// MAIN EXECUTE
// ═══════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `*📸 INSTAGRAM DOWNLOADER*\n\n_Usage: .instagram <link>_\n\n*Aliases:* .ig  .igdl  .reels\n\n_Supported: Posts, Reels, IGTV, Images, Carousels_`;
    }

    // Links may come split by spaces — grab everything that looks like a URL
    const url = args.join(' ').match(/https?:\/\/\S+/)?.[0];

    if (!url || !isValidIgUrl(url)) {
        return `❌ *Invalid Instagram link*\n\n_Must be a post, reel, or TV link._`;
    }

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '⬇️', key: msg.key } }); } catch {}

    // ── Step 1: Ask Knight for the download link(s) ─────────────────────
    let media;
    try {
        console.log(`[IG] Requesting Knight API: ${url.substring(0, 60)}...`);
        media = await fetchKnightMedia(url);
        console.log(`[IG] Knight resolved ${media.items.length} item(s)`);
    } catch (err) {
        console.error('[IG] Knight API Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to resolve link*\n\n_${err.message}_\n\n_Make sure the post is public._`;
    }

    // ── Step 2: Download + send each item ───────────────────────────────
    const toSend = media.items.slice(0, MAX_ITEMS);
    let sentCount = 0;
    let lastError = null;

    for (let i = 0; i < toSend.length; i++) {
        try {
            const { buf, contentType } = await downloadMediaBuffer(toSend[i]);
            const isVideo = contentType.startsWith('video/');
            console.log(`[IG] Item ${i + 1}/${toSend.length}: ${(buf.length / 1024 / 1024).toFixed(2)} MB, type=${contentType}`);

            // Caption only on the first item to keep the chat clean
            let caption = `📸 *${media.title}*\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;
            if (i > 0) caption = `_(${i + 1}/${toSend.length})_`;
            if (toSend.length > MAX_ITEMS && i === MAX_ITEMS - 1) {
                caption += `\n\n_+${media.items.length - MAX_ITEMS} more items not shown_`;
            }

            if (isVideo) {
                await sock.sendMessage(chatId, {
                    video: buf,
                    mimetype: 'video/mp4',
                    caption,
                }, { quoted: msg });
            } else {
                await sock.sendMessage(chatId, {
                    image: buf,
                    caption,
                }, { quoted: msg });
            }

            sentCount++;
        } catch (err) {
            console.error(`[IG] Item ${i + 1} failed:`, err.message);
            lastError = err.message;
        }
    }

    // ── Step 3: Report result ───────────────────────────────────────────
    if (sentCount > 0) {
        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        if (sentCount < toSend.length) {
            return `⚠️ Sent *${sentCount}/${toSend.length}* items. Some failed: _${lastError}_`;
        }
        return null;
    }

    try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
    return `❌ *Failed to download media*\n\n_${lastError || 'Unknown error'}_\n\n_Make sure the post is public._`;
}

module.exports = {
    name: 'instagram',
    aliases: ['ig', 'igdl', 'reels', 'insta'],
    desc: 'Download Instagram media (posts, reels, images)',
    category: 'downloader',
    execute,
};
