/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  Aether Scan API — v3 (Dual Queue Architecture)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  FILOSOFÍA APRENDIDA DE v1 + v2:
 *
 *  ✗ v2 falló porque TTL agresivo vaciaba la cache, los bots recibían null,
 *    el Lua scanner entraba en backoff exponencial 2→30s, y 700 bots
 *    durmiendo simultáneamente colapsaban el throughput.
 *
 *  ✗ v1 sufre porque sirve ids FIFO (los más viejos primero, ya dead servers),
 *    rechaza fresh ids cuando cache está full, y los descartados re-entran
 *    al cache (ciclo infinito de basura).
 *
 *  ✓ v3 combina lo mejor de ambos:
 *    - Cache SIEMPRE llena (sin TTL agresivo) → bots nunca starvan
 *    - Bots reciben los ids MÁS FRESCOS primero (LIFO) → high hit rate
 *    - Ids fallidos van a un pool SEPARADO (retry queue) → no contaminan
 *    - Cache LLENA evicta los más viejos (no los frescos) → freshness in flow
 *    - Descartados se bloquean 60s en seenIds → fix definitivo del ciclo basura
 *
 *  Compatibilidad: API pública 100% igual. Scraper Python + Lua bots INTACTOS.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '2mb' }));

// =====================================================
// ⚙️ CONSTANTES (todas tunables)
// =====================================================
const HOT_CACHE_LIMIT      = 1500;                 // fresh pool — Pro plan aguanta
const RETRY_QUEUE_LIMIT    = 200;                  // pool separado para reintentos
const EXPIRACION_MS        = 60 * 1000;            // bloqueo en seenIds (1 min)
const PENDING_TIMEOUT_MS   = 30 * 1000;            // bot tiene 30s para confirmar
const MAX_FALLOS           = 3;                    // ↓ de 5 (menos basura cycling)
const FAILCOUNT_GC_MS      = 5 * 60 * 1000;        // purga failCount viejos
const CLEANUP_INTERVAL_MS  = 60 * 1000;            // limpieza periódica

// =====================================================
// 💾 ESTRUCTURAS
// =====================================================

// HOT: ids frescos del scraper. LIFO (más nuevo se sirve primero).
// Estructura: [{id, pushedAt}, ...]  push al final, pop del final.
let hotCache = [];

// RETRY: ids que fallaron pero aún tienen vidas. FIFO (más viejo primero).
// Sólo se consume cuando HOT está vacío.
let retryQueue = [];

// Set unificado para dedup O(1) contra AMBAS colas + pending + seen.
const cacheIdSet = new Set();

// Estados externos a la cache
const seenIds    = new Map();   // id → ts (bloqueado 60s tras success/discard)
const pendingIds = new Map();   // id → ts (entregado a bot, esperando confirm)
const failCount  = new Map();   // id → {count, lastUpdate}

// =====================================================
// 📊 STATS (todas instrumentadas para diagnóstico)
// =====================================================
const stats = {
    // Compat v1
    jobs_assigned:      0,
    total_received:     0,
    total_unicos:       0,
    total_repetidos:    0,
    total_confirmados:  0,
    total_fallidos:     0,
    total_descartados:  0,
    active_bots:        0,

    // v3 — observabilidad de la dual queue
    total_evicted_hot:  0,    // ids frescos evictados por cap (fresh out)
    total_served_hot:   0,    // bots que recibieron desde HOT
    total_served_retry: 0,    // bots que recibieron desde RETRY (fallback)
    total_served_null:  0,    // bots que recibieron null (¡malo, queremos 0!)
    total_pending_recycled: 0, // pending huérfanos rescatados al retry queue
};

// =====================================================
// 🔧 HELPERS DE CACHE
// =====================================================

/**
 * Empuja id fresco al HOT. Si HOT está full, evicta el MÁS VIEJO
 * (preservando el id fresco que acaba de llegar).
 */
function pushToHot(id, ahora) {
    if (cacheIdSet.has(id)) return false;

    if (hotCache.length >= HOT_CACHE_LIMIT) {
        // EVICTION: out con el más viejo, dentro con el nuevo (LRU)
        const evicted = hotCache.shift();
        cacheIdSet.delete(evicted.id);
        stats.total_evicted_hot++;
    }

    hotCache.push({ id, pushedAt: ahora });   // LIFO: push al final
    cacheIdSet.add(id);
    return true;
}

/**
 * Empuja id fallido a RETRY queue. Si está full, drop el más viejo.
 * No usa eviction-stats porque retry es de baja calidad — dropear no duele.
 */
function pushToRetry(id, ahora) {
    if (cacheIdSet.has(id)) return false;

    if (retryQueue.length >= RETRY_QUEUE_LIMIT) {
        const dropped = retryQueue.shift();
        cacheIdSet.delete(dropped.id);
    }

    retryQueue.push({ id, pushedAt: ahora });  // FIFO: push al final
    cacheIdSet.add(id);
    return true;
}

/**
 * Lógica de servir bots:
 *   1) HOT primero (pop del final = más nuevo = LIFO)
 *   2) RETRY si HOT vacío (shift del frente = más viejo = FIFO)
 *   3) null si ambos vacíos (esto incrementa total_served_null — métrica de salud)
 */
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

