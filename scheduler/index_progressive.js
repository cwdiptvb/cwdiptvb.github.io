// api/index.js - ENHANCED WITH PROGRESSIVE LOADING & MULTI-TIER CACHING
import fetch from 'node-fetch';
import { CHANNEL_MAP } from '../utils/channelMap.js';
import { convertToXMLTV, validateXMLTV, getStatistics, formatSize } from '../utils/convert.js';

// Configuration
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'dea6ce3893227222ef38c383336d893f';
const GROQ_API_KEY = process.env.GROQ_API_KEY || null;
const FULL_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes for complete data
const PARTIAL_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes for partial data
const MAX_EXECUTION_TIME = 8000; // 8 seconds (safe for Vercel hobby)
const BATCH_SIZE = 8;
const CHANNELS_PER_CHUNK = 30; // Process 30 channels at a time

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
  programmeCount: 0,
  isPartial: true
};

// Channel-level cache (persistent across requests)
const channelCache = new Map(); // channelId -> { xml, timestamp, programmes }

/**
 * Fetches EPG data from epg.pw with timeout
 */
async function fetchChannelEPG(tvgId, epgId) {
  const url = `https://epg.pw/api/epg.xml?channel_id=${epgId}`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000); // 6s timeout
    
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
  while ((match = regex.exec(xml)) !== null) {
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
  }
  
  return programmes;
}

/**
 * Uses Groq AI to identify series and episodes (simplified for speed)
 */
async function analyzeWithAI(programmes) {
  if (!GROQ_API_KEY || programmes.length === 0) {
    return [];
  }
  
  try {
    const programmeSummary = programmes.map((p, i) => ({
      index: i,
      title: p.title,
      desc: p.description.substring(0, 150)
    }));
    
    const prompt = `Analyze these TV programme listings and identify TV SERIES episodes (scripted shows like dramas, comedies, etc).

TV Listings:
${JSON.stringify(programmeSummary, null, 2)}

For EACH listing (all ${programmeSummary.length}), respond with:
{
  "index": <number>,
  "isSeries": <boolean - true ONLY for scripted TV series, NOT for news/sports/talk shows>,
  "showName": "<clean show name>",
  "season": <number or null>,
  "episode": <number or null>
}

Examples:
- "Breaking Bad" or "Breaking Bad S01E05" → isSeries: true
- "Friends - The One With..." → isSeries: true
- "CNN Tonight" or "NBC Nightly News" → isSeries: false (news)
- "SportsCenter" or "NFL Football" → isSeries: false (sports)
- "The Tonight Show" → isSeries: false (talk show)

Look for S##E## patterns, "Season X Episode Y", or episode titles in descriptions.
Respond with ONLY a JSON array, no other text.`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',
        messages: [{
          role: 'system',
          content: 'You are a TV listing analyzer. Only mark scripted TV series as isSeries:true. News, sports, and talk shows should be isSeries:false. Always respond with valid JSON only.'
        }, {
          role: 'user',
          content: prompt
        }],
        temperature: 0.1,
        max_tokens: 4000
      })
    });
    
    if (!response.ok) return [];
    
    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    
    let jsonStr = content;
    if (content.includes('```json')) {
      jsonStr = content.split('```json')[1].split('```')[0].trim();
    } else if (content.includes('```')) {
      jsonStr = content.split('```')[1].split('```')[0].trim();
    }
    
    const results = JSON.parse(jsonStr);
    return results;
    
  } catch (error) {
    return [];
  }
}

/**
 * Enriches with TMDB metadata (simplified)
 */
