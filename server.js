"use strict";

const express = require("express");

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 10000);

/*
 * ============================================================
 * CONFIG
 * ============================================================
 */

const API_SECRET = process.env.API_SECRET;

if (!API_SECRET) {
    console.error("ERROR: API_SECRET environment variable is missing.");
    process.exit(1);
}

const ADMIN_LEVELS = {
    // Example:
    // "yourrobloxusername": 100
};

/*
 * Servers expire automatically if they haven't sent a heartbeat.
 *
 * Change this if your Roblox heartbeat runs less frequently.
 */
const SERVER_TIMEOUT_MS = 90 * 1000;

/*
 * ============================================================
 * MEMORY STORAGE
 * ============================================================
 *
 * IMPORTANT:
 * This is intentionally simple for the first deployment.
 *
 * If Render restarts the service, these Maps are cleared.
 * For a permanent production server list, move this storage
 * to PostgreSQL/Redis.
 */

const servers = new Map();
const rules = new Map();
const intents = new Map();

/*
 * ============================================================
 * AUTHENTICATION
 * ============================================================
 */

function authenticate(req, res, next) {
    const header = req.get("Authorization") || "";

    if (!header.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "UNAUTHORIZED"
        });
    }

    const supplied = header.slice(7);

    if (supplied !== API_SECRET) {
        return res.status(401).json({
            error: "UNAUTHORIZED"
        });
    }

    next();
}

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

function now() {
    return Date.now();
}

function cleanString(value, fallback = "") {
    if (typeof value !== "string") {
        return fallback;
    }

    return value.trim();
}

function cleanNumber(value, fallback = 0) {
    const n = Number(value);

    return Number.isFinite(n) ? n : fallback;
}

function cleanPlayerIds(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map(Number)
        .filter(Number.isSafeInteger);
}

function cleanPlayerList(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter(entry => entry && typeof entry === "object")
        .slice(0, 100);
}

function normalizeServer(data) {
    const playerIds = cleanPlayerIds(data.playerIds);

    return {
        jobId: cleanString(data.jobId || data.serverId),
        serverId: cleanString(data.serverId || data.jobId),

        placeId: cleanNumber(data.placeId),

        players: Math.max(
            0,
            cleanNumber(data.players, playerIds.length)
        ),

        playerIds,

        playerList: cleanPlayerList(data.playerList),

        maxPlayers: Math.max(
            1,
            cleanNumber(data.maxPlayers, 32)
        ),

        region: cleanString(data.region, "--"),

        accessCode:
            typeof data.accessCode === "string"
                ? data.accessCode
                : undefined,

        gameMode:
            data.gameMode === "Casual"
                ? "Casual"
                : "Standard",

        vip: Boolean(data.vip),

        vipOwner:
            data.vipOwner === undefined ||
            data.vipOwner === null
                ? undefined
                : cleanNumber(data.vipOwner),

        map:
            typeof data.map === "string"
                ? data.map
                : undefined,

        rules:
            data.rules &&
            typeof data.rules === "object"
                ? data.rules
                : {},

        prime: Boolean(data.prime),

        lat: cleanNumber(data.lat, 0),
        lon: cleanNumber(data.lon, 0),

        updatedAt: now()
    };
}

function removeExpiredServers() {
    const cutoff = now() - SERVER_TIMEOUT_MS;

    for (const [id, server] of servers) {
        if (!server.updatedAt || server.updatedAt < cutoff) {
            servers.delete(id);
        }
    }
}

function publicServer(server) {
    return {
        jobId: server.jobId,
        serverId: server.serverId,
        placeId: server.placeId,
        players: server.players,
        playerIds: server.playerIds,
        playerList: server.playerList,
        maxPlayers: server.maxPlayers,
        region: server.region,
        accessCode: server.accessCode,
        gameMode: server.gameMode,
        vip: server.vip,
        vipOwner: server.vipOwner,
        map: server.map,
        rules: server.rules,
        prime: server.prime,
        lat: server.lat,
        lon: server.lon
    };
}

