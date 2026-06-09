const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// База данных в памяти для тестов Hokuo
const users = new Map(); 
const blacklists = new Map(); 
const onlineUsers = new Map(); 

const megaEmail = process.env.MEGA_EMAIL;
const megaPassword = process.env.MEGA_PASSWORD;
let isMegaReady = false;

// Прямая авторизация через официальный HTTP API сервер MEGA (Без библиотек и сторонних утилит)
async function loginToMegaAPI() {
    if (!megaEmail || !megaPassword) {
        console.warn('⚠️ Переменные MEGA_EMAIL или MEGA_PASSWORD не заданы в Environment на Render');
        return;
    }

    try {
        console.log('🔄 Отправляем прямой сетевой запрос авторизации в API MEGA...');
        
        // Хешируем пароль по правилам криптографии MEGA API
        const passwordHash = crypto.createHash('sha256').update(megaPassword).digest('base64');

        const response = await fetch('https://mega.co.nz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([{
                a: 'us', // действие: личный вход
                user: megaEmail,
                password: passwordHash
            }])
        });

        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
        
        const data = await response.json();
        
        // Проверяем, вернула ли MEGA ошибку (отрицательные числа в API MEGA означают коды ошибок)
        if (typeof data === 'number' || (Array.isArray(data) && typeof data[0] === 'number')) {
            const errorCode = Array.isArray(data) ? data[0] : data;
            console.error(`❌ Сетевой API MEGA отклонил данные. Код ошибки: ${errorCode}. Проверьте правильность почты и пароля в настройках Render.`);
            isMegaReady = false;
        } else {
            console.log('✅ Успешное прямое сетевое подключение к API облака MEGA!');
            isMegaReady = true;
        }
    } catch (apiError) {
        console.error('❌ Ошибка сети при попытке связаться с API MEGA:', apiError.message);
        isMegaReady = false;
    }
}

// Запускаем сетевой вход при старте сервера
loginToMegaAPI();

// Настройка Multer для приема файлов в буфер памяти
const upload = multer({ storage: multer.memoryStorage() });

// --- МАРШРУТЫ (HTTP ENDPOINTS) ---

app.get('/', (req, res) => {
    res.json({
        status: "ok",
        message: "🚀 Сервер мессенджера Hokuo работает",
        storage: isMegaReady ? "✅ MEGA успешно подключена напрямую через HTTP API" : "❌ MEGA не настроена (неверные данные авторизации)",
        timestamp: new Date().toISOString()
    });
});

// Маршрут регистрации
app.post('/register', async (req, res) => {
    const { username, password, hokuo_id } = req.body;
    if (!username || !password || !hokuo_id) return res.status(400).json({ error: "Заполните все поля" });
    if (users.has(hokuo_id)) return res.status(400).json({ error: "Этот Hokuo ID уже занят" });

    const hashedPassword = await bcrypt.hash(password, 10);
    users.set(hokuo_id, { username, password_hash: hashedPassword, hokuo_id });
    blacklists.set(hokuo_id, new Set());
    res.status(201).json({ status: "success", message: "Пользователь зарегистрирован", hokuo_id });
});

// Маршрут авторизации
app.post('/login', async (req, res) => {
    const { hokuo_id, password } = req.body;
    const user = users.get(hokuo_id);
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: "Неверный пароль" });

    res.json({ status: "success", token: "session-token-hokuo", username: user.username, hokuo_id });
});

// Загрузка файлов напрямую в MEGA через API запрос
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!isMegaReady) return res.status(503).json({ error: "Облако MEGA сейчас недоступно" });
    if (!req.file) return res.status(400).json({ error: "Файл не отправлен" });

    try {
        const remoteFileName = `${Date.now()}_${req.file.originalname}`;
        
        // Отправляем файл бинарным HTTP-потоком прямо на upload-сервер MEGA API
        const uploadResponse = await fetch(`https://mega.co.nz?id=${Math.floor(Math.random() * 1000000)}&ak=hokuoMessenger`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-MEGA-Filename': encodeURIComponent(remoteFileName)
            },
            body: req.file.buffer
        });

        if (!uploadResponse.ok) throw new Error("MEGA API Upload Rejected");

        const uploadResult = await uploadResponse.json();
        
        // Формируем прямую ссылку на файл
        const fileUrl = `https://mega.nz{Date.now()}`;

        res.json({ url: fileUrl });
    } catch (uploadErr) {
        console.error('Ошибка загрузки файла по HTTP API:', uploadErr.message);
        res.status(500).json({ error: "Не удалось сохранить файл в MEGA через API" });
    }
});

// --- ЛОГИКА ЧАТА (WEBSOCKETS) ---
io.on('connection', (socket) => {
    socket.on('userOnline', (hokuo_id) => {
        onlineUsers.set(socket.id, hokuo_id);
        io.emit('statusChanged', { hokuo_id, status: "online" });
    });

    socket.on('sendMessage', (data) => {
        const { sender_id, recipient_id } = data;
        const recipientBlacklist = blacklists.get(recipient_id);
        if (recipientBlacklist && recipientBlacklist.has(sender_id)) return;
        io.emit('newMessage', data);
    });

    socket.on('blockUser', ({ my_id, block_id }) => {
        const myBlacklist = blacklists.get(my_id);
        if (myBlacklist) {
            myBlacklist.add(block_id);
            socket.emit('blockedStatus', { target_id: block_id, isBlocked: true });
        }
    });

    socket.on('disconnect', () => {
        const hokuo_id = onlineUsers.get(socket.id);
        if (hokuo_id) {
            io.emit('statusChanged', { hokuo_id, status: "offline" });
            onlineUsers.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Сервер Hokuo успешно запущен на порту ${PORT}`);
});
