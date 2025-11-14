/**
 * index.js (fixed, cleaned)
 *
 * - Writes cookies from env secret (optional)
 * - Tries multiple yt-dlp formats with extractor-args fallback
 * - Graceful app.listen wrapper to avoid EADDRINUSE crash
 * - Save mp3 to ./downloads, schedule delete after 1 hour
 *
 * Env variables:
 *  - PORT (Railway will set)
 *  - USE_COOKIES = "true" to enable cookies usage
 *  - COOKIES_CONTENT = full content of cookies.txt (store as Railway secret)
 *  - COOKIES_FILE = path to write cookies inside container (default ./cookies.txt)
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sanitize = require('sanitize-filename');

const HOST = '0.0.0.0';
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const ONE_HOUR_MS = 60 * 60 * 1000;

// ensure downloads dir
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// write cookies file from secret (if provided)
const COOKIES_FILE = process.env.COOKIES_FILE || './cookies.txt';
if (process.env.COOKIES_CONTENT) {
  try {
    fs.writeFileSync(path.join(__dirname, COOKIES_FILE), process.env.COOKIES_CONTENT, { mode: 0o600 });
    console.log('Wrote cookies file from env to', COOKIES_FILE);
  } catch (e) {
    console.warn('Could not write cookies file:', e && e.message);
  }
}

const app = express();
app.use(cors());
app.disable('x-powered-by');

// quality map
const qualityMap = { low: '64k', medium: '128k', high: '320k' };

// cleanup old files at startup
function cleanupOldFiles() {
  const now = Date.now();
  fs.readdir(DOWNLOAD_DIR, (err, files) => {
    if (err) return console.error('cleanup read dir error:', err);
    files.forEach(file => {
      const p = path.join(DOWNLOAD_DIR, file);
      fs.stat(p, (err, stat) => {
        if (err) return;
        const age = now - new Date(stat.mtime).getTime();
        if (age > ONE_HOUR_MS) {
          fs.unlink(p, e => { if (!e) console.log('Startup cleanup removed', p); });
        }
      });
    });
  });
}
cleanupOldFiles();

// schedule delete after 1 hour
function scheduleDelete(filePath) {
  setTimeout(() => {
    fs.unlink(filePath, err => {
      if (!err) console.log('Auto-deleted', filePath);
    });
  }, ONE_HOUR_MS);
}

// helper: fetch metadata (title)
function fetchMetadata(videoUrl) {
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', ['-j', '--no-warnings', videoUrl], { stdio: ['ignore','pipe','inherit'] });
    let out = '';
    proc.stdout.on('data', c => out += c.toString());
    proc.on('close', code => {
      if (code === 0 && out) {
        try {
          const j = JSON.parse(out);
          return resolve(j);
        } catch (e) {
          return resolve(null);
        }
      }
      resolve(null);
    });
    proc.on('error', () => resolve(null));
  });
}

// main route: /:quality/id=:id
app.get('/:quality/id=:id', async (req, res) => {
  try {
    const rawQuality = (req.params.quality || 'high').toLowerCase();
    const idParam = req.params.id;
    if (!idParam) return res.status(400).send('Missing id');

    const qualityKey = ['low','medium','high'].includes(rawQuality) ? rawQuality : 'high';
    const bitrate = qualityMap[qualityKey];

    const videoUrl = /^[a-zA-Z0-9_-]{11}$/.test(idParam)
      ? `https://www.youtube.com/watch?v=${idParam}`
      : (idParam.startsWith('http') ? idParam : `https://www.youtube.com/watch?v=${idParam}`);

    // metadata for friendly filename
    let safeTitle = null;
    try {
      const meta = await fetchMetadata(videoUrl);
      if (meta && meta.title) safeTitle = sanitize(meta.title).slice(0,120);
    } catch(e) { console.warn('metadata error', e && e.message); }

    const ts = Date.now();
    const base = safeTitle ? safeTitle : ( /^[a-zA-Z0-9_-]{11}$/.test(idParam) ? idParam : sanitize(idParam).slice(0,40) );
    const filename = `${base}-${qualityKey}-${ts}.mp3`;
    const filePath = path.join(DOWNLOAD_DIR, filename);

    // serve if exists
    if (fs.existsSync(filePath)) {
      return res.download(filePath, filename, err => { if (!err) scheduleDelete(filePath); });
    }

    // formats to try
    const formatsToTry = [
      'bestaudio[ext=m4a]/bestaudio',
      'bestaudio[protocol^=https]/bestaudio',
      'bestaudio[ext=webm]/bestaudio',
      'bestaudio'
    ];

    // common yt-dlp args with extractor args fallback
    const commonYtdlArgs = [
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificate',
      '--rm-cache-dir',
      '--geo-bypass',
      '--no-call-home',
      '--no-config',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--extractor-args', 'youtube:player_client=web_html5'
    ];

    // optionally add cookies if enabled and file exists
    const useCookies = (process.env.USE_COOKIES || '').toLowerCase() === 'true';
    const cookiesPath = path.join(__dirname, COOKIES_FILE || './cookies.txt');
    if (useCookies && fs.existsSync(cookiesPath)) {
      commonYtdlArgs.push('--cookies', COOKIES_FILE);
      console.log('Using cookies file for yt-dlp:', COOKIES_FILE);
    }

    let finalErrorText = '';
    let converted = false;

    for (const fmt of formatsToTry) {
      if (converted) break;

      let ytdlStderr = '';
      let ffmpegStderr = '';

      const ytdlArgs = ['-f', fmt, '-o', '-'].concat(commonYtdlArgs, [videoUrl]);

      console.log('Attempting format:', fmt);

      const ytdl = spawn('yt-dlp', ytdlArgs, { stdio: ['ignore','pipe','pipe'] });

      ytdl.stderr.on('data', d => { ytdlStderr += d.toString(); console.debug('yt-dlp:', d.toString().trim()); });
      ytdl.on('error', err => { ytdlStderr += `yt-dlp spawn error: ${err.message}\n`; });

      // spawn ffmpeg to write mp3
      const ffmpeg = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'warning',
        '-i', 'pipe:0',
        '-vn',
        '-b:a', bitrate,
        '-f', 'mp3',
        filePath
      ], { stdio: ['pipe','inherit','pipe'] });

      ffmpeg.stderr.on('data', d => { ffmpegStderr += d.toString(); console.debug('ffmpeg:', d.toString().trim()); });
      ffmpeg.on('error', err => { ffmpegStderr += `ffmpeg spawn error: ${err.message}\n`; });

      // pipe ytdl stdout -> ffmpeg stdin
      ytdl.stdout.pipe(ffmpeg.stdin);

      // wait for ffmpeg to finish
      const attemptResult = await new Promise(resolve => {
        let finished = false;
        ffmpeg.on('close', code => { if (!finished) { finished = true; resolve({ code, ytdlStderr, ffmpegStderr }); } });
      });

      if (attemptResult.code === 0 && fs.existsSync(filePath)) {
        console.log('Conversion success (format):', fmt, filePath);
        converted = true;
        return res.download(filePath, filename, err => { if (!err) scheduleDelete(filePath); });
      } else {
        finalErrorText += `\n\n--- Attempt format=${fmt} ---\n\nyt-dlp stderr:\n${attemptResult.ytdlStderr || '(none)'}\n\nffmpeg stderr:\n${attemptResult.ffmpegStderr || '(none)'}\n\nffmpeg exit code: ${attemptResult.code}\n`;
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e){}
        console.warn('Attempt failed for format', fmt);
      }
    } // end formats loop

    console.error('All conversion attempts failed:', finalErrorText);

    // helpful advice messages
    let advice = '';
    if (/HTTP Error 403|Forbidden/i.test(finalErrorText)) {
      advice += '\nDetected 403 Forbidden — try cookies (USE_COOKIES=true + COOKIES_CONTENT secret) or an authenticated account.';
    }
    if (/Requested format is not available/i.test(finalErrorText)) {
      advice += '\nRequested format not available — multiple fallbacks attempted.';
    }

    if (!res.headersSent) {
      return res.status(500).send('Conversion failed. Debug info:\n' + finalErrorText + '\n' + advice);
    }

  } catch (err) {
    console.error('Server route error', err);
    if (!res.headersSent) res.status(500).send('Server error');
  }
});

// health / root
app.get('/', (req, res) => res.send('yt-music-download-api running. Example: /High/id=dQw4w9WgXcQ'));

// single, safe listen with error handler (avoid unhandled EADDRINUSE)
const server = app.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Exiting.`);
    process.exit(1);
  } else {
    console.error('Server error', err);
    process.exit(1);
  }
});

// optional: global uncaught exception handler to log and exit (so platform can restart)
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});
