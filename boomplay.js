/**
 * commands/boomplay.js — Boomplay Track Info + Best-Effort Download
 * Aliases: .bp, .bpdown
 *
 * Boomplay stream URLs are frequently token-gated/expiring. If
 * download_url comes back null or the fetch fails, this command
 * still reports the track's title/artist/cover so the user isn't
 * left with a silent failure.
 */

const axios = require('axios');

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/boomplay.php';

const BOOMPLAY_REGEX = /https?:\/\/(www\.)?boomplay\.com\//i;

function isValidBoomplayUrl(url) {
    return BOOMPLAY_REGEX.test(url);
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

async function fetchTrackInfo(url) {
    const res = await tryRequest(() =>
        axios.get(OXBOT_API_URL, { params: { api_key: OXBOT_API_KEY, url }, timeout: 30000 })
    );
    const data = res.data;
    if (!data.ok) throw new Error(data.error || 'API error');
    return data;
}

async function downloadBuffer(fileUrl, minBytes = 10000) {
    const buf = await tryRequest(async () => {
        const res = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 60000,
            maxContentLength: Infinity,
            validateStatus: s => s >= 200 && s < 400,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.boomplay.com/',
            },
        });
        return Buffer.from(res.data);
    });
    if (!buf || buf.length < minBytes) throw new Error(`Response too small (${buf?.length ?? 0} bytes) — likely an expired or invalid stream token`);
    return buf;
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `*🎵 BOOMPLAY DOWNLOADER*\n\n*.boomplay <link>* — Fetch track info and audio (best-effort — Boomplay's streams are often token-gated)\n\n*Aliases:* .bp  .bpdown`;
    }

    const url = args[0].trim();
    if (!isValidBoomplayUrl(url)) return `❌ *Invalid Boomplay link*`;

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '⬇️', key: msg.key } }); } catch {}

    let result;
    try {
        result = await fetchTrackInfo(url);
    } catch (err) {
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to get track info*\n\n_${err.message}_`;
    }

    const caption = `🎵 *${result.title}*${result.artist ? `\n_${result.artist}_` : ''}\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;

    if (!result.stream_available || !result.download_url) {
        try { await sock.sendMessage(chatId, { react: { text: '⚠️', key: msg.key } }); } catch {}
        // No playable stream — still send what we have so the request
        // isn't a total dead end.
        if (result.cover) {
            await sock.sendMessage(chatId, { image: { url: result.cover }, caption }, { quoted: msg });
        } else {
            await sock.sendMessage(chatId, { text: caption }, { quoted: msg });
        }
        return `⚠️ *No downloadable audio stream found for this track* — Boomplay's stream links are often session-locked. Info was still sent above.`;
    }

    try {
        const buf = await downloadBuffer(result.download_url);
        await sock.sendMessage(chatId, {
            audio: buf,
            mimetype: 'audio/mpeg',
            fileName: `${result.title.replace(/[^\w\s\-()']/g, '').trim()}.mp3`,
        }, { quoted: msg });
        await sock.sendMessage(chatId, { text: caption });
        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;
    } catch (err) {
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Stream link expired or failed*\n\n_${err.message}_\n\n_Track: ${result.title}${result.artist ? ` — ${result.artist}` : ''}_`;
    }
}

module.exports = {
    name: 'boomplay',
    aliases: ['bp', 'bpdown'],
    desc: 'Fetch Boomplay track info and audio (best-effort, streams may be token-gated)',
    category: 'downloader',
    execute,
};