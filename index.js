// ╔══════════════════════════════════════════════╗
// ║  V I V E K  -  MULTI-ACCOUNT BOT ENGINE      ║
// ╚══════════════════════════════════════════════╝

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage,
    fetchLatestBaileysVersion,
    Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import express from 'express';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'edge-tts';

const app = express();
const PORT = process.env.BOT_PORT || 4000;

app.use(express.json());

// Multi-Account Registry
const activeSockets = new Map();
const pairingCodes = new Map();
const targetAutoReplies = new Map();
const messageStore = new Map();

const SESSIONS_BASE = './sessions';
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

const getUptime = () => {
    const uptimeSeconds = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
};

async function startSession(phoneNumber) {
    const cleanedNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (!cleanedNumber) return { success: false, error: 'Invalid Phone Number' };

    const sessionPath = `${SESSIONS_BASE}/${cleanedNumber}`;
    fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Safari'),
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 20000
    });

    activeSockets.set(cleanedNumber, sock);

    if (!state.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleanedNumber);
                pairingCodes.set(cleanedNumber, code);
                console.log(`[PAIRING CODE - ${cleanedNumber}]: ${code}`);
            } catch (err) {
                console.error(`Error requesting pairing code for ${cleanedNumber}:`, err);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (upd) => {
        const { connection, lastDisconnect } = upd;
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 500;
            pairingCodes.delete(cleanedNumber);
            if (statusCode !== DisconnectReason.loggedOut) {
                startSession(cleanedNumber);
            } else {
                activeSockets.delete(cleanedNumber);
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        } else if (connection === 'open') {
            pairingCodes.delete(cleanedNumber);
            console.log(`✅ Session Active: ${cleanedNumber}`);
        }
    });

    // Message Processing Engine
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const mek = chatUpdate.messages[0];
            if (!mek.message || mek.key.remoteJid === 'status@broadcast') return;

            if (mek.key.id) messageStore.set(mek.key.id, mek);

            const from = mek.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const type = Object.keys(mek.message)[0];
            const sender = mek.key.participant || mek.key.remoteJid;
            const botOwner = sock.user.id.split(':')[0] + '@s.whatsapp.net';

            const body = (type === 'conversation') ? mek.message.conversation : 
                         (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text : '';

            const command = body.trim().toLowerCase().split(' ')[0];
            const args = body.trim().split(' ').slice(1);
            const qtext = args.join(' ');

            const sendBorderStatus = async (statusTitle, statusText) => {
                const borderMsg = `
╭━━━━━━━╮
    ╭━━━╯  ⚡  ╰━━━╮
   ╱   𝙑𝙄𝙑𝙀权 𝙑𝙄𝘽𝙀𝙎   ╲
  ╲     𝙐𝙇𝙏𝙄𝙈𝘼𝙏𝙀     ╱
   ╰━━╮           ╭━━╯
      ╰━━╮     ╭━━╯
          ╰━━━╯

   ╭─╮  ⚡ 𝙎𝙔𝙎𝙏𝙀𝙈 𝙎𝙏𝘼𝙏𝙐𝙎
   ╰╮╰━━━━━━━━━━━━━━━━
    ╰─ ⚙️ ${statusTitle}
       📝 ${statusText}

       ╭━━━━━━━━╮
    ╭━━╯  𝙑𝙄𝙑𝙀权  ╰━━╮
    ╰━━ 𝙎𝙔𝙎𝙏𝙀𝙈  ━━╯
       ╰━━━━━━━━╯`;
                await sock.sendMessage(from, { text: borderMsg }, { quoted: mek });
            };

            if (!mek.key.fromMe && targetAutoReplies.has(sender)) {
                await sock.sendMessage(from, { text: targetAutoReplies.get(sender) }, { quoted: mek });
            }

            if (!mek.key.fromMe) return; // Strict Owner Control Check

            if (command === '.ping' || command === 'ping' || command === '.runtime') {
                await sendBorderStatus('𝙋𝙄𝙉𝙂 & 𝙍𝙐𝙉𝙏𝙄𝙈𝙀', `Status: Online 🟢\n       ⏳ Uptime: ${getUptime()}`);
            }

            if (command === '.ttsg' || command === 'ttsg' || command === '.ttsb' || command === 'ttsb') {
                if (!qtext) return sendBorderStatus('𝙏𝙏𝙎 𝙀𝙍𝙍𝙊𝙍', 'Text missing!');
                let targetJid = from;
                let textToSend = qtext;
                if (/^\d{10,15}$/.test(args[0])) {
                    targetJid = `${args[0]}@s.whatsapp.net`;
                    textToSend = args.slice(1).join(' ');
                }
                const tts = new MsEdgeTTS();
                const voice = command.includes('ttsg') ? 'hi-IN-SwaraNeural' : 'hi-IN-MadhurNeural';
                await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
                const filePath = `./tts_${Date.now()}.mp3`;
                await tts.toFile(filePath, textToSend);
                await sock.sendMessage(targetJid, { audio: { url: filePath }, mimetype: 'audio/mp4', ptt: true });
                if (targetJid !== from) await sendBorderStatus('𝙑𝙊𝙄𝘾𝙀 𝙉𝙊𝙏𝙀 𝙎𝙀𝙉𝙏', `Secretly sent to @${targetJid.split('@')[0]}`);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        } catch (e) {
            console.error('Processing error:', e);
        }
    });

    return { success: true };
}

// Auto Restructure Active Sessions on Engine Start
fs.readdirSync(SESSIONS_BASE).forEach((folder) => {
    if (fs.existsSync(`${SESSIONS_BASE}/${folder}/creds.json`)) {
        startSession(folder);
    }
});

// REST APIs for Flask Interface
app.post('/api/connect', async (req, res) => {
    const { phone } = req.body;
    const result = await startSession(phone);
    res.json(result);
});

app.post('/api/disconnect', async (req, res) => {
    const { phone } = req.body;
    const cleanedNumber = phone.replace(/[^0-9]/g, '');
    if (activeSockets.has(cleanedNumber)) {
        const sock = activeSockets.get(cleanedNumber);
        await sock.logout();
        sock.end(undefined);
        activeSockets.delete(cleanedNumber);
        fs.rmSync(`${SESSIONS_BASE}/${cleanedNumber}`, { recursive: true, force: true });
        res.json({ success: true, message: 'Session Removed' });
    } else {
        res.json({ success: false, error: 'Session Not Found' });
    }
});

app.get('/api/status/:phone', (req, res) => {
    const cleanedNumber = req.params.phone.replace(/[^0-9]/g, '');
    const isConnected = activeSockets.has(cleanedNumber);
    const code = pairingCodes.get(cleanedNumber) || null;
    res.json({ connected: isConnected, code });
});

app.get('/api/admin/accounts', (req, res) => {
    const accounts = Array.from(activeSockets.keys()).map((num) => ({
        phone: num,
        status: pairingCodes.has(num) ? 'Pairing' : 'Connected 🟢'
    }));
    res.json({ accounts, uptime: getUptime() });
});

app.listen(PORT, () => console.log(`🚀 Node Engine running on port ${PORT}`));
