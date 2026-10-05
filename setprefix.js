/**
 * commands/setprefix.js
 * Change bot command prefix (Owner Only)
 *
 * FIXED: this was writing to bot_settings.custom_prefix, but the prefix
 * gate in index.js (getPrefixes) reads from bot_settings.prefix — a
 * completely different column. The change was saving fine, just to a
 * column nothing ever read, so it silently never took effect.
 *
 * FIXED: even with the column corrected, getPrefixes() caches per
 * session for 60s with no way to invalidate it from here. Now saves
 * via botData.savePrefixToDb() (writes the right column) and immediately
 * calls botData.clearPrefixCache() so the new prefix works on your very
 * next message instead of up to a minute later.
 *
 * FIXED: sock._customPrefix was only ever set by this command and never
 * read by the prefix gate, and it doesn't survive a bot restart (it's
 * in-memory only) — so "current prefix" display could lie after a
 * restart. Current prefix is now read from the DB via
 * botData.getPrefixes(), the same source of truth the gate uses.
 */

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    try {
        if (!args[0]) {
            const currentPrefixes = await botData.getPrefixes(sock);
            return await sock.sendMessage(chatId, {
                text: `📌 *Current Prefix:* ${currentPrefixes.join(' | ')}\n\n_Usage: .setprefix <new prefix>_`
            }, { quoted: msg });
        }

        const newPrefix = args[0];

        // Limit prefix length to prevent weird behavior
        if (newPrefix.length > 3) {
            return await sock.sendMessage(chatId, {
                text: '❌ *Invalid Prefix!*\n_Prefix must be 1 to 3 characters long._'
            }, { quoted: msg });
        }

        // ── Save to Database (correct column, UPDATE-first pattern) ────────
        const db        = botData?.db;
        const sessionId = botData?.sessionId;

        if (!db || !sessionId) {
            return await sock.sendMessage(chatId, {
                text: '❌ Could not resolve this bot\'s session — prefix not saved.'
            }, { quoted: msg });
        }

        const saved = await botData.savePrefixToDb(db, sessionId, newPrefix);
        if (!saved) {
            return await sock.sendMessage(chatId, {
                text: '❌ Failed to save the new prefix to the database. Try again.'
            }, { quoted: msg });
        }

        // ── Invalidate the cache immediately so it works on your next message ──
        botData.clearPrefixCache(sessionId);

        await sock.sendMessage(chatId, {
            text: `✅ *Prefix Changed Successfully!*\n\n📌 *New Prefix:* ${newPrefix}\n_Example: ${newPrefix}menu_`
        }, { quoted: msg });

    } catch (err) {
        console.error('[SETPREFIX] Error:', err.message);
        await sock.sendMessage(chatId, {
            text: `❌ Failed to set prefix: ${err.message}`
        }, { quoted: msg });
    }

    return null;
}

module.exports = {
    name: 'setprefix',
    aliases: ['prefix'],
    desc: 'Change bot command prefix',
    category: 'owner',
    execute
};