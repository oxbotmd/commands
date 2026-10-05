/**
 * commands/tgsticker.js — Telegram Sticker Downloader
 * Aliases: .tgsticker, .tgs
 *
 * Single stickers (t.me/channel/123): reliable.
 * Packs (t.me/addstickers/name): best-effort, may miss items — see
 * api/tgsticker.php comments for why full-pack listing isn't guaranteed
 * without a Telegram bot token.
 *
 * .tgs animated stickers are gzipped Lottie JSON, not a media format
 * WhatsApp can render — sent as a document instead of a sticker so
 * they're not silently dropped.
 */

const axios = require('axios');

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/tgsticker.php';

const TELEGRAM_REGEX = /https?:\/\/(www\.)?(t\.me|telegram\.me)\//i;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function isValidTelegramUrl(url) {
    return TELEGRAM_REGEX.test(url);
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

async function fetchStickerInfo(url) {
    const res = await tryRequest(() =>
        axios.get(OXBOT_API_URL, { params: { api_key: OXBOT_API_KEY, url }, timeout: 30000 })
    );
    const data = res.data;
    if (!data.ok) throw new Error(data.error || 'API error');
    return data;
}

async function downloadBuffer(fileUrl, minBytes = 500) {
    const buf = await tryRequest(async () => {
        const res = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 60000,
            maxContentLength: 50 * 1024 * 1024,
            validateStatus: s => s >= 200 && s < 400,
            headers: { 'User-Agent': HEADERS['User-Agent'], 'Referer': 'https://t.me/' },
        });
        return Buffer.from(res.data);
    });
    if (!buf || buf.length < minBytes) throw new Error(`Response too small (${buf?.length ?? 0} bytes)`);
    return buf;
}

async function sendSticker(sock, chatId, msg, sticker, quoted) {
    const buf = await downloadBuffer(sticker.download_url);

    if (sticker.sticker_type === 'animated' && sticker.download_url.toLowerCase().endsWith('.tgs')) {
        // .tgs can't be rendered as a WhatsApp sticker directly — send as
        // a document so it's still delivered rather than silently dropped.
        await sock.sendMessage(chatId, {
            document: buf,
            mimetype: 'application/gzip',
            fileName: 'sticker.tgs',
        }, { quoted: quoted ? msg : undefined });
        return;
    }

    await sock.sendMessage(chatId, { sticker: buf }, { quoted: quoted ? msg : undefined });
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `*🎟️ TELEGRAM STICKER GRABBER*\n\n*.tgsticker <link>* — Download a sticker from a message link\n\n_Full pack links (t.me/addstickers/...) are best-effort and may miss some stickers._\n\n*Aliases:* .tgs`;
    }

    const url = args[0].trim();
    if (!isValidTelegramUrl(url)) return `❌ *Invalid Telegram link*`;

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '⬇️', key: msg.key } }); } catch {}

    let result;
    try {
        result = await fetchStickerInfo(url);
    } catch (err) {
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to get sticker*\n\n_${err.message}_`;
    }

    try {
        if (result.type === 'pack') {
            let sent = 0, failed = 0;
            for (let i = 0; i < result.stickers.length; i++) {
                try {
                    await sendSticker(sock, chatId, msg, result.stickers[i], i === 0);
                    sent++;
                    await new Promise(r => setTimeout(r, 500));
                } catch (e) {
                    failed++;
                }
            }
            try { await sock.sendMessage(chatId, { react: { text: sent > 0 ? '✅' : '❌', key: msg.key } }); } catch {}
            if (sent === 0) return `❌ *Failed to download any stickers from this pack*`;
            return `⚠️ Sent ${sent}/${result.stickers.length} stickers (pack scraping is best-effort — some may be missing).${failed > 0 ? ` ${failed} failed.` : ''}`;
        }

        await sendSticker(sock, chatId, msg, result, true);
        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;
    } catch (err) {
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to download sticker*\n\n_${err.message}_`;
    }
}

module.exports = {
    name: 'tgsticker',
    aliases: ['tgs'],
    desc: 'Download a Telegram sticker (single link reliable; packs best-effort)',
    category: 'downloader',
    execute,
};