function totalCacheSize() {
    return hotCache.length + retryQueue.length;
}

function oldestAgeSeconds(arr) {
    if (arr.length === 0) return 0;
    let oldest = arr[0].pushedAt;
    for (let i = 1; i < arr.length; i++) {
        if (arr[i].pushedAt < oldest) oldest = arr[i].pushedAt;
    }
    return Math.round((Date.now() - oldest) / 1000);
}

// =====================================================
// 🧹 LIMPIEZA PERIÓDICA (1 min)
// =====================================================
setInterval(() => {
    const ahora = Date.now();
    let limpios = 0, huerfanos = 0, failGc = 0;

    // (1) seenIds expirados (>60s) → eligible para re-entrar al pool
    for (const [id, ts] of seenIds.entries()) {
        if (ahora - ts > EXPIRACION_MS) {
            seenIds.delete(id);
            limpios++;
        }
    }

    // (2) pendingIds huérfanos (bot nunca confirmó en 30s) → al retry queue
    //     Razón: bot pudo haber crashed pero id sigue siendo potencialmente válido.
    //     Va a retry (no a hot) para que tenga menor prioridad que los frescos.
    for (const [id, ts] of pendingIds.entries()) {
        if (ahora - ts > PENDING_TIMEOUT_MS) {
            pendingIds.delete(id);
            // Solo re-encolar si no está ya en algún pool y no está bloqueado
            if (!cacheIdSet.has(id) && !seenIds.has(id)) {
                pushToRetry(id, ahora);
                stats.total_pending_recycled++;
                huerfanos++;
            }
        }
    }

    // (3) failCount obsoletos → memory leak fix
    for (const [id, info] of failCount.entries()) {
        if (ahora - info.lastUpdate > FAILCOUNT_GC_MS) {
            failCount.delete(id);
            failGc++;
        }
    }

    if (limpios > 0 || huerfanos > 0 || failGc > 0) {
        console.log(`🧹 GC | seen:-${limpios} pending→retry:${huerfanos} fail:-${failGc}`);
    }
}, CLEANUP_INTERVAL_MS);

// =====================================================
// 🎯 WEBHOOK ROUTER (sin cambios vs v1)
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
// 📤 GET /get-server
// =====================================================
app.get('/get-server', (req, res) => {
    const item = popFromCache();
    if (!item) return res.json({ job_id: null });

    pendingIds.set(item.id, Date.now());
    stats.jobs_assigned++;
    res.json({ job_id: item.id });
});

// =====================================================
// 📦 GET /get-batch
// =====================================================
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

// =====================================================
// ✅ POST /confirm-success
// =====================================================
app.post('/confirm-success', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });

    pendingIds.delete(job_id);
    failCount.delete(job_id);
    seenIds.set(job_id, Date.now());  // bloquear 60s para no re-servir el mismo
    stats.total_confirmados++;

    console.log(`✅ ${job_id}`);
    res.json({ status: "ok" });
});

// =====================================================
// ❌ POST /confirm-fail
// =====================================================
app.post('/confirm-fail', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });

    pendingIds.delete(job_id);
    stats.total_fallidos++;

    const prev = failCount.get(job_id) || { count: 0, lastUpdate: 0 };
    const newCount = prev.count + 1;
    failCount.set(job_id, { count: newCount, lastUpdate: Date.now() });

    if (newCount >= MAX_FALLOS) {
        // DISCARD: bloquear 60s para que NO re-entre (fix dc6b2b19 bug)
        failCount.delete(job_id);
        seenIds.set(job_id, Date.now());
        stats.total_descartados++;
        console.log(`🗑️  ${job_id} | ${newCount} fails → bloqueado 60s`);
    } else {
        // RETRY: va al pool separado (no contamina HOT)
        pushToRetry(job_id, Date.now());
        console.log(`❌ ${job_id} | ${newCount}/${MAX_FALLOS} → retry`);
    }

    res.json({ status: "ok" });
});

// =====================================================
// ⚡ POST /add-servers-bulk
// =====================================================
app.post('/add-servers-bulk', (req, res) => {
    const { job_ids } = req.body;
    if (!job_ids || job_ids.length === 0) return res.json({ status: "empty" });

    const ahora = Date.now();
    let unicos = 0, repetidos = 0;

    for (const id of job_ids) {
        // Dedup contra: ambas colas, pending, seen (bloqueados <60s)
        if (cacheIdSet.has(id))    { repetidos++; continue; }
        if (pendingIds.has(id))    { repetidos++; continue; }
        const visto = seenIds.get(id);
        if (visto && (ahora - visto) < EXPIRACION_MS) { repetidos++; continue; }

        if (pushToHot(id, ahora)) {
            unicos++;
        }
    }

    stats.total_received  += job_ids.length;
    stats.total_unicos    += unicos;
    stats.total_repetidos += repetidos;

    if (unicos > 0 || repetidos > 5) {
        console.log(
            `📥 ${job_ids.length} → +${unicos} 🆕 | ${repetidos} 🔁 | ` +
            `hot:${hotCache.length}/${HOT_CACHE_LIMIT} retry:${retryQueue.length}`
        );
    }

    res.json({ status: "ok", unicos, repetidos, cache: totalCacheSize() });
});

