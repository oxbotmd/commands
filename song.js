/**
 * song.js — YouTube Audio Downloader (Knight API)
 * Aliases: .song, .play, .ytmp3, .music
 */

const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────

const KNIGHT_API_URL = 'https://knightbotapi.stream/api/download/ytaudio';
const KNIGHT_API_KEY = 'knight';
const FORMAT         = '128kbps';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const YT_URL_REGEX = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/i;

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

// If user typed a song NAME instead of a link, find a YouTube video ID
async function searchYouTube(query) {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
    const match = String(data).match(/"videoId":"([\w-]{11})"/);
    if (!match) throw new Error('No results found on YouTube');
    return 'https://youtu.be/' + match[1];
}

// Call Knight API → returns { downloadUrl, title, thumbnail }
async function fetchKnightAudio(ytUrl) {
    const { data } = await axios.get(KNIGHT_API_URL, {
        params: {
            apikey: KNIGHT_API_KEY,
            format: FORMAT,
            url: ytUrl,          // axios URL-encodes this automatically
        },
        timeout: 30000,
    });

    const download = data?.result?.download || data?.download || data?.url;
    if (!download) {
        throw new Error(data?.message || 'Knight API returned no download link');
    }

    return {
        downloadUrl: download,
        title:       data?.result?.title    || data?.title    || 'YouTube Audio',
        thumbnail:   data?.result?.thumb    || data?.result?.thumbnail || data?.thumb || null,
    };
}

async function downloadAudioBuffer(streamUrl) {
    console.log('[SONG] Downloading audio stream:', streamUrl.substring(0, 80) + '...');

    let response;
    try {
        response = await axios.get(streamUrl, {
            responseType: 'arraybuffer',
            timeout: 90000,
            maxContentLength: 100 * 1024 * 1024, // 100MB max
            headers: { ...HEADERS, Accept: '*/*' },
        });
    } catch (err) {
        throw new Error(`Audio download failed: ${err.code || err.message}`);
    }

    const buf = Buffer.from(response.data);
    if (buf.length < 5000) {
        throw new Error(`Audio too small (${buf.length} bytes), likely an error page`);
    }

    console.log(`[SONG] ✓ Audio downloaded: ${(buf.length / 1024).toFixed(1)} KB`);
    return buf;
}

// ═══════════════════════════════════════════════════════════════
// MAIN EXECUTE
// ═══════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `*🎵 SONG DOWNLOADER*\n\n*.song <name or link>* — Download YouTube audio as MP3\n\n*Aliases:* .play  .ytmp3  .music`;
    }

    const query = args.join(' ').trim();

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '⬇️', key: msg.key } }); } catch {}

    // 1. Resolve the query to a YouTube URL
    let ytUrl;
    try {
        if (YT_URL_REGEX.test(query)) {
            ytUrl = query;
            console.log('[SONG] Direct link provided');
        } else {
            ytUrl = await searchYouTube(query);
            console.log('[SONG] Search resolved to:', ytUrl);
        }
    } catch (err) {
        console.error('[SONG] Search Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Could not find that song*\n\n_${err.message}_`;
    }

    // 2. Ask Knight API for the audio download link
    let track;
    try {
        track = await fetchKnightAudio(ytUrl);
        console.log('[SONG] Knight resolved:', track.title?.substring(0, 40));
    } catch (err) {
        console.error('[SONG] Knight API Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Knight API failed*\n\n_${err.message}_`;
    }

    // 3. Show a preview while downloading
    try {
        const previewCaption = `🎵 *${track.title}*\n\n_📥 Fetching audio..._`;
        if (track.thumbnail) {
            await sock.sendMessage(chatId, { image: { url: track.thumbnail }, caption: previewCaption }, { quoted: msg });
        } else {
            await sock.sendMessage(chatId, { text: previewCaption }, { quoted: msg });
        }
    } catch {}

    // 4. Download the audio
    let rawBuf;
    try {
        rawBuf = await downloadAudioBuffer(track.downloadUrl);
    } catch (err) {
        console.error('[SONG] Download Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to download audio*\n\n_${err.message}_`;
    }

    // 5. Send it — Knight's 128kbps output is already MP3, no conversion needed
    const safeTitle = (track.title || 'song').replace(/[^\w\s\-()']/g, '').trim();

    try {
        await sock.sendMessage(chatId, {
            audio: rawBuf,
            mimetype: 'audio/mpeg',
            fileName: `${safeTitle}.mp3`,
            ptt: false,
        }, { quoted: msg });

        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        console.log(`[SONG] ✅ Sent successfully: ${safeTitle}`);
        return null;
    } catch (err) {
        console.error('[SONG] Send Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to send audio*\n\n_${err.message}_`;
    }
}

module.exports = {
    name:     'song',
    aliases:  ['play', 'ytmp3', 'music'],
    desc:     'Download song from YouTube as MP3 (Knight API)',
    category: 'downloader',
    execute,
};
