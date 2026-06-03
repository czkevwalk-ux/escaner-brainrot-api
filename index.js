const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '4mb' }));

// =====================================================2
//  AETHER SCAN API — IDEAL (fresh-first + TTL + anti-llenos)
// =====================================================
//  Cambios vs el original (medidos en vivo: 82% de joins fallaban, 67k frescos
//  rechazados con cache 800/FIFO):
//   1) SE SIRVE EL MÁS FRESCO (LIFO: cache.pop()), no el más viejo (shift = muerto).
//   2) TTL DE FRESCURA: no se entrega un id más viejo que FRESHNESS_TTL (≈ muerto
//      por el delay Vietnam↔USA / lobby vaciada).
//   3) NUNCA se rechaza un fresco: si la cache topa, se evicta el MÁS VIEJO.
//   4) ANTI-LLENOS: si el scraper informa playing>=maxPlayers (8/8 inentrable),
//      el id se descarta (defensa por si llega un id lleno).
//   5) Acepta metadatos {servers:[{id,playing,maxPlayers,t}]} y el formato viejo
//      {job_ids:[...]} (100% retrocompatible).
//  Endpoints, nombres de /status y ruteo /notify: idénticos al original.
//  Reversible: el original está en index_original_backup.js.
// =====================================================

const envInt = (k, d) => { const v = parseInt(process.env[k]); return Number.isFinite(v) ? v : d; };

const CACHE_LIMIT       = envInt('CACHE_LIMIT', 3000);            // tope anti-OOM; el regulador real es el TTL
const FRESHNESS_TTL_MS  = envInt('FRESHNESS_TTL_S', 75) * 1000;   // no servir ids más viejos
const EXPIRACION_MS     = envInt('EXPIRACION_S', 60) * 1000;      // bloqueo tras éxito/descarte
const PENDING_TIMEOUT_MS= envInt('PENDING_TIMEOUT_S', 60) * 1000; // 60s: confirma al LLEGAR, pero con delay Vietnam + carga lenta (35 inst/VPS) puede tardar
const MAX_FALLOS        = envInt('MAX_FALLOS', 5);
const STALE_REJECT      = (process.env.STALE_REJECT || 'true').toLowerCase() === 'true';

// cache: [{ id, scrapedAt, playing, max }]  — push al final; pop() del final = MÁS fresco
let cache = [];
const cacheSet = new Set();                 // dedup O(1)
const seenIds = new Map();                  // id -> ts (bloqueado EXPIRACION_MS)
const pendingIds = new Map();               // id -> ts (entregado, esperando confirm)
const failCount = new Map();                // id -> nº de fallos

let stats = {
    jobs_assigned: 0, total_received: 0, active_bots: 0,
    total_unicos: 0, total_repetidos: 0, total_cache_lleno: 0,   // total_cache_lleno = evictados (re-mapeado)
    total_confirmados: 0, total_fallidos: 0, total_descartados: 0,
    total_stale_dropped: 0, total_full_rejected: 0, total_served_null: 0,
};

// ---------- helpers de cache (mantienen cacheSet sincronizado) ----------
function validScrapedAt(t, ahora) {
    const n = Number(t);
    return (Number.isFinite(n) && n > 0 && n <= ahora + 5000) ? n : ahora;
}
function isStale(item, ahora) {
    return FRESHNESS_TTL_MS > 0 && (ahora - item.scrapedAt) > FRESHNESS_TTL_MS;
}
function pushFresh(item) {
    if (cacheSet.has(item.id)) return false;
    if (cache.length >= CACHE_LIMIT) {
        const viejo = cache.shift();                 // evicta el MÁS VIEJO (nunca el fresco)
        if (viejo) { cacheSet.delete(viejo.id); stats.total_cache_lleno++; }
    }
    cache.push(item);
    cacheSet.add(item.id);
    return true;
}
function pushRetryFront(id, scrapedAt) {             // reintento: al FRENTE (baja prioridad bajo pop())
    if (cacheSet.has(id)) return;
    if (cache.length >= CACHE_LIMIT) {
        const viejo = cache.shift();
        if (viejo) cacheSet.delete(viejo.id);
    }
    cache.unshift({ id, scrapedAt, playing: null, max: null });
    cacheSet.add(id);
}
function popFresh(ahora) {                            // sirve el MÁS fresco; descarta stale
    while (cache.length > 0) {
        const item = cache.pop();
        cacheSet.delete(item.id);
        if (isStale(item, ahora)) { stats.total_stale_dropped++; continue; }
        return item;
    }
    return null;
}
function oldestAgeSeconds() {
    if (cache.length === 0) return 0;
    let oldest = cache[0].scrapedAt;
    for (let i = 1; i < cache.length; i++) if (cache[i].scrapedAt < oldest) oldest = cache[i].scrapedAt;
    return Math.round((Date.now() - oldest) / 1000);
}

