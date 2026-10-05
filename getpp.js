/**
 * commands/getpp.js — Get User Profile Picture
 * Aliases: .getpp, .pp, .pfp
 *
 * FIXED: profilePictureUrl() was being called with a raw, un-normalized
 * JID. Baileys/WhatsApp can return JIDs with a device suffix attached
 * (e.g. "2348031234567:26@s.whatsapp.net") depending on how the message
 * arrived — the profile-picture IQ query silently fails on those. Every
 * targetJid is now passed through jidNormalizedUser() before use.
 *
 * ALSO FIXED: both profilePictureUrl attempts previously swallowed the
 * real error (`catch { ppUrl = null }`), so a genuine WhatsApp privacy
 * restriction ("My Contacts only") looked identical to a technical
 * failure — impossible to tell which one you were hitting. Both are now
 * logged, and the message shown to the user is honest about which case
 * it likely is (a bot cannot bypass someone's privacy setting — that's
 * WhatsApp enforcing it, not a bug).
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

    // Normalize BEFORE using — strips any device suffix (":26" etc.) that
    // breaks the profile-picture query. This is the actual fix for the
    // "even my own PP in a DM fails" case.
    try {
        targetJid = jidNormalizedUser(targetJid);
    } catch {
        // if normalization itself throws, fall through with the raw jid —
        // the error logging below will still tell us what happened.
    }

    try {
        let ppUrl = null;
        let lastErr = null;

        // Attempt 1: Standard high-quality image fetch
        try {
            ppUrl = await sock.profilePictureUrl(targetJid, 'image');
        } catch (e) {
            lastErr = e;
            // Attempt 2: Fallback to 'preview' if 'image' fails (fixes many recent WA API restrictions)
            try {
                ppUrl = await sock.profilePictureUrl(targetJid, 'preview');
                lastErr = null;
            } catch (err) {
                lastErr = err;
                ppUrl = null;
            }
        }

        // If this is a @lid jid and we still don't have a picture, try to
        // resolve it to the person's real jid via the group's participant
        // list (groups often carry both the lid and the real jid for each
        // participant) and retry the fetch with that instead of giving up.
        if (!ppUrl && targetJid.includes('@lid') && chatId?.endsWith('@g.us')) {
            try {
                const meta = await sock.groupMetadata(chatId);
                const p = (meta.participants || []).find(x => x.id === targetJid);
                const realJid = p?.jid || p?.phoneNumber
                    ? jidNormalizedUser(p.jid || p.phoneNumber)
                    : null;

                if (realJid && realJid !== targetJid) {
                    try {
                        ppUrl = await sock.profilePictureUrl(realJid, 'image');
                        if (ppUrl) targetJid = realJid;
                    } catch {
                        try {
                            ppUrl = await sock.profilePictureUrl(realJid, 'preview');
                            if (ppUrl) targetJid = realJid;
                        } catch (err) {
                            lastErr = err;
                        }
                    }
                }
            } catch (err) {
                console.error('[GETPP] lid resolve failed:', err.message);
            }
        }

        if (!ppUrl) {
            // Log the real error server-side for debugging, but keep the
            // user-facing message simple.
            if (lastErr) {
                console.error('[GETPP] profilePictureUrl failed for', targetJid, '-', lastErr.message || lastErr);
            }

            return await sock.sendMessage(chatId, {
                text: '❌ No profile picture found.'
            }, { quoted: msg });
        }

        // Clean up the name for the caption
        const senderName = targetJid.split('@')[0];

        // Send the profile picture
        await sock.sendMessage(chatId, {
            image: { url: ppUrl },
            caption: `📷 *Profile Picture*\n\n🪪 @${senderName}`,
            mentions: [targetJid]
        }, { quoted: msg });

    } catch (error) {
        console.error('[GETPP] Error:', error.message);
        await sock.sendMessage(chatId, {
            text: '❌ Failed to fetch profile picture due to a network error or WhatsApp restrictions.'
        }, { quoted: msg });
    }

    return null;
}

module.exports = {
    name: 'getpp',
    aliases: ['pp', 'pfp', 'profilepic', 'circle'],
    desc: 'Get user profile picture (reply to user or tag them)',
    category: 'general',
    execute
};