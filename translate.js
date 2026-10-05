/**
 * translate.js — Text & Voice/Audio Translator
 * Aliases: .translate, .trt, .trans
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { downloadMediaMessage } = require('@whiskeysockets/baileys/lib/Utils');

// ─── Config ──────────────────────────────────────────────────────────────
const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/translate.php';
const GOOGLE_STT_KEY = 'AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw';

// WIT.AI CONFIG (100% Free STT, no limits, highly accurate)
// Create a free app at https://wit.ai/apps/new and paste your token below
const WIT_AI_TOKEN = 'RXKPYUS7RINUAJFZTEED4YCL7GPU62YB'; 

const TMP_DIR = os.tmpdir();

// ═══════════════════════════════════════════════════════════════════════════
// LANGUAGE MAP
// ═══════════════════════════════════════════════════════════════════════════
const LANG_MAP = {
    'en': 'en', 'english': 'en', 'eng': 'en',
    'fr': 'fr', 'french': 'fr', 'francais': 'fr', 'français': 'fr', 'francés': 'fr',
    'es': 'es', 'spanish': 'es', 'español': 'es', 'espanol': 'es',
    'de': 'de', 'german': 'de', 'deutsch': 'de',
    'it': 'it', 'italian': 'it', 'italiano': 'it',
    'pt': 'pt', 'portuguese': 'pt', 'português': 'pt', 'portugues': 'pt',
    'ru': 'ru', 'russian': 'ru', 'русский': 'ru',
    'ja': 'ja', 'japanese': 'ja', '日本語': 'ja',
    'ko': 'ko', 'korean': 'ko', '한국어': 'ko',
    'zh': 'zh', 'chinese': 'zh', '中文': 'zh', 'mandarin': 'zh',
    'ar': 'ar', 'arabic': 'ar', 'العربية': 'ar',
    'hi': 'hi', 'hindi': 'hi', 'हिन्दी': 'hi',
    'bn': 'bn', 'bengali': 'bn', 'বাংলা': 'bn',
    'tr': 'tr', 'turkish': 'tr', 'türkçe': 'tr',
    'pl': 'pl', 'polish': 'pl', 'polski': 'pl',
    'nl': 'nl', 'dutch': 'nl', 'nederlands': 'nl',
    'sv': 'sv', 'swedish': 'sv', 'svenska': 'sv',
    'th': 'th', 'thai': 'th', 'ไทย': 'th',
    'vi': 'vi', 'vietnamese': 'vi', 'tiếng việt': 'vi',
    'id': 'id', 'indonesian': 'id', 'bahasa': 'id',
    'ms': 'ms', 'malay': 'ms', 'malaysian': 'ms',
    'uk': 'uk', 'ukrainian': 'uk', 'українська': 'uk',
    'el': 'el', 'greek': 'el', 'ελληνικά': 'el',
    'cs': 'cs', 'czech': 'cs', 'čeština': 'cs',
    'ro': 'ro', 'romanian': 'ro', 'română': 'ro',
    'hu': 'hu', 'hungarian': 'hu', 'magyar': 'hu',
    'da': 'da', 'danish': 'da', 'dansk': 'da',
    'fi': 'fi', 'finnish': 'fi', 'suomi': 'fi',
    'no': 'no', 'norwegian': 'no', 'norsk': 'no',
    'he': 'he', 'hebrew': 'he', 'עברית': 'he',
    'fa': 'fa', 'persian': 'fa', 'farsi': 'fa', 'فارسی': 'fa',
    'ur': 'ur', 'urdu': 'ur', 'اردو': 'ur',
    'sw': 'sw', 'swahili': 'sw',
    'af': 'af', 'afrikaans': 'af',
    'yo': 'yo', 'yoruba': 'yo',
    'ig': 'ig', 'igbo': 'ig',
    'ha': 'ha', 'hausa': 'ha',
    'am': 'am', 'amharic': 'am',
    'pa': 'pa', 'punjabi': 'pa', 'ਪੰਜਾਬੀ': 'pa',
    'ta': 'ta', 'tamil': 'ta', 'தமிழ்': 'ta',
    'te': 'te', 'telugu': 'te', 'తెలుగు': 'te',
    'tl': 'tl', 'tagalog': 'tl', 'filipino': 'tl',
    'ca': 'ca', 'catalan': 'ca', 'català': 'ca',
    'hr': 'hr', 'croatian': 'hr', 'hrvatski': 'hr',
    'sr': 'sr', 'serbian': 'sr', 'српски': 'sr',
    'bg': 'bg', 'bulgarian': 'bg', 'български': 'bg',
    'sk': 'sk', 'slovak': 'sk', 'slovenčina': 'sk',
    'sl': 'sl', 'slovenian': 'sl', 'slovenščina': 'sl',
    'lt': 'lt', 'lithuanian': 'lt', 'lietuvių': 'lt',
    'lv': 'lv', 'latvian': 'lv', 'latviešu': 'lv',
    'et': 'et', 'estonian': 'et', 'eesti': 'et',
    'ka': 'ka', 'georgian': 'ka', 'ქართული': 'ka',
    'hy': 'hy', 'armenian': 'hy', 'հայերեն': 'hy',
    'kk': 'kk', 'kazakh': 'kk', 'қазақ': 'kk',
    'uz': 'uz', 'uzbek': 'uz', 'oʻzbek': 'uz',
    'my': 'my', 'burmese': 'my', 'မြန်မာဘာသာ': 'my',
    'km': 'km', 'khmer': 'km', 'ខ្មែរ': 'km',
    'ne': 'ne', 'nepali': 'ne', 'नेपाली': 'ne',
    'si': 'si', 'sinhala': 'si', 'sinhalese': 'si',
    'mn': 'mn', 'mongolian': 'mn', 'монгол': 'mn',
    'is': 'is', 'icelandic': 'is', 'íslenska': 'is',
    'sq': 'sq', 'albanian': 'sq', 'shqip': 'sq',
    'mk': 'mk', 'macedonian': 'mk', 'македонски': 'mk',
    'bs': 'bs', 'bosnian': 'bs', 'bosanski': 'bs',
    'cy': 'cy', 'welsh': 'cy', 'cymraeg': 'cy',
    'eu': 'eu', 'basque': 'eu', 'euskara': 'eu',
    'eo': 'eo', 'esperanto': 'eo',
    'ak': 'ak', 'akan': 'ak', 'twi': 'ak',
};

function resolveLang(input) {
    if (!input) return null;
    const clean = input.trim().toLowerCase();
    if (!clean) return null;
    if (LANG_MAP[clean]) return LANG_MAP[clean];
    for (const [key, code] of Object.entries(LANG_MAP)) {
        if (key.length > 3 && key.startsWith(clean)) return code;
    }
    for (const [key, code] of Object.entries(LANG_MAP)) {
        if (key.length > 4 && key.includes(clean) && clean.length >= 3) return code;
    }
    return null;
}

const LANG_NAMES = {
    en:'English',fr:'French',es:'Spanish',de:'German',it:'Italian',pt:'Portuguese',
    ru:'Russian',ja:'Japanese',ko:'Korean',zh:'Chinese',ar:'Arabic',hi:'Hindi',
    bn:'Bengali',tr:'Turkish',pl:'Polish',nl:'Dutch',sv:'Swedish',th:'Thai',
    vi:'Vietnamese',id:'Indonesian',ms:'Malay',uk:'Ukrainian',el:'Greek',cs:'Czech',
    ro:'Romanian',hu:'Hungarian',da:'Danish',fi:'Finnish',no:'Norwegian',he:'Hebrew',
    fa:'Persian',ur:'Urdu',sw:'Swahili',af:'Afrikaans',yo:'Yoruba',ig:'Igbo',
    ha:'Hausa',am:'Amharic',pa:'Punjabi',ta:'Tamil',te:'Telugu',tl:'Tagalog',
    ca:'Catalan',hr:'Croatian',sr:'Serbian',bg:'Bulgarian',sk:'Slovak',sl:'Slovenian',
    lt:'Lithuanian',lv:'Latvian',et:'Estonian',ka:'Georgian',hy:'Armenian',
    kk:'Kazakh',uz:'Uzbek',my:'Burmese',km:'Khmer',ne:'Nepali',
    si:'Sinhala',mn:'Mongolian',is:'Icelandic',sq:'Albanian',mk:'Macedonian',
    bs:'Bosnian',cy:'Welsh',eu:'Basque',eo:'Esperanto',ak:'Twi/Akan',
};

function getLangName(code) {
    return LANG_NAMES[code] || code.toUpperCase();
}

function safeUnlink(filePath) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// SPEECH-TO-TEXT 
// Fixed: trimmed to 10s (Google rejects >10s silently)
// Added: Wit.ai fallback (free, no limits)
// ═══════════════════════════════════════════════════════════════════════════
async function transcribeAudio(audioBuffer) {
    const id = `stt_${Date.now()}`;
    const inpPath = path.join(TMP_DIR, `oxbot_${id}.ogg`);
    const wavPath = path.join(TMP_DIR, `oxbot_${id}.wav`);

    try {
        let buf = audioBuffer;
        if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf, 'base64');
        fs.writeFileSync(inpPath, buf);
        console.log(`[STT] Input: ${Math.round(buf.length / 1024)}KB`);

        // 1. Convert to WAV
        // CRITICAL FIX: Changed from -t 30 to -t 10 !!!
        // Google's unofficial API silently returns 0% confidence on files > 10 seconds
        let ffmpegErr = '';
        try {
            execSync(
                `ffmpeg -i "${inpPath}" -t 10 -ar 16000 -ac 1 -sample_fmt s16 "${wavPath}" -y 2>&1`
            );
        } catch (e) {
            ffmpegErr = (e.stderr ? e.stderr.toString() : '') + (e.message || '');
            if (ffmpegErr.includes('Decoder opus not found')) {
                throw new Error('❌ *Missing OPUS decoder!*\n_Run in SSH: sudo apt install libopus0 ffmpeg -y_');
            }
        }

        if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 1000) {
            throw new Error('Audio conversion failed.');
        }

        const wavBuffer = fs.readFileSync(wavPath);
        const header = wavBuffer.slice(0, 4).toString('ascii');
        if (header !== 'RIFF') throw new Error('Corrupted WAV file.');

        // Amplitude check
        let maxAmp = 0;
        for (let i = 44; i < Math.min(wavBuffer.length, 100000); i += 2) {
            if (i + 1 < wavBuffer.length) {
                const amp = Math.abs(wavBuffer.readInt16LE(i));
                if (amp > maxAmp) maxAmp = amp;
            }
        }
        
        console.log(`[STT] WAV: ${Math.round(wavBuffer.length/1024)}KB, Peak: ${maxAmp}/32767`);

        if (maxAmp < 50) throw new Error('The voice note is completely silent or empty.');

        let resultText = null;

        // ── ATTEMPT 1: Google v2 API (Max 10 seconds now!) ──
        const langs = ['en-US', 'fr-FR', 'es-ES', 'pt-BR', 'de-DE', 'ar-SA', 'hi-IN', 'yo'];
        let bestConf = 0;

        for (const lang of langs) {
            try {
                const res = await axios.post(
                    `https://www.google.com/speech-api/v2/recognize?output=json&lang=${lang}&key=${GOOGLE_STT_KEY}`,
                    wavBuffer,
                    { headers: { 'Content-Type': 'audio/l16; rate=16000' }, timeout: 15000, maxContentLength: 10 * 1024 * 1024 }
                );
                
                const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                for (const line of raw.split('\n').filter(l => l.trim())) {
                    try {
                        const p = JSON.parse(line);
                        // Log what Google actually returns so we can debug
                        if (p.error) {
                            console.log(`[STT] Google [${lang}] ERROR: ${JSON.stringify(p.error)}`);
                            continue;
                        }
                        const alt = p.result?.[0]?.alternatives?.[0];
                        if (alt?.transcript && alt.confidence > bestConf) {
                            bestConf = alt.confidence;
                            resultText = alt.transcript;
                        }
                    } catch {}
                }
                console.log(`[STT] Google [${lang}] BestConf: ${bestConf}`);
                if (resultText && bestConf > 0.4) break;
            } catch (err) {
                // Log actual HTTP errors (403, 429, etc)
                const status = err.response?.status;
                console.log(`[STT] Google [${lang}] HTTP ${status || 'ERR'}: ${err.message?.slice(0, 60)}`);
            }
        }

        // ── ATTEMPT 2: Wit.ai (100% Free, Unlimited, No size limits) ──
        if (!resultText && WIT_AI_TOKEN && WIT_AI_TOKEN !== 'YOUR_WIT_AI_TOKEN_HERE') {
            console.log(`[STT] Google failed, trying Wit.ai...`);
            try {
                const res = await axios.post('https://api.wit.ai/speech', wavBuffer, {
                    headers: {
                        'Authorization': `Bearer ${WIT_AI_TOKEN}`,
                        'Content-Type': 'audio/wav',
                    },
                    timeout: 15000,
                    maxContentLength: 10 * 1024 * 1024,
                });

                if (res.data?._text) {
                    resultText = res.data._text;
                    console.log(`[STT] Wit.ai SUCCESS: "${resultText.slice(0, 80)}"`);
                } else if (res.data?.error) {
                    console.log(`[STT] Wit.ai ERROR: ${res.data.error}`);
                }
            } catch (err) {
                console.log(`[STT] Wit.ai Error: ${err.message?.slice(0, 80)}`);
            }
        }

        if (!resultText || resultText.length < 2) {
            console.log(`[STT] All methods failed.`);
            if (WIT_AI_TOKEN === 'YOUR_WIT_AI_TOKEN_HERE') {
                console.log(`[STT] Tip: Add a free Wit.ai token for 100% reliable voice transcription.`);
            }
            return null;
        }

        console.log(`[STT] FINAL: "${resultText.slice(0, 80)}"`);
        return resultText;

    } finally {
        safeUnlink(inpPath);
        safeUnlink(wavPath);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT-TO-SPEECH
// ═══════════════════════════════════════════════════════════════════════════
async function generateVoiceNote(text, langCode) {
    const id = `tts_${Date.now()}`;
    const chunkFiles = [];
    const finalOgg = path.join(TMP_DIR, `oxbot_${id}.ogg`);
    const finalMp3 = path.join(TMP_DIR, `oxbot_${id}.mp3`);
    const concatList = path.join(TMP_DIR, `oxbot_${id}.txt`);

    try {
        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= 180) { chunks.push(remaining); break; }
            let brk = remaining.lastIndexOf(' ', 180);
            if (brk < 90) brk = remaining.lastIndexOf('.', 180);
            if (brk < 90) brk = 180;
            chunks.push(remaining.slice(0, brk).trim());
            remaining = remaining.slice(brk).trim();
        }

        for (let i = 0; i < chunks.length; i++) {
            const chunkPath = path.join(TMP_DIR, `oxbot_${id}_p${i}.mp3`);
            chunkFiles.push(chunkPath);
            let ok = false;
            try {
                const res = await axios.get('https://translate.google.com/translate_tts', {
                    params: { ie: 'UTF-8', q: chunks[i], tl: langCode, client: 'tw-ob', ttsspeed: '0.9' },
                    responseType: 'arraybuffer', timeout: 15000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                });
                if (res.data && res.data.length > 500) { fs.writeFileSync(chunkPath, res.data); ok = true; }
            } catch {}
            if (!ok) throw new Error(`TTS failed on chunk ${i + 1}`);
        }

        const mergedMp3 = path.join(TMP_DIR, `oxbot_${id}_merged.mp3`);
        fs.writeFileSync(concatList, chunkFiles.map(f => `file '${f}'`).join('\n'));
        execSync(`ffmpeg -f concat -safe 0 -i "${concatList}" -c copy "${mergedMp3}" -y 2>/dev/null`, { timeout: 30000 });
        safeUnlink(concatList);

        if (!fs.existsSync(mergedMp3) || fs.statSync(mergedMp3).size < 500) throw new Error('Failed to merge audio.');

        let resultBuffer = null;
        let mimetype = 'audio/ogg; codecs=opus';

        try {
            execSync(`ffmpeg -i "${mergedMp3}" -c:a libopus -b:a 32k -ar 48000 -ac 1 "${finalOgg}" -y 2>/dev/null`, { timeout: 30000 });
            if (fs.existsSync(finalOgg) && fs.statSync(finalOgg).size > 200) resultBuffer = fs.readFileSync(finalOgg);
        } catch {}

        if (!resultBuffer) {
            try {
                execSync(`ffmpeg -i "${mergedMp3}" -vn -ar 44100 -ac 2 -b:a 128k "${finalMp3}" -y 2>/dev/null`, { timeout: 30000 });
                if (fs.existsSync(finalMp3) && fs.statSync(finalMp3).size > 200) {
                    resultBuffer = fs.readFileSync(finalMp3);
                    mimetype = 'audio/mpeg';
                }
            } catch (err) {
                throw new Error(`Audio conversion failed: ${err.message}`);
            }
        }

        console.log(`[TTS] OK: ${Math.round(resultBuffer.length / 1024)}KB`);
        return { buffer: resultBuffer, mimetype };

    } finally {
        safeUnlink(finalOgg);
        safeUnlink(finalMp3);
        safeUnlink(concatList);
        safeUnlink(path.join(TMP_DIR, `oxbot_${id}_merged.mp3`));
        chunkFiles.forEach(f => safeUnlink(f));
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function extractMsgText(m) {
    if (!m) return '';
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.documentMessage?.caption) return m.documentMessage.caption;
    return '';
}

function hasAudio(m) {
    return m?.audioMessage && typeof m.audioMessage === 'object';
}

const HELP_TEXT = `*🌐 TRANSLATOR*\n\n1️⃣ \`.translate <text> <language>\`\n2️⃣ Reply text → \`.translate <language>\`\n3️⃣ Reply voice → \`.translate <language>\` → *voice back!*\n\n*Accepts codes & names:*\n\`.translate hello french\`\n\`.translate hello fr\`\n\n*60+ languages:* 🇬🇧 english · 🇫🇷 french · 🇪🇸 spanish · 🇩🇪 german · 🇳🇬 yoruba · 🇳🇬 igbo · 🇳🇬 hausa`;

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXECUTE
// ═══════════════════════════════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    try {
        await sock.sendPresenceUpdate('composing', chatId);
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const quoted = ctx?.quotedMessage;

        let textToTranslate = '', targetCode = '', targetLang = '';
        let heardText = null, isVoiceOrAudio = false;

        if (args.length === 0 && !quoted) {
            await sock.sendMessage(chatId, { text: HELP_TEXT }, { quoted: msg });
            return null;
        }

        if (quoted && hasAudio(quoted)) {
            targetCode = resolveLang(args.join(' ').trim());
            if (!targetCode) {
                await sock.sendMessage(chatId, { text: `❌ Specify a language.\n_Example: .translate french_` }, { quoted: msg });
                return null;
            }
            targetLang = getLangName(targetCode);
            isVoiceOrAudio = true;

            try { await sock.sendMessage(chatId, { react: { text: quoted.audioMessage.ptt ? '🎤' : '🎵', key: msg.key } }); } catch {}
            if (!ctx?.stanzaId) throw new Error('Cannot find the audio message.');

            try { await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } }); } catch {}

            const audioBuffer = await downloadMediaMessage({
                key: { remoteJid: chatId, id: ctx.stanzaId, participant: ctx.participant || chatId },
                message: quoted,
            }, 'buffer', {});

            if (!audioBuffer || audioBuffer.length < 100) throw new Error('Failed to download audio.');

            heardText = await transcribeAudio(audioBuffer);
            if (!heardText) throw new Error('Could not understand the audio. It may be too long, unclear, or in an unsupported language.');
            textToTranslate = heardText;

        } else if (quoted) {
            targetCode = resolveLang(args.join(' ').trim());
            if (!targetCode) {
                await sock.sendMessage(chatId, { text: `❌ Specify a language.\n_Example: .translate french_` }, { quoted: msg });
                return null;
            }
            targetLang = getLangName(targetCode);
            textToTranslate = extractMsgText(quoted);
            if (!textToTranslate) {
                await sock.sendMessage(chatId, { text: `❌ Cannot translate this message type.` }, { quoted: msg });
                return null;
            }

        } else {
            if (args.length < 2) {
                await sock.sendMessage(chatId, { text: `❌ Provide text and language.\n_Example: .translate hello french_` }, { quoted: msg });
                return null;
            }
            const langInput = args.pop();
            targetCode = resolveLang(langInput);
            if (!targetCode && args.length > 0) {
                const firstArg = args.shift();
                targetCode = resolveLang(firstArg);
                if (!targetCode) { args.unshift(firstArg); args.push(langInput); 
                    await sock.sendMessage(chatId, { text: `❌ Unknown language: *${langInput}*` }, { quoted: msg }); return null; 
                }
            }
            if (!targetCode) {
                await sock.sendMessage(chatId, { text: `❌ Unknown language: *${langInput}*` }, { quoted: msg }); return null;
            }
            targetLang = getLangName(targetCode);
            textToTranslate = args.join(' ');
            if (!textToTranslate) {
                await sock.sendMessage(chatId, { text: `❌ No text provided.` }, { quoted: msg }); return null;
            }
        }

        if (!textToTranslate || !targetCode) {
            await sock.sendMessage(chatId, { text: HELP_TEXT }, { quoted: msg }); return null;
        }
        if (textToTranslate.length > 5000) textToTranslate = textToTranslate.slice(0, 5000);

        try { await sock.sendMessage(chatId, { react: { text: '🌐', key: msg.key } }); } catch {}

        const { data } = await axios.get(OXBOT_API_URL, {
            params: { api_key: OXBOT_API_KEY, text: textToTranslate, lang: targetCode },
            timeout: 15000,
        });

        if (!data.ok) throw new Error(data.error || 'Translation API error.');
        if (!data.translated_text) throw new Error('Translation returned empty.');

        const translatedText = data.translated_text;

        if (isVoiceOrAudio) {
            const audioType = quoted?.audioMessage?.ptt ? 'Voice Note' : 'Audio';
            try { await sock.sendMessage(chatId, { react: { text: '🔊', key: msg.key } }); } catch {}

            let info = `🌐 *${audioType} → ${targetLang} (${targetCode.toUpperCase()})*`;
            if (data.detected_lang && data.detected_lang !== 'auto') {
                const dc = data.detected_lang.split('-')[0].toLowerCase();
                if (dc !== targetCode) info += `\n📄 _from ${getLangName(dc)}_`;
            }
            info += `\n\n🎤 *Heard:*\n_${heardText}_`;
            await sock.sendMessage(chatId, { text: info }, { quoted: msg });

            let voiceResult = null;
            try {
                voiceResult = await generateVoiceNote(translatedText, targetCode);
            } catch (ttsErr) {
                console.error('[TTS] Error:', ttsErr.message);
                await sock.sendMessage(chatId, { text: `✨ *Translated:*\n_${translatedText}_\n\n_⚠️ Could not generate voice._` }, { quoted: msg });
                try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
                return null;
            }

            if (voiceResult?.buffer) {
                await sock.sendMessage(chatId, {
                    audio: voiceResult.buffer,
                    mimetype: voiceResult.mimetype,
                    ptt: true,
                }, { quoted: msg });
            }
            try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}

        } else {
            let response = `🌐 *Translation → ${targetLang} (${targetCode.toUpperCase()})*`;
            if (data.detected_lang && data.detected_lang !== 'auto') {
                const dc = data.detected_lang.split('-')[0].toLowerCase();
                if (dc !== targetCode) response += `\n📄 _from ${getLangName(dc)}_`;
            }
            response += `\n\n✨ *Translated:*\n_${translatedText}_`;
            await sock.sendMessage(chatId, { text: response }, { quoted: msg });
            try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        }

    } catch (err) {
        console.error('[translate] Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        let errMsg = err.message;
        if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ENOTFOUND')) errMsg = 'Cannot reach translation server.';
        else if (errMsg.includes('timeout') || errMsg.includes('ETIMEDOUT')) errMsg = 'Translation timed out.';
        await sock.sendMessage(chatId, { text: `❌ *Translation Failed*\n\n_${errMsg}_` }, { quoted: msg });
    }
    return null;
}

module.exports = {
    name: 'translate',
    aliases: ['trt', 'trans'],
    desc: 'Translate text, voice notes, or audio to any language',
    category: 'general',
    execute,
};
