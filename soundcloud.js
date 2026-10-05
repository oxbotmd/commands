/**
 * commands/soundcloud.js — SoundCloud Track Downloader + Search
 * Aliases: .sc, .scdown, .soundcloud
 *
 * Subcommands:
 *   .sc <link>            — download a track (or public set)
 *   .sc search <query>     — search SoundCloud, returns a numbered list
 *   .sc pick <number>      — download the Nth result from the last search
 *
 * Same pattern as song.js: retry wrapper, buffer validation (catches
 * error pages returned with a 200 status), and ffmpeg conversion via
 * lib/converter before sending.
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

const { toAudio } = require('../lib/converter');

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/soundcloud.php';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
};

const SOUNDCLOUD_REGEX = /https?:\/\/(www\.)?(soundcloud\.com|snd\.sc)\//i;

// chatId -> { results, expires }. Search results live for 2 minutes,
// long enough to read a list and reply with a pick.
const searchCache = new Map();
const SEARCH_TTL_MS = 120000;

function isValidSoundCloudUrl(url) {
    return SOUNDCLOUD_REGEX.test(url);
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

// ─── Get track info from our own soundcloud.php endpoint ───
async function fetchTrackInfo(url) {
    const res = await tryRequest(() =>
        axios.get(OXBOT_API_URL, { params: { api_key: OXBOT_API_KEY, url }, timeout: 45000 })
    );
    const data = res.data;
    if (!data.ok) throw new Error(data.error || 'API error');
    return data;
}

// ─── Search SoundCloud via the same endpoint, mode=search ───
async function fetchSearchResults(query, limit = 5) {
    const res = await tryRequest(() =>
        axios.get(OXBOT_API_URL, { params: { api_key: OXBOT_API_KEY, mode: 'search', q: query, limit }, timeout: 45000 })
    );
    const data = res.data;
    if (!data.ok) throw new Error(data.error || 'Search failed');
    return data.results;
}

// ─── Download the audio buffer, retrying, then check it's actually audio ───
async function downloadBuffer(audioUrl) {
    const fetchOnce = () => tryRequest(async () => {
        const res = await axios.get(audioUrl, {
            responseType: 'arraybuffer',
            timeout: 90000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            validateStatus: s => s >= 200 && s < 400,
            headers: {
                'User-Agent': HEADERS['User-Agent'],
                'Accept': '*/*',
                'Accept-Encoding': 'identity',
                'Referer': 'https://soundcloud.com/',
            },
        });
        return Buffer.from(res.data);
    });

    const buf = await fetchOnce();
    if (!buf || buf.length === 0) throw new Error('Empty buffer');

    // Catch a 200-status error page (HTML or JSON) masquerading as audio.
    const headStr = buf.toString('utf8', 0, Math.min(200, buf.length));
    if (headStr.includes('<!DOCTYPE') || headStr.includes('<html') ||
        (headStr.trim().startsWith('{') && headStr.includes('"error"'))) {
        throw new Error('Server returned an error page instead of audio');
    }

    return buf;
}

function cleanupTemp() {
    try {
        const tmpDir = os.tmpdir();
        if (!fs.existsSync(tmpDir)) return;
        const now = Date.now();
        for (const file of fs.readdirSync(tmpDir)) {
            if (!file.startsWith('oxbot_')) continue;
            try {
                const fp = path.join(tmpDir, file);
                const stats = fs.statSync(fp);
                if (now - stats.mtimeMs > 15000) fs.unlinkSync(fp);
            } catch {}
        }
    } catch {}
}

function cleanupSearchCache() {
    const now = Date.now();
    for (const [chatId, entry] of searchCache) {
        if (now > entry.expires) searchCache.delete(chatId);
    }
}

