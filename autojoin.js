/**
 * autojoin.js — Auto-Add Bot Owners (from `bots` table) to Current Group
 * Aliases: .autojoin, .massadd, .addall
 */

const SESSION_PREFIX      = 'oxbot_';
const DEFAULT_MAX_ADDS    = 20;
const HARD_MAX_ADDS       = 40;   
const MIN_DELAY_MS        = 18000; // ~18s
const MAX_DELAY_MS        = 22000; // ~22s 
const CONSECUTIVE_FAIL_LIMIT = 4; // abort run if this many fails happen back-to-back

// ✅ Robust JID cleaner
function cleanNum(jid) {
    if (!jid) return '';
    return jid.replace(/[^0-9]/g, '');
}

// Strips the "oxbot_" session prefix to recover the raw phone number
function sessionIdToPhone(sessionId) {
    if (!sessionId) return null;
    return sessionId.startsWith(SESSION_PREFIX)
        ? sessionId.slice(SESSION_PREFIX.length)
        : sessionId;
}

// Converts raw DB phone numbers to proper WhatsApp JIDs
function cleanToJid(input) {
    if (!input) return null;

    let num = String(input).replace(/[^0-9]/g, '');

    // Handle numbers that might have country codes but no leading 0
    if (num.startsWith('0') && num.length > 10) {
        num = num.slice(1);
    }

    // Basic validation (must be between 10 and 15 digits)
    if (num.length < 10 || num.length > 15) return null;

    return `${num}@s.whatsapp.net`;
}

