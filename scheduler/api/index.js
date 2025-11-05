// api/index.js
import fetch from 'node-fetch';
import { CHANNEL_MAP } from '../utils/channelMap.js';

/**
 * Merges multiple XMLTV XML strings into a single XMLTV document
 * @param {Array<{id: string, xml: string}>} xmlDocuments - Array of XML documents with their channel IDs
 * @returns {string} - Merged XMLTV XML string
 */
function mergeXMLTV(xmlDocuments) {
  const allChannels = [];
  const allProgrammes = [];
  
  for (const doc of xmlDocuments) {
    if (!doc.xml) continue;
    
    try {
      // Extract channel and programme elements using regex
      const channelMatches = doc.xml.matchAll(/<channel[^>]*>[\s\S]*?<\/channel>/g);
      const programmeMatches = doc.xml.matchAll(/<programme[^>]*>[\s\S]*?<\/programme>/g);
      
      for (const match of channelMatches) {
        allChannels.push(match[0]);
      }
      
      for (const match of programmeMatches) {
        allProgrammes.push(match[0]);
      }
    } catch (parseError) {
      console.warn(`⚠️ Error parsing XML for ${doc.id}:`, parseError.message);
    }
  }
  
  // Build the merged XMLTV document
  const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>\n';
  const tvOpen = '<tv generator-info-name="EPG.PW Aggregator" generator-info-url="https://epg.pw">\n';
  const tvClose = '</tv>';
  
  return xmlHeader + tvOpen + 
         allChannels.join('\n') + '\n' +
         allProgrammes.join('\n') + '\n' +
         tvClose;
}

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
    const timeout = setTimeout(() => controller.abort(), 8000); // 8 second timeout
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EPG-Aggregator/1.0)',
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      console.warn(`⚠️ Failed to fetch EPG for ${tvgId} (${epgId}): ${response.statusText}`);
      return { id: tvgId, xml: null };
    }
    
    const xml = await response.text();
    
    // Basic validation - check if it's valid XML with tv root
    if (!xml.includes('<tv') || !xml.includes('</tv>')) {
      console.warn(`⚠️ Invalid XML received for ${tvgId} (${epgId})`);
      return { id: tvgId, xml: null };
    }
    
    return { id: tvgId, xml };
  } catch (fetchError) {
    if (fetchError.name === 'AbortError') {
      console.warn(`⚠️ Timeout fetching ${tvgId} (${epgId})`);
    } else {
      console.warn(`⚠️ Error fetching ${tvgId} (${epgId}):`, fetchError.message);
    }
    return { id: tvgId, xml: null };
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
  
  // Main XMLTV generation route
  try {
    console.log('🔄 Starting EPG fetch from epg.pw...');
    const startTime = Date.now();
    
    // Filter out null channel IDs (channels without EPG)
    const channelsToFetch = Object.entries(CHANNEL_MAP)
      .filter(([_, epgId]) => epgId !== null);
    
    console.log(`📡 Fetching EPG data for ${channelsToFetch.length} channels...`);
    
    // Fetch all EPG data in parallel with a concurrency limit
    // Reduced batch size for Vercel serverless constraints
    const BATCH_SIZE = 5; // Process 5 channels at a time
    const epgData = [];
    
    for (let i = 0; i < channelsToFetch.length; i += BATCH_SIZE) {
      const batch = channelsToFetch.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(([tvgId, epgId]) => fetchChannelEPG(tvgId, epgId))
      );
      epgData.push(...batchResults);
      
      // Log progress every 20 channels
      if ((i + BATCH_SIZE) % 20 === 0 || i + BATCH_SIZE >= channelsToFetch.length) {
        console.log(`✓ Processed ${Math.min(i + BATCH_SIZE, channelsToFetch.length)}/${channelsToFetch.length} channels`);
      }
    }
    
    // Filter out channels that failed to fetch
    const successfulFetches = epgData.filter(e => e.xml !== null);
    
    console.log(`✅ Successfully fetched ${successfulFetches.length}/${channelsToFetch.length} channels`);
    
    if (successfulFetches.length === 0) {
      console.error('❌ No EPG data available from any channel');
      return res.status(503).send(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<tv>\n' +
        '  <error>No schedule data available from epg.pw</error>\n' +
        '</tv>'
      );
    }
    
    // Merge all XML documents
    console.log('🔄 Merging XMLTV documents...');
    const mergedXMLTV = mergeXMLTV(successfulFetches);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ XMLTV generation complete in ${duration}s`);
    console.log(`📊 Final document size: ${(mergedXMLTV.length / 1024).toFixed(2)} KB`);
    
    res.status(200).send(mergedXMLTV);
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
