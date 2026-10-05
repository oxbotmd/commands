/**
 * commands/antisticker.js
 * Auto-delete stickers (Saves to `antisticker_settings` table in MySQL — no more JSON file)
 */

const db = require('../oxbot/database');

function cleanNum(jid) {
    if (!jid) return '';
    return jid.replace(/[^0-9]/g, '');
}

// ═══════════════════════════════════════════════════
// DATABASE (Creates table automatically, in-memory cache for instant reads)
// ═══════════════════════════════════════════════════
const cache = new Map();
let ready = false;
const pending = []; // queued getConfig-dependent calls if DB not ready yet (rare — startup race)

async function ensureTable() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS antisticker_settings (
                chat_id VARCHAR(100) NOT NULL PRIMARY KEY,
                enabled TINYINT(1) NOT NULL DEFAULT 0,
                action  VARCHAR(20) NOT NULL DEFAULT 'delete',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        console.log('[antisticker] Table ready.');
    } catch (err) {
        console.error('[antisticker] Table create error:', err.message);
    }
}

async function loadFromDB() {
    try {
        const [rows] = await db.query('SELECT chat_id, enabled, action FROM antisticker_settings');
        for (const r of rows) {
            cache.set(r.chat_id, { enabled: !!r.enabled, action: r.action });
        }
        console.log(`[antisticker] Loaded ${cache.size} group rules from DB.`);
    } catch (err) {
        console.error('[antisticker] DB read error:', err.message);
    } finally {
        ready = true;
        while (pending.length) pending.shift()();
    }
}

async function init() {
    await ensureTable();
    await loadFromDB();
}
init();

function getConfig(chatId) {
    if (!cache.has(chatId)) cache.set(chatId, { enabled: false, action: 'delete' });
    return cache.get(chatId);
}

async function setConfig(chatId, enabled, action) {
    const config = getConfig(chatId);
    config.enabled = enabled;
    config.action = action;
    cache.set(chatId, config); // instant, so handleAntiSticker sees it right away

    try {
        await db.query(
            `INSERT INTO antisticker_settings (chat_id, enabled, action)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), action = VALUES(action)`,
            [chatId, enabled ? 1 : 0, action]
        );
    } catch (err) {
        console.error('[antisticker] DB save error:', err.message);
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

    // 1. Fast owner check using socket identity (same pattern as promote.js)
    let senderIsOwner = msg.key.fromMe;
    if (!senderIsOwner) {
        const ownerPhone = sock._ownerPhone;
        const senderNum = cleanNum(senderId);
        const ownerNum  = ownerPhone ? cleanNum(ownerPhone) : '';

        if (senderNum && ownerNum) {
            const sNorm = senderNum.startsWith('0') ? senderNum.slice(1) : senderNum;
            const oNorm = ownerNum.startsWith('0') ? ownerNum.slice(1) : ownerNum;
            senderIsOwner = sNorm === oNorm || sNorm.endsWith(oNorm) || oNorm.endsWith(sNorm);
        }
    }

    // 2. If NOT the owner, check if sender is a Group Admin
    if (!msg.key.fromMe && !senderIsOwner) {
        try {
            const meta = await sock.groupMetadata(chatId);
            const senderNum = cleanNum(senderId);
            const senderIsAdmin = meta.participants?.some(p =>
                cleanNum(p.id) === senderNum &&
                (p.admin === 'admin' || p.admin === 'superadmin')
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
            text: `🖼️ *Antisticker Status*\n\n>Status: *${status}*\n>Action: *${config.action.toUpperCase()}*\n\n*Usage:*\n  .antisticker on\n  .antisticker off\n  .antisticker set delete\n  .antisticker set kick`
        }, { quoted: msg });
    }

    if (opt === 'on') {
        if (config.enabled) return await sock.sendMessage(chatId, { text: '⚠️ Already ON.' }, { quoted: msg });
        await setConfig(chatId, true, config.action);
        return await sock.sendMessage(chatId, { text: `✅ *Antisticker ON*\n\nAction: *${config.action.toUpperCase()}*\n_⚠️ I must be an admin to delete messages!_` }, { quoted: msg });
    }

    if (opt === 'off') {
        await setConfig(chatId, false, config.action);
        return await sock.sendMessage(chatId, { text: '⛔ *Antisticker OFF*' }, { quoted: msg });
    }

    if (opt === 'set') {
        const setAction = (args[1] || '').toLowerCase();
        if (!['delete', 'kick'].includes(setAction)) {
            return await sock.sendMessage(chatId, { text: '❌ Choose *.antisticker set delete* or *.antisticker set kick*' }, { quoted: msg });
        }
        await setConfig(chatId, true, setAction);
        return await sock.sendMessage(chatId, { text: `✅ Action set to *${setAction.toUpperCase()}*` }, { quoted: msg });
    }

    return await sock.sendMessage(chatId, { text: '❌ Invalid option.' }, { quoted: msg });
}

// ═══════════════════════════════════════════════════
// BACKGROUND DELETER
// ═══════════════════════════════════════════════════
async function handleAntiSticker(sock, message, botData) {
    const chatId = message.key.remoteJid;
    if (!chatId?.endsWith('@g.us') || message.key.fromMe) return;

    const config = getConfig(chatId); // Instant memory read — never blocks on DB
    if (!config.enabled || !message.message?.stickerMessage) return;

    try {
        await sock.sendMessage(chatId, { delete: message.key });

        if (config.action === 'kick') {
            const sender = message.key.participant;
            if (sender) await sock.groupParticipantsUpdate(chatId, [sender], 'remove');
        }
    } catch (err) {
        console.error(`[antisticker] Action failed:`, err.message);
    }
}

module.exports = { name: 'antisticker', aliases: ['nosticker'], desc: 'Delete or kick sticker senders', category: 'group', execute, handleAntiSticker };
