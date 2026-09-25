// ╔══════════════════════════════════════════════════════════════╗
// ║   V I V E K  -  U L T I M A T E   W H A T S A P P   B O T   ║
// ╚══════════════════════════════════════════════════════════════╝

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

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = "VIVEKJOD";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const activeSockets = new Map();
const pairingCodes = new Map();
const targetAutoReplies = new Map();
const messageStore = new Map();
const processedMessages = new Set();

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

    if (activeSockets.has(cleanedNumber)) {
        try {
            const oldSock = activeSockets.get(cleanedNumber);
            oldSock.ev.removeAllListeners();
            oldSock.end(undefined);
            activeSockets.delete(cleanedNumber);
        } catch (e) {}
    }

    const sessionPath = `${SESSIONS_BASE}/${cleanedNumber}`;
    fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        syncFullHistory: false
    });

    activeSockets.set(cleanedNumber, sock);

    let generatedCode = null;
    if (!state.creds.registered) {
        try {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            generatedCode = await sock.requestPairingCode(cleanedNumber);
            pairingCodes.set(cleanedNumber, generatedCode);
            console.log(`[PAIRING CODE - ${cleanedNumber}]: ${generatedCode}`);
        } catch (err) {
            console.error(`Pairing Error (${cleanedNumber}):`, err);
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (upd) => {
        const { connection, lastDisconnect } = upd;
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 500;
            pairingCodes.delete(cleanedNumber);
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => startSession(cleanedNumber), 3000);
            } else {
                activeSockets.delete(cleanedNumber);
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        } else if (connection === 'open') {
            pairingCodes.delete(cleanedNumber);
            console.log(`✅ Session Active: ${cleanedNumber}`);
        }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            if (chatUpdate.type !== 'notify') return;
            const mek = chatUpdate.messages[0];
            if (!mek || !mek.message || mek.key.remoteJid === 'status@broadcast') return;

            if (processedMessages.has(mek.key.id)) return;
            processedMessages.add(mek.key.id);
            if (processedMessages.size > 2000) processedMessages.clear();

            if (mek.key.id) messageStore.set(mek.key.id, mek);

            const from = mek.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const type = Object.keys(mek.message)[0];
            const sender = mek.key.participant || mek.key.remoteJid;
            const botOwner = sock.user.id ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : from;

            const body = (type === 'conversation') ? mek.message.conversation : 
                         (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text : 
                         (type === 'imageMessage') ? mek.message.imageMessage.caption : 
                         (type === 'videoMessage') ? mek.message.videoMessage.caption : '';

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
                await sock.sendMessage(from, { text: borderMsg });
            };

            // 1. Target Auto-Reply Engine
            if (!mek.key.fromMe && targetAutoReplies.has(sender)) {
                await sock.sendMessage(from, { text: targetAutoReplies.get(sender) }, { quoted: mek });
            }

            // Strict Owner Check
            if (!mek.key.fromMe) return;

            // 2. Menu Command
            if (command === '.menu' || command === 'menu') {
                const menuText = `╭━━━━━━━╮
    ╭━━━╯  ⚡  ╰━━━╮
   ╱   𝙑𝙄𝙑𝙀权 𝙑𝙄𝘽𝙀𝙎   ╲
  ╲     𝙐𝙇𝙏𝙄𝙈𝘼𝙏𝙀     ╱
   ╰━━╮           ╭━━╯
      ╰━━╮     ╭━━╯
          ╰━━━╯

      ╭╮ 🎯 𝙍𝙀𝙋𝙇𝙔 𝙈𝙊𝘿𝙀
   ╭━━╯╰━━━━━━━━━━━━━━
   ╰━━ 𝙖𝙪𝙩𝙤𝙧𝙚𝙥𝙡𝙮 <𝙈𝙎𝙂>
        𝙖𝙪𝙩𝙤𝙧𝙚𝙥𝙡𝙮 𝙤𝙛𝙛

   ╭─╮ 🕶️ 𝙎𝙏𝙀𝘼𝙇𝙏𝙃
   ╰━━╮━━━━━━━━━━━━━━
       ╰─ 𝙝𝙖𝙝𝙖
          𝙨𝙨

      ╭━━╮ 🤖 𝘼𝙄 𝙕𝙊𝙉𝙀
   ╭━━╯  ╰━━━━━━━━━━━━
   ╰━━ 𝙖𝙞 <𝙦𝙪𝙚𝙨𝙩𝙞𝙤𝙣>
       𝙨𝙩𝙞𝙘𝙠𝙚𝙧

   ╭╮ 👥 𝙍𝙊𝙐𝙋 𝙒𝙀𝘼𝙋𝙊𝙉𝙎
   ╰╰━━╮━━━━━━━━━━━━━━
        ╰─ 𝙩𝙖𝙜𝙖𝙡𝙡
           𝙥𝙞𝙣𝙜 / 𝙧𝙪𝙣𝙩𝙞𝙢𝙚

       ╭━━━━━━━━╮
    ╭━━╯  𝙑𝙄𝙑𝙀权  ╰━━╮
    ╰━━ 𝙎𝙔𝙎𝙏𝙀𝙈  ━━╯
       ╰━━━━━━━━╯`;
                await sock.sendMessage(from, { text: menuText }, { quoted: mek });
            }

            // 3. Auto-Reply
            if (command === '.autoreply' || command === 'autoreply') {
                let targetJid = from;
                if (isGroup && type === 'extendedTextMessage' && mek.message.extendedTextMessage.contextInfo?.quotedMessage) {
                    targetJid = mek.message.extendedTextMessage.contextInfo.participant;
                }
                if (qtext.toLowerCase() === 'off') {
                    targetAutoReplies.delete(targetJid);
                    await sendBorderStatus('𝘼𝙐𝙏𝙊𝙍𝙀𝙋𝙇𝙔 𝘿𝙀𝘼𝘾𝙏𝙄𝙑𝘼𝙏𝙀𝘿', `Removed for @${targetJid.split('@')[0]}`);
                } else if (qtext) {
                    targetAutoReplies.set(targetJid, qtext);
                    await sendBorderStatus('𝘼𝙐𝙏𝙊𝙍𝙀𝙋𝙇𝙔 𝘼𝘾𝙏𝙄𝙑𝘼𝙏𝙀𝘿', `Set for @${targetJid.split('@')[0]}:\n"${qtext}"`);
                } else {
                    await sendBorderStatus('𝘼𝙐𝙏𝙊𝙍𝙀𝙋𝙇𝙔 𝙄𝙉𝙁𝙊', 'Usage: .autoreply <MSG> | .autoreply off');
                }
            }

            // 4. Silent View-Once Saver (Reaction Only - No Border Text)
            if (command === 'haha!' || command === 'haha' || command === '.haha') {
                const isQuotedMedia = type === 'extendedTextMessage' && mek.message.extendedTextMessage.contextInfo?.quotedMessage;
                let targetMessage = isQuotedMedia ? mek.message.extendedTextMessage.contextInfo.quotedMessage : mek.message;

                if (targetMessage?.viewOnceMessage || targetMessage?.viewOnceMessageV2) {
                    targetMessage = (targetMessage.viewOnceMessage || targetMessage.viewOnceMessageV2).message;
                }

                let mediaType = Object.keys(targetMessage)[0];
                if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(mediaType)) {
                    const streamType = mediaType.replace('Message', '');
                    const stream = await downloadContentFromMessage(targetMessage[mediaType], streamType);
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                    // Send media to owner DM silently
                    if (mediaType === 'imageMessage') {
                        await sock.sendMessage(botOwner, { image: buffer, caption: '🤫 *View-Once Decrypted*' });
                    } else if (mediaType === 'videoMessage') {
                        await sock.sendMessage(botOwner, { video: buffer, caption: '🤫 *View-Once Decrypted*' });
                    } else if (mediaType === 'audioMessage') {
                        await sock.sendMessage(botOwner, { audio: buffer, mimetype: 'audio/mp4' });
                    }

                    // React to message stealthily
                    await sock.sendMessage(from, { react: { text: '✅', key: mek.key } });
                }
            }

            // 5. Silent Status Saver (Reaction Only)
            if (command === '.ss' || command === 'ss' || command === '.savestatus') {
                const isQuoted = type === 'extendedTextMessage' && mek.message.extendedTextMessage.contextInfo?.quotedMessage;
                if (isQuoted) {
                    const quotedMsg = mek.message.extendedTextMessage.contextInfo.quotedMessage;
                    let mediaType = Object.keys(quotedMsg)[0];

                    if (['imageMessage', 'videoMessage'].includes(mediaType)) {
                        const streamType = mediaType.replace('Message', '');
                        const stream = await downloadContentFromMessage(quotedMsg[mediaType], streamType);
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                        if (mediaType === 'imageMessage') await sock.sendMessage(botOwner, { image: buffer, caption: '📲 *Status Saved!*' });
                        else await sock.sendMessage(botOwner, { video: buffer, caption: '📲 *Status Saved!*' });
                        
                        await sock.sendMessage(from, { react: { text: '✅', key: mek.key } });
                    }
                }
            }

            // 6. AI Assistant: ai
            if (command === '.ai' || command === 'ai') {
                if (!qtext) return sendBorderStatus('𝘼𝙄 𝙀𝙍𝙍𝙊𝙍', 'Please ask a question.');
                try {
                    const response = await fetch(`https://api.vyture.workers.dev/?prompt=${encodeURIComponent(qtext)}`);
                    const data = await response.json();
                    await sendBorderStatus('𝘼𝙄 𝙕𝙊𝙉𝙀', data.result || data.response || "No response.");
                } catch (e) {
                    await sendBorderStatus('𝘼𝙄 𝙀𝙍𝙍𝙊𝙍', 'API connection failed.');
                }
            }

            // 7. Sticker Maker: sticker
            if (command === '.s' || command === '.sticker' || command === 'sticker') {
                const isQuotedImage = type === 'extendedTextMessage' && mek.message.extendedTextMessage.contextInfo?.quotedMessage?.imageMessage;
                const isImage = type === 'imageMessage';

                if (isImage || isQuotedImage) {
                    const imgMsg = isImage ? mek.message.imageMessage : mek.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
                    const stream = await downloadContentFromMessage(imgMsg, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    
                    await sock.sendMessage(from, { sticker: buffer }, { quoted: mek });
                }
            }

            // 8. Tagall
            if ((command === '.tagall' || command === 'tagall') && isGroup) {
                const groupMetadata = await sock.groupMetadata(from);
                let text = `📢 *ATTENTION EVERYONE*\n\n`;
                let mentions = [];
                for (let mem of groupMetadata.participants) {
                    text += `@${mem.id.split('@')[0]}\n`;
                    mentions.push(mem.id);
                }
                await sock.sendMessage(from, { text, mentions }, { quoted: mek });
            }

            // 9. Ping & Runtime
            if (command === '.ping' || command === 'ping' || command === '.runtime' || command === 'runtime') {
                await sendBorderStatus('𝙋𝙄𝙉𝙂 & 𝙍𝙐𝙉𝙏𝙄𝙈𝙀', `Status: Online 🟢\n       ⏳ Uptime: ${getUptime()}`);
            }

        } catch (e) {
            console.error('Processing Error:', e);
        }
    });

    return { success: true, code: generatedCode };
}

