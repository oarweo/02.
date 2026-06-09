const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const mega = require('mega');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// База данных в оперативной памяти для тестов Hokuo
const users = new Map(); 
const blacklists = new Map(); 
const onlineUsers = new Map(); 

// Чтение логина и пароля из настроек Render Environment
const megaEmail = process.env.MEGA_EMAIL;
const megaPassword = process.env.MEGA_PASSWORD;
let megaStorage = null;

if (megaEmail && megaPassword) {
    megaStorage = mega({
        email: megaEmail,
        password: megaPassword
    }, (err) => {
        if (err) {
            console.error('Ошибка авторизации в MEGA:', err.message);
            megaStorage = null;
        } else {
            console.log('✅ Успешное подключение к облаку MEGA');
        }
    });
} else {
    console.warn('⚠️ Переменные MEGA_EMAIL или MEGA_PASSWORD не заданы на Render');
}

// Настройка приема файлов в память
const upload = multer({ storage: multer.memoryStorage() });

// --- МАРШРУТЫ (HTTP ENDPOINTS) ---

// Проверка статуса сервера через браузер
app.get('/', (req, res) => {
    res.json({
        status: "ok",
        message: "🚀 Сервер мессенджера Hokuo работает",
        storage: megaStorage ? "✅ MEGA успешно подключена" : "❌ MEGA не настроена (проверьте вкладку Environment на Render)",
        timestamp: new Date().toISOString()
    });
});

// Рабочий маршрут регистрации (Убирает ошибку 404)
app.post('/register', async (req, res) => {
    const { username, password, hokuo_id } = req.body;
    
    if (!username || !password || !hokuo_id) {
        return res.status(400).json({ error: "Заполните все поля" });
    }

    if (users.has(hokuo_id)) {
        return res.status(400).json({ error: "Этот Hokuo ID уже занят" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    users.set(hokuo_id, { username, password_hash: hashedPassword, hokuo_id });
    blacklists.set(hokuo_id, new Set());

    res.status(201).json({ status: "success", message: "Пользователь зарегистрирован", hokuo_id });
});

// Маршрут входа (Авторизация)
app.post('/login', async (req, res) => {
    const { hokuo_id, password } = req.body;
    
    const user = users.get(hokuo_id);
    if (!user) {
        return res.status(404).json({ error: "Пользователь не найден" });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
        return res.status(401).json({ error: "Неверный пароль" });
    }

    res.json({ status: "success", token: "session-token-hokuo", username: user.username, hokuo_id });
});

// Загрузка картинок и файлов напрямую в MEGA
app.post('/upload', upload.single('file'), (req, res) => {
    if (!megaStorage) {
        return res.status(503).json({ error: "Облачное хранилище MEGA недоступно" });
    }
    if (!req.file) {
        return res.status(400).json({ error: "Файл не отправлен" });
    }

    megaStorage.upload({
        name: `${Date.now()}_${req.file.originalname}`,
        size: req.file.size
    }, req.file.buffer, (err, file) => {
        if (err) {
            console.error('Ошибка загрузки файла в MEGA:', err);
            return res.status(500).json({ error: "Не удалось сохранить файл в облако" });
        }
        
        file.link((linkErr, url) => {
            if (linkErr) {
                return res.status(500).json({ error: "Не удалось сгенерировать ссылку" });
            }
            res.json({ url: url });
        });
    });
});

// --- ЛОГИКА ЧАТА (WEBSOCKETS) ---
io.on('connection', (socket) => {
    console.log('Пользователь подключился:', socket.id);

    socket.on('userOnline', (hokuo_id) => {
        onlineUsers.set(socket.id, hokuo_id);
        io.emit('statusChanged', { hokuo_id, status: "online" });
    });

    socket.on('sendMessage', (data) => {
        const { sender_id, recipient_id } = data;
        const recipientBlacklist = blacklists.get(recipient_id);
        
        if (recipientBlacklist && recipientBlacklist.has(sender_id)) {
            return socket.emit('error', { message: "Вы заблокированы этим пользователем" });
        }

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
