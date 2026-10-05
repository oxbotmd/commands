/**
 * commands/circle.js — Get User Profile Picture (Bulletproof)
 * Aliases: .circle, .pp, .pfp, .profilepic, .getpp
 *
 * FIXED: JIDs are now normalized (jidNormalizedUser) before calling
 * profilePictureUrl — un-normalized JIDs with a device suffix silently
 * fail the query.
 *
 * FIXED: @lid participants are no longer given up on immediately. We
 * try to resolve their real jid via the group's participant list first
 * and retry the picture fetch with that — this is also why the caption
 * now shows their actual number instead of the generic "Linked Device
 * User" label.
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    // By default, get the sender's own PP
    let targetJid = msg.key.participant || msg.key.remoteJid;

    // If the user replied to someone or tagged someone, get THEIR PP instead
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    if (contextInfo) {
        if (contextInfo.participant) {
            targetJid = contextInfo.participant;
        } else if (contextInfo.mentionedJid && contextInfo.mentionedJid.length > 0) {
            targetJid = contextInfo.mentionedJid[0];
        }
    }

    // Safety check
    if (!targetJid || !targetJid.includes('@')) {
        return await sock.sendMessage(chatId, {
            text: '❌ Could not identify the user. Reply to their message or tag them.'
        }, { quoted: msg });
    }

    // Normalize before use — strips any device suffix that breaks the query.
    try {
        targetJid = jidNormalizedUser(targetJid);
    } catch {
        // fall through with raw jid if normalization itself throws
    }

    try {
        let ppUrl = null;

        // Attempt 1: Standard high-quality image fetch
        try {
            ppUrl = await sock.profilePictureUrl(targetJid, 'image');
        } catch (e) {
            // Attempt 2: Fallback to 'preview' if 'image' fails (fixes many recent WA API restrictions)
            try {
                ppUrl = await sock.profilePictureUrl(targetJid, 'preview');
            } catch (err) {
                ppUrl = null; // Both failed
            }
        }

        // If this is a @lid jid and we still don't have a picture, resolve
        // it to the real jid via the group's participant list and retry —
        // this is what lets both the picture AND the real name resolve.
        if (!ppUrl && targetJid.includes('@lid') && chatId?.endsWith('@g.us')) {
            try {
                const meta = await sock.groupMetadata(chatId);
                const p = (meta.participants || []).find(x => x.id === targetJid);
                const realJidRaw = p?.jid || p?.phoneNumber || null;
                const realJid = realJidRaw ? jidNormalizedUser(realJidRaw) : null;

                if (realJid && realJid !== targetJid) {
                    try {
                        ppUrl = await sock.profilePictureUrl(realJid, 'image');
                    } catch {
                        try {
                            ppUrl = await sock.profilePictureUrl(realJid, 'preview');
                        } catch {
                            ppUrl = null;
                        }
                    }
                    if (ppUrl) targetJid = realJid;
                }
            } catch (err) {
                console.error('[circle] lid resolve failed:', err.message);
            }
        }

        if (!ppUrl) {
            return await sock.sendMessage(chatId, {
                text: '❌ No profile picture found. They might have it hidden from everyone or removed it.'
            }, { quoted: msg });
        }

        // Name for the caption — always the resolved jid's number now,
        // no more generic "Linked Device User" placeholder.
        const senderName = targetJid.split('@')[0];

        // Send the profile picture
        await sock.sendMessage(chatId, {
            image: { url: ppUrl },
            caption: `📷 *Profile Picture*\n\n🪪 @${senderName}`,
            mentions: [targetJid]
        }, { quoted: msg });

    } catch (error) {
        console.error('[circle] Error:', error.message);
        await sock.sendMessage(chatId, {
            text: '❌ Failed to fetch profile picture due to a network error or WhatsApp restrictions.'
        }, { quoted: msg });
    }

    return null;
}

module.exports = {
    name: 'circle',
    aliases: ['pp', 'pfp', 'profilepic', 'getpp'],
    desc: 'Get user profile picture (reply to user or tag them)',
    category: 'general',
    execute
};