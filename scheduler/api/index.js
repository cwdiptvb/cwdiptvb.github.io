// api/index.js
import fetch from 'node-fetch';
import { convertMultipleToXMLTV } from '../utils/convert.js';
import { CHANNEL_MAP } from '../utils/channelMap.js';

export default async function handler(req, res) {
  // Set CORS and content type headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/xml');

  // Handle health check
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('Service is healthy and serving XMLTV schedule at /');
  }

  // Main XMLTV generation route
  try {
    const schedules = await Promise.all(
      Object.entries(CHANNEL_MAP).map(async ([tvgId, tvpassId]) => {
        const url = `https://tvpass.org/tv_schedules/${encodeURIComponent(tvpassId)}.json`;
        
        try {
          const response = await fetch(url);
          
          if (!response.ok) {
            console.warn(`⚠️ Failed to fetch schedule for ${tvpassId}: ${response.statusText}`);
            return { id: tvgId, data: [] };
          }
          
          const data = await response.json();
          return { id: tvgId, data };
        } catch (fetchError) {
          console.warn(`⚠️ Error fetching ${tvpassId}:`, fetchError.message);
          return { id: tvgId, data: [] };
        }
      })
    );
    
    // Filter out channels that failed to fetch
    const successfulSchedules = schedules.filter(s => s.data && s.data.length > 0);
    
    if (successfulSchedules.length === 0) {
      return res.status(503).send('<?xml version="1.0" encoding="UTF-8"?><tv><error>No schedule data available</error></tv>');
    }
    
    const xmltv = convertMultipleToXMLTV(successfulSchedules);
    
    res.status(200).send(xmltv);
  } catch (err) {
    console.error("❌ Failed to generate unified XMLTV schedule:", err);
    res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><tv><error>Failed to generate XMLTV schedule</error></tv>');
  }
}