// =====================================================
// 🔔 POST /notify
// =====================================================
app.post('/notify', async (req, res) => {
    const { vps_name, payload } = req.body;
    if (!payload) return res.json({ status: "error", reason: "no payload" });

    const webhook = getWebhookByVPS(vps_name);
    if (!webhook) return res.json({ status: "error", reason: "no webhook" });

    try {
        await axios.post(webhook, payload, { timeout: 5000 });
        console.log(`📨 → ${vps_name}`);
        res.json({ status: "ok" });
    } catch (e) {
        console.log(`❌ Webhook ${vps_name}: ${e.message}`);
        res.json({ status: "error", reason: e.message });
    }
});

// =====================================================
// 📊 GET /status (compat v1 + métricas nuevas)
// =====================================================
app.get('/status', (req, res) => {
    const total = totalCacheSize();
    let health = "low";
    if (total > 400)      health = "ok";
    else if (total > 100) health = "medium";

    const totalServed = stats.total_served_hot + stats.total_served_retry;
    const hotServePct = totalServed > 0
        ? ((stats.total_served_hot / totalServed) * 100).toFixed(1)
        : "0.0";

    const totalAttempts = stats.total_confirmados + stats.total_fallidos;
    const successRate = totalAttempts > 0
        ? ((stats.total_confirmados / totalAttempts) * 100).toFixed(1)
        : "0.0";

    const porcentajeRepetidos = stats.total_received > 0
        ? ((stats.total_repetidos / stats.total_received) * 100).toFixed(1)
        : "0.0";

    res.json({
        // ──────── Compat estricto con v1 (no romper consumidores) ────────
        health,
        cache_jobs:           total,
        cache_limit:          HOT_CACHE_LIMIT,
        jobs_assigned:        stats.jobs_assigned,
        total_received:       stats.total_received,
        total_unicos:         stats.total_unicos,
        total_repetidos:      stats.total_repetidos,
        total_cache_lleno:    stats.total_evicted_hot,  // re-mapeado conceptualmente
        total_confirmados:    stats.total_confirmados,
        total_fallidos:       stats.total_fallidos,
        total_descartados:    stats.total_descartados,
        pendientes_confirmar: pendingIds.size,
        porcentaje_repetidos: porcentajeRepetidos + "%",
        bloqueados_activos:   seenIds.size,
        active_bots:          stats.active_bots,

        // ──────── Nuevos campos v3 (observabilidad de la dual queue) ────────
        version:              "v3",
        hot_cache_size:       hotCache.length,
        hot_cache_limit:      HOT_CACHE_LIMIT,
        hot_oldest_age_s:     oldestAgeSeconds(hotCache),
        retry_queue_size:     retryQueue.length,
        retry_queue_limit:    RETRY_QUEUE_LIMIT,
        retry_oldest_age_s:   oldestAgeSeconds(retryQueue),
        total_served_hot:     stats.total_served_hot,
        total_served_retry:   stats.total_served_retry,
        total_served_null:    stats.total_served_null,  // ¡debe ser ~0!
        hot_serve_pct:        hotServePct + "%",
        success_rate:         successRate + "%",
        total_pending_recycled: stats.total_pending_recycled,
        max_fallos:           MAX_FALLOS,
    });
});

app.get('/', (req, res) => res.send('🛰️ Aether Scan API v3 — Online (Dual Queue)'));

// =====================================================
// 🛡️ ERROR HANDLERS
// =====================================================
process.on('unhandledRejection', (e) => console.error('💥 UnhandledRejection:', e));
process.on('uncaughtException',  (e) => console.error('💥 UncaughtException:', e));

// =====================================================
// 🚀 START
// =====================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log('═'.repeat(64));
    console.log(`🚀 Aether Scan API v3 — puerto ${PORT}`);
    console.log('═'.repeat(64));
    console.log(`📦 HOT_CACHE_LIMIT:     ${HOT_CACHE_LIMIT}   (LIFO, evicción de viejos)`);
    console.log(`🔄 RETRY_QUEUE_LIMIT:   ${RETRY_QUEUE_LIMIT}    (FIFO, separado de HOT)`);
    console.log(`🚧 MAX_FALLOS:          ${MAX_FALLOS}      (descarte tras N intentos)`);
    console.log(`🚫 EXPIRACION_MS:       ${EXPIRACION_MS / 1000}s    (bloqueo en seenIds)`);
    console.log(`⏱️  PENDING_TIMEOUT:     ${PENDING_TIMEOUT_MS / 1000}s    (bot debe confirmar)`);
    console.log(`🎯 Estrategia:          fresh-first, never-starve, blocked-discards`);
    console.log('─'.repeat(64));
    for (let i = 1; i <= 6; i++) {
        const w = process.env[`WEBHOOK_${i}`];
        console.log(`🔑 WEBHOOK_${i}: ${w ? '✅ configurado' : '❌ FALTA'}`);
    }
    console.log('═'.repeat(64));
});
