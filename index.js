// ============================================================
//  Сервер мессенджера — MEGA Cloud Storage Edition
//  Стек: Node.js + Express + Socket.io + Multer + megajs
//  Хостинг: Render.com (free tier)
//
//  ──────────────────────────────────────────────────────────
//  КАК НАСТРОИТЬ ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ:
//
//  Локальная разработка — создайте файл .env в корне проекта
//  (и добавьте .env в .gitignore!):
//
//    MEGA_EMAIL=your@email.com
//    MEGA_PASSWORD=yourpassword
//    PORT=3000
//
//  Чтобы .env читался, установите пакет dotenv и раскомментируйте
//  строку ниже:
//    require('dotenv').config();
//
//  На Render.com — добавьте в раздел "Environment Variables":
//    Key: MEGA_EMAIL   → Value: your@email.com
//    Key: MEGA_PASSWORD → Value: yourpassword
//    (PORT Render задаёт автоматически)
// ============================================================

// require('dotenv').config(); // ← раскомментируйте для локальной разработки с .env

// ── Импорт зависимостей ──────────────────────────────────────
const express      = require('express');    // HTTP-фреймворк
const http         = require('http');       // Нативный HTTP-сервер Node.js
const { Server }   = require('socket.io'); // WebSocket-сервер
const multer       = require('multer');    // Приём файлов (multipart/form-data)
const { Readable } = require('stream');   // Создание потока из буфера (нативный модуль)
const { Storage }  = require('megajs');   // Клиент MEGA Cloud Storage

// ── Инициализация Express + HTTP-сервера ─────────────────────
const app    = express();
const server = http.createServer(app); // Socket.io требует http.Server, не просто app

// ── Socket.io: разрешаем подключения со всех источников ──────
const io = new Server(server, {
  cors: {
    origin:  '*',                 // В продакшене замените на домен вашего фронтенда
    methods: ['GET', 'POST'],
  },
});

// ── Порт: Render задаёт через PORT, локально — 3000 ──────────
const PORT = process.env.PORT || 3000;

// ============================================================
//  MEGA CLOUD STORAGE — инициализация и загрузка файлов
// ============================================================

let megaStorage = null; // Объект авторизованного хранилища
let megaReady   = false; // true — авторизация прошла успешно

/**
 * Авторизуется в MEGA через переменные окружения.
 *
 * Переменные:
 *   MEGA_EMAIL    — email вашего MEGA-аккаунта
 *   MEGA_PASSWORD — пароль от MEGA-аккаунта
 *
 * Если переменные не заданы — сервер стартует, но /upload будет
 * возвращать ошибку 503 до тех пор, пока они не будут настроены.
 */
async function initMega() {
  const email    = process.env.MEGA_EMAIL;
  const password = process.env.MEGA_PASSWORD;

  if (!email || !password) {
    console.error('❌ MEGA: переменные MEGA_EMAIL и/или MEGA_PASSWORD не заданы!');
    console.error('   Загрузка файлов будет недоступна.');
    console.error('   Добавьте переменные окружения и перезапустите сервер.');
    return;
  }

  try {
    // autologin: false — войдём вручную через .login(), чтобы поймать ошибки
    megaStorage = new Storage({ email, password, autologin: false });
    await megaStorage.login();

    megaReady = true;
    console.log('✅ MEGA: авторизация успешна — облачное хранилище готово');
  } catch (err) {
    console.error('❌ MEGA: ошибка авторизации:', err.message);
    megaStorage = null;
    megaReady   = false;
  }
}

/**
 * Загружает Buffer файла напрямую в MEGA — без сохранения на диск.
 *
 * Принцип работы:
 *   Buffer (RAM) → Readable поток → зашифрованный MEGA-стрим → облако
 *   Диск Render НЕ используется ни на одном этапе.
 *
 * @param {Buffer} buffer   - Буфер файла из памяти (req.file.buffer)
 * @param {string} filename - Имя файла, которое будет видно в MEGA
 * @returns {Promise<string>} Публичная ссылка вида https://mega.nz/file/...
 */
