const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────
// ⚠️ Move the key to an env var — you've now leaked this one publicly
const OXBOT_API_KEY = process.env.OXBOT_API_KEY || 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/linkedin.php';
const OXBOT_STREAM_URL = 'https://lecay.oxbot.name.ng/api/stream.php';

const MAX_IMAGES = 10;
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

// ─── URL helpers ─────────────────────────────────────────────────────────
const LINKEDIN_REGEX = /https?:\/\/([a-z0-9-]+\.)?linkedin\.com\/(posts|feed\/update|in\/|pulse\/)/i;
const SHORT_REGEX = /https?:\/\/lnkd\.in\/\S+/i;

function cleanUrl(raw) {
    return raw.replace(/[<>"']/g, '').replace(/[),.;!]+$/, '').trim();
}

function findUrl(text) {
    if (!text) return '';
    const m = String(text).match(/https?:\/\/\S*(?:linkedin\.com|lnkd\.in)\/\S*/i);
    return m ? cleanUrl(m[0]) : '';
}

function isValidLinkedInUrl(url) {
    return LINKEDIN_REGEX.test(url) || SHORT_REGEX.test(url);
}

// Checks args → message body → quoted/replied message → media captions
function extractUrl(msg, args) {
    const argText = Array.isArray(args) ? args.join(' ') : (args || '');
    const q = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage || {};
    return findUrl(argText)
        || findUrl(msg?.message?.conversation)
        || findUrl(msg?.message?.extendedTextMessage?.text)
        || findUrl(q.conversation)
        || findUrl(q.extendedTextMessage?.text)
        || findUrl(q.imageMessage?.caption)
        || findUrl(q.videoMessage?.caption)
        || '';
}

// ─── Helpers ─────────────────────────────────────────────────────────────
function buildCaption(title, uploader, extra = '') {
    const parts = [`💼 *${title || 'LinkedIn Post'}*`];
    if (uploader) parts.push(`👤 *${uploader}*`);
    if (extra) parts.push(extra);
    parts.push(`\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`);
    return parts.join('\n');
}

async function reply(sock, chatId, msg, text) {
    try { await sock.sendMessage(chatId, { text }, { quoted: msg }); }
    catch (e) { console.error('[LI] Reply failed:', e.message); }
}

async function fetchMetadata(url) {
    try {
        const { data } = await axios.get(OXBOT_API_URL, {
            params: { api_key: OXBOT_API_KEY, url },
            timeout: 25000,
            validateStatus: () => true,
            headers: { 'User-Agent': UA },
        });
        console.log('[LI] Metadata raw:', JSON.stringify(data).slice(0, 300));
        if (!data || typeof data !== 'object') return null;
        const d = (data.data && typeof data.data === 'object') ? data.data : data;
        if (d.ok === false || d.error) return null;
        return {
            media_type: d.media_type || d.type || '',
            title: d.title || '',
            uploader: d.uploader || d.author || '',
            images: d.images || d.image_urls || [],
            video: d.video || d.video_url || d.download_url || d.videoUrl || '',
        };
    } catch (e) {
        console.log('[LI] Metadata fetch failed:', e.message);
        return null;
    }
}

async function downloadImage(imageUrl) {
    const res = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: MAX_IMAGE_BYTES,
        validateStatus: () => true,
        headers: { 'User-Agent': UA },
    });
    const type = (res.headers['content-type'] || '').split(';')[0].trim();
    const buf = Buffer.from(res.data);
    if (res.status >= 400 || !type.startsWith('image/') || buf.length < 1000) return null;
    return { buf, mimetype: type };
}

async function sendImages(sock, chatId, msg, meta) {
    const urls = (meta.images || []).slice(0, MAX_IMAGES);
    let sent = 0;
    for (const imgUrl of urls) {
        try {
            const img = await downloadImage(imgUrl);
            if (!img) continue;
            const content = { image: img.buf, mimetype: img.mimetype };
            if (sent === 0) {
                const extra = urls.length > 1 ? `🖼️ _${urls.length} images_` : '';
                content.caption = buildCaption(meta.title, meta.uploader, extra);
            }
            await sock.sendMessage(chatId, content, { quoted: msg });
            sent++;
        } catch (e) {
            console.log(`[LI] Image skipped: ${e.message}`);
        }
    }
    if (sent === 0) throw new Error('Could not download any images from this post.');
    return sent;
}

