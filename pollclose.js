/**
 * commands/pollclose.js
 * Reply to a poll message with .pollclose to tally and announce final results.
 *
 * ⚠️ IMPORTANT LIMITATION: WhatsApp has no API for a bot to remotely force a
 * poll closed on other people's phones — that's not something Baileys, or
 * any bot, can do. This command tallies the votes we've SEEN so far (via
 * the pollStore in poll.js) and announces them as final. The poll itself
 * will still visually appear "open" in everyone's WhatsApp app; this just
 * gives you an official results announcement to treat it as closed by
 * convention. Requires the poll to have been created by THIS bot's .poll
 * command during the CURRENT process run (data is in-memory, lost on restart).
 */

const { pollStore } = require('./poll');

let getAggregateVotesInPollMessage;
try {
    ({ getAggregateVotesInPollMessage } = require('@whiskeysockets/baileys'));
} catch (err) {
    console.error('[pollclose] Could not load getAggregateVotesInPollMessage from baileys:', err.message);
}

const name     = 'pollclose';
const aliases  = ['closepoll', 'endpoll'];
const desc     = '📊 Tally and announce final results for a poll (reply to it)';
const category = 'general';

function cleanNum(jid) {
    if (!jid) return '';
    return jid.replace(/[^0-9]/g, '');
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!getAggregateVotesInPollMessage) {
        return await sock.sendMessage(chatId, {
            text: '❌ Poll tallying isn\'t available — `getAggregateVotesInPollMessage` failed to load from Baileys. Check your `@whiskeysockets/baileys` version.'
        }, { quoted: msg });
    }

    const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
    if (!stanzaId) {
        return await sock.sendMessage(chatId, {
            text: '❌ *Reply to the poll message* with `.pollclose` to tally it.\n\n_Note: only works for polls this bot created since it last restarted._'
        }, { quoted: msg });
    }

    const entry = pollStore.get(stanzaId);
    if (!entry) {
        return await sock.sendMessage(chatId, {
            text: '❌ *Poll data not found.*\n\nEither this isn\'t a poll created by `.poll`, the bot restarted since it was created, or vote tracking isn\'t wired up yet on the backend.'
        }, { quoted: msg });
    }

    if (entry.closed) {
        return await sock.sendMessage(chatId, { text: '⚠️ This poll has already been closed and announced.' }, { quoted: msg });
    }

    try {
        const results = getAggregateVotesInPollMessage({
            message: { pollCreationMessage: entry.pollCreationMessage },
            pollUpdates: entry.pollUpdates,
        });

        // results: [{ name, voters: [jid, ...] }]
        const sorted = [...results].sort((a, b) => (b.voters?.length || 0) - (a.voters?.length || 0));
        const totalVotes = sorted.reduce((sum, r) => sum + (r.voters?.length || 0), 0);

        let text = `🔒 *Poll Closed!*\n\n❓ *${entry.pollCreationMessage.name}*\n\n`;

        if (totalVotes === 0) {
            text += `_No votes were recorded._`;
        } else {
            sorted.forEach((opt, i) => {
                const count = opt.voters?.length || 0;
                const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                const medal = i === 0 && count > 0 ? '🥇 ' : i === 1 && count > 0 ? '🥈 ' : i === 2 && count > 0 ? '🥉 ' : '▫️ ';
                text += `${medal}*${opt.name}* — ${count} vote${count === 1 ? '' : 's'} (${pct}%)\n`;
            });
            text += `\n📊 Total votes: *${totalVotes}*`;
        }

        text += `\n\n_⚠️ The poll may still appear open in WhatsApp — these are the final tallied results as of closing._`;

        entry.closed = true;

        await sock.sendMessage(chatId, { text }, { quoted: msg });

    } catch (err) {
        console.error('[pollclose] Tally error:', err.message);
        await sock.sendMessage(chatId, { text: `❌ Failed to tally poll: ${err.message}` }, { quoted: msg });
    }
}

module.exports = { name, aliases, desc, category, execute };