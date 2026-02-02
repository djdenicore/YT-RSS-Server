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
const HOST = config.server.host || 'localhost';
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
        console.log(`Directory created: ${dir}`);
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

// Функция для получения значения из ID3 тегов
function getTagValue(metadata, tagPath) {
  const parts = tagPath.split('.');
  let value = metadata;
  
  for (const part of parts) {
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value = value[0];
      } else {
        value = value[part];
      }
    } else {
      return null;
    }
  }
  
  if (Array.isArray(value)) {
    value = value[0];
  }
  
  return value || null;
}

// Функция для безопасного отображения значения (заменяет null/empty на -)
function safeDisplay(value) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  return value;
}

// Функция для замены переменных в шаблоне
function replaceTemplateVariables(template, variables) {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp('\\{' + key + '\\}', 'g'), value);
  }
  return result;
}

// Генерация description для трека по шаблону из config
function generateTrackDescription(metadata, trackTitle, trackAuthor, releaseLink) {
  // Для отладки - выводим все теги в консоль
  if (config.advanced.verboseLogging) {
    console.log(`ID3 tags for ${trackTitle}:`);
    console.log('  native:', JSON.stringify(metadata.native, null, 2));
  }
  
  // Извлекаем данные из ID3 тегов
  const title = getTagValue(metadata, 'common.title') || trackTitle || '-';
  const artist = getTagValue(metadata, 'common.artist') || trackAuthor || '-';
  const album = getTagValue(metadata, 'common.album') || '-';
  const genre = getTagValue(metadata, 'common.genre') || '-';
  
  // Получаем нативные теги ID3v2.4
  let nativeTags = [];
  if (metadata.native && metadata.native['ID3v2.4']) {
    nativeTags = metadata.native['ID3v2.4'];
  }
  
  // Original Artists - сначала ищем TXXX:Orig Aut из нативных тегов
  var originalArtists = '-';
  
  if (nativeTags && Array.isArray(nativeTags)) {
    // Ищем TXXX:Orig Aut или TXXX:Original Artists
    var origAutTag = nativeTags.find(function(t) { 
      return t.id === 'TXXX:Orig Aut' || t.id === 'TXXX:Original Artists'; 
    });
    if (origAutTag && origAutTag.value) {
      originalArtists = origAutTag.value;
    }
  }
  
  // Если не нашли в TXXX, пробуем другие источники
  if (originalArtists === '-') {
    originalArtists = getTagValue(metadata, 'common.originalartist') || 
                     nativeTags.find(function(t) { return t.id === 'TPE2'; })?.value ||
                     '-';
  }
  
  const date = getTagValue(metadata, 'common.date') || 
               getTagValue(metadata, 'format.timestamp') || 
               '-';
  
  // TXXX теги
  let label = '-';
  let dj = '-';
  let credits = '-';
  let releaseBy = '-';
  let customReleaseLink = releaseLink || '-';
  
  if (nativeTags && Array.isArray(nativeTags)) {
    nativeTags.filter(function(t) { return t.id && t.id.startsWith('TXXX:'); }).forEach(function(tag) {
      var desc = tag.id.substring(5);
      var value = tag.value || '';
      var descLower = desc.toLowerCase();
      
      if (descLower === 'label' || desc === 'Label') {
        label = value;
      }
      if (descLower === 'dj' || desc === 'Dj') {
        dj = value;
      }
      if (descLower === 'credits' || desc === 'Credits') {
        credits = value;
      }
      if (descLower === 'release link' || desc === 'Release Link') {
        customReleaseLink = value;
      }
      if (descLower === 'release by' || desc === 'Release By') {
        releaseBy = value;
      }
    });
  }
  
  // Формируем социальные ссылки из конфига
  var socialLinksHtml = '';
  if (config.social && config.social.links && Array.isArray(config.social.links) && config.social.links.length > 0) {
    socialLinksHtml = config.social.links.map(function(link) {
      return link.name + ': ' + link.url;
    }).join('\n');
  } else {
    socialLinksHtml = '-';
  }
  
  // Ссылка на релиз
  var releaseUrl = customReleaseLink || releaseLink || '-';
  
  // Используем шаблон из config или стандартный
  var description = '';
  
  if (config.descriptionTemplate && config.descriptionTemplate.enabled) {
    // Переменные для замены в шаблоне
    var variables = {
      'RELEASE_BY': safeDisplay(releaseBy),
      'RELEASE_LINK': releaseUrl,
      'TITLE': safeDisplay(title),
      'AUTHOR': safeDisplay(artist),
      'ALBUM': safeDisplay(album),
      'GENRE': safeDisplay(genre),
      'ORIGINAL_ARTISTS': safeDisplay(originalArtists),
      'DATE': safeDisplay(date),
      'DJ': safeDisplay(dj),
      'LABEL': safeDisplay(label),
      'SOCIAL_LINKS': socialLinksHtml,
    };
    
    description = replaceTemplateVariables(config.descriptionTemplate.template, variables);
    
    // Добавляем Credits только если есть данные
    if (credits && credits !== '-' && credits !== '') {
      var creditsVariables = Object.assign({}, variables, { 'CREDITS': credits });
      description += replaceTemplateVariables(config.descriptionTemplate.creditsTemplate, creditsVariables);
    }
  } else {
    // Стандартный шаблон (для совместимости)
    description = '𝔻𝕖𝕤𝕔𝕣𝕚𝕡𝕥𝕚𝕠𝕟\n\n' +
      'This release is published by ' + safeDisplay(releaseBy) + '.\n\n' +
      '🔗 𝕊𝕥𝕣𝕖𝕒𝕞 & 𝔻𝕠𝕨𝕟𝕝𝕠𝕒𝕕\n' +
      releaseUrl + '\n\n' +
      '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n' +
      '𝔸𝕓𝕠𝕦𝕥 𝕣𝕖𝕝𝕖𝕒𝕤𝕖\n\n' +
      '• Title: ' + safeDisplay(title) + '\n' +
      '• Author: ' + safeDisplay(artist) + '\n' +
      '• Album: ' + safeDisplay(album) + '\n' +
      '• Genre: ' + safeDisplay(genre) + '\n' +
      '• Original Artists: ' + safeDisplay(originalArtists) + '\n' +
      '• Release date: ' + safeDisplay(date) + '\n' +
      '• DJ: ' + safeDisplay(dj) + '\n' +
      '• Label: ' + safeDisplay(label) + '\n\n' +
      '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n' +
      '𝕊𝕠𝕔𝕚𝕒𝕝\n\n' +
      socialLinksHtml;
    
    // Добавляем Credits только если есть данные
    if (credits && credits !== '-' && credits !== '') {
      description += '\n\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n' +
        'ℂ𝕣𝕖𝕕𝕚𝕥𝕤\n' +
        credits;
    }
  }
  
  return description;
}

