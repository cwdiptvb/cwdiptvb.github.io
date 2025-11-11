// api/index.js
import fetch from 'node-fetch';
import { CHANNEL_MAP } from '../utils/channelMap.js';

// Configuration
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'dea6ce3893227222ef38c383336d893f'
const GROQ_API_KEY = process.env.GROQ_API_KEY || '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'; // Free and fast!
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes in milliseconds

// In-memory cache
let cachedXMLTV = null;
let cacheTimestamp = null;

/**
 * Fetches EPG data from epg.pw for a specific channel
 */
async function fetchChannelEPG(tvgId, epgId) {
  const url = `https://epg.pw/api/epg.xml?channel_id=${epgId}`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EPG-Aggregator/1.0)' },
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) return { id: tvgId, xml: null };
    
    const xml = await response.text();
    if (!xml.includes('<tv') || !xml.includes('</tv>')) return { id: tvgId, xml: null };
    
    return { id: tvgId, xml };
  } catch (fetchError) {
    return { id: tvgId, xml: null };
  }
}

/**
 * Extracts programmes from XML and converts to structured data
 */
function extractProgrammes(xml) {
  const programmes = [];
  const programmeMatches = xml.matchAll(/<programme[^>]*start="([^"]*)"[^>]*stop="([^"]*)"[^>]*>([\s\S]*?)<\/programme>/g);
  
  for (const match of programmeMatches) {
    const start = match[1];
    const stop = match[2];
    const content = match[3];
    
    const titleMatch = content.match(/<title[^>]*>([^<]*)<\/title>/);
    const descMatch = content.match(/<desc[^>]*>([^<]*)<\/desc>/);
    
    programmes.push({
      start,
      stop,
      title: titleMatch ? titleMatch[1] : '',
      description: descMatch ? descMatch[1] : ''
    });
  }
  
  return programmes;
}

/**
 * Uses Claude AI to analyze programme and extract episode information
 */
async function enrichWithAI(programmes) {
  if (!GROQ_API_KEY || programmes.length === 0) return programmes;
  
  try {
    // Prepare batch of programmes for AI analysis (max 50 at a time)
    const batch = programmes.slice(0, 50).map(p => ({
      title: p.title,
      description: p.description,
      start: p.start
    }));
    
    const prompt = `Analyze these TV programme listings and extract episode information. For each programme, determine:
1. If it's a TV series episode (not a movie, news, or sports)
2. The show name
3. Season number (if mentioned)
4. Episode number (if mentioned)
5. Episode title (if mentioned)

Programmes:
${JSON.stringify(batch, null, 2)}

Respond with a JSON array containing objects with these fields:
- isSeries: boolean
- showName: string (cleaned show name)
- season: number or null
- episode: number or null
- episodeTitle: string or null

Only include entries where you found episode information. Use context clues from titles and descriptions.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: prompt
        }]
      }),
      timeout: 30000
    });
    
    if (!response.ok) {
      console.warn('⚠️ AI enrichment failed:', response.statusText);
      return programmes;
    }
    
    const data = await response.json();
    const aiResults = JSON.parse(data.content[0].text);
    
    // Merge AI results back into programmes
    aiResults.forEach((result, index) => {
      if (result.isSeries && result.season && result.episode) {
        const prog = programmes[index];
        prog.enriched = {
          showName: result.showName,
          season: result.season,
          episode: result.episode,
          episodeTitle: result.episodeTitle
        };
      }
    });
    
    return programmes;
  } catch (error) {
    console.warn('⚠️ AI enrichment error:', error.message);
    return programmes;
  }
}

/**
 * Searches TMDB for additional metadata
 */
async function enrichWithTMDB(programme) {
  if (!TMDB_API_KEY || !programme.enriched) return programme;
  
  try {
    const { showName } = programme.enriched;
    
    // Search for show
    const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(showName)}`;
    const searchRes = await fetch(searchUrl, { timeout: 3000 });
    
    if (!searchRes.ok) return programme;
    
    const searchData = await searchRes.json();
    const show = searchData.results?.[0];
    const showId = show?.id;
    
    if (!showId) return programme;
    
    // Store series poster
    if (show.poster_path) {
      programme.enriched.seriesPoster = `https://image.tmdb.org/t/p/w500${show.poster_path}`;
    }
    
    // Get episode details
    const { season, episode } = programme.enriched;
    const episodeUrl = `https://api.themoviedb.org/3/tv/${showId}/season/${season}/episode/${episode}?api_key=${TMDB_API_KEY}`;
    const episodeRes = await fetch(episodeUrl, { timeout: 3000 });
    
    if (!episodeRes.ok) return programme;
    
    const episodeData = await episodeRes.json();
    
    programme.enriched.episodeName = episodeData.name;
    programme.enriched.overview = episodeData.overview;
    programme.enriched.airDate = episodeData.air_date;
    
    // Store episode thumbnail (still image from the episode)
    if (episodeData.still_path) {
      programme.enriched.episodeThumbnail = `https://image.tmdb.org/t/p/w500${episodeData.still_path}`;
    }
    
    return programme;
  } catch (error) {
    return programme;
  }
}

