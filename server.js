```javascript
"use strict";

const express = require("express");

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

const PORT = Number(process.env.PORT || 10000);
const API_SECRET = process.env.API_SECRET;

if (!API_SECRET) {
    console.error("Missing API_SECRET environment variable.");
    process.exit(1);
}

/*
============================================================
CONFIG
============================================================
*/

const SERVER_TIMEOUT_MS = 30 * 1000;
const RULE_TIMEOUT_MS = 10 * 60 * 1000;
const INTENT_TIMEOUT_MS = 10 * 60 * 1000;

/*
============================================================
STORAGE

This is memory storage.

IMPORTANT:
Render restarting the service will clear these Maps.

For a permanent production system, use PostgreSQL/Redis.
============================================================
*/

const servers = new Map();
const rules = new Map();
const intents = new Map();

let admins = {};

/*
============================================================
AUTH
============================================================
*/

function authenticate(req, res, next) {
    const header = req.get("Authorization") || "";

    if (!header.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "UNAUTHORIZED"
        });
    }

    const token = header.slice(7);

    if (token !== API_SECRET) {
        return res.status(401).json({
            error: "UNAUTHORIZED"
        });
    }

    next();
}

/*
============================================================
HELPERS
============================================================
*/

function stringValue(value, fallback = "") {
    return typeof value === "string" ? value.trim() : fallback;
}

function numberValue(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function playerIds(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map(Number)
        .filter(Number.isSafeInteger);
}

function playerList(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter(v => v && typeof v === "object")
        .slice(0, 200);
}

function validMode(mode) {
    return mode === "Standard" || mode === "Casual";
}

function cleanup() {
    const now = Date.now();

    /*
    -------------------------
    Servers
    -------------------------
    */

    for (const [jobId, server] of servers) {
        if (
            !server.updatedAt ||
            now - server.updatedAt > SERVER_TIMEOUT_MS
        ) {
            servers.delete(jobId);
        }
    }

    /*
    -------------------------
    Rules
    -------------------------
    */

    for (const [ticket, entry] of rules) {
        if (
            !entry.updatedAt ||
            now - entry.updatedAt > RULE_TIMEOUT_MS
        ) {
            rules.delete(ticket);
        }
    }

    /*
    -------------------------
    Intents
    -------------------------
    */

    for (const [userId, entry] of intents) {
        if (
            !entry.updatedAt ||
            now - entry.updatedAt > INTENT_TIMEOUT_MS
        ) {
            intents.delete(userId);
        }
    }
}

function normalizeServer(body) {
    const ids = playerIds(body.playerIds);

    const maxPlayers = Math.max(
        1,
        numberValue(body.maxPlayers, 32)
    );

    const players = Math.max(
        0,
        numberValue(body.players, ids.length)
    );

    return {
        jobId: stringValue(body.jobId),
        serverId: stringValue(
            body.serverId || body.jobId
        ),

        placeId: numberValue(body.placeId),

        privateServerId:
            stringValue(body.privateServerId) || null,

        accessCode:
            stringValue(body.accessCode, "0"),

        gameMode: validMode(body.gameMode)
            ? body.gameMode
            : "Standard",

        playerIds: ids,

        playerList: playerList(body.playerList),

        players,

        maxPlayers,

        region:
            stringValue(
                body.region ||
                body.countryCode,
                "--"
            ),

        countryCode:
            stringValue(
                body.countryCode ||
                body.region,
                "--"
            ),

        lat: numberValue(body.lat, 0),
        lon: numberValue(body.lon, 0),

        vip: Boolean(body.vip),

        vipOwner:
            body.vipOwner === undefined ||
            body.vipOwner === null
                ? null
                : numberValue(body.vipOwner),

        map:
            typeof body.map === "string"
                ? body.map
                : null,

        prime:
            body.prime === undefined
                ? null
                : Boolean(body.prime),

        menuHide: Boolean(body.menuHide),

        serverLocked: Boolean(body.serverLocked),

        updateMigrating: Boolean(
            body.updateMigrating
        ),

        rules:
            body.rules &&
            typeof body.rules === "object"
                ? body.rules
                : {},

        updatedAt: Date.now()
    };
}

function publicServer(server) {
    return {
        jobId: server.jobId,
        serverId: server.serverId,

        placeId: server.placeId,

        privateServerId:
            server.privateServerId,

        accessCode:
            server.accessCode,

        players:
            server.players,

        playerIds:
            server.playerIds,

        playerList:
            server.playerList,

        maxPlayers:
            server.maxPlayers,

        region:
            server.region,

        countryCode:
            server.countryCode,

        lat:
            server.lat,

        lon:
            server.lon,

        gameMode:
            server.gameMode,

        vip:
            server.vip,

        vipOwner:
            server.vipOwner,

        map:
            server.map,

        prime:
            server.prime,

        menuHide:
            server.menuHide,

        serverLocked:
            server.serverLocked,

        updateMigrating:
            server.updateMigrating,

        rules:
            server.rules
    };
}

/*
============================================================
HEALTH
============================================================
*/

app.get("/", (req, res) => {
    res.json({
        ok: true,
        service: "Roblox Server List API",
        version: "2.0.0"
    });
});

app.get("/health", (req, res) => {
    cleanup();

    res.json({
        ok: true,
        servers: servers.size,
        rules: rules.size,
        intents: intents.size,
        admins: Object.keys(admins).length,
        time: new Date().toISOString()
    });
});

/*
============================================================
GET /v1/servers

Used by the ServerList hub/browser.
============================================================
*/

app.get(
    "/v1/servers",
    authenticate,
    (req, res) => {
        cleanup();

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
            Hide VIP servers unless requested.
            */

            if (server.vip) {

                if (!includeVip) {
                    continue;
                }

                /*
                If a specific VIP owner was requested,
                only return that owner's VIP server.
                */

                if (
                    vipOwner !== null &&
                    Number(server.vipOwner) !== vipOwner
                ) {
                    continue;
                }
            }

            result.push(
                publicServer(server)
            );
        }

        /*
        Active/populated servers first.
        */

        result.sort((a, b) => {
            return (
                Number(b.players || 0) -
                Number(a.players || 0)
            );
        });

        res.json({
            servers: result
        });
    }
);

/*
============================================================
POST /v1/servers/heartbeat

Used by:

Net.Beat(payload)
============================================================
*/

app.post(
    "/v1/servers/heartbeat",
    authenticate,
    (req, res) => {

        cleanup();

        const body = req.body || {};

        const server =
            normalizeServer(body);

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

        servers.set(
            server.jobId,
            server
        );

        res.json({
            ok: true,
            server: publicServer(server)
        });
    }
);

/*
============================================================
DELETE /v1/servers/:jobId

Used by:

Net.Drop(jobId)
============================================================
*/

app.delete(
    "/v1/servers/:jobId",
    authenticate,
    (req, res) => {

        const jobId =
            stringValue(req.params.jobId);

        if (!jobId) {
            return res.status(400).json({
                error: "MISSING_JOB_ID"
            });
        }

        const removed =
            servers.delete(jobId);

        res.json({
            ok: true,
            removed,
            jobId
        });
    }
);

/*
============================================================
POST /v1/rules

Used by:

Net.PutRules(jobId, rules, placeId)
============================================================
*/

app.post(
    "/v1/rules",
    authenticate,
    (req, res) => {

        const body = req.body || {};

        const ticket =
            stringValue(body.jobId);

        if (!ticket) {
            return res.status(400).json({
                error: "MISSING_RULES_TICKET"
            });
        }

        const placeId =
            numberValue(body.placeId);

        if (!placeId) {
            return res.status(400).json({
                error: "MISSING_PLACE_ID"
            });
        }

        const value = {
            jobId: ticket,

            placeId,

            rules:
                body.rules &&
                typeof body.rules === "object"
                    ? body.rules
                    : {},

            updatedAt: Date.now()
        };

        rules.set(
            ticket,
            value
        );

        res.json({
            ok: true,
            jobId: ticket,
            placeId
        });
    }
);

/*
============================================================
GET /v1/rules/:jobId

Used by:

Net.GetRules(jobId)
============================================================
*/

app.get(
    "/v1/rules/:jobId",
    authenticate,
    (req, res) => {

        cleanup();

        const ticket =
            stringValue(req.params.jobId);

        const entry =
            rules.get(ticket);

        if (!entry) {
            return res.status(404).json({
                error: "RULES_NOT_FOUND"
            });
        }

        res.json({
            jobId: entry.jobId,
            placeId: entry.placeId,
            rules: entry.rules
        });
    }
);

/*
============================================================
POST /v1/intent

Used by:

Net.PutIntent(...)
============================================================
*/

app.post(
    "/v1/intent",
    authenticate,
    (req, res) => {

        const body = req.body || {};

        const userId =
            numberValue(body.userId);

        if (!userId) {
            return res.status(400).json({
                error: "MISSING_USER_ID"
            });
        }

        const mode =
            stringValue(
                body.gameMode,
                "Standard"
            );

        if (!validMode(mode)) {
            return res.status(400).json({
                error: "BAD_GAMEMODE"
            });
        }

        const placeId =
            numberValue(body.placeId);

        if (!placeId) {
            return res.status(400).json({
                error: "MISSING_PLACE_ID"
            });
        }

        const ticket =
            body.rulesTicket
                ? stringValue(
                    body.rulesTicket
                )
                : null;

        const entry = {
            userId,

            gameMode:
                mode,

            rulesTicket:
                ticket,

            ticket:
                ticket,

            placeId,

            rules:
                body.rules &&
                typeof body.rules === "object"
                    ? body.rules
                    : {},

            updatedAt:
                Date.now()
        };

        /*
        One pending intent per user.
        */

        intents.set(
            String(userId),
            entry
        );

        res.json({
            ok: true,
            userId,
            gameMode: mode,
            rulesTicket: ticket
        });
    }
);

/*
============================================================
GET /v1/intent/:userId

Used by:

Net.TakeIntent(userId)

The Roblox code sends:

?consume=1

When consume=1, remove the intent after returning it.
============================================================
*/

app.get(
    "/v1/intent/:userId",
    authenticate,
    (req, res) => {

        cleanup();

        const userId =
            numberValue(
                req.params.userId
            );

        if (!userId) {
            return res.status(400).json({
                error: "BAD_USER_ID"
            });
        }

        const key =
            String(userId);

        const entry =
            intents.get(key);

        if (!entry) {
            return res.status(404).json({
                error: "INTENT_NOT_FOUND"
            });
        }

        const response = {
            userId:
                entry.userId,

            gameMode:
                entry.gameMode,

            rulesTicket:
                entry.rulesTicket,

            ticket:
                entry.ticket,

            placeId:
                entry.placeId,

            rules:
                entry.rules
        };

        if (
            req.query.consume === "1" ||
            req.query.consume === "true"
        ) {
            intents.delete(key);
        }

        res.json(response);
    }
);

/*
============================================================
GET /v1/admins

Used by the Hub:

Net.GetAdmins()
============================================================
*/

app.get(
    "/v1/admins",
    authenticate,
    (req, res) => {

        res.json({
            levelsByName:
                admins
        });
    }
);

/*
============================================================
PUT /v1/admins

Used by the main game:

Net.PutAdmins(levelsByName)
============================================================
*/

app.put(
    "/v1/admins",
    authenticate,
    (req, res) => {

        const body =
            req.body || {};

        if (
            !body.levelsByName ||
            typeof body.levelsByName !== "object" ||
            Array.isArray(body.levelsByName)
        ) {
            return res.status(400).json({
                error: "INVALID_LEVELS"
            });
        }

        const clean = {};

        for (
            const [name, level]
            of Object.entries(
                body.levelsByName
            )
        ) {

            if (
                typeof name !== "string" ||
                name.trim() === ""
            ) {
                continue;
            }

            const numericLevel =
                Number(level);

            if (
                !Number.isFinite(
                    numericLevel
                )
            ) {
                continue;
            }

            clean[
                name.toLowerCase()
            ] = numericLevel;
        }

        admins = clean;

        res.json({
            ok: true,
            levelsByName: admins
        });
    }
);

/*
============================================================
CLEANUP LOOP
============================================================
*/

setInterval(
    cleanup,
    10 * 1000
);

/*
============================================================
404
============================================================
*/

app.use(
    (req, res) => {
        res.status(404).json({
            error: "NOT_FOUND"
        });
    }
);

/*
============================================================
ERROR HANDLER
============================================================
*/

app.use(
    (err, req, res, next) => {

        console.error(
            "API ERROR:",
            err
        );

        res.status(500).json({
            error:
                "INTERNAL_SERVER_ERROR"
        });
    }
);

/*
============================================================
START
============================================================
*/

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `Roblox Server List API running on port ${PORT}`
        );
    }
);
```
