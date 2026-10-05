/**
 * commands/groupicon.js
 * Change the group profile picture (Admins only)
 */

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const name     = 'groupicon';
const desc     = 'Change group profile picture';
const category = 'group';

// ✅ Robust JID cleaner (strips @s.whatsapp.net, @lid, :0)
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
    
    // 2. Fast owner check using socket identity
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

    // 3. If NOT the owner, check if sender is a Group Admin
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

    // 4. Find the image source (Reply to image OR sent with image)
    let imageMessage = null;
    let imageSource = '';

    // Check if the current message has an image attached
    if (msg.message?.imageMessage) {
        imageMessage = msg.message.imageMessage;
        imageSource = 'current';
    }
    // Check if replying to a message that has an image
    else if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
        imageMessage = msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
        imageSource = 'quoted';
    }

    // No image found
    if (!imageMessage) {
        return await sock.sendMessage(chatId, { 
            text: '❌ No image found!\n\n_Send or reply to an image with: _ *.groupicon*' 
        }, { quoted: msg });
    }

    // 5. Download the image buffer
    let buffer;
    try {
        const stream = await downloadContentFromMessage(imageMessage, 'image');
        buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
    } catch (err) {
        return await sock.sendMessage(chatId, { 
            text: `❌ Failed to download image: ${err.message}` 
        }, { quoted: msg });
    }

    if (!buffer || buffer.length === 0) {
        return await sock.sendMessage(chatId, { text: '❌ Downloaded image is empty.' }, { quoted: msg });
    }

    // 6. Update the group icon
    try {
        await sock.updateProfilePicture(chatId, buffer);
        
        await sock.sendMessage(chatId, {
            text: `✅ *Group icon updated!*${imageSource === 'quoted' ? ' _(from replied image)_' : ''}\n👑 *By:* @${cleanNum(senderId)}`,
            mentions: [senderId]
        }, { quoted: msg });
    } catch (err) {
        // If WhatsApp rejects it, bot is probably not admin
        if (err?.message?.includes('not-admin') || err?.output?.statusCode === 400) {
            await sock.sendMessage(chatId, { 
                text: '❌ *Failed:* I need to be an admin to change the group icon.\n\n_⚠️ If you just made me admin, REMOVE and ADD me back to fix this._' 
            }, { quoted: msg });
        } else {
            await sock.sendMessage(chatId, { 
                text: `❌ Failed to update icon: ${err.message}` 
            }, { quoted: msg });
        }
    }
}

module.exports = { name, desc, category, execute };