// ---------- limpieza cada 20s: drena stale + expira seen + recicla pendientes ----------
setInterval(() => {
    const ahora = Date.now();
    let staleDrop = 0, limpios = 0, recuperados = 0;

    // drenar stale por el frente (los más viejos) -> tamaño auto-regulado por TTL
    while (cache.length && (ahora - cache[0].scrapedAt) > FRESHNESS_TTL_MS) {
        const it = cache.shift(); cacheSet.delete(it.id);
        stats.total_stale_dropped++; staleDrop++;
    }
    for (const [id, ts] of seenIds.entries()) {
        if (ahora - ts > EXPIRACION_MS) { seenIds.delete(id); limpios++; }
    }
    for (const [id, ts] of pendingIds.entries()) {
        if (ahora - ts > PENDING_TIMEOUT_MS) {
            pendingIds.delete(id);
            if (!cacheSet.has(id) && !seenIds.has(id) && (ahora - ts) < FRESHNESS_TTL_MS) {
                pushRetryFront(id, ts); recuperados++;
            }
        }
    }
    if (staleDrop || limpios || recuperados)
        console.log(`🧹 stale:-${staleDrop} seen:-${limpios} pend→retry:${recuperados} | cache:${cache.length}/${CACHE_LIMIT}`);
}, 20 * 1000);

// ---------- ruteo Discord (idéntico) ----------
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

// ---------- entregar servidores (MÁS fresco primero) ----------
app.get('/get-server', (req, res) => {
    const item = popFresh(Date.now());
    if (!item) { stats.total_served_null++; return res.json({ job_id: null }); }
    pendingIds.set(item.id, Date.now());
    stats.jobs_assigned++;
    res.json({ job_id: item.id });
});

app.get('/get-batch', (req, res) => {
    const count = parseInt(req.query.count) || 1;
    const ahora = Date.now();
    const servers = [];
    for (let i = 0; i < count; i++) {
        const item = popFresh(ahora);
        if (!item) break;
        pendingIds.set(item.id, ahora);
        servers.push({ job_id: item.id });
        stats.jobs_assigned++;
    }
    if (servers.length === 0) stats.total_served_null++;
    res.json({ servers });
});

// ---------- confirmaciones ----------
app.post('/confirm-success', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });
    pendingIds.delete(job_id);
    failCount.delete(job_id);
    seenIds.set(job_id, Date.now());
    stats.total_confirmados++;
    res.json({ status: "ok" });
});

app.post('/confirm-fail', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });
    pendingIds.delete(job_id);
    stats.total_fallidos++;
    const fallos = (failCount.get(job_id) || 0) + 1;
    if (fallos >= MAX_FALLOS) {
        failCount.delete(job_id);
        seenIds.set(job_id, Date.now());        // bloquear: que NO re-entre
        stats.total_descartados++;
    } else {
        failCount.set(job_id, fallos);
        pushRetryFront(job_id, Date.now());     // reintento al frente (no preempta a los frescos)
    }
    res.json({ status: "ok" });
});

