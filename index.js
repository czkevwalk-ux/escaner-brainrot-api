/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  Aether Scan API — v3.1-Hobby (Railway Hobby Plan Tuned)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Misma arquitectura de v3.1 Pro, ajustada para vivir cómoda en:
 *    • 512 MB RAM (vs 8 GB del Pro)
 *    • CPU compartido (vs dedicado)
 *    • 100 GB/mes egress (vs 250 GB)
 *
 *  Cambios específicos vs v3.1 Pro:
 *    ▾ HOT_CACHE_LIMIT      : 1500 → 600
 *    ▾ RETRY_QUEUE_LIMIT    : 200  → 80
 *    ▾ seenIds.max          : 50000 → 15000
 *    ▾ pendingIds.max       : 5000  → 1500
 *    ▾ failCount.max        : 5000  → 1500
 *    ▴ HOT_TTL_CHECK_MS     : 30s   → 60s (menos CPU)
 *    ▴ EVENT_LOOP_CHECK_MS  : 5s    → 30s (menos CPU)
 *    ▾ LOG_LEVEL default    : normal → quiet (menos stdout I/O)
 *    ▴ compression threshold: 1024 → 2048 (CPU sweet spot)
 *    + Memory warning automático si heap > 350MB
 *    + node --max-old-space-size=400 (en package.json start)
 *
 *  Lo que se MANTIENE (la arquitectura ganadora):
 *    ✓ Dual queue (HOT LIFO + RETRY FIFO)
 *    ✓ Eviction-on-full (nunca rechaza ids frescos)
 *    ✓ Discarded ids bloqueados 60s (fix dc6b2b19)
 *    ✓ Compression (egress crítico para Hobby de 100GB/mes)
 *    ✓ Keep-alive 65s (reúso conexiones bot↔backend)
 *    ✓ Graceful shutdown SIGTERM
 *    ✓ Health endpoint /health
 *    ✓ Todo ENV-tunable
 *
 *  Capacidad real con esta config:
 *    700 bots × 1 id activo = 700 ids "in flight"
 *    HOT 600 + RETRY 80 = 680 slots → ajustado al uso real
 *    Memoria estimada: ~150-250 MB en operación normal (margen 250+ MB)
 *
 *  API pública: 100% compatible con v1. Lua bots + Python scraper SIN CAMBIOS.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const express = require('express');
const axios = require('axios');
const compression = require('compression');
const { LRUCache } = require('lru-cache');

const app = express();

// =====================================================
// 🎛️ CONFIGURACIÓN (ajustada para Hobby — todo ENV-overridable)
// =====================================================
const envInt   = (name, def) => parseInt(process.env[name])   || def;
const envFloat = (name, def) => parseFloat(process.env[name]) || def;

// Caches — tamaños conservadores para 512MB
const HOT_CACHE_LIMIT       = envInt('HOT_CACHE_LIMIT', 600);              // ↓ vs Pro 1500
const RETRY_QUEUE_LIMIT     = envInt('RETRY_QUEUE_LIMIT', 80);             // ↓ vs Pro 200
const SEEN_MAX              = envInt('SEEN_MAX', 15000);                   // ↓ vs Pro 50000
const PENDING_MAX           = envInt('PENDING_MAX', 1500);                 // ↓ vs Pro 5000
const FAILCOUNT_MAX         = envInt('FAILCOUNT_MAX', 1500);               // ↓ vs Pro 5000

// TTLs (iguales — son lógica de negocio, no de recursos)
const HOT_SOFT_TTL_MS       = envInt('HOT_SOFT_TTL_MS', 5 * 60 * 1000);
const SEEN_TTL_MS           = envInt('SEEN_TTL_MS', 60 * 1000);
const PENDING_TIMEOUT_MS    = envInt('PENDING_TIMEOUT_MS', 30 * 1000);
const FAILCOUNT_TTL_MS      = envInt('FAILCOUNT_TTL_MS', 5 * 60 * 1000);
const MAX_FALLOS            = envInt('MAX_FALLOS', 3);

