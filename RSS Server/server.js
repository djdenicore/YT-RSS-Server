// server.js - Сервер RSS для YouTube Music
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { parseFile } from 'music-metadata';
import { XMLBuilder } from 'fast-xml-parser';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

// Загружаем конфиг
import config from './config.js';

const app = express();

// Настройки из конфига
const PORT = process.env.PORT || config.server.port;
const HOST = config.server.host;
const TRACKS_DIR = config.paths.tracksDir;
const COVERS_CACHE_DIR = config.paths.coversCacheDir;

// Создаем нужные папки
async function initDirs() {
  const dirs = [TRACKS_DIR];
  if (config.rss.youtube.generateSquareCovers) {
    dirs.push(COVERS_CACHE_DIR);
  }
  
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

// Форматирование времени для iTunes (YouTube требует этот формат)
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
  
  // Пробуем извлечь из папки
  const folderParts = folderName.split(separator);
  if (folderParts.length >= 2) {
    artist = folderParts[0].trim();
    title = folderParts.slice(1).join(separator).trim();
  }
  
  return { artist, title };
}

// Генерация квадратной обложки для YouTube
async function generateYouTubeCover(metadata, trackId, baseUrl) {
  try {
    // Если в конфиге отключена генерация обложек
    if (!config.rss.youtube.generateSquareCovers) {
      return config.rss.channelImage || '';
    }
    
    // Если в треке нет обложки
    if (!metadata.common?.picture?.[0]?.data) {
      return config.rss.channelImage || '';
    }
    
    const picture = metadata.common.picture[0];
    const coverFilename = `cover_${trackId}_${config.rss.youtube.coverSize}.jpg`;
    const coverPath = path.join(COVERS_CACHE_DIR, coverFilename);
    
    // Генерируем квадратную обложку
    await sharp(picture.data)
      .resize(config.rss.youtube.coverSize, config.rss.youtube.coverSize, {
        fit: 'cover',
        position: 'center'
      })
      .jpeg({ quality: 90 })
      .toFile(coverPath);
    
    return `${baseUrl}/covers_cache/${coverFilename}`;
    
  } catch (error) {
    if (config.advanced.verboseLogging) {
      console.log(`⚠️  Не удалось создать обложку: ${error.message}`);
    }
    return config.rss.channelImage || '';
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
        // Ищем файлы в подпапке
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
        // Файл в корне
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

// Основной RSS эндпоинт
app.get('/rss.xml', async (req, res) => {
  try {
    // Определяем базовый URL
    const baseUrl = config.server.baseUrl || `http://${req.get('host') || `${HOST}:${PORT}`}`;
    const now = new Date();
    
    // Ищем аудиофайлы
    const audioFiles = await findAudioFiles();
    
    if (audioFiles.length === 0) {
      return res.status(404).send('No audio files found in tracks folder');
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
        
        // Генерируем обложку для YouTube
        const coverUrl = await generateYouTubeCover(metadata, i, baseUrl);
        
        // Создаем item для RSS (только то, что нужно YouTube)
        const item = {
          title: metadata.common?.title || title,
          pubDate: stat.mtime.toUTCString(),
          link: fileUrl,
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
    
    // Собираем RSS (минимальный набор для YouTube)
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
          'itunes:owner': {
            'itunes:name': config.rss.author,
            'itunes:email': config.rss.email  // ✅ Для подтверждения в YouTube
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
    
    // Генерируем XML
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true,
      attributeNamePrefix: '@_'
    });
    
    const xml = builder.build(rssData);
    
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(xml);
    
    if (config.advanced.verboseLogging) {
      console.log(`✅ RSS сгенерирован: ${limitedItems.length} треков`);
    }
    
  } catch (error) {
    console.error('❌ Ошибка генерации RSS:', error);
    res.status(500).send('Server Error');
  }
});

// Статические файлы
app.use('/tracks', express.static(TRACKS_DIR));
if (config.rss.youtube.generateSquareCovers) {
  app.use('/covers_cache', express.static(COVERS_CACHE_DIR));
}

// Простая информационная страница
app.get('/', (req, res) => {
  const baseUrl = config.server.baseUrl || `http://${req.get('host') || `${HOST}:${PORT}`}`;
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
      </style>
    </head>
    <body>
      <h1>✅ RSS Server for YouTube Music</h1>
      
      <div class="info">
        <h2>📡 RSS Feed URL:</h2>
        <code class="url">${baseUrl}/rss.xml</code>
        <p><a href="${baseUrl}/rss.xml" target="_blank">Открыть RSS</a></p>
        
        <h2>📧 Email for YouTube Verification:</h2>
        <p><code>${config.rss.email}</code></p>
        <p>YouTube отправит письмо для подтверждения на эту почту</p>
      </div>
      
      <h2>🎯 Как добавить в YouTube Music:</h2>
      <ol>
        <li>Откройте <a href="https://music.youtube.com" target="_blank">YouTube Music</a></li>
        <li>В меню выберите "Библиотека" → "Подкасты"</li>
        <li>Нажмите "Добавить подкаст по RSS"</li>
        <li>Вставьте ссылку выше</li>
        <li>Подтвердите владение через email</li>
      </ol>
      
      <h2>📁 Папка с треками:</h2>
      <p><code>${TRACKS_DIR}</code></p>
      <p>Просто кидайте MP3 файлы в эту папку. ID3 теги будут использованы автоматически.</p>
      
      <h2>🎨 Квадратные видео в YouTube:</h2>
      <p>Для создания квадратных (1:1) видео в YouTube:</p>
      <ul>
        <li>Используйте квадратные обложки в MP3 файлах</li>
        <li>Рекомендуемый размер: 3000×3000 пикселей</li>
        <li>YouTube создаст видео с этой обложкой</li>
      </ul>
      
      <h2>⚙️ Настройки в config.js:</h2>
      <p>Все настройки находятся в файле <code>config.js</code></p>
      <ul>
        <li>Порт сервера, host</li>
        <li>Название канала, описание</li>
        <li>Email для подтверждения</li>
        <li>Настройки обложек для YouTube</li>
        <li>Правила парсинга файлов</li>
      </ul>
    </body>
    </html>
  `);
});

// Запуск сервера
async function startServer() {
  await initDirs();
  
  app.listen(PORT, HOST, () => {
    console.log(`
🚀 YouTube RSS Server запущен!

📍 Локальный доступ: http://localhost:${PORT}
🌐 Сетевой доступ: http://ваш-IP:${PORT}

📡 RSS Feed URL: http://ваш-IP:${PORT}/rss.xml
📧 Email для YouTube: ${config.rss.email}

📁 Папка для треков: ${TRACKS_DIR}
⚙️ Конфигурация: config.js

🎯 Важно для YouTube:
   1. Используйте ВНЕШНИЙ IP для доступа из интернета
   2. Подтвердите RSS через письмо на ${config.rss.email}
   3. YouTube создаст квадратные видео из обложек треков

💡 Советы:
   - Добавьте обложки в MP3 файлы (ID3 теги)
   - Используйте квадратные изображения 3000x3000
   - Название и артист из ID3 тегов появятся в YouTube
    `);
  });
}

startServer().catch(console.error);