// Fisher-Yates shuffle — avoids adding people in predictable DB row order
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function randomDelay(min, max) {
    return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!chatId.endsWith('@g.us')) {
        return await sock.sendMessage(chatId, { text: '❌ Group only command!' }, { quoted: msg });
    }

    const senderId = msg.key.participant || msg.key.remoteJid;
    const db = botData?.db;

    // ═══════════════════════════════════════════════════════════════
    // SECURITY CHECK (Owner/Admin only)
    // ═══════════════════════════════════════════════════════════════
    let isAllowed = msg.key.fromMe;
    if (!isAllowed) {
        const ownerPhone = sock._ownerPhone;
        const senderNum = cleanNum(senderId);
        const ownerNum  = ownerPhone ? cleanNum(ownerPhone) : '';

        if (senderNum && ownerNum) {
            const sNorm = senderNum.startsWith('0') ? senderNum.slice(1) : senderNum;
            const oNorm = ownerNum.startsWith('0') ? ownerNum.slice(1) : ownerNum;
            isAllowed = sNorm === oNorm || sNorm.endsWith(oNorm) || oNorm.endsWith(sNorm);
        }
    }

    if (!isAllowed) {
        try {
            const meta = await sock.groupMetadata(chatId);
            const senderNum = cleanNum(senderId);
            const senderIsAdmin = meta.participants?.some(p =>
                cleanNum(p.id) === senderNum &&
                (p.admin === 'admin' || p.admin === 'superadmin')
            );
            if (!senderIsAdmin) {
                return await sock.sendMessage(chatId, { text: '❌ Only group admins or owner can use this command!' }, { quoted: msg });
            }
        } catch {
            return await sock.sendMessage(chatId, { text: '❌ Could not verify admin status.' }, { quoted: msg });
        }
    }

    if (!db || !db.query) {
        return await sock.sendMessage(chatId, { text: '❌ Database error.' }, { quoted: msg });
    }

    // ═══════════════════════════════════════════════════════════════
    // PARSE OPTIONAL LIMIT (e.g. ".autojoin 15")
    // ═══════════════════════════════════════════════════════════════
    let maxAdds = DEFAULT_MAX_ADDS;
    if (args[0] && !isNaN(parseInt(args[0]))) {
        maxAdds = Math.min(Math.max(parseInt(args[0]), 1), HARD_MAX_ADDS);
    }

    await sock.sendMessage(chatId, {
        text: `⏳ *Auto-Join Initiated*\n\nScanning bots table for valid numbers (max ${maxAdds} this run)...`
    }, { quoted: msg });

    try {
        const allJids = new Set();

        // ═══════════════════════════════════════════════════════════════
        // FETCH FROM 'bots' TABLE (session_id -> phone number)
        // ═══════════════════════════════════════════════════════════════
        try {
            const [bots] = await db.query('SELECT session_id FROM bots WHERE session_id IS NOT NULL');
            if (bots && bots.length > 0) {
                bots.forEach(row => {
                    const phone = sessionIdToPhone(row.session_id);
                    const jid = cleanToJid(phone);
                    if (jid) allJids.add(jid);
                });
            }
        } catch (err) {
            console.error('[autojoin] Error fetching bots table:', err.message);
            return await sock.sendMessage(chatId, {
                text: `⚠️ Database error: Could not read bots table.\n\n_Detail: ${err.message}_`
            }, { quoted: msg });
        }

        // ═══════════════════════════════════════════════════════════════
        // EXCLUDE PEOPLE ALREADY IN THE GROUP
        // ═══════════════════════════════════════════════════════════════
        try {
            const groupMeta = await sock.groupMetadata(chatId);
            const currentMembers = new Set(groupMeta.participants.map(p => p.id));
            for (const jid of allJids) {
                if (currentMembers.has(jid)) allJids.delete(jid);
            }
        } catch (err) {
            console.log('[autojoin] Could not fetch current group members, adding all bot owners.');
        }

        if (allJids.size === 0) {
            return await sock.sendMessage(chatId, {
                text: '⚠️ *No valid users to add.*\n\nEither the bots table is empty, or all users are already in the group.'
            }, { quoted: msg });
        }

        // ═══════════════════════════════════════════════════════════════
        // PRE-CHECK VIA onWhatsApp()
        // ═══════════════════════════════════════════════════════════════
        let candidateJids = [...allJids];
        try {
            const checkResults = await sock.onWhatsApp(...candidateJids);
            const registered = new Set(
                (checkResults || [])
                    .filter(r => r.exists)
                    .map(r => r.jid)
            );
            if (registered.size > 0) {
                candidateJids = candidateJids.filter(j => registered.has(j));
            }
        } catch (err) {
            console.log('[autojoin] onWhatsApp pre-check failed, proceeding without filter:', err.message);
        }

        // Shuffle and cap
        const jidArray = shuffle(candidateJids).slice(0, maxAdds);

        if (jidArray.length === 0) {
            return await sock.sendMessage(chatId, {
                text: '⚠️ *No valid users to add* after checking WhatsApp registration.'
            }, { quoted: msg });
        }

        await sock.sendMessage(chatId, {
            text: `📊 Found *${jidArray.length}* users to add.\n\n🔄 Adding them 1 by 1 with ~20s delays...\n\n_Please wait..._`
        }, { quoted: msg });

        // ═══════════════════════════════════════════════════════════════
        // PROCESS USERS ONE BY ONE
        // ═══════════════════════════════════════════════════════════════
        let addedCount = 0;
        let failedCount = 0;
        let consecutiveFails = 0;
        let abortedEarly = false;
        const errorReasons = {
            '403': 0,
            '408': 0,
            '409': 0,
            'other': 0
        };

        for (let i = 0; i < jidArray.length; i++) {
            const jid = jidArray[i];

            if (i > 0 && i % 5 === 0) {
                try {
                    await sock.sendMessage(chatId, {
                        text: `⏳ _Adding ${i}/${jidArray.length}..._`
                    });
                } catch {}
            }

            let thisFailed = false;

            try {
                const response = await sock.groupParticipantsUpdate(chatId, [jid], 'add');

                if (Array.isArray(response)) {
                    for (const res of response) {
                        if (res.status === '200' || res.status === 200) {
                            addedCount++;
                        } else {
                            thisFailed = true;
                            failedCount++;
                            const errCode = String(res.status);
                            if (errCode === '403') errorReasons['403']++;
                            else if (errCode === '408') errorReasons['408']++;
                            else if (errCode === '409') errorReasons['409']++;
                            else errorReasons['other']++;

                            console.log(`[autojoin] Failed to add ${jid}: Status ${res.status}`);
                        }
                    }
                } else {
                    thisFailed = true;
                    failedCount++;
                    errorReasons['other']++;
                }
            } catch (err) {
                thisFailed = true;
                failedCount++;
                errorReasons['other']++;
                console.error(`[autojoin] Baileys error for ${jid}:`, err.message);
            }

            // CIRCUIT BREAKER
            if (thisFailed) {
                consecutiveFails++;
                if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
                    abortedEarly = true;
                    await sock.sendMessage(chatId, {
                        text: `🛑 *Stopping early* — ${CONSECUTIVE_FAIL_LIMIT} adds failed in a row.\n\nWhatsApp is temporarily blocking adds from this number. Wait a few hours before trying again.`
                    }, { quoted: msg });
                    break;
                }
            } else {
                consecutiveFails = 0;
            }

            if (i < jidArray.length - 1 && !abortedEarly) {
                await randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // FINAL RESULT
        // ═══════════════════════════════════════════════════════════════
        let resultText = abortedEarly
            ? `⚠️ *Auto-Join Stopped Early*\n\n`
            : `✅ *Auto-Join Complete!*\n\n`;
        resultText += `✅ Successfully Added: *${addedCount}*\n`;
        resultText += `❌ Failed: *${failedCount}*\n`;
        resultText += `📊 Total Processed: *${addedCount + failedCount}*/${jidArray.length}\n`;

        if (failedCount > 0) {
            resultText += `\n⚠️ *Why did some fail?*\n`;
            if (errorReasons['403'] > 0) resultText += `• _${errorReasons['403']} users have strict privacy settings (not in contacts).\n`;
            if (errorReasons['408'] > 0) resultText += `• _${errorReasons['408']} numbers might not be registered on WhatsApp.\n`;
            if (errorReasons['409'] > 0) resultText += `• _${errorReasons['409']} were already in the group.\n`;
            if (errorReasons['other'] > 0) resultText += `• _${errorReasons['other']} failed for unknown reasons (network/API error).\n`;
        }

        await sock.sendMessage(chatId, { text: resultText }, { quoted: msg });
        return null;

    } catch (err) {
        console.error('[autojoin] Critical error:', err.message);

        if (err?.message?.includes('not-admin') || err?.message?.includes('403') || err?.output?.statusCode === 403) {
            return await sock.sendMessage(chatId, {
                text: '❌ *Permission Denied*\n\n_The bot MUST be an Admin in this group to add participants._'
            }, { quoted: msg });
        }

        return await sock.sendMessage(chatId, {
            text: `❌ An unexpected error occurred:\n_${err.message}_`
        }, { quoted: msg });
    }
}

module.exports = {
    name:     'autojoin',
    aliases:  ['massadd', 'addall'],
    desc:     'Fetch bot owner numbers from the bots table and add them to the current group',
    category: 'owner',
    execute
};
