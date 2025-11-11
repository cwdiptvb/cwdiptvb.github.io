// utils/convert.js
// Converts enriched programme data to XMLTV format

/**
 * Escapes XML special characters
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds a channel element
 * @param {string} channelId - Channel ID
 * @param {Object} options - Additional channel options
 * @returns {string} - XML channel element
 */
export function buildChannel(channelId, options = {}) {
  let xml = `  <channel id="${escapeXml(channelId)}">\n`;
  
  const displayName = options.displayName || channelId;
  xml += `    <display-name>${escapeXml(displayName)}</display-name>\n`;
  
  if (options.icon) {
    xml += `    <icon src="${escapeXml(options.icon)}" />\n`;
  }
  
  xml += `  </channel>\n`;
  return xml;
}

/**
 * Builds a programme element with full metadata
 * @param {Object} programme - Programme data
 * @returns {string} - XML programme element
 */
export function buildProgramme(programme) {
  const { channelId, start, stop, title, description, tmdb } = programme;
  
  let xml = `  <programme start="${start}" stop="${stop}" channel="${escapeXml(channelId)}">\n`;
  
  // Check if this is an enriched series episode
  if (tmdb && tmdb.season && tmdb.episode) {
    // Enhanced series episode
    const fullTitle = tmdb.episodeName 
      ? `${tmdb.showName} - ${tmdb.episodeName}`
      : tmdb.showName || title;
    
    xml += `    <title>${escapeXml(fullTitle)}</title>\n`;
    
    // Sub-title (episode name)
    if (tmdb.episodeName) {
      xml += `    <sub-title>${escapeXml(tmdb.episodeName)}</sub-title>\n`;
    }
    
    // Enhanced description with season/episode info
    if (tmdb.overview) {
      const enhancedDesc = `S${tmdb.season}E${tmdb.episode}: ${tmdb.overview}`;
      xml += `    <desc>${escapeXml(enhancedDesc)}</desc>\n`;
    } else if (description) {
      xml += `    <desc>${escapeXml(description)}</desc>\n`;
    }
    
    // Episode number in xmltv_ns format (0-indexed)
    const episodeNum = `${tmdb.season - 1}.${tmdb.episode - 1}.`;
    xml += `    <episode-num system="xmltv_ns">${episodeNum}</episode-num>\n`;
    
    // Episode number in onscreen format (S01E05)
    const onScreen = `S${String(tmdb.season).padStart(2, '0')}E${String(tmdb.episode).padStart(2, '0')}`;
    xml += `    <episode-num system="onscreen">${onScreen}</episode-num>\n`;
    
    // Episode thumbnail (still image from the episode)
    if (tmdb.episodeThumbnail) {
      xml += `    <icon src="${escapeXml(tmdb.episodeThumbnail)}" />\n`;
    }
    
    // Series poster/artwork
    if (tmdb.seriesPoster) {
      xml += `    <image src="${escapeXml(tmdb.seriesPoster)}" />\n`;
    }
    
    // Category
    xml += `    <category>series</category>\n`;
    
    // Additional metadata if available
    if (tmdb.showId) {
      xml += `    <category>tmdb:tv:${tmdb.showId}</category>\n`;
    }
    
  } else {
    // Standard programme without enrichment
    xml += `    <title>${escapeXml(title)}</title>\n`;
    
    if (description) {
      xml += `    <desc>${escapeXml(description)}</desc>\n`;
    }
    
    // Add series poster if available but no episode info
    if (tmdb && tmdb.seriesPoster) {
      xml += `    <image src="${escapeXml(tmdb.seriesPoster)}" />\n`;
    }
  }
  
  xml += `  </programme>\n`;
  return xml;
}

/**
 * Converts array of programmes to complete XMLTV document
 * @param {Array} programmes - Array of programme objects
 * @param {Object} options - Conversion options
 * @returns {string} - Complete XMLTV XML document
 */
