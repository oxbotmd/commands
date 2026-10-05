/**
 * commands/reddit.js — Reddit Post Downloader
 * Aliases: .reddit, .rd, .redditdl
 *
 * Handles four post types returned by api/reddit.php:
 *   video   — merged mp4 (native Reddit video or hosted gif), sent as video
 *   image   — single direct image, sent as image
 *   gallery — multiple images, sent in sequence
 *   text    — no media; sends title/selftext/external link as text
 *
 * downloadBuffer() validation is two-layered, matching threads.js's
 * min-byte-size check on top of reddit's existing content-sniff:
 *   1. Content-sniff — catches a 200-status HTML/JSON error page
 *      masquerading as media.
 *   2. Size-sniff — catches truncated downloads and Reddit's small
 *      placeholder/broken-image responses (common on deleted gallery
 *      items) that don't look like an error page but aren't real
 *      media either. Threshold is type-specific since images are
 *      legitimately smaller than video.
 */

const axios = require('axios');

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/reddit.php';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
};

const REDDIT_REGEX = /https?:\/\/(www\.|old\.|new\.)?(reddit\.com|redd\.it)\//i;

// Minimum acceptable byte size per media type — mirrors threads.js's
// 10000 (video) / 1000 (image) floors.
const MIN_BYTES = {
    video: 10000,
    image: 1000,
    gallery: 1000,
};

function isValidRedditUrl(url) {
    return REDDIT_REGEX.test(url);
}

async function tryRequest(fn, attempts = 3) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        try { return await fn(); } catch (e) {
            lastErr = e;
            if (i < attempts) await new Promise(r => setTimeout(r, 1000 * i));
        }
    }
    throw lastErr;
}

// ─── Get post info from our own reddit.php endpoint ───
async function fetchPostInfo(url) {
    const res = await tryRequest(() =>
        axios.get(OXBOT_API_URL, { params: { api_key: OXBOT_API_KEY, url }, timeout: 60000 })
    );
    const data = res.data;
    if (!data.ok) throw new Error(data.error || 'API error');
    return data;
}

// ─── Download a buffer, retrying, then validate it's real media ───
async function downloadBuffer(fileUrl, minBytes = 5000) {
    const fetchOnce = () => tryRequest(async () => {
        const res = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 90000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            validateStatus: s => s >= 200 && s < 400,
            headers: {
                'User-Agent': HEADERS['User-Agent'],
                'Accept': '*/*',
                'Accept-Encoding': 'identity',
                'Referer': 'https://www.reddit.com/',
            },
        });
        return Buffer.from(res.data);
    });

    const buf = await fetchOnce();
    if (!buf || buf.length === 0) throw new Error('Empty buffer');

    // Content-sniff: catches a 200-status HTML/JSON error page.
    const headStr = buf.toString('utf8', 0, Math.min(200, buf.length));
    if (headStr.includes('<!DOCTYPE') || headStr.includes('<html') ||
        (headStr.trim().startsWith('{') && headStr.includes('"error"'))) {
        throw new Error('Server returned an error page instead of media');
    }

    // Size-sniff: catches truncated files and small placeholder/broken-image
    // responses that pass the content-sniff but still aren't real media.
    if (buf.length < minBytes) {
        throw new Error(`Response too small (${buf.length} bytes) — likely not valid media`);
    }

    return buf;
}

