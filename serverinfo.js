/**
 * commands/serverinfo.js
 * Show server specs + live resource usage
 */

const os = require('os');
const { execSync } = require('child_process');

const name     = 'serverinfo';
const aliases  = ['server', 'specs', 'hostinfo'];
const desc     = '🖥️ Show server specs and live resource usage';
const category = 'general';

// ── Static specs (adjust to match your actual VPS) ────────────────────────
const SERVER_OS      = 'Ubuntu 24.04 LTS';
const SERVER_STORAGE  = '500 GB';
const SERVER_RAM      = 12; // GB
const SERVER_CPU      = 20; // cores

function bar(pct, size = 10) {
    const filled = Math.round((pct / 100) * size);
    const empty = size - filled;
    return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}

function icon(pct) {
    if (pct > 90) return '🔴';
    if (pct > 70) return '🟡';
    return '🟢';
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(' ');
}

// Reads real disk usage for "/" via `df` — falls back to the static
// SERVER_STORAGE value with no usage % if the shell call fails
// (e.g. no permission, or running in a sandboxed/container context).
function getDiskUsage() {
    try {
        const out = execSync("df -h / | tail -1 | awk '{print $2, $3, $5}'", { timeout: 3000 }).toString().trim();
        const [total, used, pctStr] = out.split(/\s+/);
        const pct = parseInt(pctStr.replace('%', '')) || 0;
        return { total, used, pct, ok: true };
    } catch (err) {
        return { total: SERVER_STORAGE, used: 'Unknown', pct: null, ok: false };
    }
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    try {
        // ── RAM ──────────────────────────────────────────────────────────
        const totalMemBytes = os.totalmem();
        const freeMemBytes  = os.freemem();
        const usedMemBytes  = totalMemBytes - freeMemBytes;
        const ramPct        = Math.round((usedMemBytes / totalMemBytes) * 100);
        const totalMemGB    = (totalMemBytes / (1024 ** 3)).toFixed(1);
        const usedMemGB     = (usedMemBytes / (1024 ** 3)).toFixed(1);

        // ── CPU (1-minute load average as a rough % against core count) ───
        const cpuCores    = os.cpus().length || SERVER_CPU;
        const [load1]     = os.loadavg();
        const cpuPct       = Math.min(100, Math.round((load1 / cpuCores) * 100));

        // ── Disk ─────────────────────────────────────────────────────────
        const disk = getDiskUsage();

        // ── Uptime ───────────────────────────────────────────────────────
        const uptime = formatUptime(os.uptime());

        const text = `┏━━━━━━━━━━━━━━━━━━━━━┓
┃   🖥️ *Server Info*   ┃
┗━━━━━━━━━━━━━━━━━━━━━┛

┌── 🧩 SPECS ──────────────┐
│ 💻 OS       : *${SERVER_OS}*
│ 💾 Storage  : *${SERVER_STORAGE}*
│ 🧠 RAM      : *${SERVER_RAM} GB*
│ ⚙️ CPU      : *${SERVER_CPU} Cores*
│ ⏱️ Uptime   : *${uptime}*
└──────────────────────────┘

┌── 📊 LIVE USAGE ─────────┐
│ ${icon(ramPct)} RAM   [${bar(ramPct)}] ${ramPct}%
│    ${usedMemGB}GB / ${totalMemGB}GB used
│
│ ${icon(cpuPct)} CPU   [${bar(cpuPct)}] ${cpuPct}%
│    Load avg: ${load1.toFixed(2)} (${cpuCores} cores)
│
${disk.ok
    ? `│ ${icon(disk.pct)} Disk  [${bar(disk.pct)}] ${disk.pct}%\n│    ${disk.used} / ${disk.total} used`
    : `│ ⚪ Disk  Unable to read (${disk.total} total)`}
└──────────────────────────┘

💡 Type *.menu* for all commands`;

        await sock.sendMessage(chatId, { text }, { quoted: msg });
        return null;

    } catch (err) {
        console.error('[serverinfo] Error:', err.message);
        await sock.sendMessage(chatId, { text: `❌ Failed to fetch server info: ${err.message}` }, { quoted: msg });
        return null;
    }
}

module.exports = { name, aliases, desc, category, execute };