/**
 * Builds enriched XMLTV programme element
 */
function buildProgrammeXML(programme, channelId) {
  const { start, stop, title, description, enriched } = programme;
  
  let xml = `  <programme start="${start}" stop="${stop}" channel="${channelId}">\n`;
  
  if (enriched) {
    // Enhanced title with episode name
    const fullTitle = enriched.episodeName 
      ? `${enriched.showName} - ${enriched.episodeName}`
      : title;
    xml += `    <title>${escapeXml(fullTitle)}</title>\n`;
    
    // Sub-title
    if (enriched.episodeName) {
      xml += `    <sub-title>${escapeXml(enriched.episodeName)}</sub-title>\n`;
    }
    
    // Enhanced description
    const enhancedDesc = enriched.overview 
      ? `S${enriched.season}E${enriched.episode}: ${enriched.overview}`
      : description;
    xml += `    <desc>${escapeXml(enhancedDesc)}</desc>\n`;
    
    // Episode number (xmltv_ns format - 0-indexed)
    const episodeNum = `${enriched.season - 1}.${enriched.episode - 1}.`;
    xml += `    <episode-num system="xmltv_ns">${episodeNum}</episode-num>\n`;
    
    // OnScreen format (S01E05)
    const onScreen = `S${String(enriched.season).padStart(2, '0')}E${String(enriched.episode).padStart(2, '0')}`;
    xml += `    <episode-num system="onscreen">${onScreen}</episode-num>\n`;
    
    // Episode thumbnail (still image from the episode)
    if (enriched.episodeThumbnail) {
      xml += `    <icon src="${enriched.episodeThumbnail}" />\n`;
    }
    
    // Series poster/thumbnail
    if (enriched.seriesPoster) {
      xml += `    <image src="${enriched.seriesPoster}" />\n`;
    }
    
    // Category
    xml += `    <category>series</category>\n`;
  } else {
    // Standard programme without enrichment
    xml += `    <title>${escapeXml(title)}</title>\n`;
    if (description) {
      xml += `    <desc>${escapeXml(description)}</desc>\n`;
    }
  }
  
  xml += `  </programme>\n`;
  
  return xml;
}

/**
 * Escapes XML special characters
 */