// ---------- recibir del scraper ----------
app.post('/add-servers-bulk', (req, res) => {
    const ahora = Date.now();
    const { job_ids, servers } = req.body;

    let entrada = [];
    if (Array.isArray(servers) && servers.length) {
        entrada = servers.map(s => ({
            id: s.id,
            playing: (s.playing ?? s.p ?? null),
            max: (s.maxPlayers ?? s.m ?? null),
            scrapedAt: validScrapedAt(s.t ?? s.ts, ahora),
        }));
    } else if (Array.isArray(job_ids) && job_ids.length) {
        entrada = job_ids.map(id => ({ id, playing: null, max: null, scrapedAt: ahora }));
    } else {
        return res.json({ status: "empty" });
    }

    let unicos = 0, repetidos = 0, llenos = 0;
    for (const item of entrada) {
        if (!item.id) continue;
        if (STALE_REJECT && item.max != null && item.playing != null && item.playing >= item.max) { llenos++; continue; }
        if (cacheSet.has(item.id) || pendingIds.has(item.id)) { repetidos++; continue; }
        const usado = seenIds.get(item.id);
        if (usado && (ahora - usado) < EXPIRACION_MS) { repetidos++; continue; }
        if (pushFresh(item)) unicos++;
    }

    stats.total_received += entrada.length;
    stats.total_unicos += unicos;
    stats.total_repetidos += repetidos;
    stats.total_full_rejected += llenos;

    if (unicos > 0 || llenos > 0)
        console.log(`📥 ${entrada.length} → +${unicos} 🆕 ${repetidos} 🔁 ${llenos} 🚫llenos | cache:${cache.length}/${CACHE_LIMIT}`);
    res.json({ status: "ok", unicos, repetidos, llenos, cache: cache.length });
});

// ---------- notify -> Discord (idéntico) ----------
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
        console.log(`❌ Discord ${vps_name}: ${e.message}`);
        res.json({ status: "error", reason: e.message });
    }
});

// ---------- status (mismos campos + extras) ----------
app.get('/status', (req, res) => {
    let health = "low";
    if (cache.length > CACHE_LIMIT * 0.25) health = "ok";
    else if (cache.length > CACHE_LIMIT * 0.05) health = "medium";

    const intentos = stats.total_confirmados + stats.total_fallidos;
    const successRate = intentos > 0 ? ((stats.total_confirmados / intentos) * 100).toFixed(1) : "0.0";
    const pctRepetidos = stats.total_received > 0 ? ((stats.total_repetidos / stats.total_received) * 100).toFixed(1) : "0.0";

    res.json({
        health,
        cache_jobs: cache.length,
        cache_limit: CACHE_LIMIT,
        jobs_assigned: stats.jobs_assigned,
        total_received: stats.total_received,
        total_unicos: stats.total_unicos,
        total_repetidos: stats.total_repetidos,
        total_cache_lleno: stats.total_cache_lleno,
        total_confirmados: stats.total_confirmados,
        total_fallidos: stats.total_fallidos,
        total_descartados: stats.total_descartados,
        pendientes_confirmar: pendingIds.size,
        porcentaje_repetidos: pctRepetidos + "%",
        bloqueados_activos: seenIds.size,
        active_bots: stats.active_bots,
        // extras
        version: "ideal-v1",
        success_rate: successRate + "%",
        freshness_ttl_s: FRESHNESS_TTL_MS / 1000,
        hot_oldest_age_s: oldestAgeSeconds(),
        total_stale_dropped: stats.total_stale_dropped,
        total_full_rejected: stats.total_full_rejected,
        total_served_null: stats.total_served_null,
    });
});

app.get('/', (req, res) => res.send('🛰️ Aether Scan API IDEAL - Online'));

process.on('unhandledRejection', (e) => console.error('UnhandledRejection:', e));
process.on('uncaughtException',  (e) => console.error('UncaughtException:', e));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Aether Scan API IDEAL en puerto ${PORT}`);
    console.log(`📦 CACHE_LIMIT:${CACHE_LIMIT} ⏳ TTL:${FRESHNESS_TTL_MS/1000}s 🚫anti-llenos:${STALE_REJECT} | fresh-first(LIFO)`);
    for (let i = 1; i <= 6; i++) console.log(`🔑 WEBHOOK_${i}: ${process.env['WEBHOOK_' + i] ? 'ok' : 'FALTA'}`);
});
