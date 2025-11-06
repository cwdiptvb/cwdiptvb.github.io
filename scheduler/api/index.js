// api/index.js
import fetch from 'node-fetch';
import { CHANNEL_MAP } from '../utils/channelMap.js';

/**
 * Fetches EPG data from epg.pw for a specific channel
 * @param {string} tvgId - The M3U tvg-id
 * @param {string} epgId - The epg.pw channel ID
 * @returns {Promise<{id: string, xml: string}>}
 */
async function fetchChannelEPG(tvgId, epgId) {
  const url = `https://epg.pw/api/epg.xml?channel_id=${epgId}`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EPG-Aggregator/1.0)',
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      return { id: tvgId, xml: null };
    }
    
    const xml = await response.text();
    
    // Basic validation
    if (!xml.includes('<tv') || !xml.includes('</tv>')) {
      return { id: tvgId, xml: null };
    }
    
    return { id: tvgId, xml };
  } catch (fetchError) {
    return { id: tvgId, xml: null };
  }
}

/**
 * Extracts and updates channel and programme elements from XML
 * @param {string} xml - Raw XML content
 * @param {string} tvgId - The tvg-id to use
 * @returns {Object} - Object with channel and programmes
 */
function extractAndUpdateElements(xml, tvgId) {
  try {
    // Extract channel element and update its ID
    const channelMatch = xml.match(/<channel[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/);
    let channel = null;
    
    if (channelMatch) {
      channel = channelMatch[0].replace(/id="[^"]*"/, `id="${tvgId}"`);
      
      // Ensure display-name exists
      if (!channel.includes('<display-name>')) {
        channel = channel.replace('</channel>', `  <display-name>${tvgId}</display-name>\n</channel>`);
      }
    }
    
    // Extract all programme elements and update their channel attributes
    const programmes = [];
    const programmeMatches = xml.matchAll(/<programme[^>]*>([\s\S]*?)<\/programme>/g);
    
    for (const match of programmeMatches) {
      const programme = match[0].replace(/channel="[^"]*"/, `channel="${tvgId}"`);
      programmes.push(programme);
    }
    
    return { channel, programmes };
  } catch (error) {
    console.warn(`⚠️ Error extracting elements for ${tvgId}:`, error.message);
    return { channel: null, programmes: [] };
  }
}

/**
 * Main handler function for Vercel serverless
 */
export default async function handler(req, res) {
  // Set CORS and content type headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
  
  // Handle health check
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('Service is healthy and serving XMLTV schedule at /');
  }
  
  // Handle debug endpoint
  if (req.url === '/debug') {
    res.setHeader('Content-Type', 'application/json');
    const channelsToFetch = Object.entries(CHANNEL_MAP)
      .filter(([_, epgId]) => epgId !== null);
    
    return res.status(200).json({
      totalChannels: channelsToFetch.length,
      sampleChannels: channelsToFetch.slice(0, 5).map(([tvgId, epgId]) => ({ tvgId, epgId })),
      apiExample: `https://epg.pw/api/epg.xml?channel_id=${channelsToFetch[0][1]}`
    });
  }
  
  // Main XMLTV generation route
  try {
    console.log('🔄 Starting EPG fetch from epg.pw...');
    const startTime = Date.now();
    
    // Filter out null channel IDs
    const channelsToFetch = Object.entries(CHANNEL_MAP)
      .filter(([_, epgId]) => epgId !== null);
    
    console.log(`📡 Fetching EPG data for ${channelsToFetch.length} channels...`);
    
    // Fetch in smaller batches to avoid timeout (Vercel has 10s limit on Hobby plan)
    const BATCH_SIZE = 20; // Fetch 20 channels at a time
    const allChannels = [];
    const allProgrammes = [];
    let successCount = 0;
    
    for (let i = 0; i < channelsToFetch.length; i += BATCH_SIZE) {
      const batch = channelsToFetch.slice(i, i + BATCH_SIZE);
      
      const batchResults = await Promise.all(
        batch.map(([tvgId, epgId]) => fetchChannelEPG(tvgId, epgId))
      );
      
      // Process results
      for (const result of batchResults) {
        if (result.xml) {
          const { channel, programmes } = extractAndUpdateElements(result.xml, result.id);
          
          if (channel) {
            allChannels.push(channel);
            allProgrammes.push(...programmes);
            successCount++;
          }
        }
      }
      
      // Log progress every 40 channels
      if ((i + BATCH_SIZE) % 40 === 0 || i + BATCH_SIZE >= channelsToFetch.length) {
        console.log(`✓ Processed ${Math.min(i + BATCH_SIZE, channelsToFetch.length)}/${channelsToFetch.length} channels (${successCount} successful)`);
      }
    }
    
    console.log(`✅ Successfully fetched ${successCount}/${channelsToFetch.length} channels`);
    
    if (allChannels.length === 0) {
      console.error('❌ No EPG data available from any channel');
      return res.status(503).send(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<tv>\n' +
        '  <error>No schedule data available from epg.pw</error>\n' +
        '</tv>'
      );
    }
    
    // Build final XMLTV document
    const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>\n';
    const tvOpen = '<tv source-info-name="EPG.PW" source-info-url="https://epg.pw" generator-info-name="EPG Aggregator">\n';
    const tvClose = '</tv>';
    
    const finalXMLTV = xmlHeader + tvOpen + 
                      allChannels.join('\n') + '\n' +
                      allProgrammes.join('\n') + '\n' +
                      tvClose;
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ XMLTV generation complete in ${duration}s`);
    console.log(`📊 Final: ${allChannels.length} channels, ${allProgrammes.length} programmes`);
    console.log(`📊 Document size: ${(finalXMLTV.length / 1024 / 1024).toFixed(2)} MB`);
    
    res.status(200).send(finalXMLTV);
  } catch (err) {
    console.error("❌ Failed to generate unified XMLTV schedule:", err);
    res.status(500).send(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<tv>\n' +
      '  <error>Failed to generate XMLTV schedule: ' + err.message + '</error>\n' +
      '</tv>'
    );
  }
}
