// index_progressive.js - ULTRA-SAFE FOR VERCEL HOBBY (10s timeout)
import fetch from 'node-fetch';
import { CHANNEL_MAP } from './utils/channelMap.js';
import { convertToXMLTV, validateXMLTV, getStatistics, formatSize } from './utils/convert.js';

// CONSERVATIVE CONFIGURATION FOR HOBBY PLAN
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'dea6ce3893227222ef38c383336d893f';
const GROQ_API_KEY = null; // DISABLED - too slow for hobby plan
const FULL_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
const PARTIAL_CACHE_DURATION = 3 * 60 * 1000; // 3 minutes (reduced)
const MAX_EXECUTION_TIME = 5000; // 5 seconds (very conservative for 10s limit)
const BATCH_SIZE = 5; // Reduced from 8
const CHANNELS_PER_CHUNK = 15; // Reduced from 30
const FETCH_TIMEOUT = 4000; // 4s per channel fetch (reduced from 6s)

// Multi-tier cache
let fullCache = {
  data: null,
  timestamp: null,
  channelCount: 0,
  programmeCount: 0
};

let partialCache = {
  data: null,
  timestamp: null,
  channelCount: 0,
  programmeCount: 0
};

// Channel-level cache
const channelCache = new Map();

/**
 * Fetches EPG data with aggressive timeout
 */
async function fetchChannelEPG(tvgId, epgId) {
  const url = `https://epg.pw/api/epg.xml?channel_id=${epgId}`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    if (!response.ok) return null;
    
    const xml = await response.text();
    if (!xml.includes('<tv')) return null;
    
    return { tvgId, xml };
  } catch (error) {
    return null;
  }
}

/**
 * Extracts programmes from XML
 */
