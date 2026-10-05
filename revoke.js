/**
 * commands/revoke.js
 * Reset the group invite link (Admins only)
 */

const name     = 'revoke';
const aliases  = ['resetlink', 'resetlinkgroup', 'newlink', 'revokelink'];
const desc     = 'Reset the group invite link';
const category = 'group';

function cleanNum(jid) {
    if (!jid) return '';
    return jid.replace(/[^0-9]/g, '');
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    // 1. Must be a group
    if (!chatId.endsWith('@g.us')) {
        return await sock.sendMessage(chatId, { text: '❌ Group only command!' }, { quoted: msg });
    }

    const senderId = msg.key.participant || msg.key.remoteJid;
    
    // 2. Fast owner check
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

    // 3. Admin check
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

    // 4. Revoke the link silently
    try {
        // Revokes the old link (new one is generated in the background by WhatsApp)
        await sock.groupRevokeInvite(chatId);
        
        // Send simple message without the new link
        await sock.sendMessage(chatId, {
            text: `✅ *Group link has been changed successfully.*\n\n👑 *Changed by:* @${cleanNum(senderId)}`,
            mentions: [senderId]
        }, { quoted: msg });
    } catch (err) {
        console.error('Revoke error:', err);
        if (err?.message?.includes('not-admin') || err?.output?.statusCode === 400) {
            await sock.sendMessage(chatId, { 
                text: '❌ *Action failed:* I need to be an admin to change the group link.' 
            }, { quoted: msg });
        } else {
            await sock.sendMessage(chatId, { text: `❌ Failed to change link: ${err.message}` }, { quoted: msg });
        }
    }
}

module.exports = { name, aliases, desc, category, execute };
