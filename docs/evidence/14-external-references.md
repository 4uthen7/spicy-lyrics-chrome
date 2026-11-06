# External corroborating references (not first-party evidence)

These are public third-party sources used ONLY to corroborate schema/endpoint names that the
shipped web-player bundle does not fully expose. They are not authoritative for the 2026 build.

## 1. syrics (third-party Spotify lyrics downloader, Python) - fetched 2026-11-06
- https://raw.githubusercontent.com/akashrchandran/syrics/main/syrics/api.py -> HTTP 200, 4697 bytes
- https://raw.githubusercontent.com/akashrchandran/syrics/main/syrics/totp.py -> HTTP 200, 1589 bytes

Relevant excerpt from api.py (verbatim):

```
TOKEN_URL = 'https://open.spotify.com/api/token'
SERVER_TIME_URL = 'https://open.spotify.com/server-time'
SPOTIFY_HOME_PAGE_URL = "https://open.spotify.com/"
CLIENT_VERSION = "1.2.46.25.g7f189073"

HEADERS = {
    "accept": "application/json",
    "accept-language": "en-US",
    "content-type": "application/json",
    "origin": SPOTIFY_HOME_PAGE_URL,
    "referer": SPOTIFY_HOME_PAGE_URL,
    ...
    "spotify-app-version": CLIENT_VERSION,
    "app-platform": "WebPlayer",
}
...
    params={
        "reason": "init",
        "productType": "web-player",
        "totp": totp,
        "totpVer": str(self.totp.version),
        "ts": str(server_time),
    }
    req = self.session.get(TOKEN_URL, params=params)
    token = req.json()
    self.token = token['accessToken']
...
    def get_lyrics(self, track_id: str):
        params = 'format=json&market=from_token'
        req = self.session.get(f'https://spclient.wg.spotify.com/color-lyrics/v2/track/{track_id}', params=params)
        return req.json() if req.status_code == 200 else None
```

- Confirms: token comes from open.spotify.com/api/token (TOTP protected, requires an sp_dc session cookie),
  color-lyrics v2 bare-track endpoint and `format=json&market=from_token` params, app-platform/spotify-app-version headers.
- totp.py confirms TOTP: 30 s period, 6 digits, HMAC-SHA1 over the 8-byte counter, secret/version fetched from a
  public secrets mirror. The captured browser request used `totpVer=61`, which matches the reference's versioned secret.

## 2. spotify-lyrics-api (Akash R Chandran) README - fetched 2026-11-06
- https://raw.githubusercontent.com/duball69/spotify-lyrics-api/main/README.md -> HTTP 200

Relevant excerpt (verbatim, from the "LINE Synced" example):

```json
{
    "error": false,
    "syncType": "LINE_SYNCED",
    "lines": [
        {
            "startTimeMs": "960",
            "words": "One, two, three, four",
            "syllables": [],
            "endTimeMs": "0"
        },
        {
            "startTimeMs": "4020",
            "words": "Ooh-ooh, ooh-ooh-ooh",
            "syllables": [],
            "endTimeMs": "0"
        }
    ]
}
```

- Confirms the per-line field names/types: startTimeMs (string), endTimeMs (string, "0" when absent),
  words (string), syllables (array, empty for line-synced).
- This README states word/syllable synced timing was not exposed by Spotify at the time of writing (2022).
  The 2026 bundle DOES contain the SYLLABLE_SYNCED syncType value, so syllable payloads now exist; the exact
  syllable object field names are NOT captured in any artifact available here -> UNVERIFIED.

## 3. Not usable
- https://spicylyrics.org/ -> Cloudflare challenge page (HTTP 200, 8859 bytes, no app JS). No code source.
- Public code search (grep.app) -> Cloudflare challenge. GitHub code search requires auth. Not used.
