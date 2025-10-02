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

app.get('/m3usch', async (req, res) => {
  try {
    const schedules = await Promise.all(
      Object.entries(CHANNEL_MAP).map(async ([tvgId, tvpassId]) => {
        const url = `https://tvpass.org/tv_schedules/${encodeURIComponent(tvpassId)}.json`;
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Unavailable: ${tvpassId}`);
          const data = await response.json();
          return { id: tvgId, data };
        } catch (err) {
          console.warn(`⚠️ Skipping ${tvpassId}: ${err.message}`);
          return null;
        }
      })
    );

    const filtered = schedules.filter(Boolean); // remove nulls
    const xmltv = convertMultipleToXMLTV(filtered);
    res.setHeader('Content-Type', 'application/xml');
    res.send(xmltv);
  } catch (err) {
    console.error("❌ Failed to build unified XMLTV:", err);
    res.status(500).send("Failed to generate schedule");
  }
});

app.get('/', async (req, res) => {
  const plId = req.query['pl-id'];
  if (plId) {
    const tvpassId = CHANNEL_MAP[plId] || plId; // fallback to raw pl-id
    const url = `https://tvpass.org/tv_schedules/${encodeURIComponent(tvpassId)}.json`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`⚠️ Skipping ${tvpassId}: ${response.statusText}`);
        return res.status(204).send(); // No content
      }
      const data = await response.json();
      const xmltv = convertMultipleToXMLTV([{ id: plId, data }]);
      res.setHeader('Content-Type', 'application/xml');
      return res.send(xmltv);
    } catch (err) {
      console.warn(`⚠️ Failed to fetch ${tvpassId}: ${err.message}`);
      return res.status(204).send(); // No content
    }
  }

  return res.status(400).send('Missing pl-id or ch-id');
});

app.listen(PORT, () => {
  console.log(`TVPass proxy running on port ${PORT}`);
});
