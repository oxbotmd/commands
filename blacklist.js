/**
 * commands/blacklist.js
 * Owner-only: block specific numbers from using this bot.
 * Usage:
 *   .blacklist add <number> [reason]
 *   .blacklist remove <number>
 *   .blacklist list
 */

const name     = 'blacklist';
const desc     = 'Block a number from using this bot';
const category = 'owner';
const aliases  = ['bl'];

function cleanNum(jid) {
    return jid ? String(jid).replace(/[^0-9]/g, '') : '';
}

function norm(num) {
    const n = cleanNum(num);
    return n.startsWith('0') ? n.slice(1) : n;
}

async function execute(sock, msg, botData, args) {
    const chatId    = msg.key.remoteJid;
    const db        = botData?.db;
    const sessionId = botData?.sessionId;

    if (!db || !sessionId) {
        return await sock.sendMessage(chatId, { text: '❌ Database unavailable.' }, { quoted: msg });
    }

    const sub = (args[0] || '').toLowerCase();

    // ── LIST ──────────────────────────────────────────────────────────────
    if (sub === 'list') {
        try {
            const [rows] = await db.query(
                'SELECT user_number, user_name, reason, created_at FROM bot_blacklist WHERE session_id=? ORDER BY created_at DESC',
                [sessionId]
            );
            if (!rows.length) {
                return await sock.sendMessage(chatId, { text: '📋 Blacklist is empty.' }, { quoted: msg });
            }
            let text = `🚫 *Blacklist (${rows.length})*\n\n`;
            rows.forEach((r, i) => {
                text += `${i + 1}. +${r.user_number}`;
                if (r.user_name) text += ` (${r.user_name})`;
                if (r.reason)    text += `\n   Reason: ${r.reason}`;
                text += `\n`;
            });
            return await sock.sendMessage(chatId, { text }, { quoted: msg });
        } catch (err) {
            return await sock.sendMessage(chatId, { text: `❌ Failed to load blacklist: ${err.message}` }, { quoted: msg });
        }
    }

    // ── REMOVE ────────────────────────────────────────────────────────────
    if (sub === 'remove' || sub === 'rm' || sub === 'unban') {
        const target = norm(args[1]);
        if (!target) {
            return await sock.sendMessage(chatId, { text: '❌ Usage: .blacklist remove <number>' }, { quoted: msg });
        }
        try {
            await db.query(
                'DELETE FROM bot_blacklist WHERE session_id=? AND user_number=?',
                [sessionId, target]
            );
            const { bustBlacklistCache } = require('./index');
            if (bustBlacklistCache) bustBlacklistCache(sessionId);
            return await sock.sendMessage(chatId, { text: `✅ +${target} removed from blacklist.` }, { quoted: msg });
        } catch (err) {
            return await sock.sendMessage(chatId, { text: `❌ Failed to remove: ${err.message}` }, { quoted: msg });
        }
    }

    // ── ADD ───────────────────────────────────────────────────────────────
    if (sub === 'add' || sub === 'ban') {
        const target = norm(args[1]);
        const reason = args.slice(2).join(' ').trim() || null;

        if (!target || target.length < 8) {
            return await sock.sendMessage(chatId, { text: '❌ Usage: .blacklist add <number> [reason]' }, { quoted: msg });
        }

        // Don't let the owner accidentally blacklist themselves
        const ownerNum = norm(botData?.sessionId?.replace('oxbot_', ''));
        if (target === ownerNum) {
            return await sock.sendMessage(chatId, { text: '❌ You cannot blacklist yourself.' }, { quoted: msg });
        }

        // Try to resolve a display name for the target from any recently
        // seen message in this chat (pushName), so the list is readable.
        let userName = null;
        try {
            if (msg.key.participant && cleanNum(msg.key.participant).includes(target)) {
                userName = msg.pushName || null;
            }
        } catch {}

        try {
            await db.query(
                `INSERT INTO bot_blacklist (session_id, user_number, user_name, reason, blacklisted_by)
                 VALUES (?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE reason = VALUES(reason)`,
                [sessionId, target, userName, reason, cleanNum(msg.key.participant || msg.key.remoteJid)]
            );
            const { bustBlacklistCache } = require('./index');
            if (bustBlacklistCache) bustBlacklistCache(sessionId);

            let confirm = `✅ +${target} has been blacklisted.`;
            if (reason) confirm += `\nReason: ${reason}`;
            return await sock.sendMessage(chatId, { text: confirm }, { quoted: msg });
        } catch (err) {
            return await sock.sendMessage(chatId, { text: `❌ Failed to blacklist: ${err.message}` }, { quoted: msg });
        }
    }

    return await sock.sendMessage(chatId, {
        text: '📖 *Blacklist Usage*\n\n.blacklist add <number> [reason]\n.blacklist remove <number>\n.blacklist list'
    }, { quoted: msg });
}

module.exports = { name, desc, category, aliases, execute };