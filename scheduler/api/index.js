// api/index.js
import fetch from 'node-fetch';
import { CHANNEL_MAP } from '../utils/channelMap.js';
import { convertToXMLTV, validateXMLTV, getStatistics, formatSize } from '../utils/convert.js';

// Configuration
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'dea6ce3893227222ef38c383336d893f';
const GROQ_API_KEY = process.env.GROQ_API_KEY || null;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// In-memory cache
let cachedData = null;
let cacheTimestamp = null;

/**
 * Fetches EPG data from epg.pw
 */
async function fetchChannelEPG(tvgId, epgId) {
  const url = `https://epg.pw/api/epg.xml?channel_id=${epgId}`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    
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
 * Uses Groq AI to identify series and episodes
 */
async function analyzeWithAI(programmes) {
  if (!GROQ_API_KEY || programmes.length === 0) {
    console.log('⚠️ No Groq API key or no programmes');
    return [];
  }
  
  try {
    const programmeSummary = programmes.map((p, i) => ({
      index: i,
      title: p.title,
      desc: p.description.substring(0, 200)
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

    console.log(`🤖 Sending ${programmes.length} programmes to Groq AI...`);
    
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
        max_tokens: 8000
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Groq API error:', response.status, errorText);
      return [];
    }
    
    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    
    console.log('📝 AI Response preview:', content.substring(0, 200));
    
    // Extract JSON from response
    let jsonStr = content;
    if (content.includes('```json')) {
      jsonStr = content.split('```json')[1].split('```')[0].trim();
    } else if (content.includes('```')) {
      jsonStr = content.split('```')[1].split('```')[0].trim();
    }
    
    const results = JSON.parse(jsonStr);
    console.log(`✅ AI identified ${results.filter(r => r.isSeries).length} series episodes out of ${results.length} programmes`);
    
    return results;
    
  } catch (error) {
    console.error('❌ AI analysis error:', error.message);
    return [];
  }
}

/**
 * Enriches with TMDB metadata
 */
async function enrichWithTMDB(programme, aiResult) {
  if (!TMDB_API_KEY || !aiResult.isSeries) return programme;
  
  try {
    // Search TMDB
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
    
    // Get episode details if we have season/episode
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
 * Main handler
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Health check
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('OK');
  }
  
  // Status
  if (req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    const cacheAge = cacheTimestamp ? Math.floor((Date.now() - cacheTimestamp) / 1000) : null;
    return res.status(200).json({
      cached: !!cachedData,
      cacheAge: cacheAge ? `${cacheAge}s` : 'none',
      nextRefresh: cacheTimestamp ? `${Math.max(0, 1800 - cacheAge)}s` : 'now',
      groqEnabled: !!GROQ_API_KEY,
      tmdbEnabled: !!TMDB_API_KEY
    });
  }
  
  // Clear cache
  if (req.url === '/refresh') {
    cachedData = null;
    cacheTimestamp = null;
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('Cache cleared');
  }
  
  // Check cache
  if (cachedData && cacheTimestamp && (Date.now() - cacheTimestamp < CACHE_DURATION)) {
    console.log('✅ Serving from cache');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).send(cachedData);
  }
  
  // Generate new data
  try {
    console.log('🔄 Generating fresh EPG data...');
    const startTime = Date.now();
    
    const channelsToFetch = Object.entries(CHANNEL_MAP)
      .filter(([_, epgId]) => epgId !== null)
      .slice(0, 10); // LIMIT TO 10 CHANNELS FOR TESTING - REMOVE THIS LINE WHEN READY
    
    console.log(`📡 Fetching ${channelsToFetch.length} channels...`);
    
    // Fetch EPG data in batches
    const BATCH_SIZE = 5;
    const allResults = [];
    
    for (let i = 0; i < channelsToFetch.length; i += BATCH_SIZE) {
      const batch = channelsToFetch.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(([tvgId, epgId]) => fetchChannelEPG(tvgId, epgId))
      );
      allResults.push(...results.filter(r => r !== null));
      console.log(`✓ Fetched batch ${Math.floor(i / BATCH_SIZE) + 1}`);
    }
    
    console.log(`✅ Got ${allResults.length} channels with data`);
    
    if (allResults.length === 0) {
      throw new Error('No EPG data available from any channel');
    }
    
    // Extract all programmes
    let allProgrammes = [];
    for (const result of allResults) {
      const progs = extractProgrammes(result.xml, result.tvgId);
      allProgrammes.push(...progs.slice(0, 20)); // LIMIT: 20 programmes per channel - REMOVE THIS WHEN READY
    }
    
    console.log(`📺 Total programmes: ${allProgrammes.length}`);
    
    if (allProgrammes.length === 0) {
      throw new Error('No programmes extracted from EPG data');
    }
    
    // AI analysis (process in batches of 50)
    if (GROQ_API_KEY && allProgrammes.length > 0) {
      console.log('🤖 Starting AI analysis...');
      const AI_BATCH_SIZE = 50;
      let allAiResults = [];
      
      for (let i = 0; i < allProgrammes.length; i += AI_BATCH_SIZE) {
        const batch = allProgrammes.slice(i, i + AI_BATCH_SIZE);
        const aiResults = await analyzeWithAI(batch);
        allAiResults.push(...aiResults);
        console.log(`✓ AI processed ${Math.min(i + AI_BATCH_SIZE, allProgrammes.length)}/${allProgrammes.length} programmes`);
      }
      
      console.log('🎬 Enriching with TMDB data...');
      
      // Enrich with TMDB
      let enrichedCount = 0;
      for (let i = 0; i < allProgrammes.length && i < allAiResults.length; i++) {
        if (allAiResults[i] && allAiResults[i].isSeries) {
          await enrichWithTMDB(allProgrammes[i], allAiResults[i]);
          if (allProgrammes[i].tmdb && allProgrammes[i].tmdb.episodeName) {
            enrichedCount++;
          }
        }
      }
      
      console.log(`✅ Enriched ${enrichedCount} programmes with TMDB data`);
    } else {
      console.log('⚠️ Skipping AI analysis (no API key)');
    }
    
    // Convert to XMLTV using the conversion utility
    console.log('📝 Converting to XMLTV format...');
    const xmltv = convertToXMLTV(allProgrammes, {
      generatorName: 'AI-Enhanced EPG Aggregator',
      generatorUrl: 'https://github.com',
      sourceInfo: 'EPG.PW'
    });
    
    // Validate the output
    const validation = validateXMLTV(xmltv);
    console.log('✓ Validation:', validation.valid ? 'PASSED' : 'FAILED');
    console.log('📊 XMLTV Stats:', validation.stats);
    
    if (validation.errors.length > 0) {
      console.warn('⚠️ Validation errors:', validation.errors);
    }
    
    if (validation.warnings.length > 0) {
      console.warn('⚠️ Validation warnings:', validation.warnings);
    }
    
    // Get detailed statistics
    const stats = getStatistics(allProgrammes);
    console.log('📈 Programme Statistics:', {
      total: stats.total,
      enriched: stats.enriched,
      enrichmentRate: stats.enrichmentRate,
      channels: stats.channels,
      dateRange: stats.dateRange
    });
    
    // Cache it
    cachedData = xmltv;
    cacheTimestamp = Date.now();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const size = formatSize(xmltv.length);
    console.log(`✅ Generation complete in ${duration}s - Output size: ${size}`);
    
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Generation-Time', duration);
    res.setHeader('X-Programme-Count', stats.total.toString());
    res.setHeader('X-Enriched-Count', stats.enriched.toString());
    res.status(200).send(xmltv);
    
  } catch (error) {
    console.error('❌ Fatal Error:', error.message);
    console.error('Stack trace:', error.stack);
    
    res.setHeader('Content-Type', 'text/plain');
    res.status(500).send(`Error generating XMLTV: ${error.message}\n\nCheck Vercel logs for details.`);
  }
}
