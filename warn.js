/**
 * commands/warn.js
 * Manual .warn command — issues warnings (no auto-kick).
 *
 * Exports shared helpers (addWarning, resetWarning, etc.)
 * that antilink.js can reuse.
 */

const name     = 'warn';
const desc     = 'Warn a user';
const category = 'group';
const aliases  = ['warning'];

function cleanNum(jid) {
    if (!jid) return '';
    return jid.replace(/[^0-9]/g, '');
}

// ═══════════════════════════════════════════════════
// SHARED TABLE + HELPERS
// ═══════════════════════════════════════════════════
async function ensureWarningsTable(db) {
    if (!db) return;
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS bot_warnings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                chat_id VARCHAR(100) NOT NULL,
                user_id VARCHAR(100) NOT NULL,
                count INT DEFAULT 0,
                last_reason VARCHAR(255) DEFAULT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_chat_user (chat_id, user_id)
            )
        `);
    } catch (err) {
        console.error('[warn] Table create error:', err.message);
    }
}

async function getWarningCount(db, chatId, userId) {
    if (!db) return 0;
    try {
        const [rows] = await db.query(
            'SELECT count FROM bot_warnings WHERE chat_id = ? AND user_id = ? LIMIT 1',
            [chatId, userId]
        );
        return rows.length ? rows[0].count : 0;
    } catch {
        return 0;
    }
}

async function addWarning(db, chatId, userId, reason = null) {
    if (!db) return 0;
    await ensureWarningsTable(db);
    try {
        await db.query(
            `INSERT INTO bot_warnings (chat_id, user_id, count, last_reason)
             VALUES (?, ?, 1, ?)
             ON DUPLICATE KEY UPDATE count = count + 1, last_reason = VALUES(last_reason)`,
            [chatId, userId, reason]
        );
        return await getWarningCount(db, chatId, userId);
    } catch (err) {
        console.error('[warn] addWarning error:', err.message);
        return 0;
    }
}

async function resetWarning(db, chatId, userId) {
    if (!db) return;
    try {
        await db.query('DELETE FROM bot_warnings WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
    } catch {}
}

// ═══════════════════════════════════════════════════
// COMMAND: .warn @user [reason]
// ═══════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId?.endsWith('@g.us')) {
        return await sock.sendMessage(chatId, { text: '❌ Group only command!' }, { quoted: msg });
    }

    const senderId = msg.key.participant || chatId;
    const db       = botData?.db;

    // owner check
    let senderIsOwner = msg.key.fromMe;
    if (!senderIsOwner) {
        const ownerPhone = sock._ownerPhone;
        const senderNum  = cleanNum(senderId);
        const ownerNum   = ownerPhone ? cleanNum(ownerPhone) : '';
        if (senderNum && ownerNum) {
            const sNorm = senderNum.startsWith('0') ? senderNum.slice(1) : senderNum;
            const oNorm = ownerNum.startsWith('0')  ? ownerNum.slice(1)  : ownerNum;
            senderIsOwner = sNorm === oNorm || sNorm.endsWith(oNorm) || oNorm.endsWith(sNorm);
        }
    }

    // admin check
    if (!msg.key.fromMe && !senderIsOwner) {
        let meta;
        try { meta = await sock.groupMetadata(chatId); } catch {
            return await sock.sendMessage(chatId, { text: '❌ Could not fetch group info.' }, { quoted: msg });
        }
        const senderNum     = cleanNum(senderId);
        const senderIsAdmin = (meta.participants || []).some(p =>
            cleanNum(p.id) === senderNum && (p.admin === 'admin' || p.admin === 'superadmin')
        );
        if (!senderIsAdmin) {
            return await sock.sendMessage(chatId, { text: '❌ Only admins can warn users!' }, { quoted: msg });
        }
    }

    const target =
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
        msg.message?.extendedTextMessage?.contextInfo?.participant        ||
        null;

    if (!target) {
        return await sock.sendMessage(chatId, {
            text: '❌ Mention or reply to a user!\n_Example: *.warn @user posting spam links*_'
        }, { quoted: msg });
    }

    const reason = args.filter(a => !a.startsWith('@')).join(' ').trim() || 'No reason given';

    await ensureWarningsTable(db);
    const newCount = await addWarning(db, chatId, target, reason);

    await sock.sendMessage(chatId, {
        text: `⚠️ *Warning issued!*\n\n👤 @${cleanNum(target)}\n📝 Reason: ${reason}\n📊 Total warnings: *${newCount}*`,
        mentions: [target],
    }, { quoted: msg });

    return null;
}

module.exports = {
    name, desc, category, aliases, execute,
    ensureWarningsTable, getWarningCount, addWarning, resetWarning,
};
