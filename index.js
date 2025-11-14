/**
 * index.js
 * - Save mp3 to ./downloads
 * - Try multiple yt-dlp formats (fallbacks)
 * - Use safe yt-dlp options
 * - Auto-delete saved file after 1 hour
 * - Return combined stderr on failure for debugging
 *
 * Environment:
 * - PORT (optional) default 3000
 * - USE_COOKIES (optional) = "true" to enable cookies
 * - COOKIES_FILE (optional) path to cookies.txt inside container (e.g. ./cookies.txt)
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sanitize = require('sanitize-filename');

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const ONE_HOUR_MS = 60 * 60 * 1000;

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.disable('x-powered-by');

// quality map
const qualityMap = { low: '64k', medium: '128k', high: '320k' };

// on startup: cleanup files older than 1 hour
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

// fetch metadata (title) to make friendly filenames
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

// route: /:quality/id=:id
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

    // try metadata for nice filename
    let safeTitle = null;
    try {
      const meta = await fetchMetadata(videoUrl);
      if (meta && meta.title) safeTitle = sanitize(meta.title).slice(0,120);
    } catch(e) {
      console.warn('metadata error', e && e.message);
    }

    const ts = Date.now();
    const base = safeTitle ? safeTitle : ( /^[a-zA-Z0-9_-]{11}$/.test(idParam) ? idParam : sanitize(idParam).slice(0,40) );
    const filename = `${base}-${qualityKey}-${ts}.mp3`;
    const filePath = path.join(DOWNLOAD_DIR, filename);

    // if file already exists, serve quickly
    if (fs.existsSync(filePath)) {
      return res.download(filePath, filename, err => {
        if (!err) scheduleDelete(filePath);
      });
    }

    // yt-dlp format fallbacks (best chance ffmpeg-compatible outputs)
    const formatsToTry = [
      'bestaudio[ext=m4a]/bestaudio',
      'bestaudio[protocol^=https]/bestaudio',
      'bestaudio[ext=webm]/bestaudio',
      'bestaudio'
    ];

    // common args
    const commonYtdlArgs = [
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificate',
      '--rm-cache-dir',
      '--geo-bypass',
      '--no-call-home',
      '--no-config',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    // optional cookies (for age/region-restricted videos)
    const useCookies = (process.env.USE_COOKIES || '').toLowerCase() === 'true';
    const cookiesFile = process.env.COOKIES_FILE || './cookies.txt';
    if (useCookies && fs.existsSync(path.join(__dirname, cookiesFile))) {
      commonYtdlArgs.push('--cookies', cookiesFile);
      console.log('Using cookies file for yt-dlp:', cookiesFile);
    }

    let finalErrorText = '';
    let converted = false;

    for (const fmt of formatsToTry) {
      // stop if converted
      if (converted) break;

      // collect stderr
      let ytdlStderr = '';
      let ffmpegStderr = '';

      const ytdlArgs = ['-f', fmt, '-o', '-'].concat(commonYtdlArgs, [videoUrl]);

      console.log('Attempting format:', fmt);

      const ytdl = spawn('yt-dlp', ytdlArgs, { stdio: ['ignore','pipe','pipe'] });

      ytdl.stderr.on('data', d => { ytdlStderr += d.toString(); console.debug('yt-dlp:', d.toString().trim()); });
      ytdl.on('error', err => { ytdlStderr += `yt-dlp spawn error: ${err.message}\n`; });

      // spawn ffmpeg - write mp3 to filePath
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
        // If ytdl ends early, ffmpeg will eventually fail - let ffmpeg close handle it
        // Optional: add a timeout per attempt (not added by default)
      });

      if (attemptResult.code === 0 && fs.existsSync(filePath)) {
        // success
        console.log('Conversion success (format):', fmt, filePath);
        converted = true;
        return res.download(filePath, filename, err => {
          if (!err) scheduleDelete(filePath);
        });
      } else {
        // failed attempt: gather debug info and remove partial file
        finalErrorText += `\n\n--- Attempt format=${fmt} ---\n\nyt-dlp stderr:\n${attemptResult.ytdlStderr || '(none)'}\n\nffmpeg stderr:\n${attemptResult.ffmpegStderr || '(none)'}\n\nffmpeg exit code: ${attemptResult.code}\n`;
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e){}
        console.warn('Attempt failed for format', fmt);
        // continue loop to try next format
      }
    } // end formats loop

    // all attempts failed
    console.error('All conversion attempts failed:', finalErrorText);
    // Add helpful advice
    let advice = '';
    if (/HTTP Error 403|Forbidden/i.test(finalErrorText)) {
      advice += '\nDetected 403 Forbidden — video may be region/age-restricted. Try cookies (USE_COOKIES=true + COOKIES_FILE=./cookies.txt) or use an authenticated account.';
    }
    if (/Requested format is not available/i.test(finalErrorText)) {
      advice += '\nRequested format not available — we tried multiple fallbacks.';
    }

    if (!res.headersSent) {
      return res.status(500).send('Conversion failed. Debug info:\n' + finalErrorText + '\n' + advice);
    }

  } catch (err) {
    console.error('Server error', err);
    if (!res.headersSent) res.status(500).send('Server error');
  }
});

app.get('/', (req, res) => {
  res.send('yt-music-download-api running. Example: /High/id=dQw4w9WgXcQ');
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));// cleanup on startup - delete files older than 1 hour
function cleanupOldFiles() {
  const now = Date.now();
  fs.readdir(DOWNLOAD_DIR, (err, files) => {
    if (err) return console.error('cleanup read dir error:', err);
    files.forEach(f => {
      const p = path.join(DOWNLOAD_DIR, f);
      fs.stat(p, (err, stat) => {
        if (err) return;
        const mtime = new Date(stat.mtime).getTime();
        if ((now - mtime) > ONE_HOUR_MS) {
          fs.unlink(p, e => {
            if (!e) console.log('Startup cleanup removed', p);
          });
        }
      });
    });
  });
}
cleanupOldFiles();

// schedule deletion for filePath after 1 hour
function scheduleDelete(filePath) {
  setTimeout(() => {
    fs.unlink(filePath, err => {
      if (!err) console.log('Auto-deleted', filePath);
    });
  }, ONE_HOUR_MS);
}

// Helper: call yt-dlp to fetch metadata (title) -> promise
function fetchMetadata(videoUrl) {
  return new Promise((resolve, reject) => {
    // yt-dlp -j URL
    const proc = spawn('yt-dlp', ['-j', '--no-warnings', videoUrl], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    proc.stdout.on('data', chunk => out += chunk.toString());
    proc.on('close', code => {
      if (code === 0 && out) {
        try {
          const j = JSON.parse(out);
          resolve(j);
        } catch (e) {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });
    proc.on('error', err => reject(err));
  });
}

// Route: /High/id=VIDEOID  (case-insensitive quality)
app.get('/:quality/id=:id', async (req, res) => {
  try {
    const rawQuality = (req.params.quality || 'high').toLowerCase();
    const idParam = req.params.id;
    if (!idParam) return res.status(400).send('Missing id');

    const qualityKey = ['low', 'medium', 'high'].includes(rawQuality) ? rawQuality : 'high';
    const bitrate = qualityMap[qualityKey];

    // Accept either a plain 11-char id or a full URL
    const videoUrl = /^[a-zA-Z0-9_-]{11}$/.test(idParam)
      ? `https://www.youtube.com/watch?v=${idParam}`
      : (idParam.startsWith('http') ? idParam : `https://www.youtube.com/watch?v=${idParam}`);

    // Get metadata to create nice filename (non-blocking fallback)
    let safeTitle = null;
    try {
      const meta = await fetchMetadata(videoUrl);
      if (meta && meta.title) {
        safeTitle = sanitize(meta.title).slice(0, 120);
      }
    } catch (e) {
      console.warn('metadata fetch error:', e && e.message);
    }

    // final filename: <title or id>-<quality>-<timestamp>.mp3
    const ts = Date.now();
    const base = safeTitle ? `${safeTitle}` : ( /^[a-zA-Z0-9_-]{11}$/.test(idParam) ? idParam : sanitize(idParam).slice(0,40) );
    const filename = `${base}-${qualityKey}-${ts}.mp3`;
    const filePath = path.join(DOWNLOAD_DIR, filename);

    // If file already exists (shouldn't usually), send immediately
    if (fs.existsSync(filePath)) {
      console.log('Serving cached file', filePath);
      return res.download(filePath);
    }

    // Stream mode: spawn yt-dlp to stdout, pipe into ffmpeg to save mp3
    // yt-dlp -f bestaudio -o - <url>
    const ytdl = spawn('yt-dlp', ['-f', 'bestaudio', '-o', '-', videoUrl], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    ytdl.stderr.on('data', d => {
      // debug logs - keep minimal
      const s = d.toString();
      if (!/^\[download\]/.test(s)) console.debug('yt-dlp:', s.trim());
    });

    ytdl.on('error', err => {
      console.error('yt-dlp spawn error', err);
    });

    // ffmpeg -i pipe:0 -vn -b:a <bitrate> -f mp3 <filePath>
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'warning',
      '-i', 'pipe:0',
      '-vn',
      '-b:a', bitrate,
      '-f', 'mp3',
      filePath
    ], { stdio: ['pipe', 'inherit', 'inherit'] });

    ffmpeg.on('error', err => {
      console.error('ffmpeg spawn error', err);
    });

    // Pipe ytdl -> ffmpeg
    ytdl.stdout.pipe(ffmpeg.stdin);

    // If ffmpeg exits successfully, respond.download the saved file and schedule deletion
    ffmpeg.on('close', code => {
      if (code === 0 && fs.existsSync(filePath)) {
        console.log('Saved file:', filePath);
        // stream file to client for download
        res.download(filePath, filename, err => {
          if (err) {
            console.error('Error sending file:', err);
            if (!res.headersSent) res.status(500).send('Error sending file');
          } else {
            // schedule deletion 1 hour later
            scheduleDelete(filePath);
          }
        });
      } else {
        console.error('ffmpeg exited code', code);
        if (!res.headersSent) res.status(500).send('Conversion failed');
        // try to cleanup partial file if exists
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e){}
      }
    });

    // handle client disconnect: kill child processes
    req.on('close', () => {
      try { ytdl.kill('SIGKILL'); } catch(e){}
      try { ffmpeg.kill('SIGKILL'); } catch(e){}
    });

  } catch (err) {
    console.error('Server error', err);
    if (!res.headersSent) res.status(500).send('Server error');
  }
});

// Simple root info
app.get('/', (req, res) => {
  res.send('yt-music-download-api running. Example: /High/id=dQw4w9WgXcQ');
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
