// server.js: Octo-Juggler Web & Badge Server
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieSession = require('cookie-session');
const config = require('./configuration-map.js');
const expressLayouts = require('express-ejs-layouts');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Env configuration
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `https://octocat.yups.me`;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const DATA_PATH = path.join(__dirname, 'data', 'tokens.json');

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
    console.error("Critical: ENCRYPTION_KEY must be 32 characters long.");
    process.exit(1);
}

// Config & Middleware
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('layout', 'layout');
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.urlencoded({ extended: true }));

app.use(cookieSession({
    name: 'session',
    keys: [ENCRYPTION_KEY],
    maxAge: 24 * 60 * 60 * 1000
}));

// Encryption helpers
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

// Data persistence
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}

let userTokens = {};
if (fs.existsSync(DATA_PATH)) {
    try {
        const encryptedData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        for (const [user, encToken] of Object.entries(encryptedData)) {
            userTokens[user] = decrypt(encToken);
        }
    } catch (e) {
        console.error("Error loading tokens:", e);
        userTokens = {};
    }
}

const saveTokens = () => {
    const encryptedToSave = {};
    for (const [user, token] of Object.entries(userTokens)) {
        encryptedToSave[user] = encrypt(token);
    }
    fs.writeFileSync(DATA_PATH, JSON.stringify(encryptedToSave, null, 2));
};

const badgeCache = new Map();

// Helper: Badge Asset Resolution
function resolveAssets(repos, status) {
    const selectedLayers = [];

    for (const [category, rules] of Object.entries(config.layers)) {
        if (typeof rules === 'string') {
            selectedLayers.push(rules);
            continue;
        }

        let matchedAsset = null;
        let maxIntKey = -1;
        const entries = Object.entries(rules);

        // Step 1: Check status emojis
        for (const [key, assetName] of entries) {
            if (isNaN(key) && key !== '+' && key !== 'default' && status.includes(key)) {
                matchedAsset = assetName;
                break;
            }
        }
        if (matchedAsset) {
            selectedLayers.push(`${category}/${matchedAsset}`);
            continue;
        }

        // Find maxIntKey for the '+' logic
        for (const [key] of entries) {
            if (!isNaN(key)) {
                maxIntKey = Math.max(maxIntKey, parseInt(key));
            }
        }

        // Step 2: Exact integer match
        for (const [key, assetName] of entries) {
            if (!isNaN(key) && parseInt(key) === repos) {
                matchedAsset = assetName;
                break;
            }
        }
        if (matchedAsset) {
            selectedLayers.push(`${category}/${matchedAsset}`);
            continue;
        }

        // Step 3: '+' catch-all
        if (repos > maxIntKey && rules['+']) {
            selectedLayers.push(`${category}/${rules['+']}`);
            continue;
        }

        // Step 4: Default
        if (rules.default) {
            selectedLayers.push(`${category}/${rules.default}`);
        }
    }
    return selectedLayers;
}

function generateDynamicSVG(repos, status, isErrorState = false) {
    // If error state, force status empty and repos 0 for the juggling visuals (base state)
    const effectiveRepos = isErrorState ? 0 : repos;
    const effectiveStatus = isErrorState ? '' : status;

    console.log("Generating SVG " + repos + " " + status);

    const assets = resolveAssets(effectiveRepos, effectiveStatus);

    // Scale images to fill 512x512 and embed as Base64
    const images = assets.map(assetPath => {
        try {
            const filePath = path.join(__dirname, 'assets', assetPath);
            const fileData = fs.readFileSync(filePath);
            const base64Image = Buffer.from(fileData).toString('base64');
            const mimeType = 'image/png'; // Assuming all assets are PNGs based on config
            return `<image href="data:${mimeType};base64,${base64Image}" x="0" y="0" width="100" height="100" />`;
        } catch (e) {
            console.error(`Failed to embed asset: ${assetPath}`, e.message);
            return '';
        }
    }).join('\n      ');

    const labelText = isErrorState
        ? "I need to review my octocat juggler"
        : `Past week I contributed to ${repos} repos.`;

    // SVG Size updated to 512x600 to fit larger width and text area
    return `
    <svg width="220" height="250" viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          .label-text { 
              font-family: 'Verdana', 'Arial', sans-serif; 
              font-size: 6px; 
              fill: #535353ff; 
          }
        </style>
      </defs>
      ${images}
      
      <!-- Contribution Label: Wider margins (2% each side -> x=2, width=96) -->
      <rect x="2" y="105" width="96" height="12" rx="2" fill="#FFFFDD" stroke="#e1e4e8" stroke-width="0.5" />
      <text x="50" y="111.5" text-anchor="middle" dominant-baseline="middle" class="label-text">
        ${labelText}
      </text>
    </svg>`.trim();
}

