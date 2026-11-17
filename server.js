"use strict";

const express = require("express");
const crypto = require("node:crypto");

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

const PORT = Number(process.env.PORT || 10000);
const API_SECRET = process.env.API_SECRET;

if (!API_SECRET) {
    console.error("Missing API_SECRET environment variable.");
    process.exit(1);
}

const SERVER_TTL = 30_000;
const RULE_TTL = 10 * 60_000;
const INTENT_TTL = 10 * 60_000;
const CLEANUP_INTERVAL = 5_000;

const servers = new Map();
const rules = new Map();
const intents = new Map();

let admins = {};
let serverSnapshot = [];

function sendError(res, status, error) {
    return res.status(status).json({ error });
}

function authenticate(req, res, next) {
    const header = req.get("Authorization") || "";

    if (!header.startsWith("Bearer ")) {
        return sendError(res, 401, "UNAUTHORIZED");
    }

    const supplied = Buffer.from(header.slice(7));
    const expected = Buffer.from(API_SECRET);

    if (
        supplied.length !== expected.length ||
        !crypto.timingSafeEqual(supplied, expected)
    ) {
        return sendError(res, 401, "UNAUTHORIZED");
    }

    next();
}

function stringValue(value, fallback = "") {
    return typeof value === "string" ? value.trim() : fallback;
}

function numberValue(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}

function playerIds(value) {
    if (!Array.isArray(value)) return [];

    return value
        .map(Number)
        .filter(Number.isSafeInteger);
}

function playerList(value) {
    if (!Array.isArray(value)) return [];

    return value
        .filter(player => player && typeof player === "object")
        .slice(0, 200);
}

function validMode(mode) {
    return mode === "Standard" || mode === "Casual";
}

function publicServer(server) {
    return {
        jobId: server.jobId,
        serverId: server.serverId,
        placeId: server.placeId,
        privateServerId: server.privateServerId,
        accessCode: server.accessCode,
        players: server.players,
        playerIds: server.playerIds,
        playerList: server.playerList,
        maxPlayers: server.maxPlayers,
        region: server.region,
        countryCode: server.countryCode,
        lat: server.lat,
        lon: server.lon,
        gameMode: server.gameMode,
        vip: server.vip,
        vipOwner: server.vipOwner,
        map: server.map,
        prime: server.prime,
        menuHide: server.menuHide,
        serverLocked: server.serverLocked,
        updateMigrating: server.updateMigrating,
        rules: server.rules
    };
}

function rebuildServerSnapshot() {
    serverSnapshot = Array.from(servers.values(), publicServer);
    serverSnapshot.sort((a, b) => b.players - a.players);
}

function cleanupExpiredEntries() {
    const now = Date.now();
    let serversChanged = false;

    for (const [jobId, server] of servers) {
        if (now - server.updatedAt > SERVER_TTL) {
            servers.delete(jobId);
            serversChanged = true;
        }
    }

    for (const [ticket, entry] of rules) {
        if (now - entry.updatedAt > RULE_TTL) {
            rules.delete(ticket);
        }
    }

    for (const [userId, entry] of intents) {
        if (now - entry.updatedAt > INTENT_TTL) {
            intents.delete(userId);
        }
    }

    if (serversChanged) rebuildServerSnapshot();
}

function normalizeServer(body) {
    const ids = playerIds(body.playerIds);

    return {
        jobId: stringValue(body.jobId),
        serverId: stringValue(body.serverId || body.jobId),
        placeId: numberValue(body.placeId),
        privateServerId: stringValue(body.privateServerId) || null,
        accessCode: stringValue(body.accessCode, "0"),
        gameMode: validMode(body.gameMode) ? body.gameMode : "Standard",
        playerIds: ids,
        playerList: playerList(body.playerList),
        players: Math.max(0, numberValue(body.players, ids.length)),
        maxPlayers: Math.max(1, numberValue(body.maxPlayers, 32)),
        region: stringValue(body.region || body.countryCode, "--"),
        countryCode: stringValue(body.countryCode || body.region, "--"),
        lat: numberValue(body.lat),
        lon: numberValue(body.lon),
        vip: Boolean(body.vip),
        vipOwner: body.vipOwner == null ? null : numberValue(body.vipOwner),
        map: typeof body.map === "string" ? body.map : null,
        prime: body.prime === undefined ? null : Boolean(body.prime),
        menuHide: Boolean(body.menuHide),
        serverLocked: Boolean(body.serverLocked),
        updateMigrating: Boolean(body.updateMigrating),
        rules: objectValue(body.rules),
        updatedAt: Date.now()
    };
}

app.get("/", (req, res) => {
    res.json({
        ok: true,
        service: "Roblox Server List API",
        version: "2.1.0"
    });
});

app.get("/health", (req, res) => {
    res.json({
        ok: true,
        servers: servers.size,
        rules: rules.size,
        intents: intents.size,
        admins: Object.keys(admins).length,
        time: new Date().toISOString()
    });
});

