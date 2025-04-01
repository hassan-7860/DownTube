const express = require('express');
const ytdl = require('ytdl-core');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint to get video info
app.get('/api/info', async (req, res) => {
  try {
    const url = req.query.url;
    
    if (!url) return res.status(400).json({ error: 'URL parameter is required' });
    if (!ytdl.validateURL(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

    const info = await ytdl.getInfo(url);
    
    const formats = info.formats
      .filter(format => format.hasVideo || format.hasAudio)
      .map(format => ({
        itag: format.itag,
        quality: format.qualityLabel || format.quality,
        type: format.mimeType.split(';')[0],
        container: format.container,
        hasVideo: format.hasVideo,
        hasAudio: format.hasAudio,
        url: format.url,
        bitrate: format.bitrate,
        contentLength: format.contentLength
      }));

    res.json({
      title: info.videoDetails.title,
      thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url,
      duration: info.videoDetails.lengthSeconds,
      views: info.videoDetails.viewCount,
      author: info.videoDetails.author.name,
      formats: formats
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Failed to fetch video information' });
  }
});

// API endpoint to download video
app.get('/api/download', async (req, res) => {
  try {
    const url = req.query.url;
    const itag = req.query.itag;
    const type = req.query.type || 'video';
    
    if (!url || !itag) return res.status(400).json({ error: 'URL and itag parameters are required' });
    if (!ytdl.validateURL(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

    const info = await ytdl.getInfo(url);
    const format = info.formats.find(f => f.itag === parseInt(itag));
    if (!format) return res.status(400).json({ error: 'Requested format not available' });

    let filename = `${info.videoDetails.title.replace(/[^\w\s]/gi, '')}`;
    let options = {};
    
    if (type === 'audio') {
      options = { quality: 'highestaudio', filter: 'audioonly' };
      filename += '.mp3';
    } else {
      options = { quality: itag };
      filename += `.${format.container || 'mp4'}`;
    }

    res.header('Content-Disposition', `attachment; filename="${filename}"`);
    ytdl(url, options).pipe(res);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