/*
 * ============================================================
 * HEALTH
 * ============================================================
 */

app.get("/", (req, res) => {
    res.json({
        ok: true,
        service: "Roblox Server List API",
        version: "1.0.0"
    });
});

app.get("/health", (req, res) => {
    res.json({
        ok: true,
        servers: servers.size,
        rules: rules.size,
        intents: intents.size,
        time: new Date().toISOString()
    });
});

/*
 * ============================================================
 * GET /v1/servers
 *
 * Used by:
 *
 * Net.List()
 *
 * Supports:
 *
 * ?vipOwner=123
 * ?includeVip=1
 * ============================================================
 */

app.get("/v1/servers", authenticate, (req, res) => {
    removeExpiredServers();

    const includeVip =
        req.query.includeVip === "1" ||
        req.query.includeVip === "true";

    const vipOwner =
        req.query.vipOwner !== undefined
            ? Number(req.query.vipOwner)
            : null;

    const result = [];

    for (const server of servers.values()) {
        if (!server.jobId) {
            continue;
        }

        /*
         * VIP servers are hidden unless the Roblox client
         * specifically requests them.
         */
        if (server.vip) {
            if (!includeVip) {
                continue;
            }

            if (
                vipOwner !== null &&
                Number(server.vipOwner) !== vipOwner
            ) {
                continue;
            }
        }

        result.push(publicServer(server));
    }

    /*
     * Put active servers first.
     */
    result.sort((a, b) => {
        const aPlayers = Number(a.players || 0);
        const bPlayers = Number(b.players || 0);

        return bPlayers - aPlayers;
    });

    res.json({
        servers: result
    });
});

/*
 * ============================================================
 * POST /v1/rules
 *
 * Used by:
 *
 * Net.PutRules(jobId, rules, placeId)
 *
 * The Roblox code uses the generated rulesTicket as jobId.
 * ============================================================
 */

app.post("/v1/rules", authenticate, (req, res) => {
    const body = req.body || {};

    const jobId = cleanString(body.jobId);

    if (!jobId) {
        return res.status(400).json({
            error: "MISSING_JOB_ID"
        });
    }

    const placeId = cleanNumber(body.placeId);

    if (!placeId) {
        return res.status(400).json({
            error: "MISSING_PLACE_ID"
        });
    }

    const stored = {
        jobId,
        placeId,
        rules:
            body.rules &&
            typeof body.rules === "object"
                ? body.rules
                : {},
        createdAt: now(),
        updatedAt: now()
    };

    rules.set(jobId, stored);

    res.status(200).json({
        ok: true,
        jobId,
        placeId
    });
});

/*
 * ============================================================
 * POST /v1/intent
 *
 * Used by:
 *
 * Net.PutIntent(...)
 *
 * This stores the player's requested game mode and rules ticket.
 * ============================================================
 */

app.post("/v1/intent", authenticate, (req, res) => {
    const body = req.body || {};

    const userId = cleanNumber(body.userId);

    if (!userId) {
        return res.status(400).json({
            error: "MISSING_USER_ID"
        });
    }

    const gameMode =
        body.gameMode === "Casual"
            ? "Casual"
            : body.gameMode === "Standard"
                ? "Standard"
                : null;

    if (!gameMode) {
        return res.status(400).json({
            error: "BAD_GAMEMODE"
        });
    }

    const placeId = cleanNumber(body.placeId);

    if (!placeId) {
        return res.status(400).json({
            error: "MISSING_PLACE_ID"
        });
    }

    const rulesTicket =
        body.rulesTicket !== undefined &&
        body.rulesTicket !== null
            ? cleanString(body.rulesTicket)
            : null;

    const key = `${userId}:${placeId}`;

    const stored = {
        userId,
        placeId,
        gameMode,
        rulesTicket,
        rules:
            body.rules &&
            typeof body.rules === "object"
                ? body.rules
                : {},
        updatedAt: now()
    };

    intents.set(key, stored);

    res.status(200).json({
        ok: true,
        userId,
        gameMode,
        rulesTicket
    });
});