function formatDuration(seconds) {
    if (!seconds) return null;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function formatResultsList(results) {
    return results.map((r, i) => {
        const dur = formatDuration(r.duration_seconds);
        const parts = [`*${i + 1}.* ${r.title}`];
        if (r.uploader) parts.push(`— _${r.uploader}_`);
        if (dur) parts.push(`(${dur})`);
        return parts.join(' ');
    }).join('\n');
}

// ─── Download, convert, and send a single track ───
async function sendTrack(sock, chatId, msg, track, quoted) {
    const rawBuffer = await downloadBuffer(track.download_url);

    let finalBuffer;
    try {
        finalBuffer = await toAudio(rawBuffer, 'ignore');
    } catch (err) {
        throw new Error(`Conversion failed: ${err.message}`);
    }

    const title = (track.title || 'SoundCloud_Track').replace(/[^\w\s\-()']/g, '').trim();

    await sock.sendMessage(chatId, {
        audio: finalBuffer,
        mimetype: 'audio/mpeg',
        fileName: `${title}.mp3`,
        ptt: false,
    }, { quoted: quoted ? msg : undefined });

    return title;
}

// ─── Resolve a track URL, download it, and reply — shared by direct
//     links and search-picked links so behavior stays identical ───
async function downloadAndSendUrl(sock, msg, chatId, url) {
    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '⬇️', key: msg.key } }); } catch {}

    let result;
    try {
        result = await fetchTrackInfo(url);
    } catch (err) {
        console.log(`[sc] Info fetch failed — ${err.message}`);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to get track info*\n\n*${err.message}*`;
    }

    // ── Playlist / set: send each track ──
    if (result.type === 'playlist' && Array.isArray(result.tracks)) {
        let successCount = 0, failCount = 0;

        for (let i = 0; i < result.tracks.length; i++) {
            try {
                console.log(`[sc] Downloading track ${i + 1}/${result.tracks.length}...`);
                await sendTrack(sock, chatId, msg, result.tracks[i], i === 0);
                successCount++;
                await new Promise(r => setTimeout(r, 800));
            } catch (e) {
                console.log(`[sc] Track ${i + 1} ❌ — ${e.message}`);
                failCount++;
            }
        }

        cleanupTemp();

        if (successCount > 0) {
            try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
            if (failCount > 0) return `⚠️ Sent ${successCount}/${result.tracks.length} tracks. ${failCount} failed.`;
            return null;
        }
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to download any tracks from this set*`;
    }

    // ── Single track ──
    const duration = formatDuration(result.duration_seconds);

    try {
        console.log(`[sc] Downloading: ${result.title}`);
        const title = await sendTrack(sock, chatId, msg, result, true);

        await sock.sendMessage(chatId, {
            text: `🎧 *${title}*${duration ? `\n⏱ ${duration}` : ''}\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`,
        });

        console.log(`[sc] ✅ Sent successfully: ${title}`);
        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        cleanupTemp();
        return null;
    } catch (err) {
        console.log(`[sc] Error — ${err.message}`);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to download track*\n\n_${err.message}_`;
    }
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    cleanupSearchCache();

    if (!args || args.length === 0) {
        return `*🎧 SOUNDCLOUD DOWNLOADER*\n\n` +
            `*.sc <link>* — Download a track (or all tracks in a public set)\n` +
            `*.sc search <query>* — Search SoundCloud for tracks\n` +
            `*.sc pick <number>* — Download a result from your last search\n\n` +
            `*Aliases:* .scdown  .soundcloud`;
    }

    const sub = args[0].trim().toLowerCase();

    // ── .sc search <query> ──
    if (sub === 'search') {
        const query = args.slice(1).join(' ').trim();
        if (!query) return `❌ *Usage:* .sc search <song name>`;

        try { await sock.sendPresenceUpdate('composing', chatId); } catch {}

        let results;
        try {
            results = await fetchSearchResults(query, 5);
        } catch (err) {
            console.log(`[sc] Search failed — ${err.message}`);
            return `❌ *Search failed*\n\n_${err.message}_`;
        }

        searchCache.set(chatId, { results, expires: Date.now() + SEARCH_TTL_MS });

        return `*🔍 SOUNDCLOUD RESULTS*\n\n${formatResultsList(results)}\n\n_Reply *.sc pick <number>* within 2 minutes to download_`;
    }

    // ── .sc pick <number> ──
    if (sub === 'pick') {
        const cached = searchCache.get(chatId);
        if (!cached || Date.now() > cached.expires) {
            searchCache.delete(chatId);
            return `❌ *No active search.* Run *.sc search <query>* first.`;
        }

        const idx = parseInt(args[1], 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= cached.results.length) {
            return `❌ *Invalid pick.* Choose a number between 1 and ${cached.results.length}.`;
        }

        const picked = cached.results[idx];
        searchCache.delete(chatId); // one-shot: picking clears the cache

        if (!picked.permalink_url) {
            return `❌ *That result has no downloadable link.* Try another pick or a fresh search.`;
        }

        return await downloadAndSendUrl(sock, msg, chatId, picked.permalink_url);
    }

    // ── .sc <link> ──
    const url = args[0].trim();
    if (!isValidSoundCloudUrl(url)) {
        return `❌ *Invalid SoundCloud link*\n\n_Tip: use *.sc search <query>* if you don't have a link_`;
    }

    return await downloadAndSendUrl(sock, msg, chatId, url);
}

module.exports = {
    name: 'soundcloud',
    aliases: ['sc', 'scdown'],
    desc: 'Download a SoundCloud track or public set, or search by name',
    category: 'downloader',
    execute,
};
