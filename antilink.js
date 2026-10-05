// commands/antilink.js
const { getSettings, setAntilink, setAntilinkAction } = require('../lib/antilink');

function cleanNumber(jid) {
    if (!jid) return '';
    return jid.split(':')[0].split('@')[0];
}

async function getOwnerNumber(db, sessionId) {
    try {
        const [rows] = await db.query(
            'SELECT u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ? LIMIT 1',
            [sessionId]
        );
        if (!rows.length || !rows[0].phone) return null;
        return String(rows[0].phone).replace(/\D/g, '');
    } catch (err) {
        console.error('[antilink] DB error fetching owner:', err.message);
        return null;
    }
}

async function isOwner(db, sessionId, senderId, sock, chatId) {
    const ownerNumber = await getOwnerNumber(db, sessionId);
    if (!ownerNumber) return false;

    const ownerJid    = ownerNumber + '@s.whatsapp.net';
    const senderClean = cleanNumber(senderId);

    if (senderId === ownerJid)          return true;
    if (senderClean === ownerNumber)    return true;
    if (senderId.includes(ownerNumber)) return true;

    if (sock && chatId && chatId.endsWith('@g.us') && senderId.includes('@lid')) {
        try {
            const metadata     = await sock.groupMetadata(chatId);
            const participants = metadata.participants || [];
            const match = participants.find(p => {
                const pIdClean = cleanNumber(p.id || '');
                return pIdClean === ownerNumber || (p.id || '') === ownerJid;
            });
            if (match) return true;
        } catch (e) {
            console.error('[antilink] Group LID check error:', e.message);
        }
    }
    return false;
}

async function isGroupAdmin(sock, chatId, senderId) {
    try {
        const metadata = await sock.groupMetadata(chatId);
        const senderNum = cleanNumber(senderId);
        return metadata.participants?.some(p => {
            const pNum = cleanNumber(p.id);
            const pLidNum = p.lid ? cleanNumber(p.lid) : null;
            const matches = pNum === senderNum || (pLidNum && pLidNum === senderNum);
            return matches && (p.admin === 'admin' || p.admin === 'superadmin');
        }) || false;
    } catch {
        return false;
    }
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return;

    if (!chatId.endsWith('@g.us')) {
        return await sock.sendMessage(chatId, { text: '❌ This command is for groups only.' }, { quoted: msg });
    }

    if (!botData?.sessionId || !botData?.db) {
        return await sock.sendMessage(chatId, { text: '⚠️ Database error. Please restart the bot.' }, { quoted: msg });
    }

    const db = botData.db;
    const sessionId = botData.sessionId;
    const senderId = msg.key.participant || msg.key.participantAlt;
    if (!senderId) {
        return await sock.sendMessage(chatId, { text: '❌ Could not verify your identity. Try again.' }, { quoted: msg });
    }

    let isAuthorized = msg.key.fromMe === true;
    if (!isAuthorized) isAuthorized = await isOwner(db, sessionId, senderId, sock, chatId);
    if (!isAuthorized) isAuthorized = await isGroupAdmin(sock, chatId, senderId);

    if (!isAuthorized) {
        return await sock.sendMessage(chatId, { text: '❌ Only the bot owner or group admins can use this command.' }, { quoted: msg });
    }

    const opt = args[0]?.toLowerCase();
    const settings = await getSettings(db, chatId, sessionId);

    if (!opt || opt === 'get') {
        return await sock.sendMessage(chatId, {
            text: `🔗 *Antilink Settings*\n\n` +
                  `• Status: *${settings.enabled ? 'ON' : 'OFF'}*\n` +
                  `• Action: *${settings.action.toUpperCase()}*\n\n` +
                  `*Usage:*\n.antilink on\n.antilink off\n.antilink set delete\n.antilink set kick`
        }, { quoted: msg });
    }

    if (opt === 'on') {
        await setAntilink(db, chatId, sessionId, true);
        return await sock.sendMessage(chatId, { text: '✅ Antilink turned *ON*.' }, { quoted: msg });
    }

    if (opt === 'off') {
        await setAntilink(db, chatId, sessionId, false);
        return await sock.sendMessage(chatId, { text: '❌ Antilink turned *OFF*.' }, { quoted: msg });
    }

    if (opt === 'set') {
        const newAction = args[1]?.toLowerCase();
        if (!['delete', 'kick'].includes(newAction)) {
            return await sock.sendMessage(chatId, { text: '❌ Use: `.antilink set delete` or `.antilink set kick`' }, { quoted: msg });
        }
        await setAntilinkAction(db, chatId, sessionId, newAction);
        return await sock.sendMessage(chatId, { text: `✅ Action set to *${newAction.toUpperCase()}*` }, { quoted: msg });
    }

    return await sock.sendMessage(chatId, { text: '❌ Invalid command. Use `.antilink`' }, { quoted: msg });
}

module.exports = {
    name: 'antilink',
    aliases: ['antilink'],
    desc: 'Delete links from non-admins',
    category: 'admin',
    execute
};
