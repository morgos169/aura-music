const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 3000;

const lyricsCache = {};
let top100Cache = null;
let top100CacheTime = 0;
let top100CacheSource = '';

const CHART_URLS = [
    'https://rss.marketingtools.apple.com/api/v2/kr/music/most-played/100/songs.json',
    'https://rss.applemarketingtools.com/api/v2/kr/music/most-played/100/songs.json',
    'https://rss.marketingtools.apple.com/api/v2/us/music/most-played/100/songs.json',
    'https://itunes.apple.com/kr/rss/topsongs/limit=100/json',
    'https://itunes.apple.com/us/rss/topsongs/limit=100/json'
];

function httpsGetJson(url, headers = {}, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'AuraMusic/1.1 (personal playlist; chart display)',
                'Accept': 'application/json, text/javascript, */*;q=0.1',
                ...headers
            }
        }, (res) => {
            const status = res.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
                if (redirectCount >= 5) {
                    return reject(new Error('Too many redirects'));
                }
                const next = new URL(res.headers.location, url).toString();
                res.resume();
                return resolve(httpsGetJson(next, headers, redirectCount + 1));
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (status >= 400) {
                    return reject(new Error(`HTTP ${status} for ${url}`));
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
                }
            });
        });
        req.setTimeout(15000, () => {
            req.destroy(new Error(`Timeout fetching ${url}`));
        });
        req.on('error', reject);
    });
}

function mapAppleMarketingResults(results, sourceLabel) {
    return (results || []).map((item, index) => {
        let albumArt = item.artworkUrl100 || '';
        if (albumArt) {
            albumArt = albumArt.replace(/100x100bb/, '300x300bb');
        }
        return {
            rank: index + 1,
            id: String(item.id || `apple-${index + 1}`),
            title: item.name || '',
            artist: item.artistName || '',
            albumArt: albumArt || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
            source: sourceLabel
        };
    }).filter(t => t.title && t.artist);
}

function mapItunesRssEntries(entries, sourceLabel) {
    return (entries || []).map((item, index) => {
        const images = item['im:image'] || [];
        const bestImg = images.length ? images[images.length - 1].label : '';
        const albumArt = bestImg
            ? String(bestImg).replace(/\d+x\d+bb/, '300x300bb')
            : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        const id =
            item.id?.attributes?.['im:id'] ||
            item['im:id']?.label ||
            `itunes-${index + 1}`;
        return {
            rank: index + 1,
            id: String(id),
            title: item['im:name']?.label || '',
            artist: item['im:artist']?.label || '',
            albumArt,
            source: sourceLabel
        };
    }).filter(t => t.title && t.artist);
}

function parseChartPayload(payload, url) {
    if (payload?.feed?.results?.length) {
        return {
            tracks: mapAppleMarketingResults(payload.feed.results, 'apple-marketing-tools'),
            source: url
        };
    }
    if (payload?.feed?.entry?.length) {
        const entries = Array.isArray(payload.feed.entry)
            ? payload.feed.entry
            : [payload.feed.entry];
        return {
            tracks: mapItunesRssEntries(entries, 'itunes-rss'),
            source: url
        };
    }
    return { tracks: [], source: url };
}

async function fetchOfficialChart(force = false) {
    const now = Date.now();
    if (!force && top100Cache && (now - top100CacheTime < 10 * 60 * 1000)) {
        return { tracks: top100Cache, source: top100CacheSource, cached: true };
    }

    let lastError = null;
    for (const url of CHART_URLS) {
        try {
            const payload = await httpsGetJson(url);
            const parsed = parseChartPayload(payload, url);
            if (parsed.tracks.length > 0) {
                top100Cache = parsed.tracks;
                top100CacheTime = now;
                top100CacheSource = parsed.source;
                return { tracks: parsed.tracks, source: parsed.source, cached: false };
            }
            lastError = new Error(`Empty chart from ${url}`);
        } catch (err) {
            lastError = err;
            console.error('Chart fetch failed:', url, err.message);
        }
    }

    throw lastError || new Error('All chart sources failed');
}

function stripSyncedLrc(synced) {
    if (!synced) return null;
    return synced.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim() || null;
}

