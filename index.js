const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// =====================================================
//  AETHER SCAN API  v2  -  cache FRESH-FIRST (LIFO)
// =====================================================
//  Cambios (investigados) vs la version FIFO:
//   - Sirve el server MAS NUEVO primero (LIFO) -> los 1/8 frescos salen YA,1 
//     que es justo lo que pide Steal a Brainrot (se llenan en segundos).
//   - NUNCA descarta un server fresco: si el cache se llena, evicta el MAS VIEJO.
//   - Cache mas grande (800 -> 3000) como buffer para ~800 bots (20 VPS x ~40).
//   - Dedup O(1) con un Set persistente (antes reconstruia un Set por request).
//
//  RAILWAY HOBBY: esto usa <50 MB RAM y operaciones O(1) por request; entra
//  de sobra en el limite de 8 GB / 8 vCPU. El costo real en Hobby es CPU-seg +
//  egress, por eso TODO es O(1) y las respuestas son minimas.
// =====================================================

// =====================================================
//  CACHE EN MEMORIA (FRESH-FIRST)
//  cache[fin] = MAS NUEVO (se sirve primero) | cache[0] = MAS VIEJO (se evicta)
// =====================================================
const CACHE_LIMIT = 3000;
let cache = [];
const cacheSet = new Set();   // espejo para dedup O(1) (no reconstruir por request)

// =====================================================
//  ESTADOS DE JOB_IDS
//   seenIds   -> confirmados, bloqueados 1 min (no re-servir enseguida)
//   pendingIds-> entregados pero sin confirmar (30 s para confirmar)
//   failCount -> cuantas veces fallo un jobId (max 5 -> se descarta)
// =====================================================
const EXPIRACION_MS = 1 * 60 * 1000;   // 1 minuto
const PENDING_TIMEOUT_MS = 30 * 1000;  // 30 segundos
const MAX_FALLOS = 5;
const seenIds = new Map();
const pendingIds = new Map();
const failCount = new Map();

// =====================================================
//  ESTADISTICAS
// =====================================================
let stats = {
    jobs_assigned: 0,
    total_received: 0,
    active_bots: 0,
    total_unicos: 0,
    total_repetidos: 0,
    total_evictados: 0,      // viejos eliminados para meter frescos (antes: cache_lleno)
    total_confirmados: 0,
    total_fallidos: 0,
    total_descartados: 0,
};

// =====================================================
//  HELPERS DE CACHE (mantienen cacheSet sincronizado, todo O(1)/amortizado)
// =====================================================
function evictOldestIfFull() {
    while (cache.length > CACHE_LIMIT) {
        const viejo = cache.shift();       // saca el MAS VIEJO (fondo)
        cacheSet.delete(viejo);
        stats.total_evictados++;
    }
}
function addFresh(id) {                     // server FRESCO del scraper -> tope (se sirve primero)
    cache.push(id);
    cacheSet.add(id);
    evictOldestIfFull();
}
function addRetry(id) {                     // reintento de baja prioridad -> fondo, SOLO si hay sitio
    if (cacheSet.has(id)) return false;
    if (cache.length >= CACHE_LIMIT) { stats.total_evictados++; return false; }
    cache.unshift(id);
    cacheSet.add(id);
    return true;
}
function serveOne() {                       // bot pide -> el MAS NUEVO (LIFO)
    const id = cache.pop();
    if (id !== undefined) cacheSet.delete(id);
    return id;
}

// =====================================================
//  LIMPIEZA cada 60 s: expira seen + recupera pendientes sin confirmar
// =====================================================
setInterval(() => {
    const ahora = Date.now();
    let limpios = 0;
    for (const [id, ts] of seenIds.entries()) {
        if (ahora - ts > EXPIRACION_MS) { seenIds.delete(id); limpios++; }
    }
    if (limpios > 0) console.log(`🧹 ${limpios} seen expirados | activos: ${seenIds.size}`);

    let recuperados = 0;
    for (const [id, ts] of pendingIds.entries()) {
        if (ahora - ts > PENDING_TIMEOUT_MS) {
            pendingIds.delete(id);
            if (addRetry(id)) recuperados++;   // vuelve como baja prioridad (fondo)
        }
    }
    if (recuperados > 0) console.log(`♻️ ${recuperados} pendientes -> cache (baja prioridad)`);
}, 60 * 1000);

// =====================================================
//  ENRUTADOR DISCORD: 3 VPS POR CANAL  (sin cambios)
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
//  /get-server  (un server: el MAS NUEVO)
// =====================================================
app.get('/get-server', (req, res) => {
    const job_id = serveOne();
    if (job_id === undefined) return res.json({ job_id: null });
    pendingIds.set(job_id, Date.now());
    stats.jobs_assigned++;
    res.json({ job_id });
});

