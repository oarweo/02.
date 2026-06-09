const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Создаем папку для вечного хранения файлов прямо внутри сервера
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Делаем папку uploads публичной, чтобы файлы открывались по прямым ссылкам
app.use('/uploads', express.static(UPLOAD_DIR));

// База данных в оперативной памяти для мессенджера Hokuo
const users = new Map(); 
const blacklists = new Map(); 
const onlineUsers = new Map(); 

// Настройка Multer для сохранения файлов на локальный диск сервера
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        // Создаем уникальное имя файла, убирая пробелы и спецсимволы
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
        cb(null, uniqueSuffix + '_' + safeName);
    }
});
const upload = multer({ storage: storage });

// --- МАРШРУТЫ (HTTP ENDPOINTS) ---

// Проверка статуса сервера через браузер
app.get('/', (req, res) => {
    // Автоматически определяем текущий адрес сервера в интернете
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;

    res.json({
        status: "ok",
        message: "🚀 Сервер мессенджера Hokuo успешно работает!",
        storage: "✅ Локальное хранилище сервера активировано (Файлы сохраняются внутри Render)",
        upload_endpoint: `${baseUrl}/upload`,
        timestamp: new Date().toISOString()
    });
});

// Рабочий маршрут регистрации (Убирает ошибку 404 в приложении)
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

// Загрузка картинок и файлов напрямую на сервер Render без внешних блокировок
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "Файл не отправлен" });
    }

    // Формируем прямую рабочуть ссылку на файл в интернете
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const host = req.get('host');
    const fileUrl = `${protocol}://${host}/uploads/${req.file.filename}`;

    // Возвращаем приложению готовую ссылку на изображение
    res.json({ url: fileUrl });
});

// --- ЛОГИКА ЧАТА (WEBSOCKETS) ---
io.on('connection', (socket) => {
    console.log('Пользователь подключился к Hokuo:', socket.id);

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
    console.log(`Сервер Hokuo запущен на порту ${PORT}`);
});
