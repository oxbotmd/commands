/**
 * commands/poll.js
 * Create native WhatsApp polls (Fixed for Baileys)
 */

const name     = 'poll';
const desc     = '📊 Create a poll with options';
const category = 'general';

// ═══════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;

    if (!args.length) {
        return await sock.sendMessage(chatId, {
            text: `📊 *Poll Creator*\n\n` +
                  `📌 *Usage:*\n` +
                  `\`.poll Question | Option1 | Option2 | Option3\`\n\n` +
                  `📋 *Example:*\n` +
                  `\`.poll Who is the GOAT? | Messi | Ronaldo | Neymar\`\n\n` +
                  `⚙️ *Options:*\n` +
                  `• Minimum: 2 options\n` +
                  `• Maximum: 12 options\n` +
                  `• Separate with \`|\`\n\n` +
                  `💡 *Tip:* Add \`multi\` at the end to allow multiple selections\n` +
                  `\`.poll Best colors? | Red | Blue | Green | multi\``
        }, { quoted: msg });
    }

    const fullText = args.join(' ');

    // Split by pipe character
    const parts = fullText.split('|').map(p => p.trim()).filter(p => p.length > 0);

    if (parts.length < 3) {
        return await sock.sendMessage(chatId, {
            text: `❌ *Need at least a question + 2 options!*\n\n` +
                  `📌 *Usage:*\n\`.poll Question | Option1 | Option2\`\n\n` +
                  `📋 *Example:*\n\`.poll Who is the best? | Yes | No\``
        }, { quoted: msg });
    }

    // Check if "multi" flag is at the end
    const lastPart = parts[parts.length - 1].toLowerCase();
    let allowMultiple = false;
    let options = parts.slice(1);

    if (lastPart === 'multi' || lastPart === 'multiple') {
        allowMultiple = true;
        options = parts.slice(1, -1);
    }

    if (options.length < 2) {
        return await sock.sendMessage(chatId, {
            text: `❌ *Need at least 2 options!*\n\nYou only provided: ${options.length}`
        }, { quoted: msg });
    }

    if (options.length > 12) {
        return await sock.sendMessage(chatId, {
            text: `❌ *Maximum 12 options allowed!*\n\nYou provided: ${options.length}\nPlease remove ${options.length - 12} option(s).`
        }, { quoted: msg });
    }

    // Check for duplicate options
    const seen = new Set();
    const duplicates = [];
    for (const opt of options) {
        const lower = opt.toLowerCase();
        if (seen.has(lower)) {
            duplicates.push(opt);
        }
        seen.add(lower);
    }

    if (duplicates.length > 0) {
        return await sock.sendMessage(chatId, {
            text: `❌ *Duplicate options found!*\n\nDuplicates: ${duplicates.join(', ')}\n\nPlease use unique options.`
        }, { quoted: msg });
    }

    const question = parts[0].substring(0, 255); // WhatsApp limit is 255 chars for question

    // ✅ FIXED: Baileys expects plain strings here — it internally does
    // `message.poll.values.map(optionName => ({ optionName }))` to build
    // the real WA poll structure. Passing objects (the old `pollOptions`
    // shape) or the wrong key name (`options` instead of `values`) meant
    // this array was always undefined on Baileys' side.
    const pollValues = options.map(opt => opt.substring(0, 100)); // truncate to 100 chars to be safe

    try {
        // ✅ FIXED: field is `selectableCount`, NOT `selectableOptionsCount`.
        // 1 = single choice. For multi-select, 0 means "no limit" (any
        // number of options can be picked) — using options.length works
        // too but 0 is the more standard "unlimited" value.
        const selectableCount = allowMultiple ? 0 : 1;

        await sock.sendMessage(chatId, {
            poll: {
                name: question,
                values: pollValues,
                selectableCount: selectableCount
            }
        });

        // Send confirmation
        const senderName = msg.pushName || 'Someone';
        await sock.sendMessage(chatId, {
            text: `📊 *Poll Created!*\n\n` +
                  `👤 *By:* ${senderName}\n` +
                  `❓ *Question:* ${question}\n` +
                  `🔢 *Options:* ${options.length}\n` +
                  `${allowMultiple ? '✅ *Multiple votes allowed*' : '☑️ *Single vote only*'}`
        }, { quoted: msg });

    } catch (err) {
        console.error('[poll] Error:', err.message);
        await sock.sendMessage(chatId, {
            text: `❌ *Failed to create poll!*\n\n` +
                  `⚠️ Error: ${err.message}\n\n` +
                  `💡 *Make sure:*\n` +
                  `• You're in a group (polls work best in groups)\n` +
                  `• Options are not too long (max 100 characters)\n` +
                  `• Question is not too long (max 255 characters)`
        }, { quoted: msg });
    }
}

module.exports = { name, desc, category, execute };
