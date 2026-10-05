/**
 * OxBot — Bank Account Saver
 * Users can save their bank account details per bot session
 *
 * Usage:
 *   .account save <name> | <number> | <bank>
 *   .account
 *   .account view
 *   .account delete
 *   .account list          (owner only)
 */

// ── Strip device/LID suffix so JIDs always compare cleanly ──
function cleanNumber(jid) {
    if (!jid) return '';
    return jid.split(':')[0].split('@')[0];
}

// ── Fetch owner phone from users table for this session ──
async function getOwnerNumber(db, sessionId) {
    try {
        const [rows] = await db.query(
            'SELECT u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ? LIMIT 1',
            [sessionId]
        );
        if (!rows.length || !rows[0].phone) return null;
        return String(rows[0].phone).replace(/\D/g, '');
    } catch (err) {
        console.error('[account] DB error fetching owner:', err.message);
        return null;
    }
}

// ── Check if sender is the owner for this session ──
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
            console.error('[account] Group LID check error:', e.message);
        }
    }

    return false;
}

// ── Get actual DB session ID (handles oxbot_ prefix mismatch) ──
async function getActualDbSessionId(db, sessionId) {
    try {
        let [rows] = await db.query(
            'SELECT session_id FROM bots WHERE session_id = ? LIMIT 1',
            [sessionId]
        );
        if (rows.length) return rows[0].session_id;

        if (!String(sessionId).startsWith('oxbot_')) {
            [rows] = await db.query(
                'SELECT session_id FROM bots WHERE session_id = ? LIMIT 1',
                [`oxbot_${sessionId}`]
            );
            if (rows.length) return rows[0].session_id;
        }
        return sessionId;
    } catch (err) {
        console.error('[account] getActualDbSessionId error:', err.message);
        return sessionId;
    }
}

