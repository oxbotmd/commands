/**
 * commands/sessionid.js
 * .sessionid — shows the LONG session ID string (the one that decodes
 * back into creds.json via the "::::" separator, same format that
 * /api/validate-session in routes/bots.js parses) — not the short
 * "oxbot_<number>" DB identifier.
 */

const fs   = require('fs');
const path = require('path');

// Same folder routes/bots.js uses: path.join(__dirname, '..', 'sessions')
// — adjust if commands/ isn't a direct sibling of routes/ in your layout.
const SESSION_DIR = path.join(__dirname, '..', 'sessions');

// ⚠️ CONFIRM THIS against whatever prefix pairing.js's deliverSession()
// actually puts before "::::" when it first sends the session string to
// the user — validate-session only checks for "::::" in the input, it
// doesn't care what comes before it, but the string here should match
// what your users already expect to paste back in.
const SESSION_PREFIX = 'OXBOT';

function cleanNumber(jid) {
    if (!jid) return '';
    return jid.split(':')[0].split('@')[0];
}

async function getActualDbSessionId(db, sessionId) {
    try {
        const [rows] = await db.query('SELECT session_id FROM bots WHERE session_id=? LIMIT 1', [sessionId]);
        if (rows.length) return rows[0].session_id;
        if (!String(sessionId).startsWith('oxbot_')) {
            const [rows2] = await db.query('SELECT session_id FROM bots WHERE session_id=? LIMIT 1', [`oxbot_${sessionId}`]);
            if (rows2.length) return rows2[0].session_id;
        }
    } catch {}
    return sessionId;
}

async function getOwnerNumber(db, sessionId) {
    try {
        const [rows] = await db.query(
            'SELECT u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ? LIMIT 1',
            [sessionId]
        );
        if (!rows.length || !rows[0].phone) return null;
        return String(rows[0].phone).replace(/\D/g, '');
    } catch {
        return null;
    }
}

async function isOwner(db, sessionId, senderId, sock, chatId) {
    const ownerNumber = await getOwnerNumber(db, sessionId);
    if (!ownerNumber) return false;

    const ownerJid = ownerNumber + '@s.whatsapp.net';
    const senderClean = cleanNumber(senderId);

    if (senderId === ownerJid) return true;
    if (senderClean === ownerNumber) return true;
    if (senderId.includes(ownerNumber)) return true;

    if (sock && chatId && chatId.endsWith('@g.us') && senderId.includes('@lid')) {
        try {
            const metadata = await sock.groupMetadata(chatId);
            const participants = metadata.participants || [];
            const match = participants.find(p => {
                const pIdClean = cleanNumber(p.id || '');
                return pIdClean === ownerNumber || (p.id || '') === ownerJid;
            });
            if (match) return true;
        } catch (e) {}
    }
    return false;
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!botData?.sessionId || !botData?.db) {
        return await sock.sendMessage(chatId, { text: '⚠️ Database error.' }, { quoted: msg });
    }

    const db = botData.db;
    const senderId = msg.key.participant || msg.key.remoteJid;
    const senderIsOwner = await isOwner(db, botData.sessionId, senderId, sock, chatId);

    if (!msg.key.fromMe && !senderIsOwner) {
        return await sock.sendMessage(chatId, { text: '❌ Owner only command.' }, { quoted: msg });
    }

    const actualId  = await getActualDbSessionId(db, botData.sessionId);
    const credsPath = path.join(SESSION_DIR, actualId, 'creds.json');

    if (!fs.existsSync(credsPath)) {
        return await sock.sendMessage(chatId, {
            text: '❌ creds.json not found for this session on disk — cannot generate the session string. Re-pair if this keeps happening.'
        }, { quoted: msg });
    }

    let longSessionId;
    try {
        const credsRaw = fs.readFileSync(credsPath, 'utf8');
        const b64      = Buffer.from(credsRaw, 'utf8').toString('base64');
        longSessionId  = `${SESSION_PREFIX}::::${b64}`;
    } catch (err) {
        return await sock.sendMessage(chatId, { text: `❌ Failed to read session file: ${err.message}` }, { quoted: msg });
    }

    await sock.sendMessage(chatId, {
        text: `🆔 *Your Session ID:*\n\n${longSessionId}\n\n⚠️ *Keep this PRIVATE* — anyone with this string can access your WhatsApp bot. Treat it like a password.`
    }, { quoted: msg });
}

module.exports = {
    name: 'sessionid',
    execute,
    desc: "Show this bot's long session ID string (Owner)",
    category: 'owner',
    aliases: ['sid', 'myid'],
};
