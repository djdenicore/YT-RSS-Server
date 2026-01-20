// server.js - Сервер RSS для YouTube Music
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { parseFile } from 'music-metadata';
import { XMLBuilder } from 'fast-xml-parser';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import crypto from 'crypto';
import https from 'https';
import http from 'http';

// Загружаем конфиг
import config from './config.js';

const app = express();

// Настройки из конфига
const PORT = process.env.PORT || config.server.port;
const HOST = config.server.host || 'localhost'; // Для прослушивания
const TRACKS_DIR = config.paths.tracksDir;
const COVERS_CACHE_DIR = config.paths.coversCacheDir;

// Кэш для RSS-данных
let rssCache = {
  data: null,
  lastUpdated: 0,
  fileHash: '',
  cacheDuration: config.cache.rssCacheDuration || 5 * 60 * 1000,
};

// Кэш для GUID файлов
const fileGuidCache = new Map();

// Функция для получения baseUrl на основе запроса
function getBaseUrl(req) {
  // Если в конфиге указан baseUrl, используем его
  if (config.server.baseUrl) {
    return config.server.baseUrl;
  }
  
  // Определяем протокол (http или https)
  const protocol = req.protocol || (req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'].split(',')[0] : 'http');
  
  // Определяем хост
  const host = req.get('host') || `${HOST}:${PORT}`;
  
  // Если хост содержит localhost, используем его как есть
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return `${protocol}://${host}`;
  }
  
  // Если есть заголовок X-Forwarded-Host (при проксировании), используем его
  const forwardedHost = req.get('x-forwarded-host');
  if (forwardedHost) {
    return `${protocol}://${forwardedHost}`;
  }
  
  // Иначе используем host из заголовка
  return `${protocol}://${host}`;
}

// Функция для скачивания изображения по URL
async function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    
    client.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image: ${response.statusCode}`));
        return;
      }
      
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer);
      });
    }).on('error', reject);
  });
}

// Создаем нужные папки
async function initDirs() {
  const dirs = [TRACKS_DIR, COVERS_CACHE_DIR];
  
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
      if (config.advanced.verboseLogging) {
        console.log(`📁 Создана папка: ${dir}`);
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

// Форматирование времени для iTunes
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Парсинг информации из имени папки/файла
function parseTrackInfo(folderName, fileName) {
  const separator = config.fileParsing.separator;
  let artist = config.rss.author;
  let title = path.parse(fileName).name;
  
  const folderParts = folderName.split(separator);
  if (folderParts.length >= 2) {
    artist = folderParts[0].trim();
    title = folderParts.slice(1).join(separator).trim();
  }
  
  return { artist, title };
}

// Генерация стабильного GUID
function generateStableGuid(filePath, stat) {
  try {
    const fileKey = `${filePath}:${stat.size}`;
    
    if (fileGuidCache.has(fileKey)) {
      return fileGuidCache.get(fileKey);
    }
    
    const hash = crypto.createHash('sha256').update(fileKey).digest('hex');
    const uuid = `${hash.substring(0, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;
    const guid = `urn:uuid:${uuid}`;
    
    fileGuidCache.set(fileKey, guid);
    return guid;
  } catch (error) {
    const backupHash = crypto.createHash('md5').update(filePath).digest('hex');
    return `urn:uuid:${backupHash.substring(0, 8)}-${backupHash.substring(8, 12)}-${backupHash.substring(12, 16)}-${backupHash.substring(16, 20)}-${backupHash.substring(20, 32)}`;
  }
}