// Background tasks — menos frecuentes para ahorrar CPU compartido
const HOT_TTL_CHECK_MS      = envInt('HOT_TTL_CHECK_MS', 60 * 1000);       // ↑ vs Pro 30s
const EVENT_LOOP_CHECK_MS   = envInt('EVENT_LOOP_CHECK_MS', 30 * 1000);    // ↑ vs Pro 5s
const HEALTH_LOG_INTERVAL_MS= envInt('HEALTH_LOG_INTERVAL_MS', 10*60*1000);// ↑ vs Pro 5min
const MEMORY_WARN_MB        = envInt('MEMORY_WARN_MB', 350);               // warn si heap > 350MB
const EVENT_LOOP_THRESHOLD  = envInt('EVENT_LOOP_THRESHOLD', 200);         // ↑ tolerancia (Hobby CPU)

// HTTP
const LOG_LEVEL             = process.env.LOG_LEVEL || 'quiet';            // ↓ vs Pro 'normal'
const WEBHOOK_TIMEOUT_MS    = envInt('WEBHOOK_TIMEOUT_MS', 5000);
const COMPRESSION_THRESHOLD = envInt('COMPRESSION_THRESHOLD', 2048);       // ↑ vs Pro 1024

// =====================================================
// 🛡️ MIDDLEWARE
// =====================================================
app.use(express.json({ limit: '1mb' }));    // ↓ vs Pro 2mb (memoria)
app.use(compression({
    threshold: COMPRESSION_THRESHOLD,        // solo comprimir >2KB (CPU sweet spot)
    level: 6,                                // balance velocidad/ratio (default)
}));

// =====================================================
// 💾 ESTRUCTURAS DE DATOS
// =====================================================

let hotCache = [];
let retryQueue = [];
const cacheIdSet = new Set();

const seenIds = new LRUCache({
    max: SEEN_MAX,
    ttl: SEEN_TTL_MS,
    updateAgeOnGet: false,
});

const pendingIds = new LRUCache({
    max: PENDING_MAX,
    ttl: PENDING_TIMEOUT_MS,
    updateAgeOnGet: false,
    dispose: (value, key, reason) => {
        if (reason === 'evict' || reason === 'set') return;
        handlePendingExpire(key);
    },
});

const failCount = new LRUCache({
    max: FAILCOUNT_MAX,
    ttl: FAILCOUNT_TTL_MS,
});

// =====================================================
// 📊 STATS
// =====================================================
const stats = {
    jobs_assigned:           0,
    total_received:          0,
    total_unicos:            0,
    total_repetidos:         0,
    total_confirmados:       0,
    total_fallidos:          0,
    total_descartados:       0,
    total_evicted_hot:       0,
    total_served_hot:        0,
    total_served_retry:      0,
    total_served_null:       0,
    total_pending_recycled:  0,
    total_hot_demoted:       0,
    event_loop_lag_max:      0,
    event_loop_lag_current:  0,
    memory_warn_count:       0,    // hobby: cuántas veces hit memoria alta
    server_started_at:       Date.now(),
};

// =====================================================
// 🔧 HELPERS
// =====================================================

function handlePendingExpire(id) {
    if (cacheIdSet.has(id) || seenIds.has(id)) return;
    pushToRetry(id, Date.now());
    stats.total_pending_recycled++;
}

function pushToHot(id, ahora) {
    if (cacheIdSet.has(id)) return false;
    if (hotCache.length >= HOT_CACHE_LIMIT) {
        const evicted = hotCache.shift();
        cacheIdSet.delete(evicted.id);
        stats.total_evicted_hot++;
    }
    hotCache.push({ id, pushedAt: ahora });
    cacheIdSet.add(id);
    return true;
}

