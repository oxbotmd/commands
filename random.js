/**
 * commands/random.js
 * Fetches a random anime via OxBot's own random.php proxy (not the
 * raw Jikan/waifu.pics APIs directly — same pattern as tiktok.js).
 */

const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_RANDOM_URL = 'https://lecay.oxbot.name.ng/api/random.php';

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    await sock.sendMessage(chatId, { text: '🔍 *Fetching random anime...*' }, { quoted: msg });

    // ═══════════════════════════════════════════════════
    // GET ANIME INFO FROM OXBOT'S OWN PROXY
    // ═══════════════════════════════════════════════════
    let anime;
    try {
        const res = await axios.get(OXBOT_RANDOM_URL, {
            params: { api_key: OXBOT_API_KEY },
            timeout: 20000,
        });

        const result = res.data;
        if (!result.ok) throw new Error(result.error || 'API error');

        anime = {
            title: result.title || 'Unknown Anime',
            image: result.image,
            synopsis: result.synopsis || '',
            episodes: result.episodes ?? '?',
            score: result.score ?? '?',
            status: result.status ?? '?',
            url: result.url || ''
        };

        console.log(`[RANDOM ANIME] ✅ Success via ${result.source || 'proxy'}`);
    } catch (err) {
        console.log(`[RANDOM ANIME] ❌ Proxy failed: ${err.message}`);
        return await sock.sendMessage(chatId, {
            text: '❌ *Failed to fetch anime.*\n_All anime servers are busy. Try again in a few seconds._'
        }, { quoted: msg });
    }

    if (!anime.image) {
        return await sock.sendMessage(chatId, {
            text: '❌ *Failed to fetch anime.*\n_No image returned. Try again._'
        }, { quoted: msg });
    }

    try {
        // Download the image into memory (No saving to disk!)
        const imgRes = await axios.get(anime.image, {
            responseType: 'arraybuffer',
            timeout: 20000,
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Referer': 'https://myanimelist.net/'
            }
        });
        const imageBuffer = Buffer.from(imgRes.data);

        // Check if image is too large for WhatsApp (max 10MB)
        if (imageBuffer.length > 10 * 1024 * 1024) {
            return await sock.sendMessage(chatId, {
                text: `*${anime.title}*\n\n⚠️ _Image was too large to send._\n\n📺 Episodes: ${anime.episodes}\n⭐ Score: ${anime.score}\n📊 Status: ${anime.status}${anime.url ? `\n\n🔗 ${anime.url}` : ''}`
            }, { quoted: msg });
        }

        // Build clean caption
        let caption = `🌟 *${anime.title}*\n\n`;
        if (anime.episodes !== '∞') caption += `📺 *Episodes:* ${anime.episodes}\n`;
        if (anime.score !== '∞') caption += `⭐ *Score:* ${anime.score}/10\n`;
        if (anime.status !== '∞') caption += `📊 *Status:* ${anime.status}\n`;

        if (anime.synopsis && anime.synopsis.length > 0) {
            // Truncate long summaries so WhatsApp doesn't cut off the message
            const shortSynopsis = anime.synopsis.length > 200
                ? anime.synopsis.substring(0, 200) + '...'
                : anime.synopsis;
            caption += `\n\n📝 *Synopsis:*\n${shortSynopsis}`;
        }

        if (anime.url) {
            caption += `\n\n🔗 *MyAnimeList:* ${anime.url}`;
        }

        caption += `\n\n_OxBot ©_`;

        // Send image directly from memory
        await sock.sendMessage(chatId, {
            image: imageBuffer,
            caption
        }, { quoted: msg });

    } catch (err) {
        console.error('[RANDOM ANIME] Image download failed:', err.message);

        // Fallback to text only if image fails
        await sock.sendMessage(chatId, {
            text: `🌟 *${anime.title}*\n\n⚠️ _Failed to download image._\n\n📺 *Episodes:* ${anime.episodes}\n⭐ *Score:* ${anime.score}\n📊 *Status:* ${anime.status}\n\n🔗 *Link:* ${anime.url || 'N/A'}\n\n_OxBot ©_`
        }, { quoted: msg });
    }

    return null;
}

module.exports = {
    name: 'random',
    aliases: ['animerandom', 'randomanime', 'anime'],
    desc: 'Get a random anime recommendation',
    category: 'anime',
    execute
};