// Restructure Active Sessions on Boot
fs.readdirSync(SESSIONS_BASE).forEach((folder) => {
    if (fs.existsSync(`${SESSIONS_BASE}/${folder}/creds.json`)) {
        startSession(folder);
    }
});

// APIs
app.post('/connect', async (req, res) => {
    const { phone } = req.body;
    const result = await startSession(phone);
    res.json(result);
});

app.post('/disconnect', async (req, res) => {
    const { phone } = req.body;
    const cleanedNumber = phone.replace(/[^0-9]/g, '');
    if (activeSockets.has(cleanedNumber)) {
        const sock = activeSockets.get(cleanedNumber);
        sock.ev.removeAllListeners();
        await sock.logout();
        sock.end(undefined);
        activeSockets.delete(cleanedNumber);
        fs.rmSync(`${SESSIONS_BASE}/${cleanedNumber}`, { recursive: true, force: true });
        res.json({ success: true, message: 'Session Removed' });
    } else {
        res.json({ success: false, error: 'Session Not Found' });
    }
});

app.get('/status/:phone', (req, res) => {
    const cleanedNumber = req.params.phone.replace(/[^0-9]/g, '');
    const isConnected = activeSockets.has(cleanedNumber);
    const code = pairingCodes.get(cleanedNumber) || null;
    res.json({ connected: isConnected, code });
});

