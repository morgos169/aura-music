const https = require('https');

const searchCache = {};

module.exports = async (req, res) => {
    const query = req.query.q || '';
    if (!query) {
        return res.status(400).json({ success: false, error: '검색어가 없습니다.' });
    }

    if (searchCache[query]) {
        return res.status(200).json({ success: true, videoId: searchCache[query] });
    }

    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const options = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
        }
    };

    https.get(url, options, (ytRes) => {
        let data = '';
        ytRes.on('data', chunk => data += chunk);
        ytRes.on('end', () => {
            try {
                let videoId = '';
                const match = data.match(/"videoRenderer"\s*:\s*\{\s*"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
                if (match && match[1]) {
                    videoId = match[1];
                } else {
                    const watchMatch = data.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
                    if (watchMatch && watchMatch[1]) {
                        videoId = watchMatch[1];
                    }
                }

                if (videoId) {
                    searchCache[query] = videoId;
                    res.status(200).json({ success: true, videoId });
                } else {
                    res.status(404).json({ success: false, error: "유튜브에서 비디오 ID를 찾지 못했습니다." });
                }
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });
    }).on('error', (err) => {
        res.status(500).json({ success: false, error: err.message });
    });
};