// --- Routes ---

app.get('/', (req, res) => {
    res.render('index');
});

app.get('/info', (req, res) => {
    res.render('info');
});

app.get('/login', (req, res) => {
    console.log("Starting login flow...");
    res.redirect(`https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=read:user`);
});

app.get('/callback', async (req, res) => {
    const { code, error, error_description } = req.query;

    if (error) {
        return res.render('error', {
            errorTitle: "ACCESS DENIED",
            errorMessage: error_description || "Authentication was cancelled or failed."
        });
    }

    try {
        const response = await axios.post('https://github.com/login/oauth/access_token', {
            client_id: GITHUB_CLIENT_ID,
            client_secret: GITHUB_CLIENT_SECRET,
            code
        }, { headers: { Accept: 'application/json' } });

        if (response.data.error) {
            return res.render('error', {
                errorTitle: "TOKEN ERROR",
                errorMessage: response.data.error_description || "Failed to retrieve access token."
            });
        }

        const token = response.data.access_token;
        const userRes = await axios.get('https://api.github.com/user', {
            headers: { Authorization: `token ${token}` }
        });

        const username = userRes.data.login;
        userTokens[username] = token;
        saveTokens();

        req.session.username = username;

        res.render('success', {
            username,
            badgeUrl: `${BASE_URL}/badge/${username}`,
            statsUrl: `${BASE_URL}/stats/${username}`
        });
    } catch (err) {
        console.error(err);
        res.render('error', {
            errorTitle: "SYSTEM ERROR",
            errorMessage: "Something went wrong during authentication."
        });
    }
});

app.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
});

app.get('/controls', (req, res) => {
    if (!req.session || !req.session.username) {
        return res.redirect('/');
    }
    const username = req.session.username;
    res.render('controls', {
        username,
        badgeUrl: `${BASE_URL}/badge/${username}`
    });
});

app.post('/api/refresh-cache', (req, res) => {
    if (!req.session || !req.session.username) {
        return res.status(401).send('Unauthorized');
    }
    badgeCache.delete(req.session.username);
    res.redirect('/controls');
});

app.post('/api/delete-account', async (req, res) => {
    if (!req.session || !req.session.username) {
        return res.status(401).send('Unauthorized');
    }
    const username = req.session.username;
    const token = userTokens[username];

    // Revoke Token
    if (token) {
        try {
            await axios.delete(`https://api.github.com/applications/${GITHUB_CLIENT_ID}/grant`, {
                headers: {
                    Authorization: 'Basic ' + Buffer.from(`${GITHUB_CLIENT_ID}:${GITHUB_CLIENT_SECRET}`).toString('base64')
                },
                data: { access_token: token }
            });
            console.log(`Token revoked for user ${username}`);
        } catch (e) {
            console.error(`Failed to revoke token for ${username}:`, e.message);
        }
    }

    delete userTokens[username];
    badgeCache.delete(username);
    saveTokens();
    req.session = null;
    res.redirect('/');
});

app.get('/badge/:username', async (req, res) => {
    const { username } = req.params;
    const token = userTokens[username];

    // 1. User not registered check -> Fallback SVG (Error State)
    if (!token) {
        res.setHeader('Content-Type', 'image/svg+xml');
        // Generate SVG with error state (0 repos, empty status, "I need to review...")
        return res.send(generateDynamicSVG(0, '', true));
    }

    const cached = badgeCache.get(username);
    if (cached && Date.now() - cached.time < 3600000) {
        res.setHeader('Content-Type', 'image/svg+xml');
        return res.send(cached.svg);
    }

    try {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const [eventsRes, gqlRes] = await Promise.all([
            axios.get(`https://api.github.com/users/${username}/events`, { headers: { Authorization: `token ${token}` } }),
            axios.post('https://api.github.com/graphql', {
                query: `{ user(login: "${username}") { status { emoji message } } }`
            }, { headers: { Authorization: `token ${token}` } })
        ]);

        const repos = new Set(eventsRes.data.filter(e => new Date(e.created_at) > weekAgo).map(e => e.repo.name)).size;
        const status = gqlRes.data.data.user.status?.emoji || gqlRes.data.data.user.status?.message || '';
        const svg = generateDynamicSVG(repos, status);

        badgeCache.set(username, { svg, time: Date.now() });

        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(svg);
    } catch (err) {
        console.error("Badge Gen Error:", err.message);
        // On error (e.g. invalid token, API down) -> Return Fallback SVG
        const svg = generateDynamicSVG(0, '', true);
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(svg);
    }
});

