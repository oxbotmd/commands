/**
 * commands/wiki.js
 * Search Wikipedia for a topic summary
 */

const name     = 'wiki';
const desc     = '📖 Search Wikipedia for a topic summary';
const category = 'search';

const axios = require('axios');

// ═══════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;

    if (!args[0]) {
        return await sock.sendMessage(chatId, {
            text: `❌ Provide a search term.\n_Usage: .wiki <query>_`
        }, { quoted: msg });
    }

    const query = args.join(" ");

    try {
        // Step 1: Search Wikipedia for the closest matching article
        const searchRes = await axios.get("https://en.wikipedia.org/w/api.php", {
            params: {
                action: "query",
                list: "search",
                srsearch: query,
                format: "json",
                srlimit: 1,
            },
            timeout: 8000,
        });

        const results = searchRes.data.query.search;
        if (!results.length) {
            return await sock.sendMessage(chatId, {
                text: `❌ No Wikipedia results for *${query}*.`
            }, { quoted: msg });
        }

        const pageId = results[0].pageid;
        const title = results[0].title;

        // Step 2: Fetch the summary/intro of that specific article
        const summaryRes = await axios.get("https://en.wikipedia.org/w/api.php", {
            params: {
                action: "query",
                pageids: pageId,
                prop: "extracts",
                exintro: true,
                explaintext: true, // Gets plain text instead of HTML
                format: "json",
            },
            timeout: 8000,
        });

        let extract = summaryRes.data.query.pages[pageId].extract || "";
        
        // Trim to ~800 chars at sentence boundary to avoid huge walls of text
        if (extract.length > 800) {
            extract = extract.slice(0, 800);
            const lastDot = extract.lastIndexOf(".");
            if (lastDot > 400) extract = extract.slice(0, lastDot + 1);
            extract += "\n\n_...read more on Wikipedia_";
        }

        const url = `https://en.wikipedia.org/?curid=${pageId}`;
        
        await sock.sendMessage(chatId, {
            text: `📖 *${title}*\n\n${extract}\n\n🔗 ${url}`
        }, { quoted: msg });

    } catch (err) {
        console.error("[wiki] Error:", err.message);
        await sock.sendMessage(chatId, {
            text: `❌ Failed to fetch Wikipedia data. Try again.`
        }, { quoted: msg });
    }
}

module.exports = { name, desc, category, execute };