async function enrichWithTMDB(programme, aiResult) {
  if (!TMDB_API_KEY || !aiResult.isSeries) return programme;
  
  try {
    const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(aiResult.showName)}`;
    const searchRes = await fetch(searchUrl, { timeout: 3000 });
    
    if (!searchRes.ok) return programme;
    
    const searchData = await searchRes.json();
    const show = searchData.results?.[0];
    
    if (!show) return programme;
    
    programme.tmdb = {
      showId: show.id,
      showName: show.name,
      seriesPoster: show.poster_path ? `https://image.tmdb.org/t/p/w500${show.poster_path}` : null
    };
    
    if (aiResult.season && aiResult.episode) {
      const episodeUrl = `https://api.themoviedb.org/3/tv/${show.id}/season/${aiResult.season}/episode/${aiResult.episode}?api_key=${TMDB_API_KEY}`;
      const episodeRes = await fetch(episodeUrl, { timeout: 3000 });
      
      if (episodeRes.ok) {
        const episodeData = await episodeRes.json();
        
        programme.tmdb.season = aiResult.season;
        programme.tmdb.episode = aiResult.episode;
        programme.tmdb.episodeName = episodeData.name;
        programme.tmdb.overview = episodeData.overview;
        programme.tmdb.episodeThumbnail = episodeData.still_path ? `https://image.tmdb.org/t/p/w500${episodeData.still_path}` : null;
      }
    }
    
    return programme;
    
  } catch (error) {
    return programme;
  }
}

/**
 * Loads channels progressively with time limit
 */
async function loadChannelsProgressively(startTime, maxTime) {
  const channelsToFetch = Object.entries(CHANNEL_MAP)
    .filter(([_, epgId]) => epgId !== null && epgId !== '');
  
  console.log(`📡 Total channels available: ${channelsToFetch.length}`);
  
  const allResults = [];
  const now = Date.now();
  
  // First, try to use cached channel data
  let channelsFromCache = 0;
  for (const [tvgId, epgId] of channelsToFetch) {
    const cached = channelCache.get(tvgId);
    if (cached && (now - cached.timestamp < 60 * 60 * 1000)) { // 1 hour cache
      allResults.push({ tvgId, xml: cached.xml, fromCache: true });
      channelsFromCache++;
      
      // Stop if we're running out of time
      if (Date.now() - startTime > maxTime * 0.8) break;
    }
  }
  
  console.log(`✓ Loaded ${channelsFromCache} channels from cache`);
  
  // Fetch remaining channels in chunks until time runs out
  const remainingChannels = channelsToFetch.filter(([tvgId]) => 
    !allResults.some(r => r.tvgId === tvgId)
  );
  
  let processedChunks = 0;
  let totalFetched = 0;
  
  for (let i = 0; i < remainingChannels.length; i += CHANNELS_PER_CHUNK) {
    // Check if we have time left
    const elapsed = Date.now() - startTime;
    if (elapsed > maxTime * 0.85) {
      console.log(`⏱️ Time limit approaching (${elapsed}ms), stopping at ${allResults.length} channels`);
      break;
    }
    
    const chunk = remainingChannels.slice(i, i + CHANNELS_PER_CHUNK);
    console.log(`📥 Fetching chunk ${processedChunks + 1} (${chunk.length} channels)...`);
    
    // Fetch this chunk in smaller batches
    for (let j = 0; j < chunk.length; j += BATCH_SIZE) {
      const batch = chunk.slice(j, j + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(([tvgId, epgId]) => fetchChannelEPG(tvgId, epgId))
      );
      
      // Cache successful fetches
      for (const result of results) {
        if (result) {
          channelCache.set(result.tvgId, {
            xml: result.xml,
            timestamp: now,
            programmes: null // Will be populated if needed
          });
          allResults.push(result);
          totalFetched++;
        }
      }
    }
    
    processedChunks++;
    console.log(`✓ Chunk ${processedChunks} complete (${totalFetched} new, ${allResults.length} total)`);
  }
  
  console.log(`✅ Loaded ${allResults.length} channels (${channelsFromCache} cached, ${totalFetched} fresh)`);
  return allResults;
}

