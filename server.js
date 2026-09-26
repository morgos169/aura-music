const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const youtubedl = require('youtube-dl-exec');

const PORT = 3000;

// In-memory caches to reduce external requests and speed up execution
const searchCache = {};
const lyricsCache = {};
let top100Cache = null;
let top100CacheTime = 0;

// 1. Scrape Melon Top 100 Chart
function fetchMelonChart() {
    return new Promise((resolve, reject) => {
        // Cache Top 100 results for 10 minutes to avoid rate-limiting
        const now = Date.now();
        if (top100Cache && (now - top100CacheTime < 10 * 60 * 1000)) {
            return resolve(top100Cache);
        }

        const options = {
            hostname: 'www.melon.com',
            path: '/chart/index.htm',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const list = [];
                    // tr elements with class lst50 or lst100
                    const trRegex = /<tr class="lst(50|100)"[^>]*>([\s\S]*?)<\/tr>/g;
                    let match;
                    let rank = 1;
                    while ((match = trRegex.exec(data)) !== null && rank <= 100) {
                        const trHtml = match[2];
                        
                        // Extract Song ID
                        const idMatch = trHtml.match(/value="(\d+)"/);
                        const songId = idMatch ? idMatch[1] : '';

                        // Extract Title
                        const titleMatch = trHtml.match(/<div class="ellipsis rank01">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
                        let title = titleMatch ? titleMatch[1] : '';
                        title = title
                            .replace(/<[^>]+>/g, '') // remove tags
                            .replace(/&nbsp;/gi, ' ')
                            .replace(/&amp;/g, '&')
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"')
                            .replace(/&#39;/g, "'")
                            .trim();

                        // Extract Artist
                        const artistMatch = trHtml.match(/<div class="ellipsis rank02">([\s\S]*?)<\/div>/);
                        let artist = '';
                        if (artistMatch) {
                            const artistDiv = artistMatch[1];
                            const aMatch = artistDiv.match(/<a[^>]*>([\s\S]*?)<\/a>/);
                            artist = aMatch ? aMatch[1] : '';
                        }
                        artist = artist
                            .replace(/<[^>]+>/g, '')
                            .replace(/&nbsp;/gi, ' ')
                            .replace(/&amp;/g, '&')
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"')
                            .replace(/&#39;/g, "'")
                            .trim();

                        // Extract Album Art Cover
                        const imgMatch = trHtml.match(/<a[^>]*class="image_typeAll"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/);
                        let albumArt = imgMatch ? imgMatch[1] : '';
                        // Strip quality query params if needed, or keep standard
                        if (albumArt && albumArt.indexOf('?') > -1) {
                            albumArt = albumArt.substring(0, albumArt.indexOf('?'));
                        }

                        if (title && artist) {
                            list.push({
                                rank,
                                id: songId,
                                title,
                                artist,
                                albumArt: albumArt || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
                            });
                            rank++;
                        }
                    }
                    if (list.length > 0) {
                        top100Cache = list;
                        top100CacheTime = now;
                        resolve(list);
                    } else {
                        reject(new Error("Failed to parse chart rows"));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

// 2. Scrape YouTube for Video ID
function searchYouTube(query) {
    return new Promise((resolve, reject) => {
        if (searchCache[query]) {
            return resolve(searchCache[query]);
        }

        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        };

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    // Method A: Look for "videoRenderer":{"videoId":"..."
                    let videoId = '';
                    const match = data.match(/"videoRenderer"\s*:\s*\{\s*"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
                    if (match && match[1]) {
                        videoId = match[1];
                    } else {
                        // Method B: Fallback watch?v= matching
                        const watchMatch = data.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
                        if (watchMatch && watchMatch[1]) {
                            videoId = watchMatch[1];
                        }
                    }

                    if (videoId) {
                        searchCache[query] = videoId;
                        resolve(videoId);
                    } else {
                        reject(new Error("No videoId found on YouTube"));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

// 3. Scrape Melon Lyrics Details
function fetchMelonLyrics(songId) {
    return new Promise((resolve, reject) => {
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
                        let htmlLyrics = match[1];
                        htmlLyrics = htmlLyrics.replace(/<!--[\s\S]*?-->/g, ''); // Remove comments
                        let lyrics = htmlLyrics.replace(/<br\s*\/?>/gi, '\n');   // Convert linebreaks
                        lyrics = lyrics.replace(/<[^>]+>/g, '');                // Remove HTML tags
                        lyrics = lyrics
                            .replace(/&amp;/g, '&')
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"')
                            .replace(/&#39;/g, "'")
                            .trim();
                        resolve(lyrics);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

// 4. Query LRCLIB API for Lyrics
function fetchLrcLibLyrics(title, artist) {
    return new Promise((resolve) => {
        const cleanTitle = title.replace(/[^a-zA-Z0-9가-힣\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const cleanArtist = artist.replace(/[^a-zA-Z0-9가-힣\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const query = `${cleanArtist} ${cleanTitle}`;
        const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;

        const options = {
            headers: {
                'User-Agent': 'AuraMusicPlayer/1.0.0 (https://github.com/google-deepmind/antigravity)'
            }
        };

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const results = JSON.parse(data);
                    if (Array.isArray(results) && results.length > 0) {
                        const match = results.find(r => r.plainLyrics) || results[0];
                        if (match && match.plainLyrics) {
                            resolve(match.plainLyrics.trim());
                            return;
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

const handler = (req, res) => {
    // Parse URL and search parameters
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (pathname === '/api/top100') {
        fetchMelonChart()
            .then(tracks => {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, tracks }));
            })
            .catch(err => {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            });
    } else if (pathname === '/api/search') {
        const query = parsedUrl.searchParams.get('q') || '';
        if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: false, error: 'Query missing' }));
        }

        searchYouTube(query)
            .then(videoId => {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, videoId }));
            })
            .catch(err => {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            });
    } else if (pathname === '/api/lyrics') {
        const title = parsedUrl.searchParams.get('title') || '';
        const artist = parsedUrl.searchParams.get('artist') || '';
        const melonId = parsedUrl.searchParams.get('melonId') || '';

        const cacheKey = `${title}-${artist}-${melonId}`;
        if (lyricsCache[cacheKey]) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: true, lyrics: lyricsCache[cacheKey] }));
        }

        let lyricsPromise;
        if (melonId) {
            lyricsPromise = fetchMelonLyrics(melonId).then(lyrics => {
                if (lyrics) return lyrics;
                return fetchLrcLibLyrics(title, artist);
            });
        } else {
            lyricsPromise = fetchLrcLibLyrics(title, artist);
        }

        lyricsPromise
            .then(lyrics => {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                if (lyrics) {
                    lyricsCache[cacheKey] = lyrics;
                    res.end(JSON.stringify({ success: true, lyrics }));
                } else {
                    res.end(JSON.stringify({
                        success: false,
                        lyrics: `[${title} — ${artist}]\n\n가사를 불러올 수 없습니다.\n\nAura Music과 함께 즐거운 감상 되세요.`
                    }));
                }
            })
            .catch(err => {
                console.error(err);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    success: false,
                    lyrics: `[${title} — ${artist}]\n\n가사를 로드하는 과정에서 오류가 발생했습니다.\n\nAura Music과 함께 즐거운 감상 되세요.`
                }));
            });
    } else if (pathname === '/api/download') {
        const videoId = parsedUrl.searchParams.get('id');
        let title = parsedUrl.searchParams.get('title') || 'downloaded_track';
        let artist = parsedUrl.searchParams.get('artist') || 'Artist';

        if (!videoId) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: false, error: 'Video ID missing' }));
        }

        const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        // Encode the filename for HTTP headers (using .m4a since yt-dlp fetches bestaudio)
        const rawFileName = `${artist} - ${title}.m4a`;
        const encodedFileName = encodeURIComponent(rawFileName);

        res.writeHead(200, {
            'Content-Disposition': `attachment; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`,
            'Content-Type': 'audio/mp4'
        });

        try {
            const subprocess = youtubedl.exec(ytUrl, {
                f: 'bestaudio[ext=m4a]/bestaudio/best',
                o: '-'
            });
            
            subprocess.stdout.pipe(res);

            subprocess.on('close', () => {
                if (!res.writableEnded) {
                    res.end();
                }
            });

            subprocess.on('error', (err) => {
                console.error('youtube-dl stream error:', err);
                if (!res.writableEnded) {
                    res.end();
                }
            });
        } catch (err) {
            console.error('Download setup error:', err);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end('Server Error');
            }
        }
    } else {
        // Fallback: serve index.html
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(404);
                res.end('파일을 찾을 수 없습니다: index.html');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(content);
            }
        });
    }
};

const server = http.createServer(handler);

// Vercel 환경이 아닐 때만 로컬 포트로 서버를 엽니다.
if (!process.env.VERCEL) {
    server.listen(PORT, () => {
        const url = `http://localhost:${PORT}`;
        console.log(`서버가 시작되었습니다: ${url}`);
        // 브라우저 자동 실행
        const startCmd = process.platform === 'win32' ? 'start ""' : 'open';
        exec(`${startCmd} ${url}`);
    });
}

// Vercel 서버리스 함수로 동작할 수 있도록 핸들러를 export 합니다.
module.exports = handler;