function pushToRetry(id, ahora) {
    if (cacheIdSet.has(id)) return false;
    if (retryQueue.length >= RETRY_QUEUE_LIMIT) {
        const dropped = retryQueue.shift();
        cacheIdSet.delete(dropped.id);
    }
    retryQueue.push({ id, pushedAt: ahora });
    cacheIdSet.add(id);
    return true;
}

function popFromCache() {
    if (hotCache.length > 0) {
        const item = hotCache.pop();
        cacheIdSet.delete(item.id);
        stats.total_served_hot++;
        return item;
    }
    if (retryQueue.length > 0) {
        const item = retryQueue.shift();
        cacheIdSet.delete(item.id);
        stats.total_served_retry++;
        return item;
    }
    stats.total_served_null++;
    return null;
}

function logLevel(level, ...args) {
    if (LOG_LEVEL === 'quiet') return;
    if (level === 'verbose' && LOG_LEVEL !== 'verbose') return;
    console.log(...args);
}

// =====================================================
// ⏱️ TAREAS DE BACKGROUND (menos frecuentes en Hobby)
// =====================================================

// (1) Soft TTL safety net en HOT (60s check en Hobby vs 30s en Pro)
setInterval(() => {
    const ahora = Date.now();
    const survivors = [];
    let demoted = 0;

    for (const item of hotCache) {
        if (ahora - item.pushedAt > HOT_SOFT_TTL_MS) {
            cacheIdSet.delete(item.id);
            if (retryQueue.length < RETRY_QUEUE_LIMIT) {
                retryQueue.push({ id: item.id, pushedAt: ahora });
                cacheIdSet.add(item.id);
            }
            demoted++;
        } else {
            survivors.push(item);
        }
    }

    if (demoted > 0) {
        hotCache = survivors;
        stats.total_hot_demoted += demoted;
        logLevel('normal', `⬇️  ${demoted} items >5min demoted: HOT → RETRY (safety net)`);
    }
}, HOT_TTL_CHECK_MS);

// (2) Event Loop Lag monitoring (cada 30s en Hobby vs 5s en Pro)
setInterval(() => {
    const start = Date.now();
    setImmediate(() => {
        const lag = Date.now() - start;
        stats.event_loop_lag_current = lag;
        if (lag > stats.event_loop_lag_max) stats.event_loop_lag_max = lag;
        if (lag > EVENT_LOOP_THRESHOLD) {
            // En Hobby es esperable cierto lag por CPU compartido — solo loguear si extremo
            console.log(`⚠️  Event Loop lag: ${lag}ms (>${EVENT_LOOP_THRESHOLD}ms)`);
        }
    });
}, EVENT_LOOP_CHECK_MS);

// (3) Memory monitoring (cada 60s — específico Hobby para detectar presión de 512MB)
setInterval(() => {
    const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heapMB > MEMORY_WARN_MB) {
        stats.memory_warn_count++;
        console.log(`⚠️  HEAP HIGH: ${heapMB.toFixed(1)}MB (umbral ${MEMORY_WARN_MB}MB) — caches creciendo`);
        // Intentar forzar GC suave si está disponible (con --expose-gc)
        if (global.gc) {
            global.gc();
            const after = process.memoryUsage().heapUsed / 1024 / 1024;
            console.log(`   GC ejecutado: ${heapMB.toFixed(1)} → ${after.toFixed(1)} MB`);
        }
    }
}, 60 * 1000);

// (4) Health summary log (cada 10min en Hobby vs 5min en Pro)
setInterval(() => {
    const totalCache = hotCache.length + retryQueue.length;
    const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    const uptime = Math.round((Date.now() - stats.server_started_at) / 60000);

    console.log(
        `📊 [${uptime}min] hot:${hotCache.length} retry:${retryQueue.length} ` +
        `served:hot=${stats.total_served_hot}/retry=${stats.total_served_retry}/null=${stats.total_served_null} ` +
        `confirm:${stats.total_confirmados}/${stats.total_confirmados + stats.total_fallidos} mem:${memMB}MB`
    );
}, HEALTH_LOG_INTERVAL_MS);