/**
 * Main handler with progressive loading
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Health check
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('OK');
  }
  
  // Status endpoint
  if (req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    const fullCacheAge = fullCache.timestamp ? Math.floor((Date.now() - fullCache.timestamp) / 1000) : null;
    const partialCacheAge = partialCache.timestamp ? Math.floor((Date.now() - partialCache.timestamp) / 1000) : null;
    
    return res.status(200).json({
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
      channelLevelCache: {
        entries: channelCache.size,
        maxAge: '1 hour'
      },
      config: {
        groqEnabled: !!GROQ_API_KEY,
        tmdbEnabled: !!TMDB_API_KEY,
        totalChannels: Object.keys(CHANNEL_MAP).length,
        validChannels: Object.values(CHANNEL_MAP).filter(id => id !== null && id !== '').length,
        maxExecutionTime: `${MAX_EXECUTION_TIME}ms`,
        channelsPerChunk: CHANNELS_PER_CHUNK
      }
    });
  }
  
  // Clear all caches
  if (req.url === '/refresh') {
    fullCache.data = null;
    fullCache.timestamp = null;
    partialCache.data = null;
    partialCache.timestamp = null;
    channelCache.clear();
    
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('All caches cleared');
  }
  
  // Clear only partial cache (force full rebuild on next request)
  if (req.url === '/refresh-partial') {
    partialCache.data = null;
    partialCache.timestamp = null;
    
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('Partial cache cleared');
  }
  
  // Main EPG endpoint
  try {
    const startTime = Date.now();
    const now = Date.now();
    
    // Try full cache first (best quality, complete data)
    if (fullCache.data && fullCache.timestamp && (now - fullCache.timestamp < FULL_CACHE_DURATION)) {
      console.log('✅ Serving FULL cache');
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('X-Cache', 'HIT-FULL');
      res.setHeader('X-Cache-Age', `${Math.floor((now - fullCache.timestamp) / 1000)}s`);
      res.setHeader('X-Channel-Count', fullCache.channelCount.toString());
      res.setHeader('X-Programme-Count', fullCache.programmeCount.toString());
      return res.status(200).send(fullCache.data);
    }
    
    // Try partial cache (faster response for recent data)
    if (partialCache.data && partialCache.timestamp && (now - partialCache.timestamp < PARTIAL_CACHE_DURATION)) {
      console.log('✅ Serving PARTIAL cache (full cache rebuilding in background)');
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('X-Cache', 'HIT-PARTIAL');
      res.setHeader('X-Cache-Age', `${Math.floor((now - partialCache.timestamp) / 1000)}s`);
      res.setHeader('X-Channel-Count', partialCache.channelCount.toString());
      res.setHeader('X-Programme-Count', partialCache.programmeCount.toString());
      res.setHeader('X-Warning', 'Partial data - full refresh in progress');
      return res.status(200).send(partialCache.data);
    }
    
    // Generate new data with progressive loading
    console.log('🔄 Generating EPG data with progressive loading...');
    
    // Load channels progressively
    const channelResults = await loadChannelsProgressively(startTime, MAX_EXECUTION_TIME);
    
    if (channelResults.length === 0) {
      throw new Error('No EPG data available from any channel');
    }
    
    // Extract all programmes
    let allProgrammes = [];
    for (const result of channelResults) {
      const progs = extractProgrammes(result.xml, result.tvgId);
      allProgrammes.push(...progs);
    }
    
    console.log(`📺 Extracted ${allProgrammes.length} programmes from ${channelResults.length} channels`);
    
    if (allProgrammes.length === 0) {
      throw new Error('No programmes extracted from EPG data');
    }
    
    // AI enrichment (only for entertainment/series channels, skip news/sports)
    const elapsed = Date.now() - startTime;
    let enrichedCount = 0;
    
    if (GROQ_API_KEY && elapsed < MAX_EXECUTION_TIME * 0.7) {
      console.log('🤖 Starting AI analysis (time permitting)...');
      
      // Filter for likely series content (skip news/sports)
      const seriesToEnrich = allProgrammes.filter(p => {
        const title = p.title.toLowerCase();
        const isNews = title.includes('news') || title.includes('cnn') || title.includes('msnbc');
        const isSports = title.includes('sport') || title.includes('nfl') || title.includes('nba');
        return !isNews && !isSports;
      }).slice(0, 100); // Limit to 100 for speed
      
      if (seriesToEnrich.length > 0) {
        const AI_BATCH_SIZE = 30;
        
        for (let i = 0; i < seriesToEnrich.length; i += AI_BATCH_SIZE) {
          // Check time limit
          if (Date.now() - startTime > MAX_EXECUTION_TIME * 0.8) {
            console.log('⏱️ Time limit for AI analysis reached');
            break;
          }
          
          const batch = seriesToEnrich.slice(i, i + AI_BATCH_SIZE);
          const aiResults = await analyzeWithAI(batch);
          
          // Enrich with TMDB
          for (let j = 0; j < batch.length && j < aiResults.length; j++) {
            if (aiResults[j] && aiResults[j].isSeries) {
              await enrichWithTMDB(batch[j], aiResults[j]);
              if (batch[j].tmdb && batch[j].tmdb.episodeName) {
                enrichedCount++;
              }
            }
          }
        }
        
        console.log(`✅ Enriched ${enrichedCount} programmes with TMDB data`);
      }
    } else {
      console.log('⚠️ Skipping AI analysis (no time or API key)');
    }
    
    // Convert to XMLTV
    console.log('📝 Converting to XMLTV format...');
    const xmltv = convertToXMLTV(allProgrammes, {
      generatorName: 'Progressive EPG Aggregator',
      generatorUrl: 'https://github.com',
      sourceInfo: 'EPG.PW'
    });
    
    // Validate
    const validation = validateXMLTV(xmltv);
    const stats = getStatistics(allProgrammes);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const size = formatSize(xmltv.length);
    
    // Determine if this is a full or partial build
    const totalValidChannels = Object.values(CHANNEL_MAP).filter(id => id !== null && id !== '').length;
    const isFullBuild = channelResults.length >= totalValidChannels * 0.9; // 90% or more = full
    
    if (isFullBuild) {
      // Cache as FULL data
      fullCache.data = xmltv;
      fullCache.timestamp = Date.now();
      fullCache.channelCount = stats.channels;
      fullCache.programmeCount = stats.total;
      
      console.log(`✅ FULL build complete in ${duration}s - ${stats.channels} channels, ${stats.total} programmes (${size})`);
      
      res.setHeader('X-Cache', 'MISS-FULL');
      res.setHeader('X-Build-Type', 'full');
    } else {
      // Cache as PARTIAL data
      partialCache.data = xmltv;
      partialCache.timestamp = Date.now();
      partialCache.channelCount = stats.channels;
      partialCache.programmeCount = stats.total;
      
      console.log(`✅ PARTIAL build complete in ${duration}s - ${stats.channels}/${totalValidChannels} channels, ${stats.total} programmes (${size})`);
      console.log(`⏩ ${totalValidChannels - stats.channels} channels pending for full build`);
      
      res.setHeader('X-Cache', 'MISS-PARTIAL');
      res.setHeader('X-Build-Type', 'partial');
      res.setHeader('X-Warning', `Partial data: ${stats.channels}/${totalValidChannels} channels loaded`);
    }
    
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('X-Generation-Time', duration);
    res.setHeader('X-Programme-Count', stats.total.toString());
    res.setHeader('X-Channel-Count', stats.channels.toString());
    res.setHeader('X-Enriched-Count', stats.enriched.toString());
    res.status(200).send(xmltv);
    
  } catch (error) {
    console.error('❌ Fatal Error:', error.message);
    console.error('Stack trace:', error.stack);
    
    res.setHeader('Content-Type', 'text/plain');
    res.status(500).send(`Error generating XMLTV: ${error.message}\n\nCheck Vercel logs for details.`);
  }
}