async function uploadBufferToMega(buffer, filename) {
  return new Promise((resolve, reject) => {
    // Открываем зашифрованный стрим загрузки в корень MEGA-аккаунта
    const uploadStream = megaStorage.root.upload({
      name: filename,       // Имя файла внутри MEGA
      size: buffer.length,  // Размер обязателен — MEGA использует для шифрования потока
    });

    // Файл успешно загружен — получаем публичную ссылку
    uploadStream.on('complete', async (megaFile) => {
      try {
        const link = await megaFile.link(); // Генерируем публичную прямую ссылку
        resolve(link);
      } catch (linkErr) {
        reject(linkErr);
      }
    });

    uploadStream.on('error', reject);

    // Создаём Readable прямо из буфера и стримим в MEGA.
    // Файл НИКОГДА не касается диска сервера!
    Readable.from(buffer).pipe(uploadStream);
  });
}

// ============================================================
//  MULTER — приём файлов в оперативную память (без диска!)
// ============================================================

// memoryStorage: multer держит файл в req.file.buffer (RAM).
// Никаких временных файлов на диске Render не создаётся.
const upload = multer({
  storage: multer.memoryStorage(),

  // Белый список MIME-типов
  fileFilter: (req, file, cb) => {
    const ALLOWED = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
      'video/mp4',  'video/webm',  'video/ogg',
      'audio/mpeg', 'audio/ogg',  'audio/wav',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
    ];

    if (ALLOWED.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Тип файла не поддерживается: ${file.mimetype}`), false);
    }
  },

  limits: { fileSize: 50 * 1024 * 1024 }, // Лимит: 50 МБ
});

// ============================================================
//  EXPRESS MIDDLEWARE
// ============================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
//  HTTP-МАРШРУТЫ
// ============================================================

// ── GET / — Healthcheck ───────────────────────────────────────
// Render.com пингует этот endpoint, чтобы сервис не «засыпал».
app.get('/', (req, res) => {
  res.json({
    status:    'ok',
    message:   '🚀 Сервер мессенджера (MEGA Edition) работает',
    storage:   megaReady ? '☁️  MEGA Cloud Storage' : '❌ MEGA не настроена',
    timestamp: new Date().toISOString(),
  });
});

// ── POST /upload ─────────────────────────────────────────────
// Принимает файл из поля "file" в multipart/form-data.
//
// Поток обработки (без диска!):
//   1. multer читает multipart-тело → req.file.buffer (только RAM)
//   2. Буфер стримится напрямую в MEGA через зашифрованный поток
//   3. MEGA возвращает публичную ссылку
//   4. Клиент получает: { "url": "https://mega.nz/file/..." }
//   5. Все WebSocket-клиенты получают событие "file_message"
app.post('/upload', upload.single('file'), async (req, res) => {
  // Проверяем: multer передал файл?
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'Файл не передан. Используйте поле "file" в multipart/form-data.',
    });
  }

  // MEGA должна быть инициализирована
  if (!megaReady) {
    return res.status(503).json({
      success: false,
      message: 'MEGA Cloud Storage не настроена. Задайте MEGA_EMAIL и MEGA_PASSWORD.',
    });
  }

  // Уникальное имя: timestamp + случайное + оригинальное (без пробелов)
  const prefix   = `${Date.now()}_${Math.round(Math.random() * 1e4)}`;
  const safeName = req.file.originalname.replace(/\s+/g, '_');
  const filename = `${prefix}_${safeName}`;

  const buffer   = req.file.buffer; // Файл целиком в RAM — диск не нужен
  const fileSize = buffer.length;

  try {
    console.log(`☁️  Загружаем в MEGA: ${filename} (${fileSize} байт)`);

    // Загружаем буфер напрямую в MEGA и получаем публичную ссылку
    const fileUrl = await uploadBufferToMega(buffer, filename);

    console.log(`✅ Загружено в MEGA: ${fileUrl}`);

    // Уведомляем всех подключённых клиентов через WebSocket
    io.emit('file_message', {
      filename,
      originalname: req.file.originalname,
      mimetype:     req.file.mimetype,
      size:         fileSize,
      url:          fileUrl,
      storage:      'mega',
      timestamp:    new Date().toISOString(),
    });

    // Возвращаем клиенту ссылку — главное поле: "url"
    return res.status(201).json({
      success:      true,
      url:          fileUrl,   // ← Публичная ссылка MEGA (требование задания)
      message:      'Файл успешно загружен в MEGA',
      filename,
      originalname: req.file.originalname,
      mimetype:     req.file.mimetype,
      size:         fileSize,
      storage:      'mega',
    });

  } catch (err) {
    console.error('❌ Ошибка загрузки в MEGA:', err.message);
    return res.status(500).json({
      success: false,
      message: `Ошибка загрузки файла: ${err.message}`,
    });
  }
});

// ── Централизованный обработчик ошибок ───────────────────────
// Перехватывает ошибки multer (LIMIT_FILE_SIZE и др.) и любые next(err)
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'Файл превышает лимит 50 МБ' });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// ============================================================
//  WEBSOCKET — СОБЫТИЯ SOCKET.IO
// ============================================================

// Онлайн-пользователи в памяти.
// Ключ: socket.id  |  Значение: { username, joinedAt }
const activeUsers = new Map();

io.on('connection', (socket) => {
  console.log(`✅ Подключился: ${socket.id}`);

  // ── join: пользователь называет своё имя ─────────────────
  // Клиент отправляет: { username: 'Иван' }
  socket.on('join', (data) => {
    const username = (data?.username?.trim()) || `User_${socket.id.slice(0, 4)}`;

    activeUsers.set(socket.id, { username, joinedAt: new Date().toISOString() });
    console.log(`👤 Вошёл: ${username} (${socket.id})`);

    // Подтверждение самому пользователю
    socket.emit('join_success', {
      message:     `Добро пожаловать, ${username}!`,
      username,
      onlineCount: activeUsers.size,
    });

    // Уведомление остальным
    socket.broadcast.emit('user_joined', {
      username,
      onlineCount: activeUsers.size,
      timestamp:   new Date().toISOString(),
    });

    // Актуальный список всем
    io.emit('users_online', Array.from(activeUsers.values()));
  });

  // ── message: текстовое сообщение ─────────────────────────
  // Клиент отправляет: { text: 'Привет!' }
  socket.on('message', (data) => {
    if (!data?.text || typeof data.text !== 'string') {
      socket.emit('error', { message: 'Некорректный формат сообщения' });
      return;
    }

    const senderInfo = activeUsers.get(socket.id);
    const username   = senderInfo?.username || 'Аноним';

    const payload = {
      id:        `${socket.id}_${Date.now()}`,
      username,
      text:      data.text.slice(0, 4000), // Максимальная длина сообщения
      timestamp: new Date().toISOString(),
    };

    console.log(`💬 [${username}]: ${payload.text}`);

    // Рассылаем ВСЕМ (включая отправителя)
    io.emit('message', payload);
  });

  // ── typing: индикатор «пользователь печатает» ────────────
  // Клиент отправляет: { isTyping: true/false }
  socket.on('typing', (data) => {
    const senderInfo = activeUsers.get(socket.id);
    const username   = senderInfo?.username || 'Кто-то';

    // Отправляем ВСЕМ, кроме самого печатающего
    socket.broadcast.emit('typing', {
      username,
      isTyping:  !!data?.isTyping,
      timestamp: new Date().toISOString(),
    });
  });

  // ── disconnect: пользователь ушёл ────────────────────────
  socket.on('disconnect', (reason) => {
    const userInfo = activeUsers.get(socket.id);
    const username = userInfo?.username || socket.id;

    activeUsers.delete(socket.id);
    console.log(`❌ Отключился: ${username} | Причина: ${reason}`);

    io.emit('user_left', {
      username,
      onlineCount: activeUsers.size,
      timestamp:   new Date().toISOString(),
    });

    io.emit('users_online', Array.from(activeUsers.values()));
  });
});

// ============================================================
//  ЗАПУСК СЕРВЕРА
// ============================================================

// async IIFE — сначала авторизуемся в MEGA, потом начинаем принимать запросы
(async () => {
  await initMega(); // Шаг 1: подключаемся к MEGA

  server.listen(PORT, () => { // Шаг 2: запускаем HTTP/WebSocket сервер
    console.log('============================================================');
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`☁️  Хранилище: ${megaReady ? 'MEGA Cloud Storage ✅' : 'MEGA не настроена ❌'}`);
    console.log(`🌐 Healthcheck:   GET  http://localhost:${PORT}/`);
    console.log(`📤 Загрузка файлов: POST http://localhost:${PORT}/upload`);
    console.log('============================================================');
  });
})();
