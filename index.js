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

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
app.use('/uploads', express.static(UPLOAD_DIR));

// База данных в оперативной памяти (сбросится при перезапуске сервера)
const users = new Map(); 
const blacklists = new Map(); 
const onlineUsers = new Map(); 

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '_' + file.originalname.replace(/[^a-zA-Z0-9.]/g, "_"));
    }
});
const upload = multer({ storage: storage });

// --- ПРОВЕРКА ВСЕХ ПУТЕЙ ДЛЯ ТЕБЯ ---
// Теперь при заходе на https://zero2-7gya.onrender.com ты увидишь, что пути ЕСТЬ!
app.get('/', (req, res) => {
    res.json({
        status: "working",
        message: "🚀 Сервер Hokuo успешно запущен!",
        available_endpoints: {
            registration: "POST /register",
            login: "POST /login",
            upload_files: "POST /upload"
        }
    });
});

// КРИТИЧЕСКИЙ МАРШРУТ РЕГИСТРАЦИИ
app.post('/register', async (req, res) => {
    console.log('=== ЗАПРОС НА РЕГИСТРАЦИЮ ===', req.body);
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

    console.log(`✅ Пользователь ${username} (${hokuo_id}) успешно сохранен в базу!`);
    res.status(201).json({ status: "success", message: "Пользователь зарегистрирован", hokuo_id });
});

// КРИТИЧЕСКИЙ МАРШРУТ ВХОДА
app.post('/login', async (req, res) => {
    console.log('=== ЗАПРОС НА ВХОД ===', req.body);
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

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Файл не отправлен" });
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const fileUrl = `${protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
});

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
