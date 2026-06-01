const https = require('https');

const lyricsCache = {};

function fetchMelonLyrics(songId) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'www.melon.com',
            path: `/song/detail.htm?songId=${songId}`,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const match = data.match(/<div[^>]*class="lyric"[^>]*id="d_video_summary"[^>]*>([\s\S]*?)<\/div>/);
                    if (match) {
                        let htmlLyrics = match[1].replace(//g, '');
                        let lyrics = htmlLyrics.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
                        lyrics = lyrics.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
                        resolve(lyrics);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

function fetchLrcLibLyrics(title, artist) {
    return new Promise((resolve) => {
        const query = `${artist} ${title}`.replace(/[^a-zA-Z0-9가-힣\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;

        const options = { headers: { 'User-Agent': 'AuraMusicPlayer/1.0.0' } };

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const results = JSON.parse(data);
                    if (Array.isArray(results) && results.length > 0) {
                        const match = results.find(r => r.plainLyrics) || results[0];
                        if (match && match.plainLyrics) return resolve(match.plainLyrics.trim());
                    }
                    resolve(null);
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

module.exports = async (req, res) => {
    const title = req.query.title || '';
    const artist = req.query.artist || '';
    const melonId = req.query.melonId || '';

    const cacheKey = `${title}-${artist}-${melonId}`;
    if (lyricsCache[cacheKey]) {
        return res.status(200).json({ success: true, lyrics: lyricsCache[cacheKey] });
    }

    let lyrics = null;
    
    if (melonId) {
        lyrics = await fetchMelonLyrics(melonId);
    }
    
    if (!lyrics) {
        lyrics = await fetchLrcLibLyrics(title, artist);
    }

    if (lyrics) {
        lyricsCache[cacheKey] = lyrics;
        res.status(200).json({ success: true, lyrics });
    } else {
        res.status(404).json({
            success: false,
            lyrics: `[${title} — ${artist}]\n\n가사를 불러올 수 없습니다.\n\nAura Music과 함께 즐거운 감상 되세요.`
        });
    }
};