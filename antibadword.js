/**
 * commands/antibadword.js
 * Auto-moderate profanity in groups. Same table/cache pattern as antisticker.js.
 *
 * ⚠️ REQUIRES WIRING: handleAntiBadword() must be called for every incoming
 * group text message from your central message handler — same pattern as
 * antisticker.js's handleAntiSticker:
 *
 *   const { handleAntiBadword } = require('../commands/antibadword');
 *   await handleAntiBadword(sock, message, botData);
 */

const db = require('../oxbot/database');

const name     = 'antibadword';
const aliases  = ['badword', 'profanityfilter'];
const desc     = 'Auto-delete/warn/kick on profanity';
const category = 'group';

// Starter list — generic profanity only, no slurs. Admins can extend via .antibadword add
const DEFAULT_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'dick', 'bastard', 'cunt', 'whore', 'pussy'];

function cleanNum(jid) {
    if (!jid) return '';
    return jid.replace(/[^0-9]/g, '');
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ═══════════════════════════════════════════════════
// DATABASE (cache Map for instant reads, same as antisticker.js)
// ═══════════════════════════════════════════════════
const cache = new Map();

async function ensureTable() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS antibadword_settings (
                chat_id VARCHAR(100) NOT NULL PRIMARY KEY,
                enabled TINYINT(1) NOT NULL DEFAULT 0,
                action  VARCHAR(20) NOT NULL DEFAULT 'delete',
                words   TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
    } catch (err) {
        console.error('[antibadword] Table create error:', err.message);
    }
}

async function loadFromDB() {
    try {
        const [rows] = await db.query('SELECT chat_id, enabled, action, words FROM antibadword_settings');
        for (const r of rows) {
            let words;
            try { words = JSON.parse(r.words || '[]'); } catch { words = []; }
            cache.set(r.chat_id, { enabled: !!r.enabled, action: r.action, words });
        }
        console.log(`[antibadword] Loaded ${cache.size} group rules from DB.`);
    } catch (err) {
        console.error('[antibadword] DB read error:', err.message);
    }
}

async function init() {
    await ensureTable();
    await loadFromDB();
}
init();

function getConfig(chatId) {
    if (!cache.has(chatId)) cache.set(chatId, { enabled: false, action: 'delete', words: [...DEFAULT_WORDS] });
    return cache.get(chatId);
}

async function saveConfig(chatId, config) {
    cache.set(chatId, config);
    try {
        await db.query(
            `INSERT INTO antibadword_settings (chat_id, enabled, action, words)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), action = VALUES(action), words = VALUES(words)`,
            [chatId, config.enabled ? 1 : 0, config.action, JSON.stringify(config.words)]
        );
    } catch (err) {
        console.error('[antibadword] DB save error:', err.message);
    }
}