export function convertToXMLTV(programmes, options = {}) {
  const generatorName = options.generatorName || 'AI-Enhanced EPG Aggregator';
  const generatorUrl = options.generatorUrl || 'https://github.com';
  const sourceInfo = options.sourceInfo || 'EPG.PW';
  
  // Build XML header
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<tv source-info-name="${escapeXml(sourceInfo)}" `;
  xml += `generator-info-name="${escapeXml(generatorName)}" `;
  xml += `generator-info-url="${escapeXml(generatorUrl)}">\n`;
  
  // Extract unique channels
  const channelsMap = new Map();
  for (const prog of programmes) {
    if (prog.channelId && !channelsMap.has(prog.channelId)) {
      channelsMap.set(prog.channelId, {
        id: prog.channelId,
        displayName: prog.channelDisplayName || prog.channelId
      });
    }
  }
  
  // Add all channels
  for (const [channelId, channelData] of channelsMap) {
    xml += buildChannel(channelId, channelData);
  }
  
  // Add all programmes
  for (const prog of programmes) {
    xml += buildProgramme(prog);
  }
  
  xml += '</tv>';
  
  return xml;
}

/**
 * Validates XMLTV document structure
 * @param {string} xmltv - XMLTV XML string
 * @returns {Object} - Validation result
 */
export function validateXMLTV(xmltv) {
  const result = {
    valid: true,
    errors: [],
    warnings: [],
    stats: {
      channels: 0,
      programmes: 0,
      enriched: 0
    }
  };
  
  // Basic structure checks
  if (!xmltv.includes('<?xml version="1.0"')) {
    result.errors.push('Missing XML declaration');
    result.valid = false;
  }
  
  if (!xmltv.includes('<tv') || !xmltv.includes('</tv>')) {
    result.errors.push('Missing <tv> root element');
    result.valid = false;
  }
  
  // Count elements
  const channelMatches = xmltv.match(/<channel/g);
  const programmeMatches = xmltv.match(/<programme/g);
  const enrichedMatches = xmltv.match(/<episode-num/g);
  
  result.stats.channels = channelMatches ? channelMatches.length : 0;
  result.stats.programmes = programmeMatches ? programmeMatches.length : 0;
  result.stats.enriched = enrichedMatches ? enrichedMatches.length : 0;
  
  if (result.stats.channels === 0) {
    result.warnings.push('No channels found');
  }
  
  if (result.stats.programmes === 0) {
    result.warnings.push('No programmes found');
  }
  
  return result;
}

/**
 * Formats file size for display
 * @param {number} bytes - Size in bytes
 * @returns {string} - Formatted size string
 */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Creates a statistics summary for logging
 * @param {Array} programmes - Array of programme objects
 * @returns {Object} - Statistics object
 */
export function getStatistics(programmes) {
  const stats = {
    total: programmes.length,
    enriched: 0,
    channels: new Set(),
    dateRange: {
      start: null,
      end: null
    },
    categories: new Map()
  };
  
  for (const prog of programmes) {
    // Count enriched programmes
    if (prog.tmdb && prog.tmdb.season && prog.tmdb.episode) {
      stats.enriched++;
    }
    
    // Track unique channels
    if (prog.channelId) {
      stats.channels.add(prog.channelId);
    }
    
    // Track date range
    if (prog.start) {
      const startDate = prog.start.slice(0, 8);
      if (!stats.dateRange.start || startDate < stats.dateRange.start) {
        stats.dateRange.start = startDate;
      }
      if (!stats.dateRange.end || startDate > stats.dateRange.end) {
        stats.dateRange.end = startDate;
      }
    }
  }
  
  stats.channels = stats.channels.size;
  stats.enrichmentRate = stats.total > 0 
    ? ((stats.enriched / stats.total) * 100).toFixed(1) + '%'
    : '0%';
  
  return stats;
}

export default {
  buildChannel,
  buildProgramme,
  convertToXMLTV,
  validateXMLTV,
  formatSize,
  getStatistics,
  escapeXml
};
