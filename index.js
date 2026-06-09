const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

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

// Функция для выполнения консольных команд MEGA
const runMegaCommand = (command) => {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) reject(error || stderr);
            else resolve(stdout.trim());
        });
    });
};

// Авторизация в официальном клиенте MEGA при старте сервера
if (megaEmail && megaPassword) {
    console.log('🔄 Начинаем настройку официального клиента MEGA...');
    // Устанавливаем официальную консольную утилиту MEGA на сервер Render
    exec('curl -fsSL https://mega.nz -o megacmd.deb && dpkg -i megacmd.deb || apt-get install -f -y', async (err) => {
        try {
            // Логинимся в аккаунт
            await runMegaCommand(`mega-login "${megaEmail}" "${megaPassword}"`);
            console.log('✅ Официальный клиент MEGA успешно авторизован!');
            isMegaReady = true;
        } catch (authError) {
            console.error('❌ Ошибка входа в аккаунт MEGA:', authError);
        }
    });
} else {
    console.warn('⚠️ Переменные MEGA_EMAIL или MEGA_PASSWORD не заданы в Environment на Render');
}

// Настройка Multer для временного сохранения файлов на диске перед отправкой
const upload = multer({ dest: 'temp/' });

// --- МАРШРУТЫ (HTTP ENDPOINTS) ---

app.get('/', (req, res) => {
    res.json({
        status: "ok",
        message: "🚀 Сервер мессенджера Hokuo работает",
        storage: isMegaReady ? "✅ MEGA успешно подключена через официальный клиент" : "❌ MEGA не авторизована",
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

// Загрузка файлов через официальную команду MEGA
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!isMegaReady) return res.status(503).json({ error: "Облако MEGA сейчас недоступно" });
    if (!req.file) return res.status(400).json({ error: "Файл не отправлен" });

    const localFilePath = req.file.path;
    const remoteFileName = `${Date.now()}_${req.file.originalname}`;

    try {
        // 1. Отправляем файл в облако командой mega-put
        await runMegaCommand(`mega-put "${localFilePath}" /`);
        
        // 2. Переименовываем его в корне, чтобы не было дублей
        await runMegaCommand(`mega-mv "/${path.basename(localFilePath)}" "/${remoteFileName}"`);
        
        // 3. Получаем официальную публичную ссылку командой mega-export
        const rawLinkOutput = await runMegaCommand(`mega-export -a "/${remoteFileName}"`);
        
        // Извлекаем чистый URL из ответа консоли
        const urlMatch = rawLinkOutput.match(/https:\/\/mega\.nz\/file\/[^\s]+/);
        const fileUrl = urlMatch ? urlMatch[0] : rawLinkOutput;

        // Удаляем временный файл с сервера Render, чтобы не забивать память
        fs.unlinkSync(localFilePath);

        res.json({ url: fileUrl });
    } catch (uploadErr) {
        console.error('Ошибка при работе с командами MEGA:', uploadErr);
        if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
        res.status(500).json({ error: "Не удалось сохранить файл в MEGA" });
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

