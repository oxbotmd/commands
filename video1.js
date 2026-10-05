/**
 * commands/video1.js — Multi-Platform Video Downloader (video + audio)
 * Aliases: .vid1, .videodl
 *
 * Routing:
 *   - YouTube    → api/video1.php    (dual-stream JSON: video_url + audio_url)
 *   - Threads    → api/threads.php   (dual-stream JSON, + carousel/image branches)
 *   - Instagram  → api/instagram.php (streams ONE raw file — video+audio muxed,
 *                  or an image. Audio extracted LOCALLY via ffmpeg.)
 *   - TikTok/Facebook/Twitter/LinkedIn → api/download.php + api/stream.php.
 *     CORRECTED: stream.php's yt-dlp format string is
 *     "best[vcodec!=none][acodec!=none]/best" — this ALWAYS returns one
 *     muxed file, never a separate audio-only stream. There is no
 *     audio_url to fetch here, same situation as Instagram. Audio is
 *     now extracted LOCALLY from the downloaded video buffer via
 *     ffmpeg, same pattern as handleInstagram — this was the actual
 *     bug: audio was never being extracted at all on this path.
 *     LinkedIn is now correctly routed HERE (not to a separate
 *     metadata-only endpoint) since download.php's _lecay_linkedin()
 *     already returns a real download_url via og:video scraping.
 *   - Snapchat   → api/snapchat.php  (dual-stream — public Spotlight links only)
 */

const axios = require('axios');

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_BASE = 'https://lecay.oxbot.name.ng/api';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const PLATFORM_PATTERNS = {
    youtube: /(youtube\.com|youtu\.be)/i,
    instagram: /instagram\.com/i,
    twostep: /(tiktok\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|linkedin\.com)/i, // LinkedIn added here, not a separate case
    threads: /threads\.(net|com)/i,
    snapchat: /snapchat\.com/i,
};

function detectPlatform(input) {
    for (const [platform, regex] of Object.entries(PLATFORM_PATTERNS)) {
        if (regex.test(input)) return platform;
    }
    return null;
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

async function downloadBuffer(url, minBytes = 5000, extraHeaders = {}) {
    const buf = await tryRequest(async () => {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 180000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            validateStatus: s => s >= 200 && s < 400,
            headers: { ...HEADERS, ...extraHeaders },
        });
        return Buffer.from(res.data);
    });
    if (!buf || buf.length < minBytes) throw new Error(`Response too small (${buf?.length ?? 0} bytes) — likely not valid media`);
    return buf;
}