// Генерация стабильного GUID
function generateStableGuid(filePath, stat) {
  try {
    var fileKey = filePath + ':' + stat.size;
    
    if (fileGuidCache.has(fileKey)) {
      return fileGuidCache.get(fileKey);
    }
    
    var hash = crypto.createHash('sha256').update(fileKey).digest('hex');
    var uuid = hash.substring(0, 8) + '-' + hash.substring(8, 12) + '-' + hash.substring(12, 16) + '-' + hash.substring(16, 20) + '-' + hash.substring(20, 32);
    var guid = 'urn:uuid:' + uuid;
    
    fileGuidCache.set(fileKey, guid);
    return guid;
  } catch (error) {
    var backupHash = crypto.createHash('md5').update(filePath).digest('hex');
    return 'urn:uuid:' + backupHash.substring(0, 8) + '-' + backupHash.substring(8, 12) + '-' + backupHash.substring(12, 16) + '-' + backupHash.substring(16, 20) + '-' + backupHash.substring(20, 32);
  }
}

// Функция для обрезки изображения в квадрат
async function cropToSquare(imageBuffer, size) {
  size = size || 3000;
  try {
    var image = sharp(imageBuffer);
    var metadata = await image.metadata();
    
    if (metadata.width === metadata.height && metadata.width === size) {
      return await image.jpeg({ quality: 90 }).toBuffer();
    }
    
    var cropMode = config.rss.youtube.cropMode || 'crop';
    
    if (cropMode === 'crop') {
      var minSize = Math.min(metadata.width, metadata.height);
      var left = Math.floor((metadata.width - minSize) / 2);
      var top = Math.floor((metadata.height - minSize) / 2);
      
      return await image
        .extract({ left: left, top: top, width: minSize, height: minSize })
        .resize(size, size, { fit: 'fill' })
        .jpeg({ quality: 90 })
        .toBuffer();
    } else {
      var ratio = Math.min(size / metadata.width, size / metadata.height);
      var newWidth = Math.round(metadata.width * ratio);
      var newHeight = Math.round(metadata.height * ratio);
      
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
    throw new Error('Image crop error: ' + error.message);
  }
}

// Скачивание и обработка обложки канала
async function processChannelCover(baseUrl) {
  try {
    if (!config.rss.channelImage) {
      return '';
    }
    
    var coverHash = crypto.createHash('md5').update(config.rss.channelImage).digest('hex').substring(0, 12);
    var coverFilename = 'channel_' + coverHash + '_' + config.rss.youtube.coverSize + '.jpg';
    var coverPath = path.join(COVERS_CACHE_DIR, coverFilename);
    
    try {
      await fs.access(coverPath);
      if (config.advanced.verboseLogging) {
        console.log('Using cached channel cover');
      }
      return baseUrl + '/covers_cache/' + coverFilename;
    } catch (e) {
      // Cover doesn't exist
    }
    
    if (config.advanced.verboseLogging) {
      console.log('Downloading channel cover: ' + config.rss.channelImage);
    }
    
    var imageBuffer = await downloadImage(config.rss.channelImage);
    var squareImage = await cropToSquare(imageBuffer, config.rss.youtube.coverSize);
    await sharp(squareImage).toFile(coverPath);
    
    if (config.advanced.verboseLogging) {
      console.log('Channel cover processed and saved');
    }
    
    return baseUrl + '/covers_cache/' + coverFilename;
    
  } catch (error) {
    if (config.advanced.verboseLogging) {
      console.log('Failed to process channel cover: ' + error.message);
    }
    return '';
  }
}

// Обработка обложки трека из ID3 тегов
async function processTrackCover(metadata, filePath, stat, baseUrl) {
  try {
    if (!metadata.common || !metadata.common.picture || !metadata.common.picture[0] || !metadata.common.picture[0].data) {
      return null;
    }
    
    var picture = metadata.common.picture[0];
    var fileHash = crypto.createHash('md5').update(filePath + ':' + stat.size).digest('hex').substring(0, 12);
    var coverFilename = 'track_' + fileHash + '_' + config.rss.youtube.coverSize + '.jpg';
    var coverPath = path.join(COVERS_CACHE_DIR, coverFilename);
    
    try {
      await fs.access(coverPath);
      if (config.advanced.verboseLogging) {
        console.log('Using cached cover for ' + path.basename(filePath));
      }
      return baseUrl + '/covers_cache/' + coverFilename;
    } catch (e) {
      // Cover doesn't exist
    }
    
    if (config.advanced.verboseLogging) {
      console.log('Processing cover for ' + path.basename(filePath));
    }
    
    var squareImage = await cropToSquare(picture.data, config.rss.youtube.coverSize);
    await sharp(squareImage).toFile(coverPath);
    
    if (config.advanced.verboseLogging) {
      console.log('Cover saved: ' + coverFilename);
    }
    
    return baseUrl + '/covers_cache/' + coverFilename;
    
  } catch (error) {
    if (config.advanced.verboseLogging) {
      console.log('Failed to process cover for ' + path.basename(filePath) + ': ' + error.message);
    }
    return null;
  }
}

// Поиск аудиофайлов
async function findAudioFiles() {
  var files = [];
  
  try {
    var entries = await fs.readdir(TRACKS_DIR, { withFileTypes: true });
    
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var entryPath = path.join(TRACKS_DIR, entry.name);
      
      if (entry.isDirectory()) {
        var subEntries = await fs.readdir(entryPath);
        for (var j = 0; j < subEntries.length; j++) {
          if (/\.(mp3|m4a|flac|wav|ogg)$/i.test(subEntries[j])) {
            files.push({
              path: path.join(entryPath, subEntries[j]),
              folder: entry.name,
              filename: subEntries[j]
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
      console.error('Error reading tracks folder:', error);
    }
  }
  
  return files;
}

// Получение хэша содержимого папки
async function getTracksFolderHash() {
  try {
    var files = await findAudioFiles();
    var fileInfo = files.map(function(f) { return f.path + ':' + f.filename; }).sort().join('|');
    return crypto.createHash('md5').update(fileInfo).digest('hex');
  } catch (error) {
    return Date.now().toString();
  }
}

// Генерация RSS данных
async function generateRssData(baseUrl) {
  var now = new Date();
  
  var audioFiles = await findAudioFiles();
  
  if (audioFiles.length === 0) {
    throw new Error('No audio files found in tracks folder');
  }
  
  var channelCoverUrl = '';
  if (config.rss.channelImage) {
    channelCoverUrl = await processChannelCover(baseUrl);
  }
  
  var items = [];
  
  for (var i = 0; i < audioFiles.length; i++) {
    var file = audioFiles[i];
    
    try {
      var fileUrl = baseUrl + '/tracks/' + encodeURIComponent(file.folder ? path.join(file.folder, file.filename) : file.filename);
      var stat = await fs.stat(file.path);
      var metadata = await parseFile(file.path);
      
      var trackInfo = parseTrackInfo(file.folder, file.filename);
      
      var coverUrl = null;
      if (config.rss.youtube.generateSquareCovers) {
        coverUrl = await processTrackCover(metadata, file.path, stat, baseUrl);
      }
      
      if (!coverUrl && channelCoverUrl) {
        coverUrl = channelCoverUrl;
      }
      
      // Извлекаем Release Link из TXXX тегов
      var releaseLink = '';
      if (metadata.native && Array.isArray(metadata.native)) {
        var txxxTag = metadata.native.find(function(t) { 
          return t.id === 'TXXX' && t.value; 
        });
        if (txxxTag && txxxTag.value) {
          releaseLink = txxxTag.value;
        }
      }
      
      var trackDescription = generateTrackDescription(metadata, trackInfo.title, trackInfo.artist, releaseLink);
      var guidValue = generateStableGuid(file.path, stat);
      
      var item = {
        title: metadata.common && metadata.common.title ? metadata.common.title : trackInfo.title,
        pubDate: stat.mtime.toUTCString(),
        link: fileUrl,
        guid: {
          '#text': guidValue,
          '@_isPermaLink': 'false'
        },
        'itunes:duration': formatDuration(metadata.format && metadata.format.duration),
        'itunes:author': (metadata.common && metadata.common.artist) ? metadata.common.artist : trackInfo.artist,
        'itunes:explicit': config.rss.explicit,
        description: trackDescription,
        enclosure: {
          '@_type': 'audio/mpeg',
          '@_url': fileUrl,
          '@_length': stat.size
        }
      };
      
      if (coverUrl) {
        item['itunes:image'] = { '@_href': coverUrl };
      }
      
      items.push(item);
      
      if (config.advanced.verboseLogging) {
        console.log('Added track: ' + item.title + (coverUrl ? ' (with cover)' : ' (without cover)'));
      }
      
    } catch (error) {
      if (config.advanced.verboseLogging) {
        console.log('Skipping file ' + file.filename + ': ' + error.message);
      }
      continue;
    }
  }
  
  // Сортируем по дате
  items.sort(function(a, b) { return new Date(b.pubDate) - new Date(a.pubDate); });
  
  var maxItems = Math.min(items.length, config.advanced.maxTracksInRSS);
  var limitedItems = items.slice(0, maxItems);
  
  var rssData = {
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
        webMaster: config.rss.email + ' (' + config.rss.author + ')',
        image: {
          url: channelCoverUrl || config.rss.channelImage,
          title: config.rss.title,
          link: config.rss.link
        },
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
app.get('/rss.xml', async function(req, res) {
  try {
    var baseUrl = getBaseUrl(req);
    var now = Date.now();
    
    if (config.advanced.verboseLogging) {
      console.log('Using baseUrl: ' + baseUrl + ' (from request)');
    }
    
    var currentFolderHash = await getTracksFolderHash();
    
    var shouldRefreshCache = 
      !rssCache.data ||
      (now - rssCache.lastUpdated) > rssCache.cacheDuration ||
      currentFolderHash !== rssCache.fileHash;
    
    if (shouldRefreshCache) {
      if (config.advanced.verboseLogging) {
        console.log('Updating RSS cache...');
      }
      
      rssCache.data = await generateRssData(baseUrl);
      rssCache.lastUpdated = now;
      rssCache.fileHash = currentFolderHash;
      
      if (config.advanced.verboseLogging) {
        console.log('RSS generated: ' + rssCache.data.rss.channel.item.length + ' tracks');
      }
    } else if (config.advanced.verboseLogging) {
      console.log('Using cached RSS (age: ' + Math.round((now - rssCache.lastUpdated) / 1000) + 's)');
    }
    
    var builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true,
      attributeNamePrefix: '@_',
      processEntities: true,
      xmlKeepEntities: true
    });
    
    var xml = builder.build(rssCache.data);
    
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Last-Modified', new Date(rssCache.lastUpdated).toUTCString());
    
    res.send(xml);
    
  } catch (error) {
    console.error('RSS generation error:', error);
    res.status(500).send('Server Error');
  }
});

// Эндпоинт для принудительного обновления кэша
app.get('/refresh-rss', async function(req, res) {
  try {
    var baseUrl = getBaseUrl(req);
    var currentFolderHash = await getTracksFolderHash();
    
    rssCache.data = null;
    rssCache.lastUpdated = 0;
    rssCache.fileHash = '';
    
    var rssData = await generateRssData(baseUrl);
    rssCache.data = rssData;
    rssCache.lastUpdated = Date.now();
    rssCache.fileHash = currentFolderHash;
    
    res.json({
      success: true,
      message: 'RSS cache updated',
      baseUrl: baseUrl,
      itemsCount: rssData.rss.channel.item.length,
      refreshedAt: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('RSS refresh error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Статические файлы
app.use('/tracks', express.static(TRACKS_DIR));
app.use('/covers_cache', express.static(COVERS_CACHE_DIR));

// Информационная страница
app.get('/', function(req, res) {
  var baseUrl = getBaseUrl(req);
  var cacheAge = rssCache.lastUpdated ? Math.round((Date.now() - rssCache.lastUpdated) / 1000) : 0;
  var itemsCount = rssCache.data && rssCache.data.rss && rssCache.data.rss.channel && rssCache.data.rss.channel.item ? rssCache.data.rss.channel.item.length : 0;
  
  res.send('<!DOCTYPE html><html><head><title>YouTube RSS Server</title><meta charset="utf-8"><style>body{font-family:Arial;max-width:800px;margin:0 auto;padding:20px}h1{color:#ff0000}code{background:#f5f5f5;padding:2px 5px;border-radius:3px}.url{color:#0066cc;word-break:break-all}.info{background:#f0f8ff;padding:15px;border-radius:8px;margin:15px 0}.btn{background:#007bff;color:white;padding:10px 15px;border:none;border-radius:5px;cursor:pointer;text-decoration:none;display:inline-block;margin:5px}.btn:hover{background:#0056b3}.btn-refresh{background:#28a745}.btn-refresh:hover{background:#1e7e34}.features{background:#f0fff0;padding:10px;border-radius:5px;margin:10px 0}.base-url-info{background:#fff8e1;padding:10px;border-radius:5px;margin:10px 0}</style></head><body><h1>YouTube RSS Server</h1><div class="info"><div class="base-url-info"><h3>Current address:</h3><p><strong>Base URL:</strong> <code class="url">' + baseUrl + '</code></p></div><h2>RSS Feed URL:</h2><code class="url">' + baseUrl + '/rss.xml</code><p><a href="' + baseUrl + '/rss.xml" target="_blank" class="btn">Open RSS</a></p><h2>Status:</h2><p>Cache age: <strong>' + cacheAge + ' seconds</strong></p><p>Tracks in RSS: <strong>' + itemsCount + '</strong></p><a href="' + baseUrl + '/refresh-rss" class="btn btn-refresh">Refresh RSS</a><h2>Features:</h2><div class="features"><div class="feature-item">Auto baseUrl detection</div><div class="feature-item">Square cover generation (3000x3000)</div><div class="feature-item">Covers from ID3 tags</div><div class="feature-item">Cover caching</div><div class="feature-item">Custom description template in config.js</div></div><h2>Tracks folder:</h2><p><code>' + TRACKS_DIR + '</code></p><p>Add MP3 files with ID3 tags to this folder.</p></div></body></html>');
});

// Запуск сервера
async function startServer() {
  await initDirs();
  
  app.listen(PORT, HOST, function() {
    console.log('YouTube RSS Server started!');
    console.log('Local access: http://localhost:' + PORT);
    console.log('RSS Feed: ' + (config.server.baseUrl || '[auto-detected on first request]') + '/rss.xml');
    console.log('Refresh: /refresh-rss');
  });
}

startServer().catch(console.error);
