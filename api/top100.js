const https = require('https');

let top100Cache = null;
let top100CacheTime = 0;

module.exports = async (req, res) => {
    const now = Date.now();
    if (top100Cache && (now - top100CacheTime < 10 * 60 * 1000)) {
        return res.status(200).json({ success: true, tracks: top100Cache });
    }

    const options = {
        hostname: 'www.melon.com',
        path: '/chart/index.htm',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    };

    https.get(options, (melonRes) => {
        let data = '';
        melonRes.on('data', chunk => data += chunk);
        melonRes.on('end', () => {
            try {
                const list = [];
                const trRegex = /<tr class="lst(50|100)"[^>]*>([\s\S]*?)<\/tr>/g;
                let match;
                let rank = 1;
                while ((match = trRegex.exec(data)) !== null && rank <= 100) {
                    const trHtml = match[2];
                    
                    const idMatch = trHtml.match(/value="(\d+)"/);
                    const songId = idMatch ? idMatch[1] : '';

                    const titleMatch = trHtml.match(/<div class="ellipsis rank01">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
                    let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim() : '';

                    const artistMatch = trHtml.match(/<div class="ellipsis rank02">([\s\S]*?)<\/div>/);
                    let artist = '';
                    if (artistMatch) {
                        const aMatch = artistMatch[1].match(/<a[^>]*>([\s\S]*?)<\/a>/);
                        artist = aMatch ? aMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim() : '';
                    }

                    const imgMatch = trHtml.match(/<a[^>]*class="image_typeAll"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/);
                    let albumArt = imgMatch ? imgMatch[1] : '';
                    if (albumArt && albumArt.indexOf('?') > -1) albumArt = albumArt.substring(0, albumArt.indexOf('?'));

                    if (title && artist) {
                        list.push({
                            rank, id: songId, title, artist,
                            albumArt: albumArt || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
                        });
                        rank++;
                    }
                }
                
                if (list.length > 0) {
                    top100Cache = list;
                    top100CacheTime = now;
                    res.status(200).json({ success: true, tracks: list });
                } else {
                    res.status(500).json({ success: false, error: "차트 데이터를 파싱하지 못했습니다." });
                }
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });
    }).on('error', (err) => {
        res.status(500).json({ success: false, error: err.message });
    });
};