function sanitizeFilename(title) {
    return (title || 'video').replace(/[^\w\s\-()']/g, '').trim().slice(0, 60) || 'video';
}

// ─── Shared: extract audio locally from a video buffer we already
//     have, for endpoints that never produce a separate audio_url
//     (instagram.php, stream.php). Non-fatal on failure — video was
//     already sent by the caller before this runs. ───
async function sendExtractedAudio(sock, chatId, videoBuf, filenameBase, sourceTag) {
    try {
        const { toAudio } = require('../lib/converter'); // same converter soundcloud.js uses
        const audioBuf = await toAudio(videoBuf, 'ignore');
        await sock.sendMessage(chatId, {
            audio: audioBuf,
            mimetype: 'audio/mpeg',
            fileName: `${sanitizeFilename(filenameBase)}.mp3`,
        });
    } catch (err) {
        console.log(`[video1] ${sourceTag} local audio extraction failed, video already sent — ${err.message}`);
        // Non-fatal — video already delivered
    }
}

// ─── Shared handler for dual-stream endpoints (video_url + audio_url JSON) ───
async function handleDualStream(sock, msg, chatId, endpoint, params, emojiTag) {
    const { data } = await tryRequest(() =>
        axios.get(`${OXBOT_BASE}/${endpoint}`, { params, timeout: 60000 })
    );
    if (!data.ok) throw new Error(data.error || 'Could not fetch that media');

    const title = data.title || 'Video';
    const caption = `${emojiTag} *${title}*${data.uploader ? `\n👤 ${data.uploader}` : ''}\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;

    const videoBuf = await downloadBuffer(data.video_url, 10000);
    await sock.sendMessage(chatId, {
        video: videoBuf,
        mimetype: 'video/mp4',
        caption,
        fileName: `${sanitizeFilename(title)}.mp4`,
    }, { quoted: msg });

    if (data.audio_url) {
        try {
            const audioBuf = await downloadBuffer(data.audio_url, 5000);
            await sock.sendMessage(chatId, {
                audio: audioBuf,
                mimetype: 'audio/mpeg',
                fileName: `${sanitizeFilename(title)}.mp3`,
            });
        } catch (err) {
            console.log(`[video1] ${endpoint} audio stream failed, video already sent — ${err.message}`);
        }
    }
}

// ─── Instagram: instagram.php streams ONE raw file. Audio extracted
//     locally, since there's no separate audio_url server-side. ───
async function handleInstagram(sock, msg, chatId, url) {
    const res = await tryRequest(() =>
        axios.get(`${OXBOT_BASE}/instagram.php`, {
            params: { api_key: OXBOT_API_KEY, url },
            responseType: 'arraybuffer',
            timeout: 120000,
        })
    );

    const contentType = res.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
        const err = JSON.parse(Buffer.from(res.data).toString());
        throw new Error(err.error || 'instagram.php returned an error');
    }

    const buf = Buffer.from(res.data);
    if (buf.length < 5000) throw new Error(`Response too small (${buf.length} bytes)`);

    const isVideo = contentType.includes('video');
    const caption = `📸 *Instagram Media*\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;

    if (!isVideo) {
        await sock.sendMessage(chatId, { image: buf, caption }, { quoted: msg });
        return;
    }

    await sock.sendMessage(chatId, { video: buf, mimetype: 'video/mp4', caption }, { quoted: msg });
    await sendExtractedAudio(sock, chatId, buf, 'instagram_audio', 'Instagram');
}

// ─── TikTok/Facebook/Twitter/LinkedIn: download.php + stream.php.
//     FIXED: stream.php always returns one muxed file — same as
//     Instagram, there's no separate audio_url, so audio is now
//     extracted locally from the video buffer we already downloaded
//     instead of being silently skipped. ───
async function handleTwoStep(sock, msg, chatId, url) {
    const { data } = await tryRequest(() =>
        axios.get(`${OXBOT_BASE}/download.php`, { params: { api_key: OXBOT_API_KEY, url }, timeout: 30000 })
    );
    if (!data.ok) throw new Error(data.error || 'Could not fetch that video');

    // download.php can also return type: image/carousel (TikTok photo
    // posts, IG-style carousels via LinkedIn/Facebook fallback paths) —
    // handle those without going through stream.php, since stream.php
    // is video-only.
    if (data.type === 'image' || data.type === 'carousel') {
        const images = data.images || [data.download_url];
        for (let i = 0; i < images.length; i++) {
            const buf = await downloadBuffer(images[i], 1000);
            await sock.sendMessage(chatId, {
                image: buf,
                caption: i === 0 ? `📷 *${data.title || 'Media'}*\n📱 ${data.platform}\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_` : `_${i + 1} of ${images.length}_`,
            }, { quoted: i === 0 ? msg : undefined });
            await new Promise(r => setTimeout(r, 500));
        }
        return;
    }

    const videoRes = await tryRequest(() =>
        axios.get(`${OXBOT_BASE}/stream.php`, {
            params: { api_key: OXBOT_API_KEY, video_url: url, filename: sanitizeFilename(data.title) },
            responseType: 'arraybuffer',
            timeout: 180000,
        })
    );

    const contentType = videoRes.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
        const err = JSON.parse(Buffer.from(videoRes.data).toString());
        throw new Error(err.error || 'stream.php returned an error');
    }

    const videoBuf = Buffer.from(videoRes.data);
    if (videoBuf.length < 10000) throw new Error(`Downloaded file too small (${videoBuf.length} bytes)`);

    await sock.sendMessage(chatId, {
        video: videoBuf,
        caption: `🎬 *${data.title || 'Video'}*\n📱 ${data.platform}\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`,
        mimetype: 'video/mp4',
    }, { quoted: msg });

    // THIS is the actual fix — audio was never being sent on this
    // path before, because stream.php never returns a separate stream.
    await sendExtractedAudio(sock, chatId, videoBuf, data.title || `${data.platform}_audio`, data.platform);
}

// ─── Threads: carousel/image/video, video routes through dual-stream shape ───
async function handleThreads(sock, msg, chatId, url) {
    const { data } = await tryRequest(() =>
        axios.get(`${OXBOT_BASE}/threads.php`, { params: { api_key: OXBOT_API_KEY, url }, timeout: 45000 })
    );
    if (!data.ok) throw new Error(data.error || 'Could not fetch that post');

    const title = data.title || 'Threads Media';
    const caption = `🧵 *${title}*${data.uploader ? `\n_${data.uploader}_` : ''}\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;

    if (data.type === 'carousel') {
        for (let i = 0; i < data.images.length; i++) {
            const buf = await downloadBuffer(data.images[i], 1000, { Referer: 'https://www.threads.net/' });
            await sock.sendMessage(chatId, {
                image: buf,
                caption: i === 0 ? caption : `_${i + 1} of ${data.images.length}_`,
            }, { quoted: i === 0 ? msg : undefined });
            await new Promise(r => setTimeout(r, 500));
        }
        return;
    }

    if (data.type === 'image') {
        const buf = await downloadBuffer(data.video_url, 1000, { Referer: 'https://www.threads.net/' });
        await sock.sendMessage(chatId, { image: buf, caption }, { quoted: msg });
        return;
    }

    const videoBuf = await downloadBuffer(data.video_url, 10000, { Referer: 'https://www.threads.net/' });
    await sock.sendMessage(chatId, {
        video: videoBuf,
        mimetype: 'video/mp4',
        caption,
        fileName: `${sanitizeFilename(title)}.mp4`,
    }, { quoted: msg });

    if (data.audio_url) {
        try {
            const audioBuf = await downloadBuffer(data.audio_url, 5000, { Referer: 'https://www.threads.net/' });
            await sock.sendMessage(chatId, {
                audio: audioBuf,
                mimetype: 'audio/mpeg',
                fileName: `${sanitizeFilename(title)}.mp3`,
            });
        } catch (err) {
            console.log(`[video1] Threads audio stream failed, video already sent — ${err.message}`);
        }
    }
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `*🎬 VIDEO DOWNLOADER*\n\n*.vid1 <name/link>* — Download video + audio\n\n_Supports: YouTube, Instagram, TikTok, Facebook, Twitter/X, LinkedIn, Threads, Snapchat_\n\n_Snapchat: public Spotlight links only._\n\n*Aliases:* .videodl`;
    }

    const input = args.join(' ').trim();
    const platform = detectPlatform(input);

    if (!platform && /^https?:\/\//i.test(input)) {
        return `❌ *Unsupported link.* Currently working: YouTube, Instagram, TikTok, Facebook, Twitter/X, LinkedIn, Threads, Snapchat.`;
    }

    const effectivePlatform = platform || 'youtube';

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '⬇️', key: msg.key } }); } catch {}

    try {
        if (effectivePlatform === 'youtube') {
            await handleDualStream(sock, msg, chatId, 'video1.php', { api_key: OXBOT_API_KEY, q: input }, '🎬');
        } else if (effectivePlatform === 'instagram') {
            await handleInstagram(sock, msg, chatId, input);
        } else if (effectivePlatform === 'twostep') {
            await handleTwoStep(sock, msg, chatId, input);
        } else if (effectivePlatform === 'threads') {
            await handleThreads(sock, msg, chatId, input);
        } else if (effectivePlatform === 'snapchat') {
            await handleDualStream(sock, msg, chatId, 'snapchat.php', { api_key: OXBOT_API_KEY, url: input }, '👻');
        }

        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;
    } catch (err) {
        console.log(`[video1] Error (${effectivePlatform}) — ${err.message}`);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to download*\n\n_${err.message}_`;
    }
}

module.exports = {
    name: 'video1',
    aliases: ['vid1', 'videodl'],
    desc: 'Download video + audio from YouTube, Instagram, TikTok, Facebook, Twitter/X, LinkedIn, Threads, Snapchat',
    category: 'downloader',
    execute,
};
