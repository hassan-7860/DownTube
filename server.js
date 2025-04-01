const express = require('express');
const ytdl = require('ytdl-core');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS configuration
app.use(cors({
  origin: ['http://localhost:3000', 'https://yourdomain.com'],
  methods: ['GET'],
  allowedHeaders: ['Content-Type']
}));

// Rate limiting to prevent abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', apiLimiter);

// Error class for YouTube-specific errors
class YouTubeError extends Error {
  constructor(message, type, statusCode = 400) {
    super(message);
    this.name = 'YouTubeError';
    this.type = type;
    this.statusCode = statusCode;
  }
}

// Helper function to extract video ID
const extractVideoId = (url) => {
  const patterns = [
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i,
    /youtube\.com\/shorts\/([^"&?\/\s]{11})/i
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
};

// Enhanced YouTube URL validation
const validateYouTubeUrl = (url) => {
  if (!url) throw new YouTubeError('URL is required', 'MISSING_URL', 400);
  
  const videoId = extractVideoId(url);
  if (!videoId) throw new YouTubeError('Invalid YouTube URL format', 'INVALID_URL', 400);
  
  if (!ytdl.validateURL(`https://www.youtube.com/watch?v=${videoId}`)) {
    throw new YouTubeError('YouTube URL validation failed', 'INVALID_VIDEO', 400);
  }

  return videoId;
};

// API endpoint to get video info with enhanced error handling
app.get('/api/info', async (req, res) => {
  try {
    const { url } = req.query;
    
    // Validate URL
    const videoId = validateYouTubeUrl(url);
    const properUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Get video info with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const info = await ytdl.getInfo(properUrl, {
      requestOptions: {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }
    });

    clearTimeout(timeout);

    // Check if video is available
    if (info.videoDetails.isPrivate) {
      throw new YouTubeError('This video is private', 'PRIVATE_VIDEO', 403);
    }

    if (info.videoDetails.isLiveContent) {
      throw new YouTubeError('Live streams cannot be downloaded', 'LIVE_STREAM', 400);
    }

    // Process formats
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
        contentLength: format.contentLength,
        approxDurationMs: format.approxDurationMs
      }));

    res.status(200).json({
      status: 'success',
      data: {
        videoId,
        title: info.videoDetails.title,
        thumbnail: info.videoDetails.thumbnails.slice(-1)[0].url,
        duration: info.videoDetails.lengthSeconds,
        views: info.videoDetails.viewCount,
        author: info.videoDetails.author?.name || 'Unknown',
        formats
      }
    });

  } catch (error) {
    clearTimeout(timeout);
    
    console.error(`[${new Date().toISOString()}] Error:`, {
      url: req.query.url,
      error: error.message,
      stack: error.stack
    });

    if (error.name === 'YouTubeError') {
      return res.status(error.statusCode).json({
        status: 'error',
        code: error.type,
        message: error.message,
        suggestion: error.type === 'INVALID_URL' ? 
          'Try using format: https://www.youtube.com/watch?v=VIDEO_ID' : ''
      });
    }

    if (error.message.includes('This video is unavailable')) {
      return res.status(404).json({
        status: 'error',
        code: 'VIDEO_UNAVAILABLE',
        message: 'This video is unavailable or has been removed'
      });
    }

    if (error.message.includes('rate limit')) {
      return res.status(429).json({
        status: 'error',
        code: 'RATE_LIMITED',
        message: 'YouTube is temporarily blocking requests. Please try again later.'
      });
    }

    res.status(500).json({
      status: 'error',
      code: 'SERVER_ERROR',
      message: 'Failed to fetch video information',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Download endpoint with enhanced error handling
app.get('/api/download', async (req, res) => {
  try {
    const { url, itag, type = 'video' } = req.query;
    
    // Validate parameters
    if (!url || !itag) {
      throw new YouTubeError('URL and itag parameters are required', 'MISSING_PARAMS', 400);
    }

    const videoId = validateYouTubeUrl(url);
    const properUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Get video info first to validate
    const info = await ytdl.getInfo(properUrl);
    const format = info.formats.find(f => f.itag === parseInt(itag));
    
    if (!format) {
      throw new YouTubeError('Requested format not available', 'FORMAT_UNAVAILABLE', 400);
    }

    // Set download options
    let filename = `${info.videoDetails.title.replace(/[^\w\s]/gi, '')}`;
    let options = { quality: itag };

    if (type === 'audio') {
      options = { 
        quality: 'highestaudio', 
        filter: 'audioonly',
        format: info.formats.find(f => f.itag === 140) || format // Fallback to itag 140 for audio
      };
      filename += '.mp3';
    } else {
      filename += `.${format.container || 'mp4'}`;
    }

    // Set headers
    res.header('Content-Disposition', `attachment; filename="${filename}"`);
    res.header('Content-Type', format.mimeType);

    // Stream the download with error handling
    const stream = ytdl(properUrl, options)
      .on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) {
          res.status(500).json({
            status: 'error',
            code: 'STREAM_ERROR',
            message: 'Download failed due to stream error'
          });
        }
      });

    stream.pipe(res);

  } catch (error) {
    console.error('Download error:', error);

    if (error.name === 'YouTubeError') {
      return res.status(error.statusCode).json({
        status: 'error',
        code: error.type,
        message: error.message
      });
    }

    res.status(500).json({
      status: 'error',
      code: 'DOWNLOAD_FAILED',
      message: 'Failed to process download request'
    });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    code: 'NOT_FOUND',
    message: 'Endpoint not found'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({
    status: 'error',
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred'
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Environment:', process.env.NODE_ENV || 'development');
});
     
