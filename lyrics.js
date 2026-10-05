/**
 * lyrics.js — Song Lyrics Finder
 * Aliases: .lyrics, .lyric, .lirik
 * Uses the centralized Lecay API
 */

const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/lyrics.php';

// ═══════════════════════════════════════════════════
// HELPER: Split long text into WhatsApp-safe chunks
// ═══════════════════════════════════════════════════
function splitLyrics(text, maxLen = 4000) {
    if (text.length <= maxLen) return [text];
    
    const chunks = [];
    let start = 0;
    
    while (start < text.length) {
        let end = start + maxLen;
        
        if (end >= text.length) {
            chunks.push(text.substring(start));
            break;
        }
        
        // Find a newline to split at so we don't cut words in half
        let lastNewline = text.lastIndexOf('\n', end);
        if (lastNewline > start) {
            end = lastNewline;
        }
        
        chunks.push(text.substring(start, end).trim());
        start = end + 1;
    }
    
    return chunks.filter(c => c.length > 0);
}

// ═══════════════════════════════════════════════════
// MAIN EXECUTE
// ═══════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `❌ *Please provide a song name!*

_Usage: .lyrics <song name>_

_Example: .lyrics Despacito_`;
    }

    const query = args.join(' ').trim();

    // Working indicator
    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '🎵', key: msg.key } }); } catch {}

    // ── Fetch from Lecay API ────────────────────────────────────────────
    let result;
    try {
        const { data } = await axios.get(OXBOT_API_URL, {
            params: { 
                api_key: OXBOT_API_KEY, 
                q: query 
            },
            timeout: 15000,
        });

        if (!data.ok) {
            throw new Error(data.error || 'API returned an error');
        }

        result = data;
    } catch (err) {
        console.error('[Lyrics] API Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to find lyrics*\n\n_${err.message}_`;
    }

    // ── Prepare Header & Footer ──────────────────────────────────────────
    const header = `🎵 *${result.title}*${result.artist ? `\n👤 *Artist:* ${result.artist}` : ''}\n\n`;
    const footer = `\n\n_𝗙𝗘𝗧𝗖𝗛𝗘𝗗 𝗕𝗬 𝗢𝗫 𝗕𝗢𝗧_`;

    // Split the lyrics into chunks if they are too long for WhatsApp
    const lyricsChunks = splitLyrics(result.lyrics, 4000);

    // ── Send Messages ────────────────────────────────────────────────────
    try {
        for (let i = 0; i < lyricsChunks.length; i++) {
            // Keep "typing..." status active while sending long songs
            try { await sock.sendPresenceUpdate('composing', chatId); } catch {}

            let textToSend = '';

            if (i === 0) {
                // First message gets the header
                textToSend = header + lyricsChunks[i];
                
                // If it's the ONLY message, add the footer here
                if (lyricsChunks.length === 1) {
                    textToSend += footer;
                }

                await sock.sendMessage(chatId, {
                    text: textToSend,
                }, { quoted: msg });

            } else if (i === lyricsChunks.length - 1) {
                // Last message gets the footer
                textToSend = `_Part ${i + 1}/${lyricsChunks.length}_\n\n` + lyricsChunks[i] + footer;
                
                await sock.sendMessage(chatId, {
                    text: textToSend,
                }, { quoted: msg });

            } else {
                // Middle messages get a part counter
                textToSend = `_Part ${i + 1}/${lyricsChunks.length}_\n\n` + lyricsChunks[i];
                
                await sock.sendMessage(chatId, {
                    text: textToSend,
                }, { quoted: msg });
            }
        }

        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;

    } catch (err) {
        console.error('[Lyrics] Send error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to send lyrics*\n\n_${err.message}_`;
    }
}

module.exports = {
    name:     'lyrics',
    aliases:  ['lyric', 'lirik'],
    desc:     'Get lyrics of any song',
    category: 'general',
    execute,
};
