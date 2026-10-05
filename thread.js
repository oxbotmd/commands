/**
 * threads.js — Threads Video & Image Downloader
 * Aliases: .threads, .th, .thdown
 */

const axios = require('axios');

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/threads.php';

const THREADS_REGEX = /https?:\/\/(www\.)?threads\.(net|com)\//i;

function isValidThreadsUrl(url) {
    return THREADS_REGEX.test(url);
}

async function downloadImageBuffer(imageUrl) {
    const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        maxContentLength: 50 * 1024 * 1024,
        validateStatus: (status) => status < 500,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Referer': 'https://www.threads.net/',
        },
    });
    if (response.status >= 400) throw new Error(`Image server returned HTTP ${response.status}`);
    const buf = Buffer.from(response.data);
    if (buf.length < 1000) throw new Error(`Image too small (${buf.length} bytes), likely an error`);
    return buf;
}

async function downloadVideoBuffer(videoUrl) {
    const response = await axios.get(videoUrl, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: 150 * 1024 * 1024,
        validateStatus: (status) => status < 500,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Referer': 'https://www.threads.net/',
        },
    });
    if (response.status >= 400) throw new Error(`Video server returned HTTP ${response.status}`);
    const buf = Buffer.from(response.data);
    if (buf.length < 10000) throw new Error(`Response too small (${buf.length} bytes). Not a valid video.`);
    return buf;
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `*🧵 THREADS DOWNLOADER*\n\n*.threads <link>* — Download video or images\n\n*Aliases:* .th  .thdown`;
    }

    const url = args[0].trim();
    if (!isValidThreadsUrl(url)) {
        return `❌ *Invalid Threads link*`;
    }

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '⬇️', key: msg.key } }); } catch {}

    let result;
    try {
        result = await axios.get(OXBOT_API_URL, { params: { api_key: OXBOT_API_KEY, url }, timeout: 30000 });
        result = result.data;
        if (!result.ok) throw new Error(result.error || 'API error');
    } catch (err) {
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to get media info*\n\n*${err.message}*`;
    }

    const title = result.title || 'Threads Media';
    const type = result.type || 'video';

    if (type === 'image' || type === 'carousel') {
        const images = result.images || [result.download_url];
        let successCount = 0, failCount = 0;

        for (let i = 0; i < images.length; i++) {
            try {
                const imgBuf = await downloadImageBuffer(images[i]);
                const caption = images.length > 1
                    ? `🧵 *${title}*\n\n_𝗜𝗠𝗔𝗚𝗘 ${i + 1} 𝗢𝗙 ${images.length}_\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`
                    : `🧵 *${title}*\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;
                await sock.sendMessage(chatId, { image: imgBuf, caption }, { quoted: i === 0 ? msg : undefined });
                successCount++;
                if (i < images.length - 1) await new Promise(r => setTimeout(r, 500));
            } catch (e) {
                failCount++;
            }
        }

        if (successCount > 0) {
            try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
            if (failCount > 0) return `⚠️ Downloaded ${successCount}/${images.length} images. ${failCount} failed.`;
            return null;
        }
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to download images*`;
    }

    const caption = `🧵 *${title}*\n\n_𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;
    try {
        const buf = await downloadVideoBuffer(result.download_url);
        await sock.sendMessage(chatId, { video: buf, mimetype: 'video/mp4', caption }, { quoted: msg });
        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;
    } catch (err) {
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to download video*\n\n_${err.message}_`;
    }
}

module.exports = {
    name: 'threads',
    aliases: ['th', 'thdown'],
    desc: 'Download Threads video or images',
    category: 'downloader',
    execute,
};

