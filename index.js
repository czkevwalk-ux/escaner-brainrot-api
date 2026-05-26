/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  Aether Scan API — Backend v2 (Freshness-First)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Cambios vs v1 (los 6 fixes auditados):
 *    1. LIFO en /get-server  (antes FIFO) → bots reciben ids MÁS frescos
 *    2. TTL por id en cache (15s) → auto-purga ids viejos antes de servirlos
 *    3. /confirm-fail bloquea 60s (antes re-cache hasta 5 veces) → no contamina
 *    4. cacheIdSet mantenido a nivel módulo → O(1) en dedup (antes O(n))
 *    5. CACHE_LIMIT 800 → 2000 (aprovecha RAM del plan Pro)
 *    6. failCount purga periódica → no más memory leak
 *
 *  API pública SIN CAMBIOS — clientes (scraper Python, Lua bots) intactos.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '2mb' }));

// =====================================================
// 💾 CACHE EN MEMORIA — cada item: { id, pushedAt }
// =====================================================
const CACHE_LIMIT = 2000;                   // ↑ Pro plan: 8GB de RAM, podemos
const FRESHNESS_TTL_MS = 15 * 1000;         // ⏱️ id stale después de 15s
const CACHE_PURGE_INTERVAL_MS = 5 * 1000;   // purga cada 5s

let cache = [];                              // [{id, pushedAt}, ...]  push al final, pop del final
const cacheIdSet = new Set();                // 🚀 lookup O(1) para dedup

// =====================================================
// 🧠 ESTADOS DE JOB_IDS
//   seenIds      → bloqueados 60s (ya visitados o fallaron)
//   pendingIds   → entregados al bot pero sin confirmar (30s)
//   failCount    → contador de fallos por id (purga si > 5min sin update)
// =====================================================
const EXPIRACION_MS         = 60 * 1000;    // 1 min bloqueo tras success o fail
const PENDING_TIMEOUT_MS    = 30 * 1000;    // 30s para confirmar
const MAX_FALLOS            = 3;            // ↓ 5 → 3 (menos retries de basura)
const FAILCOUNT_GC_MS       = 5 * 60 * 1000;// purga failCount > 5min sin update

const seenIds    = new Map();   // id → timestamp
const pendingIds = new Map();   // id → timestamp
const failCount  = new Map();   // id → { count, lastUpdate }

// =====================================================
// ⏱️ LIMPIEZA AUTOMÁTICA
// =====================================================

// (a) Cada 5s: purgar ids stale de la cache principal
setInterval(() => {
    const ahora = Date.now();
    const before = cache.length;
    const newCache = [];
    for (const item of cache) {
        if (ahora - item.pushedAt < FRESHNESS_TTL_MS) {
            newCache.push(item);
        } else {
            cacheIdSet.delete(item.id);
        }
    }
    cache = newCache;
    const purged = before - cache.length;
    if (purged > 0) {
        console.log(`🧹 Purgados ${purged} ids stale (>${FRESHNESS_TTL_MS/1000}s) | cache: ${cache.length}/${CACHE_LIMIT}`);
    }
}, CACHE_PURGE_INTERVAL_MS);

// (b) Cada 60s: limpiar seenIds, pendingIds, failCount
setInterval(() => {
    const ahora = Date.now();
    let limpios = 0;

    // seenIds expirados (>60s)
    for (const [id, ts] of seenIds.entries()) {
        if (ahora - ts > EXPIRACION_MS) {
            seenIds.delete(id);
            limpios++;
        }
    }
    if (limpios > 0) console.log(`🧹 seenIds: ${limpios} expirados | activos: ${seenIds.size}`);

    // pendingIds que nunca confirmaron → bloquear en seenIds (NO devolver a cache)
    // (un bot que no confirmó probablemente murió o el server estaba mal)
    let huerfanos = 0;
    for (const [id, ts] of pendingIds.entries()) {
        if (ahora - ts > PENDING_TIMEOUT_MS) {
            pendingIds.delete(id);
            seenIds.set(id, ahora); // bloquear 60s, no re-cachear
            huerfanos++;
        }
    }
    if (huerfanos > 0) console.log(`⏱️  pendingIds: ${huerfanos} huérfanos → bloqueados 60s`);

    // failCount: purgar entradas viejas (>5min sin update)
    let failPurged = 0;
    for (const [id, info] of failCount.entries()) {
        if (ahora - info.lastUpdate > FAILCOUNT_GC_MS) {
            failCount.delete(id);
            failPurged++;
        }
    }
    if (failPurged > 0) console.log(`🧹 failCount: ${failPurged} obsoletos`);
}, 60 * 1000);

