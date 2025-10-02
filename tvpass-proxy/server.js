import path from 'path';
console.log("Current file:", path.resolve('./server.js'));
import express from 'express';
import fetch from 'node-fetch';
import { convertMultipleToXMLTV } from './utils/convert.js';
import { CHANNEL_MAP } from './utils/channelMap.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', async (req, res) => {
  const chId = req.query['ch-id'];
  const plId = req.query['pl-id'];

  if (chId) {
    const url = `https://tvpass.org/tv_schedules/${encodeURIComponent(chId)}.json`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return res.status(response.status).json({ error: `Upstream fetch failed`, code: `err_upstream_${response.status}` });
      }
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Proxy fetch failed', code: 'err_proxy_failure' });
    }
  }

  if (plId) {
    const tvpassId = CHANNEL_MAP[plId];
    if (!tvpassId) return res.status(404).send(`Unknown channel ID: ${plId}`);

    const url = `https://tvpass.org/tv_schedules/${encodeURIComponent(tvpassId)}.json`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return res.status(response.status).send(`Upstream fetch failed: ${response.statusText}`);
      }
      const data = await response.json();
      const xmltv = convertMultipleToXMLTV([{ id: plId, data }]);
      res.setHeader('Content-Type', 'application/xml');
      return res.send(xmltv);
    } catch (err) {
      return res.status(500).send(`Proxy fetch failed`);
    }
  }

  return res.status(400).send('Missing ch-id or pl-id parameter');
});

app.get('/m3usch', async (req, res) => {
  try {
    const schedules = await Promise.all(
      Object.entries(CHANNEL_MAP).map(async ([tvgId, tvpassId]) => {
        const url = `https://tvpass.org/tv_schedules/${encodeURIComponent(tvpassId)}.json`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch ${tvpassId}`);
        const data = await response.json();
        return { id: tvgId, data };
      })
    );

    const xmltv = convertMultipleToXMLTV(schedules);
    res.setHeader('Content-Type', 'application/xml');
    res.send(xmltv);
  } catch (err) {
    console.error("❌ Failed to build unified XMLTV:", err);
    res.status(500).send("Failed to generate schedule");
  }
});

app.listen(PORT, () => {
  console.log(`TVPass proxy running on port ${PORT}`);
});  