app.get('/admin/accounts', (req, res) => {
    const password = req.query.pass;
    if (password === ADMIN_PASSWORD) {
        const accounts = Array.from(activeSockets.keys()).map((num) => ({
            phone: num,
            status: pairingCodes.has(num) ? 'Pairing' : 'Connected 🟢'
        }));
        res.json({ accounts, uptime: getUptime() });
    } else {
        res.status(403).json({ error: 'Unauthorized' });
    }
});

// Web Dashboard UI Route
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VIVEK BOT ENGINE</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@500;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    <style>
        :root { --neon-blue: #00f3ff; --neon-purple: #9d00ff; --bg-dark: #05050a; --card-bg: rgba(15, 15, 30, 0.85); }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Rajdhani', sans-serif; }
        body { background: var(--bg-dark); color: #fff; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
        .container { width: 90%; max-width: 480px; padding: 30px; background: var(--card-bg); border-radius: 20px; border: 1px solid rgba(0, 243, 255, 0.3); box-shadow: 0 0 30px rgba(0, 243, 255, 0.2); text-align: center; }
        h1 { font-family: 'Orbitron', sans-serif; font-size: 20px; background: linear-gradient(90deg, var(--neon-blue), var(--neon-purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 20px; }
        .input-box { width: 100%; padding: 14px; margin: 12px 0; border-radius: 10px; border: 1px solid rgba(0,243,255,0.3); background: rgba(0, 0, 0, 0.6); color: #fff; font-size: 16px; outline: none; }
        .btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 15px; }
        .btn { padding: 14px; border: none; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; text-transform: uppercase; transition: 0.3s; }
        .btn-primary { background: linear-gradient(45deg, #00f3ff, #0066ff); color: #000; }
        .btn-danger { background: linear-gradient(45deg, #ff0055, #9d00ff); color: #fff; }
        .btn-info { background: linear-gradient(45deg, #11998e, #38ef7d); color: #000; }
        .btn-admin { background: linear-gradient(45deg, #f857a6, #ff5858); color: #fff; grid-column: span 2; }
        .btn:hover { transform: scale(1.03); }
        .code-display { margin-top: 20px; padding: 15px; background: rgba(0,0,0,0.9); border-radius: 10px; border: 1px dashed var(--neon-blue); font-family: 'Orbitron', sans-serif; font-size: 24px; color: var(--neon-blue); display: none; }
        .account-card { background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(255,255,255,0.1); }
    </style>
</head>
<body>
    <div class="container">
        <h1>⚡ VIVEK BOT ENGINE ⚡</h1>
        <input type="text" id="phoneNumber" class="input-box" placeholder="919876543210 (Country Code)">

        <div class="btn-grid">
            <button class="btn btn-primary" onclick="connectBot()">🚀 Link Account</button>
            <button class="btn btn-danger" onclick="disconnectBot()">🚫 Disconnect</button>
            <button class="btn btn-info" onclick="checkStatus()">🔍 Status Check</button>
            <button class="btn btn-admin" onclick="openAdminPanel()">👑 Admin Panel</button>
        </div>

        <div id="codeDisplay" class="code-display"></div>
        <div id="adminPanel" style="display:none; margin-top:20px; text-align:left;">
            <h3 style="color:var(--neon-blue); margin-bottom:10px;">🛡️ Active Sessions</h3>
            <div id="accountsList"></div>
        </div>
    </div>

    <script>
        async function connectBot() {
            const phone = document.getElementById('phoneNumber').value;
            if(!phone) return Swal.fire('Error', 'Enter phone number!', 'error');
            Swal.fire({ title: 'Requesting Code...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            
            try {
                const res = await fetch('/connect', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    body: JSON.stringify({ phone }) 
                }).then(r => r.json());

                if(res.success && res.code) {
                    Swal.close();
                    const display = document.getElementById('codeDisplay');
                    display.innerText = res.code;
                    display.style.display = 'block';
                } else if(res.success) {
                    checkStatus();
                } else {
                    Swal.fire('Error', res.error || 'Failed to generate code', 'error');
                }
            } catch (err) {
                Swal.fire('Error', 'Server error, try again!', 'error');
            }
        }

        async function disconnectBot() {
            const phone = document.getElementById('phoneNumber').value;
            if(!phone) return Swal.fire('Error', 'Enter phone number!', 'error');
            const res = await fetch('/disconnect', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ phone }) }).then(r => r.json());
            if(res.success) {
                Swal.fire('Success', 'Account Removed!', 'success');
                document.getElementById('codeDisplay').style.display = 'none';
            } else Swal.fire('Error', res.error, 'error');
        }

        async function checkStatus() {
            const phone = document.getElementById('phoneNumber').value;
            if(!phone) return Swal.fire('Error', 'Enter phone number!', 'error');
            const res = await fetch('/status/' + phone).then(r => r.json());
            const display = document.getElementById('codeDisplay');
            if(res.connected) {
                Swal.fire('Status', '🟢 Account Online!', 'success');
                display.style.display = 'none';
            } else if(res.code) {
                Swal.close();
                display.innerText = res.code;
                display.style.display = 'block';
            } else {
                Swal.fire('Status', '🟡 Generating code, check again in 3s...', 'info');
            }
        }

        async function openAdminPanel() {
            const { value: password } = await Swal.fire({ title: 'Admin Verification', input: 'password', showCancelButton: true });
            if (password === 'VIVEKJOD') {
                const res = await fetch('/admin/accounts?pass=' + password).then(r => r.json());
                const list = document.getElementById('accountsList');
                list.innerHTML = '';
                res.accounts.forEach(acc => {
                    list.innerHTML += \`<div class="account-card"><span>+\${acc.phone} (\${acc.status})</span><button class="btn btn-danger" style="padding:4px 8px; font-size:12px;" onclick="adminRemove('\${acc.phone}')">Remove</button></div>\`;
                });
                document.getElementById('adminPanel').style.display = 'block';
                Swal.fire('Welcome Boss!', 'Admin Panel Unlocked', 'success');
            } else if(password) Swal.fire('Denied', 'Wrong Password!', 'error');
        }

        async function adminRemove(phone) {
            document.getElementById('phoneNumber').value = phone;
            await disconnectBot();
            openAdminPanel();
        }
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => console.log(`🚀 Server active on port ${PORT}`));
