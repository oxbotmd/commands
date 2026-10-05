/**
 * spotify.js — Spotify Downloader (Normal JSON Way)
 */

const axios = require('axios');

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/spotify.php';

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    // Get input from args or quoted message
    let input = args.join(' ').trim();
    if (!input && msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        const quoted = msg.message.extendedTextMessage.contextInfo.quotedMessage;
        input = quoted.conversation || quoted.extendedTextMessage?.text || '';
    }

    if (!input) {
        return `❌ *Provide a Spotify link or song name!*

_Usage: .spotify <url or name>_

_Example: .spotify https://open.spotify.com/track/xyz_
_Example: .spotify Con Calma Daddy Yankee_`;
    }

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '🎵', key: msg.key } }); } catch {}
    
    await sock.sendMessage(chatId, { 
        text: `🔍 *Searching...*\n_Downloading audio, please wait..._` 
    }, { quoted: msg });

    try {
        // ═══════════════════════════════════════════════════
        // DETERMINE PARAMS (url vs q)
        // ═══════════════════════════════════════════════════
        const isUrl = input.startsWith('http://') || input.startsWith('https://');
        const params = { 
            api_key: OXBOT_API_KEY,
            [isUrl ? 'url' : 'q']: input 
        };

        // ═══════════════════════════════════════════════════
        // FETCH JSON (Normal Way)
        // ═══════════════════════════════════════════════════
        const { data } = await axios.get(OXBOT_API_URL, {
            params: params,
            timeout: 120000,
        });

        if (!data.ok) {
            throw new Error(data.error || 'API returned an error');
        }

        // ═══════════════════════════════════════════════════
        // FORMAT & SEND
        // ═══════════════════════════════════════════════════
        const mins = Math.floor((data.duration || 0) / 60);
        const secs = String((data.duration || 0) % 60).padStart(2, '0');
        
        const caption = `🎵 *${data.title}*\n` +
                        `👤 *Artist:* ${data.artist}\n` +
                        `💿 *Album:* ${data.album || 'Unknown'}\n` +
                        `⏱ *Duration:* ${mins}:${secs}\n\n` +
                        `_𝗙𝗘𝗧𝗖𝗛𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;

        try { await sock.sendPresenceUpdate('composing', chatId); } catch {}

        // 1. Send Image + Info
        if (data.thumbnail) {
            await sock.sendMessage(chatId, {
                image: { url: data.thumbnail },
                caption: caption,
            }, { quoted: msg });
        } else {
            await sock.sendMessage(chatId, { text: caption }, { quoted: msg });
        }

        // 2. Send Audio from download_url
        await sock.sendMessage(chatId, {
            audio: { url: data.download_url },
            mimetype: 'audio/mpeg',
            fileName: `${data.title.replace(/[\\/:*?"<>|]/g, '')}.mp3`
        }, { quoted: msg });

        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;

    } catch (err) {
        console.error('[Spotify] Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to download song*\n\n_${err.message}_`;
    }
}

module.exports = {
    name:     'spotify',
    aliases:  ['sp', 'spdl'],
    desc:     'Download songs from Spotify link or song name',
    category: 'downloader',
    execute,
};
