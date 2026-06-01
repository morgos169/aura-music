const https = require('https');

// 서버 과부하를 방지하기 위한 가사 메모리 캐시
const lyricsCache = {};

// [해결책] 국내외 가사 데이터가 가장 풍부하고 차단이 없는 정식 오픈 API 사용
function fetchOdesliLyrics(title, artist) {
    return new Promise((resolve) => {
        // 특수문자를 제거하여 검색 정확도 높이기
        const cleanTitle = title.replace(/[^a-zA-Z0-9가-힣\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const cleanArtist = artist.replace(/[^a-zA-Z0-9가-힣\s]/g, ' ').replace(/\s+/g, ' ').trim();
        
        // K-POP 가사 매칭률이 가장 높은 대안 API 쿼리 구성
        const query = `${cleanArtist} ${cleanTitle}`;
        const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;

        const options = {
            headers: {
                'User-Agent': 'AuraMusicPlayer/1.1.0 (Contact: admin@auramusic.local)'
            },
            timeout: 5000 // 5초 타임아웃 설정을 통해 무한 대기 방지
        };

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const results = JSON.parse(data);
                    if (Array.isArray(results) && results.length > 0) {
                        // 결과 중 빈 가사가 아닌 정확한 plainLyrics가 있는 것을 우선 선택
                        const match = results.find(r => r.plainLyrics && r.plainLyrics.trim().length > 0) || results[0];
                        if (match && match.plainLyrics) {
                            return resolve(match.plainLyrics.trim());
                        }
                    }
                    resolve(null);
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

// 2차 백업용 가사 API (텍스트 가사 매칭)
function fetchBackupLyrics(title, artist) {
    return new Promise((resolve) => {
        const query = encodeURIComponent(`${artist} ${title} 가사`);
        // 구글 검색 파싱이 아닌 오픈형 가사 데이터베이스 우회 호출
        const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
        
        https.get(url, { headers: { 'User-Agent': 'AuraMusic' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (Array.isArray(json) && json[0] && json[0].plainLyrics) {
                        resolve(json[0].plainLyrics.trim());
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

module.exports = async (req, res) => {
    // Vercel 환경에서 CORS 에러를 방지하기 위한 헤더 설정
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const title = req.query.title || '';
    const artist = req.query.artist || '';

    if (!title) {
        return res.status(400).json({ success: false, error: '곡 제목(title) 파라미터가 필요합니다.' });
    }

    const cacheKey = `${title}-${artist}`.trim();
    
    // 1. 이미 검색한 적이 있는 가사라면 캐시에서 즉시 반환
    if (lyricsCache[cacheKey]) {
        return res.status(200).json({ success: true, lyrics: lyricsCache[cacheKey] });
    }

    // 2. 1차 가사 라이브러리 요청
    let lyrics = await fetchOdesliLyrics(title, artist);
    
    // 3. 실패 시 2차 백업 가사 라이브러리 요청
    if (!lyrics) {
        lyrics = await fetchBackupLyrics(title, artist);
    }

    // 4. 가사를 성공적으로 찾은 경우
    if (lyrics && lyrics.length > 10) {
        lyricsCache[cacheKey] = lyrics;
        return res.status(200).json({ success: true, lyrics });
    } 

    // 5. 모든 API가 가사 찾기를 실패했을 때 보여줄 안내 문구
    const fallbackLyrics = `[${title} — ${artist}]\n\n서버 환경에서 가사를 실시간으로 불러오지 못했습니다.\n\n유튜브 재생 화면 내의 자막(CC) 기능을 이용하시거나,\n네이버/멜론에 '${artist} ${title} 가사'를 검색하시면 정확한 가사를 확인하실 수 있습니다.\n\nAura Music과 함께 즐거운 감상 되세요.`;
    
    res.status(200).json({
        success: false,
        lyrics: fallbackLyrics
    });
};