function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Main handler function
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  
  // Health check
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('Service is healthy');
  }
  
  // Status endpoint
  if (req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    const cacheAge = cacheTimestamp ? Math.floor((Date.now() - cacheTimestamp) / 1000) : null;
    return res.status(200).json({
      cached: !!cachedXMLTV,
      cacheAge: cacheAge ? `${cacheAge}s ago` : 'no cache',
      nextRefresh: cacheTimestamp ? `${Math.max(0, 1800 - cacheAge)}s` : 'now',
      aiEnabled: !!ANTHROPIC_API_KEY,
      tmdbEnabled: !!TMDB_API_KEY
    });
  }
  
  // Force refresh endpoint
  if (req.url === '/refresh') {
    cacheTimestamp = null;
    cachedXMLTV = null;
    return res.status(200).send('Cache cleared, next request will regenerate');
  }
  
  // Check cache
  if (cachedXMLTV && cacheTimestamp && (Date.now() - cacheTimestamp < CACHE_DURATION)) {
    const cacheAge = Math.floor((Date.now() - cacheTimestamp) / 1000);
    console.log(`✅ Serving from cache (age: ${cacheAge}s)`);
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-Age', cacheAge.toString());
    return res.status(200).send(cachedXMLTV);
  }
  
  // Generate new XMLTV
  try {
    console.log('🔄 Generating fresh XMLTV (cache miss or expired)...');
    const startTime = Date.now();
    
    const channelsToFetch = Object.entries(CHANNEL_MAP)
      .filter(([_, epgId]) => epgId !== null);
    
    console.log(`📡 Fetching ${channelsToFetch.length} channels from EPG.PW...`);
    
    // Fetch all channels in batches
    const BATCH_SIZE = 20;
    const allChannelsData = [];
    
    for (let i = 0; i < channelsToFetch.length; i += BATCH_SIZE) {
      const batch = channelsToFetch.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(([tvgId, epgId]) => fetchChannelEPG(tvgId, epgId))
      );
      allChannelsData.push(...results.filter(r => r.xml));
      console.log(`✓ Fetched ${Math.min(i + BATCH_SIZE, channelsToFetch.length)}/${channelsToFetch.length}`);
    }
    
    console.log(`✅ Retrieved ${allChannelsData.length} channels with data`);
    
    // Build XMLTV
    let xmltv = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xmltv += '<tv source-info-name="EPG.PW" generator-info-name="AI-Enhanced EPG Aggregator">\n';
    
    // Add channels
    for (const channelData of allChannelsData) {
      const channelMatch = channelData.xml.match(/<channel[^>]*>([\s\S]*?)<\/channel>/);
      if (channelMatch) {
        xmltv += `  <channel id="${channelData.id}">\n`;
        xmltv += `    <display-name>${channelData.id}</display-name>\n`;
        xmltv += `  </channel>\n`;
      }
    }
    
    // Process programmes with AI enrichment
    console.log('🤖 Enriching programmes with AI...');
    let totalProgrammes = 0;
    let enrichedCount = 0;
    
    for (const channelData of allChannelsData) {
      let programmes = extractProgrammes(channelData.xml);
      totalProgrammes += programmes.length;
      
      // AI enrichment (in batches of 50)
      if (ANTHROPIC_API_KEY) {
        for (let i = 0; i < programmes.length; i += 50) {
          const batch = programmes.slice(i, i + 50);
          await enrichWithAI(batch);
        }
      }
      
      // TMDB enrichment for AI-identified series
      if (TMDB_API_KEY) {
        for (const prog of programmes) {
          if (prog.enriched) {
            await enrichWithTMDB(prog);
            enrichedCount++;
          }
        }
      }
      
      // Build programme XML
      for (const prog of programmes) {
        xmltv += buildProgrammeXML(prog, channelData.id);
      }
    }
    
    xmltv += '</tv>';
    
    // Cache the result
    cachedXMLTV = xmltv;
    cacheTimestamp = Date.now();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Generation complete in ${duration}s`);
    console.log(`📊 ${allChannelsData.length} channels, ${totalProgrammes} programmes, ${enrichedCount} enriched`);
    console.log(`📦 Size: ${(xmltv.length / 1024 / 1024).toFixed(2)} MB`);
    
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Generation-Time', duration);
    res.status(200).send(xmltv);
    
  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><tv><e>Error generating XMLTV</e></tv>');
  }
}