// ═══════════════════════════════════════════════════
// COMMAND
// ═══════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!chatId.endsWith('@g.us')) {
        return await sock.sendMessage(chatId, { text: '❌ Group only command!' }, { quoted: msg });
    }

    const senderId = msg.key.participant || msg.key.remoteJid;

    // Owner/admin check — same pattern as antisticker.js / promote.js
    let senderIsOwner = msg.key.fromMe;
    if (!senderIsOwner && sock._ownerPhone) {
        const senderNum = cleanNum(senderId);
        const ownerNum  = cleanNum(sock._ownerPhone);
        if (senderNum && ownerNum) {
            const sN = senderNum.startsWith('0') ? senderNum.slice(1) : senderNum;
            const oN = ownerNum.startsWith('0') ? ownerNum.slice(1) : ownerNum;
            senderIsOwner = sN === oN || sN.endsWith(oN) || oN.endsWith(sN);
        }
    }

    if (!msg.key.fromMe && !senderIsOwner) {
        try {
            const meta = await sock.groupMetadata(chatId);
            const senderNum = cleanNum(senderId);
            const senderIsAdmin = meta.participants?.some(p =>
                cleanNum(p.id) === senderNum && (p.admin === 'admin' || p.admin === 'superadmin')
            );
            if (!senderIsAdmin) {
                return await sock.sendMessage(chatId, { text: '❌ Only admins can use this!' }, { quoted: msg });
            }
        } catch {
            return await sock.sendMessage(chatId, { text: '❌ Could not fetch group info.' }, { quoted: msg });
        }
    }

    const opt = (args[0] || '').toLowerCase();
    const config = getConfig(chatId);

    if (!opt || opt === 'get') {
        const status = config.enabled ? '✅ ON' : '❌ OFF';
        return await sock.sendMessage(chatId, {
            text: `🤬 *Antibadword Status*\n\n>Status: *${status}*\n>Action: *${config.action.toUpperCase()}*\n>Words tracked: *${config.words.length}*\n\n*Usage:*\n  .antibadword on\n  .antibadword off\n  .antibadword set delete|warn|kick\n  .antibadword add <word>\n  .antibadword remove <word>\n  .antibadword list`
        }, { quoted: msg });
    }

    if (opt === 'on') {
        config.enabled = true;
        await saveConfig(chatId, config);
        return await sock.sendMessage(chatId, { text: `✅ *Antibadword ON*\n\nAction: *${config.action.toUpperCase()}*\n_⚠️ I must be an admin to delete messages or kick!_` }, { quoted: msg });
    }

    if (opt === 'off') {
        config.enabled = false;
        await saveConfig(chatId, config);
        return await sock.sendMessage(chatId, { text: '⛔ *Antibadword OFF*' }, { quoted: msg });
    }

    if (opt === 'set') {
        const setAction = (args[1] || '').toLowerCase();
        if (!['delete', 'warn', 'kick'].includes(setAction)) {
            return await sock.sendMessage(chatId, { text: '❌ Choose: `.antibadword set delete`, `warn`, or `kick`' }, { quoted: msg });
        }
        config.action = setAction;
        await saveConfig(chatId, config);
        return await sock.sendMessage(chatId, { text: `✅ Action set to *${setAction.toUpperCase()}*` }, { quoted: msg });
    }

    if (opt === 'add') {
        const word = (args[1] || '').toLowerCase().trim();
        if (!word) return await sock.sendMessage(chatId, { text: '❌ Provide a word to add.\n_Example: .antibadword add idiot_' }, { quoted: msg });
        if (config.words.includes(word)) {
            return await sock.sendMessage(chatId, { text: `⚠️ "${word}" is already tracked.` }, { quoted: msg });
        }
        config.words.push(word);
        await saveConfig(chatId, config);
        return await sock.sendMessage(chatId, { text: `✅ Added "${word}" to the filter list.` }, { quoted: msg });
    }

    if (opt === 'remove') {
        const word = (args[1] || '').toLowerCase().trim();
        if (!word) return await sock.sendMessage(chatId, { text: '❌ Provide a word to remove.' }, { quoted: msg });
        if (!config.words.includes(word)) {
            return await sock.sendMessage(chatId, { text: `⚠️ "${word}" isn't in the list.` }, { quoted: msg });
        }
        config.words = config.words.filter(w => w !== word);
        await saveConfig(chatId, config);
        return await sock.sendMessage(chatId, { text: `🗑️ Removed "${word}" from the filter list.` }, { quoted: msg });
    }

    if (opt === 'list') {
        if (!config.words.length) {
            return await sock.sendMessage(chatId, { text: '📭 No words in the filter list.' }, { quoted: msg });
        }
        return await sock.sendMessage(chatId, {
            text: `🤬 *Filtered Words* (${config.words.length})\n\n${config.words.map(w => `• ${w}`).join('\n')}`
        }, { quoted: msg });
    }

    return await sock.sendMessage(chatId, { text: '❌ Invalid option. Type `.antibadword` to see the menu.' }, { quoted: msg });
}

// ═══════════════════════════════════════════════════
// BACKGROUND WATCHER
// ═══════════════════════════════════════════════════
async function handleAntiBadword(sock, message, botData) {
    const chatId = message.key.remoteJid;
    if (!chatId?.endsWith('@g.us') || message.key.fromMe) return;

    const config = getConfig(chatId);
    if (!config.enabled || !config.words.length) return;

    const text = message.message?.conversation
        || message.message?.extendedTextMessage?.text
        || message.message?.imageMessage?.caption
        || message.message?.videoMessage?.caption
        || '';
    if (!text) return;

    const lower = text.toLowerCase();
    const matched = config.words.find(w => {
        const re = new RegExp(`\\b${escapeRegex(w)}\\b`, 'i');
        return re.test(lower);
    });
    if (!matched) return;

    const sender = message.key.participant || message.key.remoteJid;

    try {
        await sock.sendMessage(chatId, { delete: message.key });

        if (config.action === 'warn') {
            await sock.sendMessage(chatId, {
                text: `⚠️ @${sender.split('@')[0]}, that language isn't allowed here. Message deleted.`,
                mentions: [sender],
            });
        } else if (config.action === 'kick') {
            await sock.sendMessage(chatId, {
                text: `🚫 @${sender.split('@')[0]} removed for using inappropriate language.`,
                mentions: [sender],
            });
            await sock.groupParticipantsUpdate(chatId, [sender], 'remove');
        }
    } catch (err) {
        console.error('[antibadword] Action failed:', err.message);
    }
}

module.exports = { name, aliases, desc, category, execute, handleAntiBadword };