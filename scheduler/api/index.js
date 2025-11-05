// api/index.js
import fetch from 'node-fetch';
import { CHANNEL_MAP } from '../utils/channelMap.js';

/**
 * Filters XMLTV to only include channels from our channel map
 * @param {string} xmlContent - Raw XMLTV content
 * @param {Set<string>} channelIds - Set of EPG.PW channel IDs to include
 * @returns {Object} - Object with channels and programmes arrays
 */
function filterXMLTV(xmlContent, channelIds) {
  const channels = [];
  const programmes = [];
  
  try {
    // Extract all channel elements
    const channelMatches = xmlContent.matchAll(/<channel[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g);
    
    for (const match of channelMatches) {
      const channelId = match[1];
      const fullChannelElement = match[0];
      
      // Check if this channel ID is in our map
      if (channelIds.has(channelId)) {
        channels.push(fullChannelElement);
      }
    }
    
    // Extract all programme elements for our channels
    const programmeMatches = xmlContent.matchAll(/<programme[^>]*channel="([^"]*)"[^>]*>([\s\S]*?)<\/programme>/g);
    
    for (const match of programmeMatches) {
      const channelId = match[1];
      const fullProgrammeElement = match[0];
      
      // Only include programmes for our channels
      if (channelIds.has(channelId)) {
        programmes.push(fullProgrammeElement);
      }
    }
    
  } catch (parseError) {
    console.error('❌ Error filtering XMLTV:', parseError.message);
  }
  
  return { channels, programmes };
}

/**
 * Builds the channel ID to tvg-id mapping
 * @returns {Map} - Map of EPG.PW channel IDs to tvg-ids
 */
function buildChannelIdMap() {
  const map = new Map();
  
  for (const [tvgId, epgId] of Object.entries(CHANNEL_MAP)) {
    if (epgId !== null) {
      // EPG.PW uses just the numerical ID in their XML
      map.set(epgId, tvgId);
    }
  }
  
  return map;
}

/**
 * Updates channel IDs in XMLTV to use tvg-ids from M3U
 * @param {Array<string>} channels - Array of channel XML strings
 * @param {Array<string>} programmes - Array of programme XML strings
 * @param {Map} channelIdMap - Map of EPG.PW IDs to tvg-ids
 * @returns {Object} - Updated channels and programmes
 */
function updateChannelIds(channels, programmes, channelIdMap) {
  const updatedChannels = channels.map(channel => {
    // Find the channel ID
    const idMatch = channel.match(/id="([^"]*)"/);
    if (idMatch && channelIdMap.has(idMatch[1])) {
      const newId = channelIdMap.get(idMatch[1]);
      return channel.replace(/id="[^"]*"/, `id="${newId}"`);
    }
    return channel;
  });
  
  const updatedProgrammes = programmes.map(programme => {
    // Find the channel attribute
    const channelMatch = programme.match(/channel="([^"]*)"/);
    if (channelMatch && channelIdMap.has(channelMatch[1])) {
      const newId = channelIdMap.get(channelMatch[1]);
      return programme.replace(/channel="[^"]*"/, `channel="${newId}"`);
    }
    return programme;
  });
  
  return { channels: updatedChannels, programmes: updatedProgrammes };
}

/**
 * Builds final XMLTV document
 * @param {Array<string>} channels - Array of channel XML strings
 * @param {Array<string>} programmes - Array of programme XML strings
 * @returns {string} - Complete XMLTV document
 */
function buildXMLTV(channels, programmes) {
  const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>\n';
  const tvOpen = '<tv generator-info-name="EPG.PW Aggregator" generator-info-url="https://epg.pw">\n';
  const tvClose = '</tv>';
  
  return xmlHeader + tvOpen + 
         channels.join('\n') + '\n' +
         programmes.join('\n') + '\n' +
         tvClose;
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
    
    // Build channel ID mapping (EPG.PW ID -> tvg-id)
    const channelIdMap = buildChannelIdMap();
    const epgChannelIds = new Set(channelIdMap.keys());
    
    console.log(`📡 Loading XMLTV files for ${channelIdMap.size} channels...`);
    
    // Fetch both US and Canadian XMLTV files in parallel
    const [usResponse, caResponse] = await Promise.all([
      fetch('https://epg.pw/xmltv/epg_US.xml', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EPG-Aggregator/1.0)' }
      }),
      fetch('https://epg.pw/xmltv/epg_CA.xml', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EPG-Aggregator/1.0)' }
      })
    ]);
    
    if (!usResponse.ok && !caResponse.ok) {
      console.error('❌ Failed to fetch both XMLTV files');
      return res.status(503).send(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<tv>\n' +
        '  <e>Failed to fetch EPG data from epg.pw</e>\n' +
        '</tv>'
      );
    }
    
    console.log('✅ XMLTV files downloaded, filtering channels...');
    
    let allChannels = [];
    let allProgrammes = [];
    
    // Process US XMLTV
    if (usResponse.ok) {
      const usXml = await usResponse.text();
      const usFiltered = filterXMLTV(usXml, epgChannelIds);
      console.log(`📺 Found ${usFiltered.channels.length} US channels, ${usFiltered.programmes.length} programmes`);
      allChannels.push(...usFiltered.channels);
      allProgrammes.push(...usFiltered.programmes);
    }
    
    // Process Canadian XMLTV
    if (caResponse.ok) {
      const caXml = await caResponse.text();
      const caFiltered = filterXMLTV(caXml, epgChannelIds);
      console.log(`📺 Found ${caFiltered.channels.length} Canadian channels, ${caFiltered.programmes.length} programmes`);
      allChannels.push(...caFiltered.channels);
      allProgrammes.push(...caFiltered.programmes);
    }
    
    if (allChannels.length === 0) {
      console.error('❌ No matching channels found in EPG data');
      return res.status(503).send(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<tv>\n' +
        '  <e>No matching channels found in EPG data</e>\n' +
        '</tv>'
      );
    }
    
    // Update channel IDs to use tvg-ids from M3U
    console.log('🔄 Updating channel IDs to match M3U tvg-ids...');
    const { channels: updatedChannels, programmes: updatedProgrammes } = 
      updateChannelIds(allChannels, allProgrammes, channelIdMap);
    
    // Build final XMLTV document
    console.log('🔄 Building final XMLTV document...');
    const finalXMLTV = buildXMLTV(updatedChannels, updatedProgrammes);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ XMLTV generation complete in ${duration}s`);
    console.log(`📊 Final: ${updatedChannels.length} channels, ${updatedProgrammes.length} programmes`);
    console.log(`📊 Document size: ${(finalXMLTV.length / 1024 / 1024).toFixed(2)} MB`);
    
    res.status(200).send(finalXMLTV);
  } catch (err) {
    console.error("❌ Failed to generate unified XMLTV schedule:", err);
    res.status(500).send(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<tv>\n' +
      '  <e>Failed to generate XMLTV schedule: ' + err.message + '</e>\n' +
      '</tv>'
    );
  }
}
