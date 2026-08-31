const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// قراءة الأيديهات وفصلها بفاصلة لتدعم أكثر من لاعب
const USER_IDS_ENV = process.env.USER_ID || '9511971040';
const USER_IDS = USER_IDS_ENV.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

const COOKIE = process.env.ROBLOX_COOKIE || process.env.ROBLOSECURITY;
const DB_FILE = process.env.DB_PATH || "/data/data.json";
const PORT = process.env.PORT || 3000;

if (!COOKIE) {
    console.error("خطأ: يجب تحديد متغير البيئة ROBLOX_COOKIE أو ROBLOSECURITY");
    process.exit(1);
}

let csrfToken = '';
let usernameCache = {}; // لتخزين أسماء اللاعبين لعدم طلبها مراراً

// تحميل البيانات لكل لاعب
function loadData() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("خطأ في قراءة ملف البيانات:", e);
    }
    return {};
}

let db = loadData();

// تهيئة قاعدة البيانات لجميع اللاعبين المطلوبين
USER_IDS.forEach(id => {
    if (!db[id]) {
        db[id] = { currentSession: null, history: [] };
    }
});

function saveData() {
    try {
        const dir = path.dirname(DB_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
        console.error("خطأ في حفظ البيانات:", e);
    }
}

// دالة الطلبات لروبلوكس
function robloxRequest(method, urlString, bodyData = null, isRetry = false) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Cookie': `.ROBLOSECURITY=${COOKIE}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        };

        if (csrfToken) options.headers['X-CSRF-TOKEN'] = csrfToken;

        if (bodyData) {
            const postData = JSON.stringify(bodyData);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(postData);
        }

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 403 && !isRetry) {
                    const newCsrf = res.headers['x-csrf-token'];
                    if (newCsrf) {
                        csrfToken = newCsrf;
                        return robloxRequest(method, urlString, bodyData, true).then(resolve).catch(reject);
                    }
                }
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
                } else {
                    reject(new Error(`HTTP Error ${res.statusCode}`));
                }
            });
        });

        req.on('error', err => reject(err));
        if (bodyData) req.write(JSON.stringify(bodyData));
        req.end();
    });
}

// جلب اسم اللعبة
async function fetchGameName(universeId) {
    if (!universeId) return "لعبة غير معروفة";
    try {
        const res = await robloxRequest('GET', `https://games.roblox.com/v1/games?universeIds=${universeId}`);
        if (res && res.data && res.data.length > 0) return res.data[0].name;
    } catch (e) {}
    return `Universe ${universeId}`;
}

// جلب اسم اللاعب
async function fetchUsername(userId) {
    if (usernameCache[userId]) return usernameCache[userId];
    try {
        const res = await robloxRequest('GET', `https://users.roblox.com/v1/users/${userId}`);
        if (res && res.name) {
            usernameCache[userId] = res.name;
            return res.name;
        }
    } catch (e) {}
    return `User ${userId}`;
}

// فحص حضور جميع اللاعبين
async function checkPresence() {
    if (USER_IDS.length === 0) return;
    try {
        // تهيئة أسماء اللاعبين أولاً إذا لم تكن موجودة
        for (const id of USER_IDS) await fetchUsername(id);

        const res = await robloxRequest('POST', 'https://presence.roblox.com/v1/presence/users', {
            userIds: USER_IDS
        });

        if (!res || !res.userPresences) return;

        for (const presence of res.userPresences) {
            const userId = presence.userId;
            const type = presence.userPresenceType; 
            const placeId = presence.placeId;
            const universeId = presence.universeId;

            if (!db[userId]) db[userId] = { currentSession: null, history: [] };

            if (type === 2 && placeId) {
                if (!db[userId].currentSession || db[userId].currentSession.placeId !== placeId) {
                    if (db[userId].currentSession) closeSession(userId);
                    
                    const gameName = await fetchGameName(universeId);
                    db[userId].currentSession = {
                        placeId: placeId,
                        universeId: universeId,
                        gameName: gameName,
                        startTime: new Date().toISOString()
                    };
                    saveData();
                    console.log(`[→] اللاعب ${usernameCache[userId]} دخل إلى: ${gameName}`);
                }
            } else {
                if (db[userId].currentSession) closeSession(userId);
            }
        }
    } catch (e) {
        console.error("خطأ أثناء الفحص:", e.message);
    }
}

