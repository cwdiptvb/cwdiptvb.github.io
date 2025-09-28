import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

// Allow CORS for frontend access
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Proxy endpoint
app.get('/', async (req, res) => {
  const chId = req.query['ch-id'];
  if (!chId) {
    return res.status(400).json({ error: 'Missing ch-id parameter', code: 'err_missing_ch_id' });
  }

  const url = `https://tvpass.org/tv_schedules/${encodeURIComponent(chId)}.json`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({
        error: `Upstream fetch failed: ${response.statusText}`,
        code: `err_upstream_${response.status}`
      });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Proxy fetch failed', code: 'err_proxy_failure' });
  }
});

app.listen(PORT, () => {
  console.log(`TVPass proxy running on port ${PORT}`);
});