function fetchLrcLibLyrics(title, artist) {
    return new Promise((resolve) => {
        const cleanTitle = title.replace(/[^\w\uac00-\ud7a3\s]/gi, ' ').replace(/\s+/g, ' ').trim();
        const cleanArtist = artist.replace(/[^\w\uac00-\ud7a3\s]/gi, ' ').replace(/\s+/g, ' ').trim();
        if (!cleanTitle) return resolve(null);

        const headers = {
            'User-Agent': 'AuraMusic/1.1 (https://lrclib.net; personal lyrics display)'
        };

        const getUrl =
            `https://lrclib.net/api/get?artist_name=${encodeURIComponent(cleanArtist)}` +
            `&track_name=${encodeURIComponent(cleanTitle)}`;

        httpsGetJson(getUrl, headers)
            .then((data) => {
                const lyrics = data.plainLyrics || stripSyncedLrc(data.syncedLyrics);
                if (lyrics) {
                    resolve({ text: lyrics.trim(), source: 'LRCLIB' });
                    return null;
                }
                return null;
            })
            .catch(() => null)
            .then((hit) => {
                if (hit) {
                    resolve(hit);
                    return;
                }
                const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanArtist} ${cleanTitle}`)}`;
                return httpsGetJson(searchUrl, headers)
                    .then((results) => {
                        if (!Array.isArray(results) || results.length === 0) {
                            resolve(null);
                            return;
                        }
                        const match = results.find(r => r.plainLyrics || r.syncedLyrics) || results[0];
                        const lyrics = match.plainLyrics || stripSyncedLrc(match.syncedLyrics);
                        if (lyrics) {
                            resolve({ text: lyrics.trim(), source: 'LRCLIB' });
                        } else {
                            resolve(null);
                        }
                    })
                    .catch(() => resolve(null));
            });
    });
}

function fetchLyricsOvh(title, artist) {
    return new Promise((resolve) => {
        const cleanTitle = title.trim();
        const cleanArtist = artist.trim();
        if (!cleanTitle || !cleanArtist) return resolve(null);

        const url =
            `https://api.lyrics.ovh/v1/${encodeURIComponent(cleanArtist)}/${encodeURIComponent(cleanTitle)}`;

        httpsGetJson(url, {
            'User-Agent': 'AuraMusic/1.1 (personal lyrics display)'
        })
            .then((data) => {
                if (data && data.lyrics) {
                    resolve({ text: String(data.lyrics).trim(), source: 'lyrics.ovh' });
                } else {
                    resolve(null);
                }
            })
            .catch(() => resolve(null));
    });
}

async function resolveLyrics(title, artist) {
    const fromLrc = await fetchLrcLibLyrics(title, artist);
    if (fromLrc) return fromLrc;
    return fetchLyricsOvh(title, artist);
}

const handler = (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (pathname === '/api/top100') {
        const force = parsedUrl.searchParams.get('refresh') === '1';
        fetchOfficialChart(force)
            .then(({ tracks, source, cached }) => {
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store'
                });
                res.end(JSON.stringify({
                    success: true,
                    source,
                    cached: !!cached,
                    tracks
                }));
            })
            .catch(err => {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            });
    } else if (pathname === '/api/lyrics') {
        const title = parsedUrl.searchParams.get('title') || '';
        const artist = parsedUrl.searchParams.get('artist') || '';
        const cacheKey = `${title}::${artist}`.toLowerCase();

        if (lyricsCache[cacheKey]) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: true, ...lyricsCache[cacheKey] }));
        }

        resolveLyrics(title, artist)
            .then(result => {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                if (result) {
                    lyricsCache[cacheKey] = { lyrics: result.text, source: result.source };
                    res.end(JSON.stringify({
                        success: true,
                        lyrics: result.text,
                        source: result.source
                    }));
                } else {
                    res.end(JSON.stringify({
                        success: false,
                        lyrics: null,
                        source: null
                    }));
                }
            })
            .catch(err => {
                console.error(err);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, lyrics: null, error: err.message }));
            });
    } else {
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

if (!process.env.VERCEL) {
    server.listen(PORT, () => {
        const url = `http://localhost:${PORT}`;
        console.log(`서버가 시작되었습니다: ${url}`);
        const startCmd = process.platform === 'win32' ? 'start ""' : 'open';
        exec(`${startCmd} ${url}`);
    });
}

module.exports = handler;
