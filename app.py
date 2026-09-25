from flask import Flask, render_template_string, request, jsonify
import requests
import os

app = Flask(__name__)
NODE_ENGINE_URL = os.environ.get("NODE_ENGINE_URL", "http://127.0.0.1:4000")
ADMIN_PASSWORD = "VIVEKJOD"

HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VIVEK WHATSAPP BOT ENGINE</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@500;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    <style>
        :root {
            --neon-blue: #00f3ff;
            --neon-purple: #9d00ff;
            --bg-dark: #05050a;
            --card-bg: rgba(15, 15, 30, 0.75);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Rajdhani', sans-serif; }
        body {
            background: var(--bg-dark);
            color: #fff;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow-x: hidden;
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(0, 243, 255, 0.1) 0%, transparent 40%),
                radial-gradient(circle at 90% 80%, rgba(157, 0, 255, 0.1) 0%, transparent 40%);
        }
        .bg-grid {
            position: fixed; width: 100vw; height: 100vh;
            background: linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px),
                        linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px);
            background-size: 40px 40px; pointer-events: none; z-index: 0;
        }
        .container {
            width: 90%; max-width: 500px; padding: 30px;
            background: var(--card-bg);
            border-radius: 20px;
            border: 1px solid rgba(0, 243, 255, 0.2);
            box-shadow: 0 0 30px rgba(0, 243, 255, 0.15), inset 0 0 15px rgba(157, 0, 255, 0.1);
            backdrop-filter: blur(12px);
            z-index: 1; position: relative; text-align: center;
            animation: fadeIn 1s ease-in-out;
        }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
        h1 {
            font-family: 'Orbitron', sans-serif; font-size: 22px; font-weight: 900;
            background: linear-gradient(90deg, var(--neon-blue), var(--neon-purple));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            margin-bottom: 20px; text-shadow: 0 0 10px rgba(0,243,255,0.3);
        }
        .input-box {
            width: 100%; padding: 14px; margin: 12px 0; border-radius: 10px; border: 1px solid rgba(0,243,255,0.3);
            background: rgba(0, 0, 0, 0.5); color: #fff; font-size: 16px; outline: none; transition: 0.3s;
        }
        .input-box:focus { border-color: var(--neon-blue); box-shadow: 0 0 15px rgba(0,243,255,0.4); }
        .btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 15px; }
        .btn {
            padding: 14px; border: none; border-radius: 10px; font-size: 16px; font-weight: 700;
            cursor: pointer; text-transform: uppercase; transition: all 0.3s ease; position: relative; overflow: hidden;
        }
        .btn-primary { background: linear-gradient(45deg, #00f3ff, #0066ff); color: #000; box-shadow: 0 0 15px rgba(0,243,255,0.3); }
        .btn-danger { background: linear-gradient(45deg, #ff0055, #9d00ff); color: #fff; box-shadow: 0 0 15px rgba(255,0,85,0.3); }
        .btn-info { background: linear-gradient(45deg, #11998e, #38ef7d); color: #000; box-shadow: 0 0 15px rgba(56,239,125,0.3); }
        .btn-admin { background: linear-gradient(45deg, #f857a6, #ff5858); color: #fff; box-shadow: 0 0 15px rgba(248,87,166,0.3); grid-column: span 2; }
        .btn:hover { transform: translateY(-3px) scale(1.02); filter: brightness(1.2); }
        .code-display {
            margin-top: 20px; padding: 15px; background: rgba(0,0,0,0.8); border-radius: 10px;
            border: 1px dashed var(--neon-blue); font-family: 'Orbitron', sans-serif; font-size: 26px;
            letter-spacing: 5px; color: var(--neon-blue); display: none;
        }
        .admin-section { display: none; margin-top: 20px; text-align: left; }
        .account-card {
            background: rgba(255,255,255,0.05); padding: 10px 15px; border-radius: 8px; margin-bottom: 8px;
            display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(255,255,255,0.1);
        }
    </style>
</head>
<body>
    <div class="bg-grid"></div>
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

        <div id="adminPanel" class="admin-section">
            <h3 style="color:var(--neon-blue); margin-bottom:10px;">🛡️ Active Sessions</h3>
            <div id="accountsList"></div>
        </div>
    </div>

    <script>
        async function connectBot() {
            const phone = document.getElementById('phoneNumber').value;
            if(!phone) return Swal.fire('Error', 'Please enter a valid phone number', 'error');

            Swal.fire({ title: 'Requesting Pairing Code...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            
            const res = await fetch('/connect', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ phone })
            }).then(r => r.json());

            if(res.success) {
                setTimeout(checkStatus, 4000);
            } else {
                Swal.fire('Failed', res.error || 'Connection Failed', 'error');
            }
        }

        async function disconnectBot() {
            const phone = document.getElementById('phoneNumber').value;
            if(!phone) return Swal.fire('Error', 'Enter Phone Number to Remove', 'error');

            const res = await fetch('/disconnect', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ phone })
            }).then(r => r.json());

            if(res.success) {
                Swal.fire('Success', 'Account Removed Successfully!', 'success');
                document.getElementById('codeDisplay').style.display = 'none';
            } else {
                Swal.fire('Error', res.error, 'error');
            }
        }

        async function checkStatus() {
            const phone = document.getElementById('phoneNumber').value;
            if(!phone) return Swal.fire('Error', 'Enter Phone Number', 'error');

            const res = await fetch(`/status/${phone}`).then(r => r.json());
            const display = document.getElementById('codeDisplay');

            if(res.connected) {
                Swal.fire('Status', '🟢 Account Connected & Active!', 'success');
                display.style.display = 'none';
            } else if(res.code) {
                Swal.close();
                display.innerText = res.code;
                display.style.display = 'block';
            } else {
                Swal.fire('Status', '🟡 Generating Pairing Code, try again in 3s...', 'info');
            }
        }

        async function openAdminPanel() {
            const { value: password } = await Swal.fire({
                title: 'Admin Verification',
                input: 'password',
                inputPlaceholder: 'Enter Admin Secret Key',
                showCancelButton: true
            });

            if (password === 'VIVEKJOD') {
                const res = await fetch('/admin/accounts?pass=' + password).then(r => r.json());
                const list = document.getElementById('accountsList');
                list.innerHTML = '';
                
                res.accounts.forEach(acc => {
                    list.innerHTML += `
                        <div class="account-card">
                            <span>+${acc.phone} (${acc.status})</span>
                            <button class="btn btn-danger" style="padding:5px 10px; font-size:12px;" onclick="adminForceDisconnect('${acc.phone}')">Remove</button>
                        </div>
                    `;
                });
                document.getElementById('adminPanel').style.display = 'block';
                Swal.fire('Welcome Boss!', 'Admin Control Granted.', 'success');
            } else if(password) {
                Swal.fire('Access Denied', 'Wrong Admin Password!', 'error');
            }
        }

        async function adminForceDisconnect(phone) {
            document.getElementById('phoneNumber').value = phone;
            await disconnectBot();
            openAdminPanel();
        }
    </script>
</body>
</html>
"""

@app.route('/')
def home():
    return render_template_string(HTML_TEMPLATE)

@app.route('/connect', methods=['POST'])
def connect():
    res = requests.post(f"{NODE_ENGINE_URL}/api/connect", json=request.json)
    return jsonify(res.json())

@app.route('/disconnect', methods=['POST'])
def disconnect():
    res = requests.post(f"{NODE_ENGINE_URL}/api/disconnect", json=request.json)
    return jsonify(res.json())

@app.route('/status/<phone>')
def status(phone):
    res = requests.get(f"{NODE_ENGINE_URL}/api/status/{phone}")
    return jsonify(res.json())

@app.route('/admin/accounts')
def admin_accounts():
    password = request.args.get('pass')
    if password == ADMIN_PASSWORD:
        res = requests.get(f"{NODE_ENGINE_URL}/api/admin/accounts")
        return jsonify(res.json())
    return jsonify({"error": "Unauthorized"}), 403

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)
