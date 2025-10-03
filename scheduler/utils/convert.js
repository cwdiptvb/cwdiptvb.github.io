/**
 * Helper function to escape special XML characters.
 * This directly addresses the "xmlParseEntityRef: no name" error.
 * @param {string} unsafe The string to escape.
 * @returns {string} The escaped string.
 */
function escapeXml(unsafe) {
    if (!unsafe) return '';
    return unsafe.replace(/[&<>"']/g, function (match) {
        switch (match) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&apos;';
        }
    });
}

/**
 * Converts TVPass JSON schedules into an XMLTV string.
 * @param {Array<{id: string, data: Array<Object>}>} schedules 
 * @returns {string} The complete XMLTV string.
 */
export function convertMultipleToXMLTV(schedules) {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<!DOCTYPE tv SYSTEM "xmltv.dtd">\n';
    // xmltv.dtd is just for validation, not required for parsing

    xml += '<tv>\n';

    // 1. Channel Definitions
    schedules.forEach(schedule => {
        // Use the tvg-id from the CHANNEL_MAP as the XMLTV channel ID
        xml += `<channel id="${schedule.id}">\n`;
        // Assuming the channel name is derived from the tvg-id for simplicity
        xml += `<display-name lang="en">${escapeXml(schedule.id.replace(/-/g, ' ').toUpperCase())}</display-name>\n`;
        xml += `</channel>\n`;
    });

    // 2. Programme Listings
    schedules.forEach(schedule => {
        schedule.data.forEach(item => {
            const start = item['data-listdatetime'].replace(/[-:T.]/g, '') + ' +0000'; // Format: YYYYMMDDhhmmss +0000 (UTC)
            const durationMinutes = item['data-duration'] || 60;
            const stopDate = new Date(new Date(item['data-listdatetime']).getTime() + durationMinutes * 60000);
            
            // Format stop time
            const pad = (num) => String(num).padStart(2, '0');
            const stop = stopDate.getUTCFullYear() + 
                         pad(stopDate.getUTCMonth() + 1) + 
                         pad(stopDate.getUTCDate()) + 
                         pad(stopDate.getUTCHours()) + 
                         pad(stopDate.getUTCMinutes()) + 
                         pad(stopDate.getUTCSeconds()) + ' +0000';

            xml += `<programme start="${start}" stop="${stop}" channel="${schedule.id}">\n`;
            
            // ESCAPING APPLIED HERE
            xml += `<title lang="en">${escapeXml(item['data-showname'] || 'Untitled')}</title>\n`;
            
            if (item['data-episodetitle']) {
                // ESCAPING APPLIED HERE
                xml += `<sub-title lang="en">${escapeXml(item['data-episodetitle'])}</sub-title>\n`;
            }

            // ESCAPING APPLIED HERE
            xml += `<desc lang="en">${escapeXml(item['data-description'] || 'No description available.')}</desc>\n`;

            xml += `<category lang="en">TV Show</category>\n`;
            // Add other standard tags like episode-num, star-rating, etc., as needed
            
            xml += `</programme>\n`;
        });
    });

    xml += '</tv>';
    return xml;
}