// Функция для обрезки изображения в квадрат
async function cropToSquare(imageBuffer, size = 3000) {
  try {
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    
    // Если изображение уже квадратное и нужного размера
    if (metadata.width === metadata.height && metadata.width === size) {
      return await image.jpeg({ quality: 90 }).toBuffer();
    }
    
    // Определяем режим обрезки
    const cropMode = config.rss.youtube.cropMode || 'crop';
    
    if (cropMode === 'crop') {
      // Режим обрезки: обрезаем до квадрата по центру
      const minSize = Math.min(metadata.width, metadata.height);
      const left = Math.floor((metadata.width - minSize) / 2);
      const top = Math.floor((metadata.height - minSize) / 2);
      
      return await image
        .extract({ left, top, width: minSize, height: minSize })
        .resize(size, size, { fit: 'fill' })
        .jpeg({ quality: 90 })
        .toBuffer();
    } else {
      // Режим background: сохраняем пропорции, добавляем фон
      const ratio = Math.min(size / metadata.width, size / metadata.height);
      const newWidth = Math.round(metadata.width * ratio);
      const newHeight = Math.round(metadata.height * ratio);
      
      return await image
        .resize(newWidth, newHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .extend({
          top: Math.floor((size - newHeight) / 2),
          bottom: Math.ceil((size - newHeight) / 2),
          left: Math.floor((size - newWidth) / 2),
          right: Math.ceil((size - newWidth) / 2),
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        })
        .jpeg({ quality: 90 })
        .toBuffer();
    }
  } catch (error) {
    throw new Error(`Ошибка обрезки изображения: ${error.message}`);
  }
}

// Скачивание и обработка обложки канала
async function processChannelCover(baseUrl) {
  try {
    if (!config.rss.channelImage) {
      return '';
    }
    
    // Создаем хэш URL обложки канала
    const coverHash = crypto.createHash('md5').update(config.rss.channelImage).digest('hex').substring(0, 12);
    const coverFilename = `channel_${coverHash}_${config.rss.youtube.coverSize}.jpg`;
    const coverPath = path.join(COVERS_CACHE_DIR, coverFilename);
    
    // Проверяем, существует ли уже обработанная обложка
    try {
      await fs.access(coverPath);
      if (config.advanced.verboseLogging) {
        console.log(`🎨 Используется кэшированная обложка канала`);
      }
      return `${baseUrl}/covers_cache/${coverFilename}`;
    } catch (e) {
      // Обложка не существует, нужно скачать и обработать
    }
    
    // Скачиваем обложку канала
    if (config.advanced.verboseLogging) {
      console.log(`⬇️  Скачиваем обложку канала: ${config.rss.channelImage}`);
    }
    
    const imageBuffer = await downloadImage(config.rss.channelImage);
    
    // Обрезаем до квадрата
    const squareImage = await cropToSquare(imageBuffer, config.rss.youtube.coverSize);
    
    // Сохраняем
    await sharp(squareImage).toFile(coverPath);
    
    if (config.advanced.verboseLogging) {
      console.log(`✅ Обложка канала обработана и сохранена`);
    }
    
    return `${baseUrl}/covers_cache/${coverFilename}`;
    
  } catch (error) {
    if (config.advanced.verboseLogging) {
      console.log(`⚠️  Не удалось обработать обложку канала: ${error.message}`);
    }
    return '';
  }
}

// Обработка обложки трека из ID3 тегов
async function processTrackCover(metadata, filePath, stat, baseUrl) {
  try {
    // Если в треке нет обложки
    if (!metadata.common?.picture?.[0]?.data) {
      return null;
    }
    
    const picture = metadata.common.picture[0];
    
    // Создаем уникальное имя файла на основе хэша файла
    const fileHash = crypto.createHash('md5').update(`${filePath}:${stat.size}`).digest('hex').substring(0, 12);
    const coverFilename = `track_${fileHash}_${config.rss.youtube.coverSize}.jpg`;
    const coverPath = path.join(COVERS_CACHE_DIR, coverFilename);
    
    // Проверяем, существует ли уже обработанная обложка
    try {
      await fs.access(coverPath);
      if (config.advanced.verboseLogging) {
        console.log(`🎨 Используется кэшированная обложка для ${path.basename(filePath)}`);
      }
      return `${baseUrl}/covers_cache/${coverFilename}`;
    } catch (e) {
      // Обложка не существует, обрабатываем
    }
    
    if (config.advanced.verboseLogging) {
      console.log(`✂️  Обрабатываем обложку для ${path.basename(filePath)}`);
    }
    
    // Обрезаем до квадрата
    const squareImage = await cropToSquare(picture.data, config.rss.youtube.coverSize);
    
    // Сохраняем
    await sharp(squareImage).toFile(coverPath);
    
    if (config.advanced.verboseLogging) {
      console.log(`✅ Обложка сохранена: ${coverFilename}`);
    }
    
    return `${baseUrl}/covers_cache/${coverFilename}`;
    
  } catch (error) {
    if (config.advanced.verboseLogging) {
      console.log(`⚠️  Не удалось обработать обложку для ${path.basename(filePath)}: ${error.message}`);
    }
    return null;
  }
}

// Поиск аудиофайлов
async function findAudioFiles() {
  const files = [];
  
  try {
    const entries = await fs.readdir(TRACKS_DIR, { withFileTypes: true });
    
    for (const entry of entries) {
      const entryPath = path.join(TRACKS_DIR, entry.name);
      
      if (entry.isDirectory()) {
        const subEntries = await fs.readdir(entryPath);
        for (const subEntry of subEntries) {
          if (/\.(mp3|m4a|flac|wav|ogg)$/i.test(subEntry)) {
            files.push({
              path: path.join(entryPath, subEntry),
              folder: entry.name,
              filename: subEntry
            });
          }
        }
      } else if (/\.(mp3|m4a|flac|wav|ogg)$/i.test(entry.name)) {
        files.push({
          path: entryPath,
          folder: '',
          filename: entry.name
        });
      }
    }
  } catch (error) {
    if (config.advanced.verboseLogging) {
      console.error('❌ Ошибка чтения папки tracks:', error);
    }
  }
  
  return files;
}

// Получение хэша содержимого папки
async function getTracksFolderHash() {
  try {
    const files = await findAudioFiles();
    const fileInfo = files.map(f => `${f.path}:${f.filename}`).sort().join('|');
    return crypto.createHash('md5').update(fileInfo).digest('hex');
  } catch (error) {
    return Date.now().toString();
  }
}

// Генерация RSS данных
async function generateRssData(baseUrl) {
  const now = new Date();
  
  // Ищем аудиофайлы
  const audioFiles = await findAudioFiles();
  
  if (audioFiles.length === 0) {
    throw new Error('No audio files found in tracks folder');
  }
  
  // Обрабатываем обложку канала
  let channelCoverUrl = '';
  if (config.rss.channelImage) {
    channelCoverUrl = await processChannelCover(baseUrl);
  }
  
  // Обрабатываем файлы
  const items = [];
  
  for (let i = 0; i < audioFiles.length; i++) {
    const file = audioFiles[i];
    
    try {
      const fileUrl = `${baseUrl}/tracks/${encodeURIComponent(file.folder ? path.join(file.folder, file.filename) : file.filename)}`;
      const stat = await fs.stat(file.path);
      const metadata = await parseFile(file.path);
      
      // Парсим информацию
      const { artist, title } = parseTrackInfo(file.folder, file.filename);
      
      // Обрабатываем обложку трека
      let coverUrl = null;
      if (config.rss.youtube.generateSquareCovers) {
        coverUrl = await processTrackCover(metadata, file.path, stat, baseUrl);
      }
      
      // Если у трека нет обложки, используем обложку канала
      if (!coverUrl && channelCoverUrl) {
        coverUrl = channelCoverUrl;
      }
      
      // Создаем стабильный GUID
      const guidValue = generateStableGuid(file.path, stat);
      
      // Создаем item для RSS
      const item = {
        title: metadata.common?.title || title,
        pubDate: stat.mtime.toUTCString(),
        link: fileUrl,
        
        guid: {
          '#text': guidValue,
          '@_isPermaLink': 'false'
        },
        
        'itunes:duration': formatDuration(metadata.format?.duration),
        'itunes:author': metadata.common?.artist || artist,
        'itunes:explicit': config.rss.explicit,
        description: metadata.common?.comment?.[0] || `${title} by ${artist}`,
        enclosure: {
          '@_type': 'audio/mpeg',
          '@_url': fileUrl,
          '@_length': stat.size
        }
      };
      
      // Добавляем обложку, если есть
      if (coverUrl) {
        item['itunes:image'] = { '@_href': coverUrl };
      }
      
      items.push(item);
      
      if (config.advanced.verboseLogging) {
        console.log(`📝 Добавлен трек: ${item.title}${coverUrl ? ' (с обложкой)' : ' (без обложки)'}`);
      }
      
    } catch (error) {
      if (config.advanced.verboseLogging) {
        console.log(`⚠️  Пропускаем файл ${file.filename}: ${error.message}`);
      }
      continue;
    }
  }
  
  // Сортируем по дате (новые сверху)
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  
  // Ограничиваем количество
  const maxItems = Math.min(items.length, config.advanced.maxTracksInRSS);
  const limitedItems = items.slice(0, maxItems);
  
  // Собираем RSS
  const rssData = {
    rss: {
      '@_version': '2.0',
      '@_xmlns:itunes': 'http://www.itunes.com/dtds/podcast-1.0.dtd',
      channel: {
        title: config.rss.title,
        link: config.rss.link,
        description: config.rss.description,
        language: config.rss.language,
        copyright: config.rss.copyright,
        lastBuildDate: now.toUTCString(),
        webMaster: `${config.rss.email} (${config.rss.author})`,
        
        // Обложка канала (обязательно квадратная)
        image: {
          url: channelCoverUrl || config.rss.channelImage,
          title: config.rss.title,
          link: config.rss.link
        },
        
        // iTunes обложка канала
        'itunes:image': {
          '@_href': channelCoverUrl || config.rss.channelImage
        },
        
        'itunes:owner': {
          'itunes:name': config.rss.author,
          'itunes:email': config.rss.email
        },
        'itunes:author': config.rss.author,
        'itunes:explicit': config.rss.explicit,
        'itunes:category': {
          '@_text': config.rss.category
        },
        item: limitedItems
      }
    }
  };
  
  return rssData;
}

// Основной RSS эндпоинт с кэшированием
app.get('/rss.xml', async (req, res) => {
  try {
    // Автоматически определяем baseUrl на основе запроса
    const baseUrl = getBaseUrl(req);
    const now = Date.now();
    
    if (config.advanced.verboseLogging) {
      console.log(`🌐 Используется baseUrl: ${baseUrl} (определен из запроса)`);
    }
    
    // Получаем текущий хэш папки с треками
    const currentFolderHash = await getTracksFolderHash();
    
    // Проверяем, нужно ли обновить кэш
    const shouldRefreshCache = 
      !rssCache.data ||
      (now - rssCache.lastUpdated) > rssCache.cacheDuration ||
      currentFolderHash !== rssCache.fileHash;
    
    if (shouldRefreshCache) {
      if (config.advanced.verboseLogging) {
        console.log(`🔄 Обновление RSS кэша...`);
      }
      
      rssCache.data = await generateRssData(baseUrl);
      rssCache.lastUpdated = now;
      rssCache.fileHash = currentFolderHash;
      
      if (config.advanced.verboseLogging) {
        console.log(`✅ RSS сгенерирован: ${rssCache.data.rss.channel.item.length} треков`);
      }
    } else if (config.advanced.verboseLogging) {
      console.log(`💾 Используется кэшированный RSS (возраст: ${Math.round((now - rssCache.lastUpdated) / 1000)}с)`);
    }
    
    // Генерируем XML
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true,
      attributeNamePrefix: '@_'
    });
    
    const xml = builder.build(rssCache.data);
    
    // Добавляем заголовки
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Last-Modified', new Date(rssCache.lastUpdated).toUTCString());
    
    res.send(xml);
    
  } catch (error) {
    console.error('❌ Ошибка генерации RSS:', error);
    res.status(500).send('Server Error');
  }
});