// =====================================================
// 📊 ESTADÍSTICAS
// =====================================================
const stats = {
    jobs_assigned:       0,
    total_received:      0,
    active_bots:         0,
    total_unicos:        0,
    total_repetidos:     0,
    total_cache_lleno:   0,
    total_confirmados:   0,
    total_fallidos:      0,
    total_descartados:   0,
    total_stale_skipped: 0,  // ← NUEVO: ids servidos saltados por TTL
};

// =====================================================
// 🎯 ENRUTADOR: 3 VPS POR CANAL DE DISCORD
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
// 📤 RUTA: ENTREGAR UN SERVIDOR (LIFO + TTL CHECK)
// =====================================================
// Pop del final = id MÁS reciente. Skip si está stale (>15s).
app.get('/get-server', (req, res) => {
    const ahora = Date.now();
    while (cache.length > 0) {
        const item = cache.pop();                // ← LIFO (era shift = FIFO)
        cacheIdSet.delete(item.id);

        if (ahora - item.pushedAt > FRESHNESS_TTL_MS) {
            stats.total_stale_skipped++;
            continue;                             // descartar id viejo, probar el siguiente
        }

        pendingIds.set(item.id, ahora);
        stats.jobs_assigned++;
        return res.json({ job_id: item.id });
    }
    return res.json({ job_id: null });
});

// =====================================================
// 📦 RUTA: ENTREGAR BATCH DE SERVIDORES (LIFO + TTL)
// =====================================================
app.get('/get-batch', (req, res) => {
    const count = Math.max(1, Math.min(parseInt(req.query.count) || 1, 20));
    const ahora = Date.now();
    const servers = [];

    while (servers.length < count && cache.length > 0) {
        const item = cache.pop();                // LIFO
        cacheIdSet.delete(item.id);

        if (ahora - item.pushedAt > FRESHNESS_TTL_MS) {
            stats.total_stale_skipped++;
            continue;
        }

        pendingIds.set(item.id, ahora);
        servers.push({ job_id: item.id });
        stats.jobs_assigned++;
    }

    res.json({ servers });
});

// =====================================================
// ✅ RUTA: CONFIRMAR ENTRADA EXITOSA
// =====================================================
app.post('/confirm-success', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });

    pendingIds.delete(job_id);
    failCount.delete(job_id);
    seenIds.set(job_id, Date.now());
    stats.total_confirmados++;

    res.json({ status: "ok" });
});

// =====================================================
// ❌ RUTA: CONFIRMAR FALLO  (NO re-cachea, va a seenIds)
// =====================================================
// Cambio crítico vs v1: el id fallido NO regresa al cache.
// Va a seenIds (bloqueado 60s). Razón: en Steal a Brainrot, un fallo
// significa "server lleno" o "server muerto" — re-intentarlo en segundos
// es desperdiciar bot-time. Si en 60s sigue listado en /servers/Public,
// el scraper lo recapturará naturalmente.
app.post('/confirm-fail', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });

    pendingIds.delete(job_id);
    stats.total_fallidos++;

    // Trackeamos el fail count para logs/debug, pero NO devolvemos al cache
    const prev = failCount.get(job_id) || { count: 0, lastUpdate: 0 };
    const newCount = prev.count + 1;
    failCount.set(job_id, { count: newCount, lastUpdate: Date.now() });

    if (newCount >= MAX_FALLOS) {
        failCount.delete(job_id);
        stats.total_descartados++;
    }

    // Bloquear 60s para que el scraper no lo re-suba inmediatamente
    seenIds.set(job_id, Date.now());

    res.json({ status: "ok" });
});