// =====================================================
// 🎯 WEBHOOK ROUTER (sin cambios)
// =====================================================
function getWebhookByVPS(vpsName) {
    if (!vpsName) return process.env.WEBHOOK_1;
    const num = parseInt(vpsName.replace(/\D/g, '') || 0);
    if (num >= 1  && num <= 3)  return process.env.WEBHOOK_1;
    if (num >= 4  && num <= 6)  return process.env.WEBHOOK_2;
    if (num >= 7  && num <= 9)  return process.env.WEBHOOK_3;
    if (num >= 10 && num <= 12) return process.env.WEBHOOK_4;
    if (num >= 13 && num <= 15) return process.env.WEBHOOK_5;
    if (num >= 16)              return process.env.WEBHOOK_6;
    return process.env.WEBHOOK_1;
}

// =====================================================
// 🛣️ ROUTES
// =====================================================

app.get('/get-server', (req, res) => {
    const item = popFromCache();
    if (!item) return res.json({ job_id: null });
    pendingIds.set(item.id, Date.now());
    stats.jobs_assigned++;
    res.json({ job_id: item.id });
});

app.get('/get-batch', (req, res) => {
    const count = Math.max(1, Math.min(parseInt(req.query.count) || 1, 20));
    const servers = [];
    const ahora = Date.now();
    for (let i = 0; i < count; i++) {
        const item = popFromCache();
        if (!item) break;
        pendingIds.set(item.id, ahora);
        servers.push({ job_id: item.id });
        stats.jobs_assigned++;
    }
    res.json({ servers });
});

app.post('/confirm-success', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });

    pendingIds.delete(job_id);
    failCount.delete(job_id);
    seenIds.set(job_id, Date.now());
    stats.total_confirmados++;

    logLevel('normal', `✅ ${job_id}`);
    res.json({ status: "ok" });
});

app.post('/confirm-fail', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });

    pendingIds.delete(job_id);
    stats.total_fallidos++;

    const prev = failCount.get(job_id) || 0;
    const newCount = prev + 1;
    failCount.set(job_id, newCount);

    if (newCount >= MAX_FALLOS) {
        failCount.delete(job_id);
        seenIds.set(job_id, Date.now());
        stats.total_descartados++;
        logLevel('normal', `🗑️  ${job_id} (${newCount} fails → bloqueado 60s)`);
    } else {
        pushToRetry(job_id, Date.now());
        logLevel('verbose', `❌ ${job_id} (${newCount}/${MAX_FALLOS} → retry)`);
    }

    res.json({ status: "ok" });
});

app.post('/add-servers-bulk', (req, res) => {
    const { job_ids } = req.body;
    if (!job_ids || job_ids.length === 0) return res.json({ status: "empty" });

    const ahora = Date.now();
    let unicos = 0, repetidos = 0;

    for (const id of job_ids) {
        if (cacheIdSet.has(id)) { repetidos++; continue; }
        if (pendingIds.has(id)) { repetidos++; continue; }
        if (seenIds.has(id))    { repetidos++; continue; }

        if (pushToHot(id, ahora)) unicos++;
    }

    stats.total_received  += job_ids.length;
    stats.total_unicos    += unicos;
    stats.total_repetidos += repetidos;

    if (unicos > 0) {
        logLevel('verbose',
            `📥 ${job_ids.length} → +${unicos} 🆕 | ${repetidos} 🔁 | ` +
            `hot:${hotCache.length}/${HOT_CACHE_LIMIT} retry:${retryQueue.length}`
        );
    }

    res.json({
        status: "ok",
        unicos,
        repetidos,
        cache: hotCache.length + retryQueue.length
    });
});