// Эндпоинт для принудительного обновления кэша
app.get('/refresh-rss', async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const currentFolderHash = await getTracksFolderHash();
    
    rssCache.data = null;
    rssCache.lastUpdated = 0;
    rssCache.fileHash = '';
    
    const rssData = await generateRssData(baseUrl);
    rssCache.data = rssData;
    rssCache.lastUpdated = Date.now();
    rssCache.fileHash = currentFolderHash;
    
    res.json({
      success: true,
      message: 'RSS кэш обновлен',
      baseUrl: baseUrl,
      itemsCount: rssData.rss.channel.item.length,
      refreshedAt: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Ошибка принудительного обновления RSS:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Статические файлы
app.use('/tracks', express.static(TRACKS_DIR));
app.use('/covers_cache', express.static(COVERS_CACHE_DIR));

// Информационная страница
app.get('/', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const cacheAge = rssCache.lastUpdated ? Math.round((Date.now() - rssCache.lastUpdated) / 1000) : 0;
  const itemsCount = rssCache.data?.rss?.channel?.item?.length || 0;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>YouTube RSS Server</title>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial; max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { color: #ff0000; }
        code { background: #f5f5f5; padding: 2px 5px; border-radius: 3px; }
        .url { color: #0066cc; word-break: break-all; }
        .info { background: #f0f8ff; padding: 15px; border-radius: 8px; margin: 15px 0; }
        .cover { max-width: 300px; margin: 15px 0; border-radius: 8px; }
        .btn { background: #007bff; color: white; padding: 10px 15px; border: none; border-radius: 5px; cursor: pointer; text-decoration: none; display: inline-block; margin: 5px; }
        .btn:hover { background: #0056b3; }
        .btn-refresh { background: #28a745; }
        .btn-refresh:hover { background: #1e7e34; }
        .features { background: #f0fff0; padding: 10px; border-radius: 5px; margin: 10px 0; }
        .feature-item { margin: 5px 0; }
        .base-url-info { background: #fff8e1; padding: 10px; border-radius: 5px; margin: 10px 0; }
      </style>
    </head>
    <body>
      <h1>✅ YouTube RSS Server</h1>
      
      <div class="info">
        <div class="base-url-info">
          <h3>🌐 Текущий адрес:</h3>
          <p><strong>Base URL:</strong> <code class="url">${baseUrl}</code></p>
          <p><small>Определяется автоматически на основе вашего запроса</small></p>
        </div>
        
        <h2>📡 RSS Feed URL:</h2>
        <code class="url">${baseUrl}/rss.xml</code>
        <p><a href="${baseUrl}/rss.xml" target="_blank" class="btn">Открыть RSS</a></p>
        
        <h2>📊 Статус:</h2>
        <p>Возраст кэша: <strong>${cacheAge} секунд</strong></p>
        <p>Треков в RSS: <strong>${itemsCount}</strong></p>
        <a href="${baseUrl}/refresh-rss" class="btn btn-refresh">🔄 Обновить RSS</a>
        
        <h2>🎯 Особенности:</h2>
        <div class="features">
          <div class="feature-item">✅ Автоматическое определение baseUrl (${config.server.baseUrl ? 'из конфига' : 'из запроса'})</div>
          <div class="feature-item">✅ Автоматическая обрезка обложек до квадрата 3000×3000</div>
          <div class="feature-item">✅ Обложки скачиваются из ID3 тегов MP3</div>
          <div class="feature-item">✅ Кэширование обложек в папке .covers_cache</div>
          <div class="feature-item">✅ Стабильные GUID (треки не вылетают из YouTube)</div>
          <div class="feature-item">✅ Поддержка ID3 тегов (артист, название, обложка)</div>
        </div>
        
        <h2>📁 Папка с треками:</h2>
        <p><code>${TRACKS_DIR}</code></p>
        <p>Просто добавляйте MP3 файлы с ID3 тегами в эту папку.</p>
        
        <h2>🎨 Обработка обложек:</h2>
        <p>Все обложки автоматически обрабатываются:</p>
        <ol>
          <li>Извлекаются из MP3 файлов (ID3 теги)</li>
          <li>Обрезаются до квадрата ${config.rss.youtube.coverSize}×${config.rss.youtube.coverSize}</li>
          <li>Сохраняются в папку .covers_cache</li>
          <li>Отдаются в RSS как квадратные изображения</li>
        </ol>
        
        <h2>📧 Подтверждение YouTube:</h2>
        <p>Email: <code>${config.rss.email}</code></p>
        <p>YouTube отправит письмо для подтверждения RSS-фида.</p>
      </div>
    </body>
    </html>
  `);
});

// Запуск сервера
async function startServer() {
  await initDirs();
  
  // Не инициализируем кэш при запуске, так как baseUrl зависит от запроса
  if (config.advanced.verboseLogging) {
    console.log(`⚠️  Кэш не инициализирован при запуске (нужен первый запрос для определения baseUrl)`);
  }
  
  app.listen(PORT, HOST, () => {
    console.log(`
🚀 YouTube RSS Server запущен!

📍 Локальный доступ: http://localhost:${PORT}
📍 Также доступен по вашему локальному IP: http://ваш-ip:${PORT}
🌐 Для доступа из интернета: используйте ваш внешний IP или домен

📡 RSS Feed URL: будет определен автоматически при запросе
🔧 Управление кэшем: /refresh-rss
📧 Email для YouTube: ${config.rss.email}

⚙️ Определение адреса: ${config.server.baseUrl ? 'фиксированный из конфига' : 'автоматически из запроса'}

📁 Папка для треков: ${TRACKS_DIR}
📁 Кэш обложек: ${COVERS_CACHE_DIR}
⚙️ Конфигурация: config.js

🎯 ОБРАБОТКА ОБЛОЖЕК:
   1. Скачиваются из ID3 тегов MP3
   2. Обрезаются до квадрата ${config.rss.youtube.coverSize}×${config.rss.youtube.coverSize}
   3. Сохраняются в .covers_cache/
   4. Отдаются в RSS как квадратные изображения

💡 Советы:
   - Добавьте обложки в MP3 файлы через ID3 теги
   - YouTube создаст квадратные видео из обложек
   - После добавления файлов обновите RSS через /refresh-rss
   - Для внешнего доступа настройте проброс порта ${PORT} на роутере
    `);
  });
}

startServer().catch(console.error);