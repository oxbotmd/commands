/**
 * delete.js — Delete a message for everyone
 * Aliases: .delete, .del
 * 
 * Works in both Groups and Private Chats.
 * ⚠️ Can ONLY delete messages sent by the bot or by the user using the command.
 */

// Helper to extract the Quoted Message ID safely across all message types
function getQuotedMessageId(msg) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo || 
               msg.message?.imageMessage?.contextInfo || 
               msg.message?.videoMessage?.contextInfo;
    
    if (!ctx) return null;
    
    // The stanzaId is the true ID of the quoted message
    if (ctx.stanzaId) return ctx.stanzaId;
    
    // Fallback to participant message ID if available
    if (ctx.participantMessage?.key?.id) return ctx.participantMessage.key.id;
    
    return null;
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    // Must be a reply to a message
    const quotedId = getQuotedMessageId(msg);
    if (!quotedId) {
        return await sock.sendMessage(chatId, { 
            text: '❌ *Reply to the message you want to delete and type .delete*' 
        }, { quoted: msg });
    }

    try {
        // METHOD 1: Standard Baileys chatModify (Most reliable)
        await sock.chatModify(chatId, quotedId, 'delete');
        console.log(`[Delete] Successfully deleted ${quotedId} using chatModify`);
        
        try { 
            await sock.sendMessage(chatId, { react: { text: '🗑️', key: msg.key } }); 
        } catch {}
        
        return null;

    } catch (err) {
        console.error('[Delete] Method 1 failed:', err.message);

        // METHOD 2: Fallback using message protocol (Sometimes bypasses chatModify bugs)
        try {
            await sock.sendMessage(chatId, {
                delete: {
                    id: quotedId,
                    remoteJid: chatId,
                    fromMe: msg.key.fromMe || false
                }
            });
            console.log(`[Delete] Successfully deleted ${quotedId} using protocol method`);
            
            try { 
                await sock.sendMessage(chatId, { react: { text: '🗑️', key: msg.key } }); 
            } catch {}
            
            return null;

        } catch (err2) {
            console.error('[Delete] Method 2 failed:', err2.message);

            // Give specific feedback based on the error
            let errorMessage = `❌ *Failed to delete message*\n\n_${err.message}_`;
            
            if (err?.message?.includes('not-authorized') || 
                err?.output?.statusCode === 403 || 
                err2?.message?.includes('not-authorized') || 
                err2?.output?.statusCode === 403) {
                errorMessage = '❌ *Permission Denied*\n\n_WhatsApp blocked the delete request._\n\n_Note: You can only delete messages sent by YOU or by THIS BOT. You cannot delete other people\'s messages._';
            } else if (err?.message?.includes('timed-out') || err2?.message?.includes('timed-out')) {
                errorMessage = '❌ *Delete timed out*\n\n_The message is too old (older than a few hours) or there is a network issue._';
            }

            return await sock.sendMessage(chatId, { text: errorMessage }, { quoted: msg });
        }
    }
}

module.exports = {
    name: 'delete',
    aliases: ['del'],
    desc: 'Delete a replied message for everyone (DMs & Groups)',
    category: 'general',
    execute
};