// =====================================================
//  /get-batch?count=N  (lote: los N mas nuevos) -- recomendado para los bots
// =====================================================
app.get('/get-batch', (req, res) => {
    let count = parseInt(req.query.count) || 1;
    if (count > 50) count = 50;            // tope sano (CPU/egress Hobby)
    const servers = [];
    for (let i = 0; i < count; i++) {
        const job_id = serveOne();
        if (job_id === undefined) break;   // cache vacio
        pendingIds.set(job_id, Date.now());
        servers.push({ job_id });
        stats.jobs_assigned++;
    }
    res.json({ servers });
});

// =====================================================
//  /confirm-success  (el bot entro bien)
// =====================================================
app.post('/confirm-success', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });

    pendingIds.delete(job_id);
    failCount.delete(job_id);
    seenIds.set(job_id, Date.now());       // bloqueado 1 min
    stats.total_confirmados++;
    res.json({ status: "ok" });
});

// =====================================================
//  /confirm-fail  (max 5 fallos -> descartar; si no, reintento baja prioridad)
// =====================================================
app.post('/confirm-fail', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });

    pendingIds.delete(job_id);
    stats.total_fallidos++;

    const fallos = (failCount.get(job_id) || 0) + 1;
    if (fallos >= MAX_FALLOS) {
        failCount.delete(job_id);
        stats.total_descartados++;
    } else {
        failCount.set(job_id, fallos);
        addRetry(job_id);                  // al fondo, sin pelear con los frescos
    }
    res.json({ status: "ok" });
});

// =====================================================
//  /add-servers-bulk  (del scraper)  - dedup O(1), fresh-first, sin descartar frescos
// =====================================================
app.post('/add-servers-bulk', (req, res) => {
    const { job_ids } = req.body;
    if (!job_ids || job_ids.length === 0) return res.json({ status: "empty" });

    const ahora = Date.now();
    let unicos = 0, repetidos = 0;

    for (const id of job_ids) {
        if (cacheSet.has(id) || pendingIds.has(id)) { repetidos++; continue; }
        const usadoEn = seenIds.get(id);
        if (usadoEn && (ahora - usadoEn) < EXPIRACION_MS) { repetidos++; continue; }
        addFresh(id);     // entra al tope; si rebalsa, se evicta el MAS VIEJO (no el fresco)
        unicos++;
    }

    stats.total_received += job_ids.length;
    stats.total_unicos += unicos;
    stats.total_repetidos += repetidos;

    res.json({ status: "ok", unicos, repetidos, cache: cache.length });
});

// =====================================================
//  /notify  -> ENRUTA A DISCORD  (sin cambios)
// =====================================================
app.post('/notify', async (req, res) => {
    const { vps_name, payload } = req.body;
    if (!payload) return res.json({ status: "error", reason: "no payload" });

    const webhook = getWebhookByVPS(vps_name);
    if (!webhook) return res.json({ status: "error", reason: "no webhook" });

    try {
        await axios.post(webhook, payload);
        console.log(`📨 Enviado → ${vps_name}`);
        res.json({ status: "ok" });
    } catch (e) {
        console.log(`❌ Error Discord: ${e.message}`);
        res.json({ status: "error", reason: e.message });
    }
});

// =====================================================
//  /status
// =====================================================
app.get('/status', (req, res) => {
    let health = "low";
    if (cache.length > CACHE_LIMIT * 0.5) health = "ok";
    else if (cache.length > CACHE_LIMIT * 0.15) health = "medium";

    const porcentajeRepetidos = stats.total_received > 0
        ? ((stats.total_repetidos / stats.total_received) * 100).toFixed(1)
        : 0;

    res.json({
        health,
        cache_jobs: cache.length,
        cache_limit: CACHE_LIMIT,
        jobs_assigned: stats.jobs_assigned,
        total_received: stats.total_received,
        total_unicos: stats.total_unicos,
        total_repetidos: stats.total_repetidos,
        total_evictados: stats.total_evictados,
        total_confirmados: stats.total_confirmados,
        total_fallidos: stats.total_fallidos,
        total_descartados: stats.total_descartados,
        pendientes_confirmar: pendingIds.size,
        porcentaje_repetidos: porcentajeRepetidos + "%",
        bloqueados_activos: seenIds.size,
        active_bots: stats.active_bots,
    });
});

app.get('/', (req, res) => res.send('🛰️ Aether Scan API v2 (fresh-first) - Online'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Servidor v2 (fresh-first) corriendo en puerto ${PORT}`);
    console.log(`📦 CACHE_LIMIT: ${CACHE_LIMIT} | modo: LIFO (mas nuevo primero) + evicta el mas viejo`);
    for (let i = 1; i <= 6; i++) {
        console.log(`🔑 WEBHOOK_${i}: ${process.env['WEBHOOK_' + i] ? 'configurado' : 'FALTA'}`);
    }
});