function sanitizeFilename(title) {
    return (title || 'Reddit_Post').replace(/[^\w\s\-()']/g, '').trim().slice(0, 80);
}

function captionFor(result) {
    const parts = [];
    if (result.title) parts.push(`*${result.title}*`);
    const meta = [];
    if (result.subreddit) meta.push(result.subreddit);
    if (result.author) meta.push(`u/${result.author}`);
    if (meta.length) parts.push(`_${meta.join(' • ')}_`);
    parts.push('_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_');
    return parts.join('\n\n');
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `*🟠 REDDIT DOWNLOADER*\n\n*.reddit <link>* — Download a video, image, gallery, or text post\n\n*Aliases:* .rd  .redditdl`;
    }

    const url = args[0].trim();
    if (!isValidRedditUrl(url)) {
        return `❌ *Invalid Reddit link*`;
    }

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '⬇️', key: msg.key } }); } catch {}

    let result;
    try {
        result = await fetchPostInfo(url);
    } catch (err) {
        console.log(`[reddit] Info fetch failed — ${err.message}`);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to get post info*\n\n*${err.message}*`;
    }

    // Optional NSFW gate — wire this up to your bot's per-chat settings
    // if you track them (e.g. botData.settings[chatId].allowNsfw).
    if (result.nsfw && botData?.settings?.[chatId]?.allowNsfw === false) {
        try { await sock.sendMessage(chatId, { react: { text: '🔞', key: msg.key } }); } catch {}
        return `🔞 *This post is marked NSFW and is disabled in this chat.*`;
    }

    try {
        switch (result.type) {
            case 'video': {
                console.log(`[reddit] Downloading video: ${result.title}`);
                const buf = await downloadBuffer(result.download_url, MIN_BYTES.video);
                await sock.sendMessage(chatId, {
                    video: buf,
                    caption: captionFor(result),
                    fileName: `${sanitizeFilename(result.title)}.mp4`,
                }, { quoted: msg });
                break;
            }

            case 'image': {
                console.log(`[reddit] Downloading image: ${result.title}`);
                const buf = await downloadBuffer(result.download_url, MIN_BYTES.image);
                await sock.sendMessage(chatId, {
                    image: buf,
                    caption: captionFor(result),
                }, { quoted: msg });
                break;
            }

            case 'gallery': {
                console.log(`[reddit] Downloading gallery (${result.images.length} images): ${result.title}`);
                let sent = 0, failed = 0;
                for (let i = 0; i < result.images.length; i++) {
                    try {
                        const buf = await downloadBuffer(result.images[i], MIN_BYTES.gallery);
                        await sock.sendMessage(chatId, {
                            image: buf,
                            caption: i === 0 ? captionFor(result) : `${i + 1}/${result.images.length}`,
                        }, { quoted: i === 0 ? msg : undefined });
                        sent++;
                        await new Promise(r => setTimeout(r, 600));
                    } catch (e) {
                        console.log(`[reddit] Gallery image ${i + 1} ❌ — ${e.message}`);
                        failed++;
                    }
                }
                if (sent === 0) throw new Error('Failed to download any images in this gallery');
                try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
                return failed > 0 ? `⚠️ Sent ${sent}/${result.images.length} images. ${failed} failed.` : null;
            }

            case 'text': {
                let text = `📝 *${result.title || 'Reddit Post'}*`;
                if (result.subreddit || result.author) {
                    const meta = [result.subreddit, result.author ? `u/${result.author}` : null].filter(Boolean);
                    text += `\n_${meta.join(' • ')}_`;
                }
                if (result.selftext) {
                    const trimmed = result.selftext.length > 1500
                        ? result.selftext.slice(0, 1500) + '…'
                        : result.selftext;
                    text += `\n\n${trimmed}`;
                }
                if (result.external_url) text += `\n\n🔗 ${result.external_url}`;
                await sock.sendMessage(chatId, { text }, { quoted: msg });
                break;
            }

            default:
                throw new Error(`Unsupported post type: ${result.type}`);
        }

        console.log(`[reddit] ✅ Sent successfully: ${result.title || url}`);
        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;
    } catch (err) {
        console.log(`[reddit] Error — ${err.message}`);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to download post*\n\n_${err.message}_`;
    }
}

module.exports = {
    name: 'reddit',
    aliases: ['rd', 'redditdl'],
    desc: 'Download a Reddit video, image, gallery, or text post',
    category: 'downloader',
    execute,
};