async function fetchVideoBuffer(videoUrl, label) {
    const res = await axios.get(videoUrl, {
        responseType: 'arraybuffer',
        timeout: 180000,
        maxContentLength: MAX_VIDEO_BYTES,
        validateStatus: () => true,
        headers: { 'User-Agent': UA },
    });
    const buf = Buffer.from(res.data);
    const ctype = res.headers['content-type'] || '';
    console.log(`[LI] ${label}: status=${res.status} type=${ctype} size=${buf.length}`);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    if (ctype.includes('application/json') || ctype.includes('text/html')) {
        let m = '';
        try { m = JSON.parse(buf.toString('utf-8')).error || ''; } catch {}
        throw new Error(m || 'Source returned an error page instead of a video.');
    }
    if (buf.length < 10000) throw new Error(`File too small (${buf.length} bytes) — not a valid video.`);
    return buf;
}

async function sendVideo(sock, chatId, msg, postUrl, meta) {
    const attempts = [];
    if (meta?.video) attempts.push(['direct', meta.video]);
    attempts.push(['stream-proxy',
        `${OXBOT_STREAM_URL}?api_key=${encodeURIComponent(OXBOT_API_KEY)}&video_url=${encodeURIComponent(postUrl)}&filename=linkedin_video`
    ]);

    let lastErr;
    for (const [label, u] of attempts) {
        try {
            const buf = await fetchVideoBuffer(u, label);
            await sock.sendMessage(chatId, {
                video: buf,
                mimetype: 'video/mp4',
                caption: buildCaption(meta?.title || 'LinkedIn Video', meta?.uploader),
            }, { quoted: msg });
            return;
        } catch (e) {
            console.log(`[LI] ${label} failed: ${e.message}`);
            lastErr = e;
        }
    }
    throw lastErr || new Error('Video download failed.');
}

// ═══════════════════════════════════════════════════════════════
// MAIN EXECUTE
// ═══════════════════════════════════════════════════════════════
async function execute(sock, msg, a, b) {
    // Defensive arg handling regardless of how the framework calls this
    let args = Array.isArray(a) ? a : Array.isArray(b) ? b : [];
    if (a && typeof a === 'object' && !Array.isArray(a) && Array.isArray(a.args)) args = a.args;

    const chatId = msg?.key?.remoteJid;
    if (!chatId || chatId === 'status@broadcast') return null;

    try {
        console.log('[LI] execute called, args:', args);

        if (!OXBOT_API_KEY) {
            await reply(sock, chatId, msg, '⚙️ LinkedIn downloader is missing its API key.');
            return null;
        }

        const url = extractUrl(msg, args);
        if (!url) {
            await reply(sock, chatId, msg,
                `💼 *LINKEDIN DOWNLOADER*\n\n📎 _Paste a LinkedIn URL after the command, or reply to a message containing one._\n\n*Example:*\n.linkedin https://www.linkedin.com/posts/...\n\n*Aliases:* .li  .lidl\n_Supported: Public LinkedIn video & image posts_`);
            return null;
        }

        if (!isValidLinkedInUrl(url)) {
            await reply(sock, chatId, msg, `❌ *Invalid LinkedIn link*\n\n📎 _Paste a public LinkedIn post URL (e.g., linkedin.com/posts/...)_`);
            return null;
        }

        console.log('[LI] URL:', url);
        try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
        try { await sock.sendMessage(chatId, { react: { text: '⬇️', key: msg.key } }); } catch {}

        const meta = await fetchMetadata(url);

        if (meta && (meta.media_type === 'image' || (!meta.video && meta.images?.length))) {
            const count = await sendImages(sock, chatId, msg, meta);
            console.log(`[LI] ✓ Sent ${count} image(s)`);
        } else {
            await sendVideo(sock, chatId, msg, url, meta);
        }

        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;

    } catch (err) {
        console.error('[LI] Final Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        await reply(sock, chatId, msg,
            `❌ *Failed to download*\n\n_${err.message}_\n\n_Make sure the post is public and not restricted._`);
        return null;
    }
}

module.exports = {
    name: 'linkedin',
    aliases: ['li', 'lidl'],
    desc: 'Download LinkedIn videos & images',
    category: 'downloader',
    execute,
};
