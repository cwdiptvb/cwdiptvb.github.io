// server.js (Updated for XMLTV at Root Path)

import path from 'path';
console.log("Current file:", path.resolve('./server.js'));
import express from 'express';
import fetch from 'node-fetch';
import { convertMultipleToXMLTV } from './utils/convert.js';
import { CHANNEL_MAP } from './utils/channelMap.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for CORS headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/xml'); // Set default content type for the primary route
  next();
});

// --- Primary Route: Generates and serves the unified XMLTV schedule at the root (/) ---
app.get('/', async (req, res) => {
  // Your frontend is now pointing to: https://cwdiptvb-github-io.onrender.com/
  // The server handles the unified XMLTV generation here.
  try {
    const schedules = await Promise.all(
      Object.entries(CHANNEL_MAP).map(async ([tvgId, tvpassId]) => {
        const url = `https://tvpass.org/tv_schedules/${encodeURIComponent(tvpassId)}.json`;
        const response = await fetch(url);
        
        // Handle upstream fetch failures gracefully
        if (!response.ok) {
            console.warn(`⚠️ Failed to fetch schedule for ${tvpassId}: ${response.statusText}`);
            // Return an empty data object so Promise.all can continue
            return { id: tvgId, data: [] }; 
        }
        
        const data = await response.json();
        return { id: tvgId, data };
      })
    );
    
    // Filter out channels that failed to fetch completely (returned {data: []})
    const successfulSchedules = schedules.filter(s => s.data && s.data.length > 0);

    const xmltv = convertMultipleToXMLTV(successfulSchedules);
    
    // Response headers are already set via middleware, just send the XML
    res.send(xmltv);
  } catch (err) {
    console.error("❌ Failed to generate unified XMLTV schedule:", err);
    // Send a 500 error response
    res.status(500).send("Failed to generate complete XMLTV schedule.");
  }
});


// --- Health Check / Fallback (Optional, but good practice) ---
// Note: This must come *after* the root route, or it won't be hit.
app.get('/health', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send('Service is healthy and serving XMLTV schedule at /');
});


// --- Removed the old code for query parameters ('ch-id' and 'pl-id') ---
// --- Removed the previous '/m3usch' route as its logic is now at '/' ---

app.listen(PORT, () => {
  console.log(`TVPass proxy (XMLTV only) running on port ${PORT}`);
});
