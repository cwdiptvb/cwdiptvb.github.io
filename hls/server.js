const express = require('express');
const { spawn } = require('child_process');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/:channelId/tracks-v1a1/mono.m3u8', (req, res) => {
  const { channelId } = req.params;
  const sourceUrl = `http://fl1.moveonjoy.com/${channelId}/tracks-v1a1/mono.m3u8`;

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');

  // Step 1: Probe audio channels
  exec(`ffprobe -v error -select_streams a:0 -show_entries stream=channels -of default=noprint_wrappers=1:nokey=1 "${sourceUrl}"`, (err, stdout) => {
    let channels = parseInt(stdout.trim()) || 2; // Default to stereo if unknown
    let ac = channels >= 6 ? 6 : 2; // Use 6 for surround, 2 for stereo

    // Step 2: Spawn FFmpeg with appropriate audio channel config
    const ffmpeg = spawn('ffmpeg', [
      '-i', sourceUrl,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-ac', ac.toString(),
      '-f', 'hls',
      '-hls_time', '4',
      '-hls_list_size', '5',
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
  console.log(`Server running on port ${PORT}`);
});