app.get('/stats/:username', async (req, res) => {
    const { username } = req.params;
    const metric = req.query.metric || 'stars';

    // Using the owner's token (the user whose stats we are viewing) as requested: "Todas las llamadas... token del usuario propietario de la página"
    const token = userTokens[username];

    if (!token) {
        return res.status(404).render('error', { errorTitle: "NOT FOUND", errorMessage: "User not registered in Octo-Juggler." });
    }

    try {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);

        const eventsRes = await axios.get(`https://api.github.com/users/${username}/events?per_page=100`, {
            headers: { Authorization: `token ${token}` }
        });

        const recentEvents = eventsRes.data.filter(e => new Date(e.created_at) > weekAgo);
        const repoStats = {};
        const totalEvents = recentEvents.length;

        for (const event of recentEvents) {
            const repoName = event.repo.name;
            if (!repoStats[repoName]) {
                repoStats[repoName] = {
                    name: repoName,
                    url: `https://github.com/${repoName}`,
                    events: 0,
                    stars: 0
                };
            }
            repoStats[repoName].events++;
        }

        const reposToFetch = Object.keys(repoStats);

        await Promise.all(reposToFetch.map(async (repoName) => {
            try {
                const repoDetail = await axios.get(`https://api.github.com/repos/${repoName}`, {
                    headers: { Authorization: `token ${token}` }
                });
                repoStats[repoName].stars = repoDetail.data.stargazers_count;
            } catch (e) {
                console.warn(`Could not fetch details for ${repoName}: ${e.message}`);
                // Proceed without stars if failed
            }
        }));

        let sortedRepos = Object.values(repoStats);

        const metricsConfig = [
            { key: 'stars', label: 'MOST STARS' },
            { key: 'events', label: 'MY ACTIVITY' },
            { key: 'percent_user', label: '% CONTRIBUTION' }
        ];

        if (metric === 'stars') {
            sortedRepos.sort((a, b) => b.stars - a.stars);
            sortedRepos = sortedRepos.map(r => ({ ...r, value: `${r.stars} STRS` }));
        } else if (metric === 'events') {
            sortedRepos.sort((a, b) => b.events - a.events);
            sortedRepos = sortedRepos.map(r => ({ ...r, value: `${r.events} ACTS` }));
        } else if (metric === 'percent_user') {
            sortedRepos.forEach(r => {
                r.percent = totalEvents > 0 ? ((r.events / totalEvents) * 100).toFixed(1) : 0;
            });
            sortedRepos.sort((a, b) => b.percent - a.percent);
            sortedRepos = sortedRepos.map(r => ({ ...r, value: `${r.percent}%` }));
        } else {
            sortedRepos.sort((a, b) => b.stars - a.stars);
            sortedRepos = sortedRepos.map(r => ({ ...r, value: `${r.stars} STRS` }));
        }

        res.render('stats', {
            username,
            badgeUrl: `${BASE_URL}/badge/${username}`,
            repos: sortedRepos,
            metrics: metricsConfig,
            currentMetric: metric,
            currentMetricLabel: metricsConfig.find(m => m.key === metric)?.label || 'METRIC',
            isLoggedIn: !!(req.session && req.session.username)
        });

    } catch (err) {
        console.error("Stats Error:", err.message);
        res.render('error', { errorTitle: "DATA ERROR", errorMessage: "Failed to load statistics. Token might be invalid." });
    }
});

app.listen(port, () => console.log(`Octo-Juggler Arcade running on port ${port}`));
