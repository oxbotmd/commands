/**
 * commands/shorten.js — URL Shortener
 * Aliases: .short, .tiny
 *
 * Uses TinyURL's public API — free, no API key required. Falls back
 * to is.gd if TinyURL fails, since both are free/keyless and it costs
 * nothing to try a second provider before giving up.
 */

const axios = require('axios');

const URL_REGEX = /^https?:\/\/.+/i;

function isValidUrl(str) {
    if (!URL_REGEX.test(str)) return false;
    try { new URL(str); return true; } catch { return false; }
}

async function shortenViaTinyUrl(longUrl) {
    const res = await axios.get('https://tinyurl.com/api-create.php', {
        params: { url: longUrl },
        timeout: 15000,
        responseType: 'text',
    });
    const result = (res.data || '').trim();
    if (!result.startsWith('http')) throw new Error('TinyURL returned an unexpected response');
    return result;
}

async function shortenViaIsGd(longUrl) {
    const res = await axios.get('https://is.gd/create.php', {
        params: { format: 'simple', url: longUrl },
        timeout: 15000,
        responseType: 'text',
    });
    const result = (res.data || '').trim();
    if (!result.startsWith('http')) throw new Error(result || 'is.gd returned an unexpected response');
    return result;
}

async function shortenUrl(longUrl) {
    try {
        return await shortenViaTinyUrl(longUrl);
    } catch (err) {
        console.log(`[shorten] TinyURL failed — ${err.message}, trying is.gd`);
        return await shortenViaIsGd(longUrl);
    }
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `*🔗 URL SHORTENER*\n\n*.shorten <link>* — Shorten a long URL\n\n*Aliases:* .short  .tiny`;
    }

    const longUrl = args[0].trim();
    if (!isValidUrl(longUrl)) {
        return `❌ *Invalid URL*\n\n_Make sure it starts with http:// or https://_`;
    }

    try { await sock.sendMessage(chatId, { react: { text: '🔗', key: msg.key } }); } catch {}

    try {
        const shortUrl = await shortenUrl(longUrl);
        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return `🔗 *Shortened URL*\n\n${shortUrl}`;
    } catch (err) {
        console.log(`[shorten] Error — ${err.message}`);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to shorten URL*\n\n_${err.message}_`;
    }
}

module.exports = {
    name: 'shorten',
    aliases: ['short', 'tiny'],
    desc: 'Shorten a long URL',
    category: 'utility',
    execute,
};