// ── Get sender's phone number (cleaned) ──
function getSenderPhone(senderId) {
    return cleanNumber(senderId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ ACTIONS ★
// ═══════════════════════════════════════════════════════════════════════════════

// ── Save / Update account ──
async function saveAccount(db, sessionId, phone, accountName, accountNumber, bankName) {
    await db.query(
        `INSERT INTO bank_accounts (session_id, phone, account_name, account_number, bank_name)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            account_name = VALUES(account_name),
            account_number = VALUES(account_number),
            bank_name = VALUES(bank_name),
            updated_at = NOW()`,
        [sessionId, phone, accountName, accountNumber, bankName]
    );
}

// ── Get single user's account ──
async function getAccount(db, sessionId, phone) {
    const [rows] = await db.query(
        'SELECT * FROM bank_accounts WHERE session_id = ? AND phone = ? LIMIT 1',
        [sessionId, phone]
    );
    return rows.length ? rows[0] : null;
}

// ── Delete user's account ──
async function deleteAccount(db, sessionId, phone) {
    const [result] = await db.query(
        'DELETE FROM bank_accounts WHERE session_id = ? AND phone = ?',
        [sessionId, phone]
    );
    return result.affectedRows > 0;
}

// ── Get all accounts for a session (owner list) ──
async function getAllAccounts(db, sessionId) {
    const [rows] = await db.query(
        'SELECT * FROM bank_accounts WHERE session_id = ? ORDER BY created_at DESC',
        [sessionId]
    );
    return rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ MAIN COMMAND ★
// ═══════════════════════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!botData?.sessionId || !botData?.db) {
        await sock.sendMessage(chatId, {
            text: '⚠️ Database error. Please restart the bot.'
        }, { quoted: msg });
        return null;
    }

    const db = botData.db;
    const actualSessionId = await getActualDbSessionId(db, botData.sessionId);
    const senderId = msg.key.participant || msg.key.remoteJid;
    const senderPhone = getSenderPhone(senderId);
    const senderIsOwner = await isOwner(db, botData.sessionId, senderId, sock, chatId);

    const action = (args[0] || '').toLowerCase();

    // ── SAVE ──
    if (action === 'save') {
        // Expect: .account save John Doe | 1234567890 | GTBank
        const rawInput = args.slice(1).join(' ');
        const parts = rawInput.split('|').map(s => s.trim());

        if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) {
            return await sock.sendMessage(chatId, {
                text: `❌ *Invalid format!*\n\n_Usage:_\n\`.account save <name> | <number> | <bank>\`\n\n_Example:_\n\`.account save John Doe | 1234567890 | GTBank\``
            }, { quoted: msg });
        }

        const accountName   = parts[0].replace(/\s+/g, ' ').trim();
        const accountNumber = parts[1].trim();
        const bankName      = parts[2].replace(/\s+/g, ' ').trim();

        // Basic validation
        if (!/^[0-9]{5,20}$/.test(accountNumber)) {
            return await sock.sendMessage(chatId, {
                text: '❌ *Invalid account number!*\n\n_Account number must be 5-20 digits only._'
            }, { quoted: msg });
        }

        if (accountName.length < 2 || accountName.length > 255) {
            return await sock.sendMessage(chatId, {
                text: '❌ *Invalid account name!*\n\n_Must be between 2-255 characters._'
            }, { quoted: msg });
        }

        if (bankName.length < 2 || bankName.length > 100) {
            return await sock.sendMessage(chatId, {
                text: '❌ *Invalid bank name!*\n\n_Must be between 2-100 characters._'
            }, { quoted: msg });
        }

        try {
            await saveAccount(db, actualSessionId, senderPhone, accountName, accountNumber, bankName);
        } catch (err) {
            console.error('[account] DB error (save):', err.message);
            return await sock.sendMessage(chatId, {
                text: '❌ Failed to save account. Try again later.'
            }, { quoted: msg });
        }

        return await sock.sendMessage(chatId, {
            text: `✅ *Account Saved Successfully!*\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━\n` +
                  `📂 *Account Name:* ${accountName}\n` +
                  `🔢 *Account Number:* ${accountNumber}\n` +
                  `🏦 *Bank:* ${bankName}\n` +
                  `━━━━━━━━━━━━━━━━━━━━\n\n` +
                  `_Use \`.account\` to view anytime._`
        }, { quoted: msg });
    }

    // ── DELETE ──
    if (action === 'delete' || action === 'remove') {
        try {
            const deleted = await deleteAccount(db, actualSessionId, senderPhone);
            if (!deleted) {
                return await sock.sendMessage(chatId, {
                    text: '❌ You have no saved account to delete.'
                }, { quoted: msg });
            }
        } catch (err) {
            console.error('[account] DB error (delete):', err.message);
            return await sock.sendMessage(chatId, {
                text: '❌ Failed to delete account. Try again later.'
            }, { quoted: msg });
        }

        return await sock.sendMessage(chatId, {
            text: '🗑️ *Account deleted successfully!*\n\n_Use `.account save` to add a new one._'
        }, { quoted: msg });
    }

    // ── LIST (Owner Only) ──
    if (action === 'list' || action === 'all') {
        if (!msg.key.fromMe && !senderIsOwner) {
            return await sock.sendMessage(chatId, {
                text: '❌ Only the bot owner can view all saved accounts.'
            }, { quoted: msg });
        }

        try {
            const accounts = await getAllAccounts(db, actualSessionId);

            if (!accounts.length) {
                return await sock.sendMessage(chatId, {
                    text: '📭 No accounts saved yet.'
                }, { quoted: msg });
            }

            let text = `📋 *All Saved Accounts (${accounts.length})*\n\n`;
            accounts.forEach((acc, i) => {
                const maskedPhone = acc.phone.slice(0, 3) + '****' + acc.phone.slice(-2);
                text += `*${i + 1}.* ${acc.account_name}\n`;
                text += `   🔢 ${acc.account_number}\n`;
                text += `   🏦 ${acc.bank_name}\n`;
                text += `   👤 ${maskedPhone}\n\n`;
            });

            text += `_Use \`.account\` to view your own._`;

            return await sock.sendMessage(chatId, { text }, { quoted: msg });
        } catch (err) {
            console.error('[account] DB error (list):', err.message);
            return await sock.sendMessage(chatId, {
                text: '❌ Failed to fetch accounts. Try again later.'
            }, { quoted: msg });
        }
    }

    // ── VIEW (no action or "view") ──
    if (!action || action === 'view') {
        try {
            const account = await getAccount(db, actualSessionId, senderPhone);

            if (!account) {
                return await sock.sendMessage(chatId, {
                    text: `📭 *No account saved yet!*\n\n` +
                          `_Save your account with:_\n\`.account save <name> | <number> | <bank>\`\n\n` +
                          `_Example:_\n\`.account save John Doe | 1234567890 | GTBank\``
                }, { quoted: msg });
            }

            return await sock.sendMessage(chatId, {
                text: `💳 *Your Bank Account*\n\n` +
                      `━━━━━━━━━━━━━━━━━━━━\n` +
                      `📂 *Account Name:* ${account.account_name}\n` +
                      `🔢 *Account Number:* ${account.account_number}\n` +
                      `🏦 *Bank:* ${account.bank_name}\n` +
                      `━━━━━━━━━━━━━━━━━━━━\n\n` +
                      `_Saved: ${account.created_at.toISOString().split('T')[0]}_\n` +
                      `_Updated: ${account.updated_at.toISOString().split('T')[0]}_`
            }, { quoted: msg });
        } catch (err) {
            console.error('[account] DB error (view):', err.message);
            return await sock.sendMessage(chatId, {
                text: '❌ Failed to fetch your account. Try again later.'
            }, { quoted: msg });
        }
    }

    // ── Unknown action ──
    return await sock.sendMessage(chatId, {
        text: `❌ *Unknown action!*\n\n` +
              `_Available commands:_\n` +
              `\`.account save <name> | <number> | <bank>\`\n` +
              `\`.account\` — view your account\n` +
              `\`.account delete\` — remove your account\n` +
              `\`.account list\` — view all (owner only)`
    }, { quoted: msg });
}

// ── Module exports ──
module.exports = {
    name: 'account',
    execute: execute,
    desc: 'Save & view bank account details',
    category: 'utility',
    aliases: ['bank', 'acc']
};