app.post('/notify', async (req, res) => {
    const { vps_name, payload } = req.body;
    if (!payload) return res.json({ status: "error", reason: "no payload" });

    const webhook = getWebhookByVPS(vps_name);
    if (!webhook) return res.json({ status: "error", reason: "no webhook" });

    try {
        await axios.post(webhook, payload, { timeout: WEBHOOK_TIMEOUT_MS });
        logLevel('normal', `📨 → ${vps_name}`);
        res.json({ status: "ok" });
    } catch (e) {
        console.log(`❌ Webhook ${vps_name}: ${e.message}`);
        res.json({ status: "error", reason: e.message });
    }
});

app.get('/status', (req, res) => {
    const totalCache = hotCache.length + retryQueue.length;
    let health = "low";
    if (totalCache > 200)      health = "ok";      // ↓ vs Pro 400 (acorde a cap 600)
    else if (totalCache > 50)  health = "medium";  // ↓ vs Pro 100

    const totalServed = stats.total_served_hot + stats.total_served_retry;
    const hotServePct = totalServed > 0
        ? ((stats.total_served_hot / totalServed) * 100).toFixed(1) : "0.0";

    const totalAttempts = stats.total_confirmados + stats.total_fallidos;
    const successRate = totalAttempts > 0
        ? ((stats.total_confirmados / totalAttempts) * 100).toFixed(1) : "0.0";

    const porcentajeRepetidos = stats.total_received > 0
        ? ((stats.total_repetidos / stats.total_received) * 100).toFixed(1) : "0.0";

    const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    const uptimeS = Math.round((Date.now() - stats.server_started_at) / 1000);

    res.json({
        // Compat v1
        health,
        cache_jobs:           totalCache,
        cache_limit:          HOT_CACHE_LIMIT,
        jobs_assigned:        stats.jobs_assigned,
        total_received:       stats.total_received,
        total_unicos:         stats.total_unicos,
        total_repetidos:      stats.total_repetidos,
        total_cache_lleno:    stats.total_evicted_hot,
        total_confirmados:    stats.total_confirmados,
        total_fallidos:       stats.total_fallidos,
        total_descartados:    stats.total_descartados,
        pendientes_confirmar: pendingIds.size,
        porcentaje_repetidos: porcentajeRepetidos + "%",
        bloqueados_activos:   seenIds.size,
        active_bots:          0,

        // v3.1 extras
        version:                "v3.1-hobby",
        plan_tier:              "hobby",
        hot_cache_size:         hotCache.length,
        hot_cache_limit:        HOT_CACHE_LIMIT,
        hot_oldest_age_s:       hotCache.length > 0
                                ? Math.round((Date.now() - hotCache[0].pushedAt) / 1000) : 0,
        retry_queue_size:       retryQueue.length,
        retry_queue_limit:      RETRY_QUEUE_LIMIT,
        retry_oldest_age_s:     retryQueue.length > 0
                                ? Math.round((Date.now() - retryQueue[0].pushedAt) / 1000) : 0,
        total_served_hot:       stats.total_served_hot,
        total_served_retry:     stats.total_served_retry,
        total_served_null:      stats.total_served_null,
        total_pending_recycled: stats.total_pending_recycled,
        total_hot_demoted:      stats.total_hot_demoted,
        hot_serve_pct:          hotServePct + "%",
        success_rate:           successRate + "%",
        memory_mb:              memMB,
        memory_warn_count:      stats.memory_warn_count,
        event_loop_lag_max_ms:  stats.event_loop_lag_max,
        event_loop_lag_now_ms:  stats.event_loop_lag_current,
        uptime_s:               uptimeS,
        max_fallos:             MAX_FALLOS,
        log_level:              LOG_LEVEL,
    });
});