// =====================================================
// ⚡ RUTA: RECIBIR SERVIDORES DEL SCRAPER
// =====================================================
app.post('/add-servers-bulk', (req, res) => {
    const { job_ids } = req.body;
    if (!job_ids || job_ids.length === 0) return res.json({ status: "empty" });

    const ahora = Date.now();
    let unicos = 0, repetidos = 0, cacheLleno = 0;

    for (const id of job_ids) {
        // O(1) checks via Sets/Maps
        if (cacheIdSet.has(id))     { repetidos++; continue; }
        if (pendingIds.has(id))     { repetidos++; continue; }

        const visto = seenIds.get(id);
        if (visto && (ahora - visto) < EXPIRACION_MS) {
            repetidos++;
            continue;
        }

        if (cache.length >= CACHE_LIMIT) {
            cacheLleno++;
            continue;
        }

        cache.push({ id, pushedAt: ahora });
        cacheIdSet.add(id);
        unicos++;
    }

    stats.total_received   += job_ids.length;
    stats.total_unicos     += unicos;
    stats.total_repetidos  += repetidos;
    stats.total_cache_lleno += cacheLleno;

    // Log compacto (no se va para arriba como antes con cada batch)
    if (unicos > 0 || cacheLleno > 0) {
        console.log(`📥 ${job_ids.length} → +${unicos} ✅ | ${repetidos} 🔁 | ${cacheLleno} 🚫 | cache: ${cache.length}/${CACHE_LIMIT}`);
    }

    res.json({ status: "ok", unicos, repetidos, cache: cache.length });
});

// =====================================================
// 🔔 RUTA: NOTIFICAR HALLAZGO → ENRUTA A DISCORD
// =====================================================
app.post('/notify', async (req, res) => {
    const { vps_name, payload } = req.body;

    if (!payload) return res.json({ status: "error", reason: "no payload" });

    const webhook = getWebhookByVPS(vps_name);
    if (!webhook) return res.json({ status: "error", reason: "no webhook" });

    try {
        await axios.post(webhook, payload, { timeout: 5000 });
        console.log(`📨 → Discord (${vps_name})`);
        res.json({ status: "ok" });
    } catch (e) {
        console.log(`❌ Webhook ${vps_name}: ${e.message}`);
        res.json({ status: "error", reason: e.message });
    }
});

// =====================================================
// 📊 RUTA: ESTADO DEL SISTEMA
// =====================================================
app.get('/status', (req, res) => {
    let health = "low";
    if (cache.length > 400)      health = "ok";
    else if (cache.length > 100) health = "medium";

    const porcentajeRepetidos = stats.total_received > 0
        ? ((stats.total_repetidos / stats.total_received) * 100).toFixed(1)
        : "0.0";

    // Edad del id más viejo en cache (útil para diagnóstico de freshness)
    let oldest_age_s = null;
    if (cache.length > 0) {
        let oldest = cache[0].pushedAt;
        for (const item of cache) {
            if (item.pushedAt < oldest) oldest = item.pushedAt;
        }
        oldest_age_s = Math.round((Date.now() - oldest) / 1000);
    }

    res.json({
        health,
        cache_jobs:           cache.length,
        cache_limit:          CACHE_LIMIT,
        cache_oldest_age_s:   oldest_age_s,
        freshness_ttl_s:      FRESHNESS_TTL_MS / 1000,
        jobs_assigned:        stats.jobs_assigned,
        total_received:       stats.total_received,
        total_unicos:         stats.total_unicos,
        total_repetidos:      stats.total_repetidos,
        total_cache_lleno:    stats.total_cache_lleno,
        total_confirmados:    stats.total_confirmados,
        total_fallidos:       stats.total_fallidos,
        total_descartados:    stats.total_descartados,
        total_stale_skipped:  stats.total_stale_skipped,
        pendientes_confirmar: pendingIds.size,
        porcentaje_repetidos: porcentajeRepetidos + "%",
        bloqueados_activos:   seenIds.size,
        active_bots:          stats.active_bots,
    });
});

app.get('/', (req, res) => res.send('🛰️ Aether Scan API v2 - Online (Freshness-First)'));

// =====================================================
// 🚀 ARRANQUE
// =====================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log('═'.repeat(60));
    console.log(`🚀 Aether Scan API v2 — puerto ${PORT}`);
    console.log('═'.repeat(60));
    console.log(`📦 CACHE_LIMIT:        ${CACHE_LIMIT}`);
    console.log(`⏱️  FRESHNESS_TTL:      ${FRESHNESS_TTL_MS / 1000}s`);
    console.log(`🚧 MAX_FALLOS:         ${MAX_FALLOS}`);
    console.log(`🔁 Modo:               LIFO (entrega ids más frescos primero)`);
    console.log('─'.repeat(60));
    for (let i = 1; i <= 6; i++) {
        const w = process.env[`WEBHOOK_${i}`];
        console.log(`🔑 WEBHOOK_${i}: ${w ? '✅ configurado' : '❌ FALTA'}`);
    }
    console.log('═'.repeat(60));
});