app.get("/v1/servers", authenticate, (req, res) => {
    const includeVip = req.query.includeVip === "1" || req.query.includeVip === "true";
    const hasVipOwner = req.query.vipOwner !== undefined;
    const vipOwner = hasVipOwner ? Number(req.query.vipOwner) : null;

    const result = includeVip && hasVipOwner
        ? serverSnapshot.filter(server =>
            !server.vip || Number(server.vipOwner) === vipOwner
        )
        : includeVip
            ? serverSnapshot
            : serverSnapshot.filter(server => !server.vip);

    res.json({ servers: result });
});

app.post("/v1/servers/heartbeat", authenticate, (req, res) => {
    const server = normalizeServer(req.body || {});

    if (!server.jobId) {
        return sendError(res, 400, "MISSING_JOB_ID");
    }

    if (!server.placeId) {
        return sendError(res, 400, "MISSING_PLACE_ID");
    }

    servers.set(server.jobId, server);
    rebuildServerSnapshot();

    res.json({
        ok: true,
        server: publicServer(server)
    });
});

app.delete("/v1/servers/:jobId", authenticate, (req, res) => {
    const jobId = stringValue(req.params.jobId);

    if (!jobId) {
        return sendError(res, 400, "MISSING_JOB_ID");
    }

    const removed = servers.delete(jobId);

    if (removed) rebuildServerSnapshot();

    res.json({ ok: true, removed, jobId });
});

app.post("/v1/rules", authenticate, (req, res) => {
    const body = req.body || {};
    const ticket = stringValue(body.jobId);
    const placeId = numberValue(body.placeId);

    if (!ticket) return sendError(res, 400, "MISSING_RULES_TICKET");
    if (!placeId) return sendError(res, 400, "MISSING_PLACE_ID");

    rules.set(ticket, {
        jobId: ticket,
        placeId,
        rules: objectValue(body.rules),
        updatedAt: Date.now()
    });

    res.json({ ok: true, jobId: ticket, placeId });
});

app.get("/v1/rules/:jobId", authenticate, (req, res) => {
    const ticket = stringValue(req.params.jobId);
    const entry = rules.get(ticket);

    if (!entry || Date.now() - entry.updatedAt > RULE_TTL) {
        if (entry) rules.delete(ticket);
        return sendError(res, 404, "RULES_NOT_FOUND");
    }

    res.json({
        jobId: entry.jobId,
        placeId: entry.placeId,
        rules: entry.rules
    });
});

app.post("/v1/intent", authenticate, (req, res) => {
    const body = req.body || {};
    const userId = numberValue(body.userId);
    const mode = stringValue(body.gameMode, "Standard");
    const placeId = numberValue(body.placeId);
    const ticket = body.rulesTicket ? stringValue(body.rulesTicket) : null;

    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return sendError(res, 400, "MISSING_USER_ID");
    }

    if (!validMode(mode)) {
        return sendError(res, 400, "BAD_GAMEMODE");
    }

    if (!placeId) {
        return sendError(res, 400, "MISSING_PLACE_ID");
    }

    intents.set(String(userId), {
        userId,
        gameMode: mode,
        rulesTicket: ticket,
        ticket,
        placeId,
        rules: objectValue(body.rules),
        updatedAt: Date.now()
    });

    res.json({
        ok: true,
        userId,
        gameMode: mode,
        rulesTicket: ticket
    });
});

app.get("/v1/intent/:userId", authenticate, (req, res) => {
    const userId = numberValue(req.params.userId);

    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return sendError(res, 400, "BAD_USER_ID");
    }

    const key = String(userId);
    const entry = intents.get(key);

    if (!entry || Date.now() - entry.updatedAt > INTENT_TTL) {
        if (entry) intents.delete(key);
        return sendError(res, 404, "INTENT_NOT_FOUND");
    }

    const response = {
        userId: entry.userId,
        gameMode: entry.gameMode,
        rulesTicket: entry.rulesTicket,
        ticket: entry.ticket,
        placeId: entry.placeId,
        rules: entry.rules
    };

    if (req.query.consume === "1" || req.query.consume === "true") {
        intents.delete(key);
    }

    res.json(response);
});

app.get("/v1/admins", authenticate, (req, res) => {
    res.json({ levelsByName: admins });
});

app.put("/v1/admins", authenticate, (req, res) => {
    const levels = req.body?.levelsByName;

    if (!levels || typeof levels !== "object" || Array.isArray(levels)) {
        return sendError(res, 400, "INVALID_LEVELS");
    }

    const clean = {};

    for (const [name, level] of Object.entries(levels)) {
        const normalizedName = name.trim().toLowerCase();
        const numericLevel = Number(level);

        if (!normalizedName || !Number.isFinite(numericLevel)) continue;
        clean[normalizedName] = numericLevel;
    }

    admins = clean;

    res.json({
        ok: true,
        levelsByName: admins
    });
});

const cleanupTimer = setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL);
cleanupTimer.unref();

app.use((req, res) => {
    sendError(res, 404, "NOT_FOUND");
});

app.use((err, req, res, next) => {
    console.error("API ERROR:", err.message || err);

    if (res.headersSent) return next(err);

    const status = err.status === 413 ? 413 : 400;
    sendError(res, status, status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST");
});

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Roblox Server List API listening on port ${PORT}`);
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