app.get('/health', (req, res) => {
    const memMB = process.memoryUsage().heapUsed / 1024 / 1024;
    const totalCache = hotCache.length + retryQueue.length;
    const uptimeS = (Date.now() - stats.server_started_at) / 1000;

    // En Hobby los umbrales son más estrictos por menor RAM
    const isHealthy =
        (totalCache > 0 || uptimeS < 60) &&
        memMB < 450 &&                                 // ↓ vs Pro 500
        stats.event_loop_lag_current < 1000;           // ↑ tolerancia Hobby

    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? "healthy" : "unhealthy",
        version: "v3.1-hobby",
        plan_tier: "hobby",
        cache_total: totalCache,
        memory_mb: memMB.toFixed(1),
        memory_limit_mb: 512,
        event_loop_lag_ms: stats.event_loop_lag_current,
        uptime_s: Math.round(uptimeS),
    });
});

app.get('/', (req, res) => res.send('🛰️ Aether Scan API v3.1-Hobby — Online'));

// =====================================================
// 🛡️ ERROR HANDLERS + GRACEFUL SHUTDOWN
// =====================================================
process.on('unhandledRejection', (e) => console.error('💥 UnhandledRejection:', e));
process.on('uncaughtException',  (e) => console.error('💥 UncaughtException:', e));

let server;
const gracefulShutdown = (signal) => {
    console.log(`🛑 ${signal} received, shutting down gracefully...`);
    if (server) {
        server.close(() => {
            console.log('✅ Server cerrado limpiamente');
            process.exit(0);
        });
        setTimeout(() => {
            console.log('⏱️  Force exit tras 10s timeout');
            process.exit(1);
        }, 10000);
    }
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// =====================================================
// 🚀 START
// =====================================================
const PORT = process.env.PORT || 8080;
server = app.listen(PORT, () => {
    console.log('═'.repeat(64));
    console.log(`🚀 Aether Scan API v3.1-HOBBY — puerto ${PORT}`);
    console.log('═'.repeat(64));
    console.log(`💰 Plan tier:            HOBBY (512MB RAM, shared CPU)`);
    console.log(`📦 HOT_CACHE_LIMIT:      ${HOT_CACHE_LIMIT}    (LIFO, evict-on-full)`);
    console.log(`🔄 RETRY_QUEUE_LIMIT:    ${RETRY_QUEUE_LIMIT}     (FIFO, fallback pool)`);
    console.log(`⏰ HOT_SOFT_TTL:         ${HOT_SOFT_TTL_MS / 1000}s   (safety net only)`);
    console.log(`🚫 SEEN_TTL:             ${SEEN_TTL_MS / 1000}s    (bloqueo post-success/discard)`);
    console.log(`⏱️  PENDING_TIMEOUT:     ${PENDING_TIMEOUT_MS / 1000}s    (bot confirma o expira)`);
    console.log(`🚧 MAX_FALLOS:           ${MAX_FALLOS}      (descarte tras N intentos)`);
    console.log(`🧠 MEMORY_WARN:          ${MEMORY_WARN_MB}MB (alerta si heap supera)`);
    console.log(`📊 LOG_LEVEL:            ${LOG_LEVEL}    (Hobby ahorra I/O)`);
    console.log(`🗜️  COMPRESSION:         >${COMPRESSION_THRESHOLD}B (gzip)`);
    console.log(`🎯 Estrategia:           fresh-first LIFO + retry-pool + soft-TTL safety`);
    console.log('─'.repeat(64));
    for (let i = 1; i <= 6; i++) {
        const w = process.env[`WEBHOOK_${i}`];
        console.log(`🔑 WEBHOOK_${i}: ${w ? '✅ configurado' : '❌ FALTA'}`);
    }
    console.log('═'.repeat(64));

    // Hobby memory baseline
    const initMem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    console.log(`📊 Memoria inicial: ${initMem} MB / 512 MB disponibles`);
});

// Keep-alive tuneado (mismo que Pro — ahorra TCP handshakes = ahorra CPU compartido)
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout   = 66 * 1000;
