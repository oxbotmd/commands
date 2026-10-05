/**
 * commands/ban.js
 * Ban or Unban users using SQL Database.
 * Usage: .ban @user [reason]
 * Usage: .unban @user
 */

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const db = botData?.db;
    if (!db) return await sock.sendMessage(chatId, { text: '⚠️ Database error.' }, { quoted: msg });

    const senderId = msg.key.participant || msg.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');
    const sessionId = botData?.sessionId;

    // ── OWNER CHECK ──
    let senderIsOwner = msg.key.fromMe;
    if (!senderIsOwner && db && sessionId) {
        try {
            const [rows] = await db.query(
                'SELECT u.phone FROM users u JOIN bots b ON b.user_id=u.id WHERE b.session_id=? LIMIT 1',
                [sessionId]
            );
            if (rows.length) {
                const ownerNum = String(rows[0].phone).replace(/\D/g, '');
                senderIsOwner = senderId.includes(ownerNum);
            }
        } catch (err) {}
    }

    // ── GROUP PERMISSION CHECK ──
    if (isGroup) {
        let meta;
        try {
            meta = await sock.groupMetadata(chatId);
        } catch {
            return await sock.sendMessage(chatId, { text: '❌ Could not fetch group info.' }, { quoted: msg });
        }

        const botJid = sock.user?.id?.split(':')[0]?.split('@')[0] + '@s.whatsapp.net';
        const botMember = meta.participants.find(p => p.id.split(':')[0]?.split('@')[0] === botJid.split('@')[0]);
        const senderMember = meta.participants.find(p => p.id.split(':')[0]?.split('@')[0] === senderId.split(':')[0]?.split('@')[0]);

        const isBotAdmin = botMember && ['admin', 'superadmin'].includes(botMember.admin);
        const isSenderAdmin = senderMember && ['admin', 'superadmin'].includes(senderMember.admin);

        if (!isBotAdmin) {
            return await sock.sendMessage(chatId, { text: '❌ Bot must be admin to use ban commands' }, { quoted: msg });
        }
        if (!isSenderAdmin && !senderIsOwner) {
            return await sock.sendMessage(chatId, { text: '❌ Only admins/owner can use ban commands' }, { quoted: msg });
        }
    } else {
        if (!senderIsOwner) {
            return await sock.sendMessage(chatId, { text: '❌ Only owner can use ban commands in private chat' }, { quoted: msg });
        }
    }

    // ── PARSE ACTION (ban vs unban) ──
    let action = 'ban'; // default
    let targetIndex = 0;

    if (args[0]?.toLowerCase() === 'unban') {
        action = 'unban';
        targetIndex = 1; // The user is the second argument
    }

    // ── GET TARGET USER ──
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    let userToAct = ctx?.mentionedJid?.[0] || ctx?.participant;

    // If no reply/mention, try to parse from args
    if (!userToAct && args[targetIndex]) {
        let cleanArg = args[targetIndex].replace(/[^0-9]/g, '');
        if (cleanArg.startsWith('0')) cleanArg = '234' + cleanArg.slice(1);
        if (cleanArg.length >= 7) {
            userToAct = cleanArg + '@s.whatsapp.net';
        }
    }

    if (!userToAct) {
        return await sock.sendMessage(chatId, { 
            text: `❌ Mention or reply to a user.\nUsage: .ban @user\nUsage: .unban @user` 
        }, { quoted: msg });
    }

    // Don't ban bot itself
    const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    if (action === 'ban' && userToAct.split('@')[0] === botId.split('@')[0]) {
        return await sock.sendMessage(chatId, { text: '❌ Cannot ban the bot itself' }, { quoted: msg });
    }

    // ── EXECUTE ACTION ──
    try {
        if (action === 'ban') {
            const reason = args.slice(targetIndex + 1).join(' ') || 'No reason provided';
            await db.query(
                'INSERT INTO banned_users (jid, reason) VALUES (?, ?) ON DUPLICATE KEY UPDATE reason = ?',
                [userToAct, reason, reason]
            );
            await sock.sendMessage(chatId, { 
                text: `🚫 *User Banned*\n@${userToAct.split('@')[0]}\nReason: ${reason}`, 
                mentions: [userToAct] 
            }, { quoted: msg });
            
            // Optional: Notify user
            await sock.sendMessage(userToAct, { text: '⛔ You have been banned from using this bot.' }).catch(() => {});

        } else if (action === 'unban') {
            const [res] = await db.query('DELETE FROM banned_users WHERE jid = ?', [userToAct]);
            if (res.affectedRows === 0) {
                return await sock.sendMessage(chatId, { text: '⚠️ User was not banned.' }, { quoted: msg });
            }
            await sock.sendMessage(chatId, { 
                text: `✅ *User Unbanned*\n@${userToAct.split('@')[0]}`, 
                mentions: [userToAct] 
            }, { quoted: msg });
        }
    } catch (err) {
        console.error('Ban/Unban error:', err);
        await sock.sendMessage(chatId, { text: '❌ Database error.' }, { quoted: msg });
    }
}

module.exports = {
    name: 'ban',
    desc: 'Ban or Unban a user (SQL)',
    category: 'admin',
    execute
};