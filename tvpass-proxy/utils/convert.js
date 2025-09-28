export function convertToXMLTV(data, channelId) {
  const pad = (n) => n.toString().padStart(2, '0');

  const formatDate = (date) => {
    const yyyy = date.getUTCFullYear();
    const MM = pad(date.getUTCMonth() + 1);
    const dd = pad(date.getUTCDate());
    const hh = pad(date.getUTCHours());
    const mm = pad(date.getUTCMinutes());
    const ss = pad(date.getUTCSeconds());
    return `${yyyy}${MM}${dd}${hh}${mm}${ss} +0000`;
  };

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n`;
  xml += `<channel id="${channelId}">\n  <display-name>${channelId}</display-name>\n</channel>\n`;

  data.forEach(item => {
    const start = new Date(item["data-listdatetime"]);
    const stop = new Date(start.getTime() + item["data-duration"] * 60000);
    const title = item["data-showname"] || "Untitled";
    const episode = item["data-episodetitle"] || "";
    const desc = item["data-description"] || "";

    xml += `<programme start="${formatDate(start)}" stop="${formatDate(stop)}" channel="${channelId}">\n`;
    xml += `  <title>${title}${episode ? ` — ${episode}` : ''}</title>\n`;
    if (desc) xml += `  <desc>${desc}</desc>\n`;
    xml += `</programme>\n`;
  });

  xml += `</tv>`;
  return xml;
}
