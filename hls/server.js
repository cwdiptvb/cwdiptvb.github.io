const express = require('express');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

function resolveRedirect(url, callback) {
  const client = url.startsWith('https') ? https : http;
  const req = client.get(url, { method: 'HEAD' }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      const redirectUrl = new URL(res.headers.location, url).href;
      resolveRedirect(redirectUrl, callback);
    } else {
      callback(url);
    }
  });
  req.on('error', () => callback(url));
}

app.get('/:channelId/tracks-v1a1/mono.m3u8', (req, res) => {
  const { channelId } = req.params;
  const sourceUrl = `http://fl1.moveonjoy.com/${channelId}/tracks-v1a1/mono.m3u8`;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');

  resolveRedirect(sourceUrl, finalUrl => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', finalUrl,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '3',
      '-hls_flags', 'delete_segments',
      '-method', 'PUT',
      'pipe:1'
    ]);

    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', data => console.error(`FFmpeg error: ${data}`));
    ffmpeg.on('close', code => console.log(`FFmpeg exited with code ${code}`));
  });
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