function extractProgrammes(xml, channelId) {
  const programmes = [];
  const regex = /<programme[^>]*start="([^"]*)"[^>]*stop="([^"]*)"[^>]*>([\s\S]*?)<\/programme>/g;
  
  let match;
  let count = 0;
  const MAX_PROGRAMMES = 50; // Limit programmes per channel to speed up processing
  
  while ((match = regex.exec(xml)) !== null && count < MAX_PROGRAMMES) {
    const start = match[1];
    const stop = match[2];
    const content = match[3];
    
    const titleMatch = content.match(/<title[^>]*>([^<]*)<\/title>/);
    const descMatch = content.match(/<desc[^>]*>([^<]*)<\/desc>/);
    
    programmes.push({
      channelId,
      start,
      stop,
      title: titleMatch ? titleMatch[1].trim() : 'Unknown',
      description: descMatch ? descMatch[1].trim() : ''
    });
    
    count++;
  }
  
  return programmes;
}

/**
 * Loads channels progressively with strict time limits
 */
async function loadChannelsProgressively(startTime, maxTime) {
  const channelsToFetch = Object.entries(CHANNEL_MAP)
    .filter(([_, epgId]) => epgId !== null && epgId !== '');
  
  console.log(`📡 Total channels: ${channelsToFetch.length}, Max time: ${maxTime}ms`);
  
  const allResults = [];
  const now = Date.now();
  
  // Use cached channels first (very fast)
  let channelsFromCache = 0;
  for (const [tvgId, epgId] of channelsToFetch) {
    const cached = channelCache.get(tvgId);
    if (cached && (now - cached.timestamp < 60 * 60 * 1000)) {
      allResults.push({ tvgId, xml: cached.xml, fromCache: true });
      channelsFromCache++;
      
      // Early exit if running out of time
      if (Date.now() - startTime > maxTime * 0.3) {
        console.log(`⏱️ Already at 30% time with ${channelsFromCache} cached channels, stopping cache load`);
        break;
      }
    }
  }
  
  console.log(`✓ Loaded ${channelsFromCache} channels from cache`);
  
  // Fetch remaining channels
  const remainingChannels = channelsToFetch.filter(([tvgId]) => 
    !allResults.some(r => r.tvgId === tvgId)
  );
  
  let totalFetched = 0;
  
  // Process in small chunks with strict time monitoring
  for (let i = 0; i < remainingChannels.length; i += CHANNELS_PER_CHUNK) {
    const elapsed = Date.now() - startTime;
    
    // Stop at 70% of time limit (very conservative)
    if (elapsed > maxTime * 0.7) {
      console.log(`⏱️ Reached 70% time limit (${elapsed}ms), stopping with ${allResults.length} channels`);
      break;
    }
    
    const chunk = remainingChannels.slice(i, i + CHANNELS_PER_CHUNK);
    const chunkNum = Math.floor(i / CHANNELS_PER_CHUNK) + 1;
    
    // Fetch chunk in batches
    for (let j = 0; j < chunk.length; j += BATCH_SIZE) {
      const batch = chunk.slice(j, j + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(([tvgId, epgId]) => fetchChannelEPG(tvgId, epgId))
      );
      
      // Cache and collect results
      for (const result of results) {
        if (result) {
          channelCache.set(result.tvgId, {
            xml: result.xml,
            timestamp: now
          });
          allResults.push(result);
          totalFetched++;
        }
      }
      
      // Check time after each batch
      const batchElapsed = Date.now() - startTime;
      if (batchElapsed > maxTime * 0.7) {
        console.log(`⏱️ Time limit reached mid-chunk, stopping`);
        break;
      }
    }
    
    console.log(`✓ Chunk ${chunkNum}: ${totalFetched} new channels (${allResults.length} total, ${Date.now() - startTime}ms elapsed)`);
  }
  
  console.log(`✅ Final: ${allResults.length} channels (${channelsFromCache} cached, ${totalFetched} fresh)`);
  return allResults;
}

/**
 * Main handler
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Health check
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('OK - Progressive EPG (Hobby Plan Optimized)');
  }
  
  // Status
  if (req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    const fullCacheAge = fullCache.timestamp ? Math.floor((Date.now() - fullCache.timestamp) / 1000) : null;
    const partialCacheAge = partialCache.timestamp ? Math.floor((Date.now() - partialCache.timestamp) / 1000) : null;
    
    return res.status(200).json({
      version: 'hobby-optimized-v1',
      plan: 'vercel-hobby',
      fullCache: {
        available: !!fullCache.data,
        age: fullCacheAge ? `${fullCacheAge}s` : 'none',
        channels: fullCache.channelCount,
        programmes: fullCache.programmeCount,
        nextRefresh: fullCache.timestamp ? `${Math.max(0, 1800 - fullCacheAge)}s` : 'now'
      },
      partialCache: {
        available: !!partialCache.data,
        age: partialCacheAge ? `${partialCacheAge}s` : 'none',
        channels: partialCache.channelCount,
        programmes: partialCache.programmeCount
      },
      channelCache: {
        entries: channelCache.size
      },
      config: {
        maxExecutionTime: `${MAX_EXECUTION_TIME}ms`,
        channelsPerChunk: CHANNELS_PER_CHUNK,
        batchSize: BATCH_SIZE,
        fetchTimeout: `${FETCH_TIMEOUT}ms`,
        totalChannels: Object.keys(CHANNEL_MAP).length,
        validChannels: Object.values(CHANNEL_MAP).filter(id => id !== null && id !== '').length
      }
    });
  }
  
  // Clear caches
  if (req.url === '/refresh') {
    fullCache.data = null;
    fullCache.timestamp = null;
    partialCache.data = null;
    partialCache.timestamp = null;
    channelCache.clear();
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('All caches cleared');
  }
  
  // Main EPG endpoint
  try {
    const startTime = Date.now();
    const now = Date.now();
    
    // Serve from full cache
    if (fullCache.data && fullCache.timestamp && (now - fullCache.timestamp < FULL_CACHE_DURATION)) {
      console.log('✅ Serving FULL cache');
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('X-Cache', 'HIT-FULL');
      res.setHeader('X-Cache-Age', `${Math.floor((now - fullCache.timestamp) / 1000)}s`);
      res.setHeader('X-Channel-Count', fullCache.channelCount.toString());
      res.setHeader('X-Programme-Count', fullCache.programmeCount.toString());
      return res.status(200).send(fullCache.data);
    }
    
    // Serve from partial cache
    if (partialCache.data && partialCache.timestamp && (now - partialCache.timestamp < PARTIAL_CACHE_DURATION)) {
      console.log('✅ Serving PARTIAL cache');
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('X-Cache', 'HIT-PARTIAL');
      res.setHeader('X-Cache-Age', `${Math.floor((now - partialCache.timestamp) / 1000)}s`);
      res.setHeader('X-Channel-Count', partialCache.channelCount.toString());
      res.setHeader('X-Programme-Count', partialCache.programmeCount.toString());
      return res.status(200).send(partialCache.data);
    }
    
    // Generate new data
    console.log('🔄 Generating EPG data (Hobby plan mode)...');
    
    // Load channels with strict time limit
    const channelResults = await loadChannelsProgressively(startTime, MAX_EXECUTION_TIME);
    
    if (channelResults.length === 0) {
      throw new Error('No EPG data available');
    }
    
    // Extract programmes
    let allProgrammes = [];
    const extractStart = Date.now();
    
    for (const result of channelResults) {
      // Check time during extraction too
      if (Date.now() - startTime > MAX_EXECUTION_TIME * 0.85) {
        console.log(`⏱️ Time limit during extraction, stopping at ${allProgrammes.length} programmes`);
        break;
      }
      
      const progs = extractProgrammes(result.xml, result.tvgId);
      allProgrammes.push(...progs);
    }
    
    console.log(`📺 Extracted ${allProgrammes.length} programmes in ${Date.now() - extractStart}ms`);
    
    if (allProgrammes.length === 0) {
      throw new Error('No programmes extracted');
    }
    
    // Convert to XMLTV (fast operation)
    const xmltv = convertToXMLTV(allProgrammes, {
      generatorName: 'Progressive EPG (Hobby Optimized)',
      generatorUrl: 'https://github.com',
      sourceInfo: 'EPG.PW'
    });
    
    const stats = getStatistics(allProgrammes);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const size = formatSize(xmltv.length);
    
    // Determine cache type
    const totalValidChannels = Object.values(CHANNEL_MAP).filter(id => id !== null && id !== '').length;
    const isFullBuild = channelResults.length >= totalValidChannels * 0.85; // 85% = full
    
    if (isFullBuild) {
      fullCache.data = xmltv;
      fullCache.timestamp = Date.now();
      fullCache.channelCount = stats.channels;
      fullCache.programmeCount = stats.total;
      
      console.log(`✅ FULL cache built: ${stats.channels} channels, ${stats.total} programmes, ${duration}s, ${size}`);
      
      res.setHeader('X-Cache', 'MISS-FULL');
      res.setHeader('X-Build-Type', 'full');
    } else {
      partialCache.data = xmltv;
      partialCache.timestamp = Date.now();
      partialCache.channelCount = stats.channels;
      partialCache.programmeCount = stats.total;
      
      console.log(`✅ PARTIAL cache built: ${stats.channels}/${totalValidChannels} channels, ${stats.total} programmes, ${duration}s, ${size}`);
      
      res.setHeader('X-Cache', 'MISS-PARTIAL');
      res.setHeader('X-Build-Type', 'partial');
      res.setHeader('X-Warning', `Partial: ${stats.channels}/${totalValidChannels} channels`);
    }
    
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('X-Generation-Time', duration);
    res.setHeader('X-Programme-Count', stats.total.toString());
    res.setHeader('X-Channel-Count', stats.channels.toString());
    res.status(200).send(xmltv);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
    
    // Return a minimal response instead of crashing
    const errorXml = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="Progressive EPG Error Handler">
  <channel id="error">
    <display-name>Service Error</display-name>
  </channel>
  <programme start="20260129000000 +0000" stop="20260130000000 +0000" channel="error">
    <title>EPG Service Error</title>
    <desc>Error: ${error.message}. Check logs for details.</desc>
  </programme>
</tv>`;
    
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('X-Error', error.message);
    res.status(200).send(errorXml); // Return 200 with error XML instead of 500
  }
}