/*
 * ============================================================
 * DELETE /v1/servers/:jobId
 *
 * Used by:
 *
 * Net.Drop(jobId)
 *
 * Used when the VIP owner shuts down their server.
 * ============================================================
 */

app.delete("/v1/servers/:jobId", authenticate, (req, res) => {
    const jobId = cleanString(req.params.jobId);

    if (!jobId) {
        return res.status(400).json({
            error: "MISSING_JOB_ID"
        });
    }

    const existed = servers.delete(jobId);

    res.status(200).json({
        ok: true,
        removed: existed,
        jobId
    });
});

/*
 * ============================================================
 * GET /v1/admins
 *
 * Used by:
 *
 * Net.GetAdmins()
 *
 * Roblox expects:
 *
 * {
 *     levelsByName = {
 *         username = 100
 *     }
 * }
 * ============================================================
 */

app.get("/v1/admins", authenticate, (req, res) => {
    res.json({
        levelsByName: ADMIN_LEVELS
    });
});

/*
 * ============================================================
 * INTERNAL SERVER REGISTRATION
 *
 * These endpoints are NOT called by the ServerListNet you sent.
 *
 * They are provided so a Roblox server heartbeat script can
 * register/update its server entry.
 * ============================================================
 */

/*
 * POST /internal/servers/register
 */

app.post("/internal/servers/register", authenticate, (req, res) => {
    const body = req.body || {};

    const server = normalizeServer(body);

    if (!server.jobId) {
        return res.status(400).json({
            error: "MISSING_JOB_ID"
        });
    }

    if (!server.placeId) {
        return res.status(400).json({
            error: "MISSING_PLACE_ID"
        });
    }

    servers.set(server.jobId, server);

    res.json({
        ok: true,
        server: publicServer(server)
    });
});

/*
 * POST /internal/servers/:jobId/heartbeat
 */

app.post(
    "/internal/servers/:jobId/heartbeat",
    authenticate,
    (req, res) => {
        const jobId = cleanString(req.params.jobId);

        if (!jobId) {
            return res.status(400).json({
                error: "MISSING_JOB_ID"
            });
        }

        const existing = servers.get(jobId);

        if (!existing) {
            return res.status(404).json({
                error: "SERVER_NOT_FOUND"
            });
        }

        const incoming = normalize({
            ...existing,
            ...req.body,
            jobId
        });

        servers.set(jobId, incoming);

        res.json({
            ok: true,
            server: publicServer(incoming)
        });
    }
);

/*
 * DELETE /internal/servers/:jobId
 */

app.delete(
    "/internal/servers/:jobId",
    authenticate,
    (req, res) => {
        const jobId = cleanString(req.params.jobId);

        const removed = servers.delete(jobId);

        res.json({
            ok: true,
            removed
        });
    }
);

/*
 * ============================================================
 * CLEANUP
 * ============================================================
 */

setInterval(() => {
    removeExpiredServers();

    /*
     * Remove old rules after 10 minutes.
     */
    const rulesCutoff = now() - 10 * 60 * 1000;

    for (const [key, value] of rules) {
        if (value.updatedAt < rulesCutoff) {
            rules.delete(key);
        }
    }

    /*
     * Remove old intents after 10 minutes.
     */
    const intentCutoff = now() - 10 * 60 * 1000;

    for (const [key, value] of intents) {
        if (value.updatedAt < intentCutoff) {
            intents.delete(key);
        }
    }
}, 30 * 1000);

/*
 * ============================================================
 * ERROR HANDLING
 * ============================================================
 */

app.use((req, res) => {
    res.status(404).json({
        error: "NOT_FOUND"
    });
});

app.use((err, req, res, next) => {
    console.error(err);

    res.status(500).json({
        error: "INTERNAL_SERVER_ERROR"
    });
});

/*
 * ============================================================
 * START
 * ============================================================
 */

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `Roblox Server List API listening on port ${PORT}`
    );
});