// إنهاء الجلسة وحساب المدة
function closeSession(userId) {
    const session = db[userId].currentSession;
    if (!session) return;
    const endTime = new Date();
    const startTime = new Date(session.startTime);
    const diffMs = endTime - startTime;
    
    const totalSeconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const durationFormatted = `${minutes} دقيقة و ${seconds} ثانية`;

    db[userId].history.unshift({
        gameName: session.gameName,
        startTime: session.startTime,
        endTime: endTime.toISOString(),
        duration: durationFormatted
    });

    // الاحتفاظ بآخر 50 جلسة لكل لاعب لتجنب تضخم الملف
    if (db[userId].history.length > 50) db[userId].history.pop();

    console.log(`[✓] اللاعب ${usernameCache[userId]} خرج من: ${session.gameName} | المدة: ${durationFormatted}`);
    db[userId].currentSession = null;
    saveData();
}

// خادم الويب
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    
    let currentHtml = '';
    let historyRows = '';

    USER_IDS.forEach(userId => {
        const username = usernameCache[userId] || `User ${userId}`;
        const userDb = db[userId];

        if (userDb && userDb.currentSession) {
            currentHtml += `<div style="background:#d4edda;padding:10px;border-radius:5px;margin-bottom:10px;border-right: 4px solid #28a745;">
                <strong>${username}:</strong> يلعب الآن <b>${userDb.currentSession.gameName}</b> (دخل: ${new Date(userDb.currentSession.startTime).toLocaleString()})
            </div>`;
        } else {
            currentHtml += `<div style="background:#f8d7da;padding:10px;border-radius:5px;margin-bottom:10px;border-right: 4px solid #dc3545;">
                <strong>${username}:</strong> غير متصل أو خارج اللعبة حالياً.
            </div>`;
        }

        if (userDb && userDb.history) {
            userDb.history.forEach(item => {
                historyRows += `<tr>
                    <td>${username}</td>
                    <td>${item.gameName}</td>
                    <td dir="ltr">${new Date(item.startTime).toLocaleString()}</td>
                    <td>${item.duration}</td>
                </tr>`;
            });
        }
    });

    if (historyRows === '') {
        historyRows = '<tr><td colspan="4" style="text-align:center;">لا توجد جلسات مسجلة بعد</td></tr>';
    }

    const html = `<!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <title>لوحة مراقبة روبلوكس</title>
        <style>
            body { font-family: Tahoma, sans-serif; background: #f4f7f6; margin: 0; padding: 20px; color: #333; }
            .container { max-width: 1000px; margin: auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            h1, h2 { color: #2c3e50; text-align: center; border-bottom: 2px solid #eee; padding-bottom: 10px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ddd; padding: 12px; text-align: right; }
            th { background-color: #2c3e50; color: white; }
            tr:nth-child(even) { background-color: #f9f9f9; }
        </style>
        <meta http-equiv="refresh" content="30">
    </head>
    <body>
        <div class="container">
            <h1>مراقبة حسابات روبلوكس متعددة</h1>
            <h2>حالة اللاعبين الحالية</h2>
            ${currentHtml}
            <h2>سجل الجلسات السابقة</h2>
            <table>
                <thead>
                    <tr>
                        <th>اللاعب</th>
                        <th>اسم اللعبة</th>
                        <th>وقت الدخول</th>
                        <th>المدة</th>
                    </tr>
                </thead>
                <tbody>
                    ${historyRows}
                </tbody>
            </table>
        </div>
    </body>
    </html>`;
    res.end(html);
});

server.listen(PORT, () => {
    console.log(`خادم الويب يعمل على المنفذ ${PORT}`);
});

checkPresence();
setInterval(checkPresence, 30000);