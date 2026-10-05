/**
 * tiktok.js — TikTok Video & Image Downloader
 * Aliases: .tiktok, .tt, .tk, .tikdown, .tdown
 * 
 * NOW SUPPORTS: Videos, Single Images, Photo Carousels
 */

const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/download.php';
const OXBOT_STREAM_URL = 'https://lecay.oxbot.name.ng/api/stream.php';

// ─── URL Validation ──────────────────────────────────────────────────────

const TIKTOK_REGEX = /https?:\/\/(vm|vt|m|www)?\.?tiktok\.com\//i;

function isValidTikTokUrl(url) {
    return TIKTOK_REGEX.test(url);
}

// ═══════════════════════════════════════════════════════════════
// IMAGE DOWNLOADER (Direct URL download for images)
// ═══════════════════════════════════════════════════════════════

async function downloadImageBuffer(imageUrl) {
    console.log('[TT] Downloading image:', imageUrl.substring(0, 80) + '...');
    
    let response;
    try {
        response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 60000, // 1 minute for images
            maxContentLength: 50 * 1024 * 1024, // 50MB max
            validateStatus: (status) => status < 500,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Referer': 'https://www.tiktok.com/',
            },
        });
    } catch (err) {
        throw new Error(`Image download failed: ${err.code || err.message}`);
    }

    if (response.status >= 400) {
        throw new Error(`Image server returned HTTP ${response.status}`);
    }

    const buf = Buffer.from(response.data);
    
    if (buf.length < 1000) {
        throw new Error(`Image too small (${buf.length} bytes), likely an error`);
    }

    console.log(`[TT] ✓ Image downloaded: ${(buf.length / 1024).toFixed(1)} KB`);
    return buf;
}

// ═══════════════════════════════════════════════════════════════
// VIDEO DOWNLOADER (Via stream.php using yt-dlp)
// ═══════════════════════════════════════════════════════════════

async function downloadVideoBuffer(originalTikTokUrl, videoTitle) {
    const safeFilename = (videoTitle || 'tiktok_video').replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 50);
    
    const streamUrl = `${OXBOT_STREAM_URL}?api_key=${OXBOT_API_KEY}&video_url=${encodeURIComponent(originalTikTokUrl)}&filename=${encodeURIComponent(safeFilename)}`;
    
    console.log('[TT] Requesting yt-dlp proxy from stream.php...');

    let response;
    try {
        response = await axios.get(streamUrl, {
            responseType: 'arraybuffer',
            timeout: 180000,
            maxContentLength: 150 * 1024 * 1024,
            validateStatus: () => true,
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
    
    console.log(`[TT] stream.php replied: Status=${response.status}, Type=${contentType}, Size=${buf.length} bytes`);

    if (response.status >= 400) {
        let errorMsg = `HTTP ${response.status}`;
        let errorCode = '';
        try {
            const errObj = JSON.parse(buf.toString('utf-8'));
            errorMsg = errObj.error || errorMsg;
            errorCode = errObj.error_code || '';
            console.log('[TT] PHP Error:', errorCode, errorMsg);
        } catch {}
        
        if (response.status === 401) {
            throw new Error('API key invalid or expired');
        }
        if (response.status === 502) {
            if (errorCode === 'YTDLP_FAILED') {
                throw new Error(errorMsg);
            }
            throw new Error(`Download failed: ${errorMsg}`);
        }
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

    console.log(`[TT] ✓ Valid video buffer: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
    return buf;
}

// ═══════════════════════════════════════════════════════════════
// MAIN EXECUTE
// ═══════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `*📱 TIKTOK DOWNLOADER*\n\n*.tiktok <link>* — Download video or images\n\n*Supports:*\n• Videos (no watermark)\n• Single images\n• Photo carousels (all images)\n\n*Aliases:* .tt  .tk  .tikdown  .tdown`;
    }

    const url = args[0].trim();

    if (!isValidTikTokUrl(url)) {
        return `❌ *Invalid TikTok link*`;
    }

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '⬇️', key: msg.key } }); } catch {}

    // 1. Get media info from API
    let result;
    try {
        result = await axios.get(OXBOT_API_URL, {
            params: { api_key: OXBOT_API_KEY, url },
            timeout: 30000,
        });
        result = result.data;
        
        if (!result.ok) throw new Error(result.error || 'API error');
        
        // Log what type we got
        const mediaType = result.type || 'video';
        console.log(`[TT] Got ${mediaType} info:`, result.title?.substring(0, 40));
        if (result.images) {
            console.log(`[TT] Found ${result.images.length} image(s)`);
        }
    } catch (err) {
        console.error('[TT] API Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to get media info*\n\n*${err.message}*`;
    }

    const title = result.title || 'TikTok Media';
    const type = result.type || 'video'; // 'video' | 'image' | 'carousel'

    // ═══════════════════════════════════════════════════════════
    // HANDLE IMAGES / CAROUSELS
    // ═══════════════════════════════════════════════════════════
    if (type === 'image' || type === 'carousel') {
        const images = result.images || [result.download_url];
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < images.length; i++) {
            const imgUrl = images[i];
            
            try {
                const imgBuf = await downloadImageBuffer(imgUrl);
                
                // Build caption
                let imgCaption;
                if (images.length > 1) {
                    imgCaption = `📷 *${title}*\n\n_𝗜𝗠𝗔𝗚𝗘 ${i + 1} 𝗢𝗙 ${images.length}_\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;
                } else {
                    imgCaption = `📷 *${title}*\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;
                }

                await sock.sendMessage(chatId, {
                    image: imgBuf,
                    caption: imgCaption,
                }, { quoted: i === 0 ? msg : undefined });

                successCount++;
                
                // Small delay between images to avoid rate limiting
                if (i < images.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            } catch (imgErr) {
                console.error(`[TT] Failed to download image ${i + 1}:`, imgErr.message);
                failCount++;
            }
        }

        // Final reaction based on results
        if (successCount > 0) {
            try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
            
            if (failCount > 0 && successCount < images.length) {
                // Some failed
                return `⚠️ Downloaded ${successCount}/${images.length} images. ${failCount} failed.`;
            }
            return null; // All success
        } else {
            try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
            return `❌ *Failed to download images*\n\n_All ${images.length} image(s) failed_`;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // HANDLE VIDEOS (original behavior)
    // ═══════════════════════════════════════════════════════════
    const caption = `🎵 *${title}*\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;

    try {
        const buf = await downloadVideoBuffer(url, title);
        
        await sock.sendMessage(chatId, {
            video: buf,
            mimetype: 'video/mp4',
            caption,
        }, { quoted: msg });

        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;

    } catch (err) {
        console.error('[TT] Video Download Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        
        return `❌ *Failed to download video*\n\n_${err.message}_`;
    }
}

module.exports = {
    name:     'tiktok',
    aliases:  ['tt', 'tk', 'tikdown', 'tdown'],
    desc:     'Download TikTok video, images, or photo carousels',
    category: 'downloader',
    execute,
};
