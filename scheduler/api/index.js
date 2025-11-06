// api/index.js
import fetch from 'node-fetch';
import { CHANNEL_MAP } from '../utils/channelMap.js';

/**
 * Filters XMLTV to only include channels from our channel map
 * @param {string} xmlContent - Raw XMLTV content
 * @param {Set<string>} channelIds - Set of EPG.PW channel IDs to include
 * @returns {Object} - Object with channels and programmes arrays
 */
function filterXMLTV(xmlContent, channelIds, source = 'unknown') {
  const channels = [];
  const programmes = [];
  
  // Debug: Log first few channel IDs found in the XML
  const sampleMatches = xmlContent.match(/<channel[^>]*id="([^"]*)"[^>]*>/g);
  if (sampleMatches && sampleMatches.length > 0) {
    console.log(`📝 ${source} sample channel IDs:`, sampleMatches.slice(0, 3).map(m => m.match(/id="([^"]*)"/)[1]));
  }
  
  try {
    // Extract all channel elements
    const channelMatches = xmlContent.matchAll(/<channel[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g);
    
    for (const match of channelMatches) {
      const channelId = match[1];
      const fullChannelElement = match[0];
      
      // Try multiple formats:
      // 1. Direct numerical ID: "403793"
      // 2. With prefix: "epg.pw/403793" or "epg.pw-403793"
      // 3. URL format: "https://epg.pw/last/403793.html"
      let numericId = channelId;
      
      if (channelId.includes('epg.pw')) {
        numericId = channelId.split('/').pop().split('.')[0].replace('epg.pw-', '');
      } else if (channelId.includes('/')) {
        numericId = channelId.split('/').pop().split('.')[0];
      }
      
      // Check if this channel ID is in our map
      if (channelIds.has(numericId)) {
        channels.push({ id: numericId, xml: fullChannelElement });
      }
    }
    
    // Extract all programme elements for our channels
    const programmeMatches = xmlContent.matchAll(/<programme[^>]*channel="([^"]*)"[^>]*>([\s\S]*?)<\/programme>/g);
    
    for (const match of programmeMatches) {
      const channelId = match[1];
      const fullProgrammeElement = match[0];
      
      // Extract the numerical ID using same logic
      let numericId = channelId;
      
      if (channelId.includes('epg.pw')) {
        numericId = channelId.split('/').pop().split('.')[0].replace('epg.pw-', '');
      } else if (channelId.includes('/')) {
        numericId = channelId.split('/').pop().split('.')[0];
      }
      
      // Only include programmes for our channels
      if (channelIds.has(numericId)) {
        programmes.push({ id: numericId, xml: fullProgrammeElement });
      }
    }
    
    console.log(`✅ ${source} matched: ${channels.length} channels, ${programmes.length} programmes`);
    
  } catch (parseError) {
    console.error(`❌ Error filtering ${source} XMLTV:`, parseError.message);
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
 * @param {Array<Object>} channels - Array of channel objects with id and xml
 * @param {Array<Object>} programmes - Array of programme objects with id and xml
 * @param {Map} channelIdMap - Map of EPG.PW IDs to tvg-ids
 * @returns {Object} - Updated channels and programmes
 */
function updateChannelIds(channels, programmes, channelIdMap) {
  const updatedChannels = channels.map(({ id, xml }) => {
    const tvgId = channelIdMap.get(id);
    if (tvgId) {
      // Replace the channel ID with the tvg-id
      return xml.replace(/id="[^"]*"/, `id="${tvgId}"`);
    }
    return xml;
  });
  
  const updatedProgrammes = programmes.map(({ id, xml }) => {
    const tvgId = channelIdMap.get(id);
    if (tvgId) {
      // Replace the channel attribute with the tvg-id
      return xml.replace(/channel="[^"]*"/, `channel="${tvgId}"`);
    }
    return xml;
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
  const tvOpen = '<tv source-info-name="EPG.PW" source-info-url="https://epg.pw" generator-info-name="EPG Aggregator" generator-info-url="https://github.com">\n';
  const tvClose = '</tv>';
  
  // Add display-name elements to channels if missing
  const enhancedChannels = channels.map(channel => {
    // Check if channel already has display-name
    if (!channel.includes('<display-name>')) {
      // Extract channel id
      const idMatch = channel.match(/id="([^"]*)"/);
      if (idMatch) {
        const channelId = idMatch[1];
        // Insert display-name before closing tag
        return channel.replace('</channel>', `  <display-name>${channelId}</display-name>\n</channel>`);
      }
    }
    return channel;
  });
  
  return xmlHeader + tvOpen + 
         enhancedChannels.join('\n') + '\n' +
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
  
  // Handle debug endpoint to see channel IDs
  if (req.url === '/debug') {
    res.setHeader('Content-Type', 'application/json');
    try {
      const channelIdMap = buildChannelIdMap();
      const epgChannelIds = Array.from(new Set(channelIdMap.keys()));
      
      // Fetch a small sample from US EPG
      const usResponse = await fetch('https://epg.pw/xmltv/epg_US.xml');
      const usXml = await usResponse.text();
      
      // Extract first 10 channel IDs from the XML
      const sampleChannelIds = [];
      const matches = usXml.matchAll(/<channel[^>]*id="([^"]*)"/g);
      let count = 0;
      for (const match of matches) {
        if (count++ < 10) sampleChannelIds.push(match[1]);
        else break;
      }
      
      return res.status(200).json({
        ourChannelIds: epgChannelIds.slice(0, 10),
        sampleEPGChannelIds: sampleChannelIds,
        totalInMap: channelIdMap.size
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
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
      const usFiltered = filterXMLTV(usXml, epgChannelIds, 'US');
      console.log(`📺 Found ${usFiltered.channels.length} US channels, ${usFiltered.programmes.length} programmes`);
      allChannels.push(...usFiltered.channels);
      allProgrammes.push(...usFiltered.programmes);
    } else {
      console.warn('⚠️ Failed to fetch US XMLTV');
    }
    
    // Process Canadian XMLTV
    if (caResponse.ok) {
      const caXml = await caResponse.text();
      const caFiltered = filterXMLTV(caXml, epgChannelIds, 'CA');
      console.log(`📺 Found ${caFiltered.channels.length} Canadian channels, ${caFiltered.programmes.length} programmes`);
      allChannels.push(...caFiltered.channels);
      allProgrammes.push(...caFiltered.programmes);
    } else {
      console.warn('⚠️ Failed to fetch Canadian XMLTV');
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
    
    // Debug: Log first few channel IDs
    if (updatedChannels.length > 0) {
      const firstChannelId = updatedChannels[0].match(/id="([^"]*)"/)?.[1];
      console.log(`📝 Sample channel ID: ${firstChannelId}`);
    }
    
    // Build final XMLTV document
    console.log('🔄 Building final XMLTV document...');
    const finalXMLTV = buildXMLTV(updatedChannels, updatedProgrammes);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ XMLTV generation complete in ${duration}s`);
    console.log(`📊 Final: ${updatedChannels.length} channels, ${updatedProgrammes.length} programmes`);
    console.log(`📊 Document size: ${(finalXMLTV.length / 1024 / 1024).toFixed(2)} MB`);
    
    // Debug: Show channel list
    const channelIds = updatedChannels
      .map(ch => ch.match(/id="([^"]*)"/)?.[1])
      .filter(Boolean)
      .slice(0, 10);
    console.log(`📋 First 10 channel IDs: ${channelIds.join(', ')}`);
    
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
