/**
 * commands/sendcoin.js
 * .sendcoin <username_or_email> <amount>
 *
 * Sends coins from the SENDER's own OxBot dashboard account (resolved
 * from the bot session that received the command) to another user's
 * account, looked up by username OR email. Minimum transfer: 20 coins.
 *
 * This is separate from /api/transfer-bot in routes/bots.js, which
 * transfers ownership of a BOT session — this only moves coin balance.
 */

const MIN_SENDCOIN = 20;

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

// Resolve the dashboard account tied to this bot session (the account
// whose coin balance will be debited), not by guessing/matching phone
// strings — the bots -> users join is the source of truth already used
// throughout routes/bots.js.
async function getSenderAccount(db, sessionId) {
    const actualId = await getActualDbSessionId(db, sessionId);
    const [rows] = await db.query(
        `SELECT u.id, u.username, u.email, u.phone, u.balance
         FROM users u JOIN bots b ON b.user_id = u.id
         WHERE b.session_id = ? LIMIT 1`,
        [actualId]
    );
    return rows.length ? rows[0] : null;
}

async function isOwner(db, sessionId, senderId, sock, chatId) {
    const account = await getSenderAccount(db, sessionId);
    const ownerNumber = account?.phone ? String(account.phone).replace(/\D/g, '') : null;
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

async function findTargetUser(db, identifier) {
    const [rows] = await db.query(
        `SELECT id, username, email, balance FROM users WHERE username = ? OR email = ? LIMIT 1`,
        [identifier, identifier]
    );
    return rows.length ? rows[0] : null;
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
        return await sock.sendMessage(chatId, { text: '❌ Only the account linked to this bot can send coins from it.' }, { quoted: msg });
    }

    if (args.length < 2) {
        return await sock.sendMessage(chatId, {
            text: `Usage: *.sendcoin <username_or_email> <amount>*\nMinimum: ${MIN_SENDCOIN} coins.\n\nExample: .sendcoin johndoe 50`
        }, { quoted: msg });
    }

    const identifier = args[0].trim();
    const amount = parseInt(args[1], 10);

    if (!Number.isFinite(amount) || amount < MIN_SENDCOIN) {
        return await sock.sendMessage(chatId, { text: `❌ Minimum transfer is ${MIN_SENDCOIN} coins.` }, { quoted: msg });
    }

    const sender = await getSenderAccount(db, botData.sessionId);
    if (!sender) {
        return await sock.sendMessage(chatId, { text: '❌ Could not find your OxBot account for this bot session.' }, { quoted: msg });
    }

    const target = await findTargetUser(db, identifier);
    if (!target) {
        return await sock.sendMessage(chatId, { text: `❌ No user found with username or email "${identifier}".` }, { quoted: msg });
    }

    if (target.id === sender.id) {
        return await sock.sendMessage(chatId, { text: '❌ You cannot send coins to yourself.' }, { quoted: msg });
    }

    if (sender.balance < amount) {
        return await sock.sendMessage(chatId, {
            text: `❌ Insufficient balance. You have ${sender.balance} coins, need ${amount}.`
        }, { quoted: msg });
    }

    try {
        // Conditional UPDATE (balance >= amount in the WHERE clause) guards
        // against a race between the balance check above and this write —
        // same pattern as the rest of the codebase should be moving toward,
        // since /api/marketplace/buy and /api/transfer-bot currently don't
        // guard against concurrent requests either.
        const [deductResult] = await db.query(
            'UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?',
            [amount, sender.id, amount]
        );
        if (!deductResult.affectedRows) {
            return await sock.sendMessage(chatId, { text: '❌ Transfer failed — balance changed, try again.' }, { quoted: msg });
        }

        await db.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, target.id]);

        await sock.sendMessage(chatId, {
            text: `✅ Sent ${amount} coins to @${target.username}.\nYour new balance: ${sender.balance - amount} coins.`
        }, { quoted: msg });

        console.log(`[sendcoin] ${sender.username} (${sender.id}) -> ${target.username} (${target.id}): ${amount} coins`);
    } catch (err) {
        console.error('[sendcoin] failed:', err.message);
        await sock.sendMessage(chatId, { text: '❌ Transfer failed due to a server error.' }, { quoted: msg });
    }
}

module.exports = {
    name: 'sendcoin',
    execute,
    desc: 'Send coins to another OxBot user by username or email (min 20 coins)',
    category: 'general',
    aliases: ['transfercoin', 'givecoin'],
};