const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.json());

// =====================================================1
// 💾 CACHE EN MEMORIA RAM
// OPTIMIZADO PARA 600 BOTS (15 VPS × 40)
// =====================================================
const CACHE_LIMIT = 2000;   // ← 2000 (antes 800) — absorbe bursts del scraper

// =====================================================
// 🧠 ESTADOS DE JOB_IDS
// =====================================================
const EXPIRACION_MS      = 30 * 1000;  // 30s — recicla servers más rápido al scraper
const PENDING_TIMEOUT_MS = 90 * 1000;  // 90s — BATCH=3 × 7s scan + 60s overhead TP/carga
const MAX_FALLOS         = 3;

let cache = [];
const seenIds    = new Map();
const pendingIds = new Map();
const failCount  = new Map();

// Limpieza automática cada 10 segundos — clave para recuperar pendientes rápido
setInterval(() => {
    const ahora = Date.now();
    let limpios = 0;
    for (const [id, timestamp] of seenIds.entries()) {
        if (ahora - timestamp > EXPIRACION_MS) {
            seenIds.delete(id);
            limpios++;
        }
    }
    if (limpios > 0) console.log(`🧹 Limpiados ${limpios} job_ids expirados | activos: ${seenIds.size}`);

    let recuperados = 0;
    for (const [id, timestamp] of pendingIds.entries()) {
        if (ahora - timestamp > PENDING_TIMEOUT_MS) {
            pendingIds.delete(id);
            if (cache.length < CACHE_LIMIT) {
                cache.push(id);
                recuperados++;
            }
        }
    }
    if (recuperados > 0) {
        ventana.recuperados += recuperados;
        console.log(`♻️  Recuperados ${recuperados} pendientes → cache | total pending: ${pendingIds.size}`);
    }
}, 10 * 1000);

// =====================================================
// 📊 ESTADÍSTICAS GLOBALES
// =====================================================
let stats = {
    jobs_assigned:      0,
    total_received:     0,
    total_unicos:       0,
    total_repetidos:    0,
    total_cache_lleno:  0,
    total_confirmados:  0,
    total_fallidos:     0,
    total_descartados:  0,
};

// =====================================================
// 📈 VENTANA DE 30s PARA LOG DE EFICIENCIA
// =====================================================
let ventana = {
    asignados:    0,   // servers entregados a bots
    confirmados:  0,   // bots confirmaron éxito
    fallidos:     0,   // bots confirmaron fallo
    recuperados:  0,   // pendientes recuperados automáticamente
    unicos:       0,   // nuevos únicos del scraper
};

setInterval(() => {
    const { asignados, confirmados, fallidos, recuperados, unicos } = ventana;
    const sinResponder  = asignados - confirmados - fallidos - recuperados;
    const tasaExito     = asignados > 0 ? ((confirmados / asignados) * 100).toFixed(1) : '0.0';
    const tasaRecupero  = asignados > 0 ? ((recuperados / asignados) * 100).toFixed(1) : '0.0';

    let estado = '🔴';
    if (confirmados >= asignados * 0.4) estado = '🟢';
    else if (confirmados >= asignados * 0.2) estado = '🟡';

    console.log(
        `\n${estado} EFICIENCIA 30s ──────────────────────────────\n` +
        `   Cache actual : ${cache.length}/${CACHE_LIMIT} | Pending: ${pendingIds.size} | Blocked: ${seenIds.size}\n` +
        `   Entregados   : ${asignados} servers a bots\n` +
        `   ✅ Confirmados: ${confirmados} (${tasaExito}%) — bots que llegaron exitosamente\n` +
        `   ❌ Fallidos   : ${fallidos} — bots que no pudieron entrar\n` +
        `   ♻️  Recuperados: ${recuperados} (${tasaRecupero}%) — sin confirmar, devueltos al cache\n` +
        `   📥 Nuevos     : ${unicos} servers únicos del scraper\n` +
        `   ❓ Sin resp   : ${Math.max(0, sinResponder)} — aún en vuelo\n` +
        `─────────────────────────────────────────────────\n`
    );

    // Reinicia la ventana
    ventana = { asignados: 0, confirmados: 0, fallidos: 0, recuperados: 0, unicos: 0 };
}, 30 * 1000);

// =====================================================
// 🎯 ENRUTADOR: 3 VPS POR CANAL
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
// 📤 RUTA: ENTREGAR UN SERVIDOR
// =====================================================
app.get('/get-server', (req, res) => {
    if (cache.length === 0) return res.json({ job_id: null });
    const job_id = cache.shift();
    pendingIds.set(job_id, Date.now());
    stats.jobs_assigned++;
    ventana.asignados++;
    res.json({ job_id });
});

// =====================================================
// 📦 RUTA: ENTREGAR BATCH DE SERVIDORES
// =====================================================
app.get('/get-batch', (req, res) => {
    const count   = Math.min(parseInt(req.query.count) || 1, 20); // máx 20 por batch
    const servers = [];
    for (let i = 0; i < count && cache.length > 0; i++) {
        const job_id = cache.shift();
        pendingIds.set(job_id, Date.now());
        servers.push({ job_id });
        stats.jobs_assigned++;
        ventana.asignados++;
    }
    res.json({ servers });
});

// =====================================================
// ✅ RUTA: CONFIRMAR ENTRADA EXITOSA
// =====================================================
app.post('/confirm-success', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });

    // delete() devuelve true si el id ESTABA en pending — si no, el cleanup ya lo recuperó
    const estabaEnPending = pendingIds.delete(job_id);
    failCount.delete(job_id);

    if (estabaEnPending) {
        // Solo bloquear si realmente era nuestro — evita bloquear un server ya en cache
        seenIds.set(job_id, Date.now());
        stats.total_confirmados++;
        ventana.confirmados++;
    }

    res.json({ status: "ok" });
});

// =====================================================
// ❌ RUTA: CONFIRMAR FALLO (máx 3 fallos → descarta)
// =====================================================
app.post('/confirm-fail', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });

    // delete() devuelve true solo si el id AÚN estaba en pending
    // Si el cleanup ya lo recuperó al cache, NO volver a pushear — evita duplicados en cache
    const estabaEnPending = pendingIds.delete(job_id);
    stats.total_fallidos++;
    ventana.fallidos++;

    if (!estabaEnPending) {
        // El cleanup ya lo devolvió al cache — ignorar para no duplicar
        return res.json({ status: "ok" });
    }

    const fallos = (failCount.get(job_id) || 0) + 1;

    if (fallos >= MAX_FALLOS) {
        failCount.delete(job_id);
        stats.total_descartados++;
        console.log(`🗑️  Descartado: ${job_id} | falló ${fallos} veces`);
    } else {
        failCount.set(job_id, fallos);
        if (cache.length < CACHE_LIMIT) {
            cache.push(job_id);
        }
    }

    res.json({ status: "ok" });
});

// =====================================================
// ⚡ RUTA: RECIBIR SERVIDORES DEL SCRAPER
// =====================================================
app.post('/add-servers-bulk', (req, res) => {
    const { job_ids } = req.body;
    if (!job_ids || job_ids.length === 0) return res.json({ status: "empty" });

    const ahora    = Date.now();
    const cacheSet = new Set(cache);
    let unicos     = 0;
    let repetidos  = 0;
    let cacheLleno = 0;

    for (const id of job_ids) {
        if (cacheSet.has(id) || pendingIds.has(id)) {
            repetidos++;
            continue;
        }

        const usadoEn = seenIds.get(id);
        if (usadoEn && (ahora - usadoEn) < EXPIRACION_MS) {
            repetidos++;
            continue;
        }

        if (cache.length < CACHE_LIMIT) {
            cache.push(id);
            cacheSet.add(id);
            unicos++;
        } else {
            cacheLleno++;
        }
    }

    stats.total_received    += job_ids.length;
    stats.total_unicos      += unicos;
    stats.total_repetidos   += repetidos;
    stats.total_cache_lleno += cacheLleno;
    ventana.unicos          += unicos;

    if (unicos > 0 || cacheLleno > 0) {
        console.log(
            `📥 +${job_ids.length} → únicos: ${unicos} | bloq: ${repetidos} | ` +
            `cache lleno: ${cacheLleno} | cache: ${cache.length}/${CACHE_LIMIT}`
        );
    }

    res.json({ status: "ok", unicos, repetidos, cache: cache.length });
});

// =====================================================
// 🔔 RUTA: NOTIFICAR HALLAZGO → DISCORD
// =====================================================
app.post('/notify', async (req, res) => {
    const { vps_name, payload } = req.body;
    if (!payload) return res.json({ status: "error", reason: "no payload" });

    const webhook = getWebhookByVPS(vps_name);
    if (!webhook) return res.json({ status: "error", reason: "no webhook configurado" });

    try {
        await axios.post(webhook, payload, { timeout: 5000 });
        console.log(`📨 Notificación enviada → ${vps_name}`);
        res.json({ status: "ok" });
    } catch (e) {
        console.log(`❌ Error Discord (${vps_name}): ${e.message}`);
        res.json({ status: "error", reason: e.message });
    }
});

// =====================================================
// 🟢 RUTA LIGERA: ¿ESTÁ EL CACHE LLENO?
// Usada por el scraper para pausar cuando no hace falta
// =====================================================
app.get('/cache-status', (req, res) => {
    const porcentaje = cache.length / CACHE_LIMIT;
    res.json({
        full:    porcentaje >= 0.85,           // true si está al 85%+
        cache:   cache.length,
        limit:   CACHE_LIMIT,
        percent: Math.round(porcentaje * 100)
    });
});

// =====================================================
// 📊 RUTA: ESTADO COMPLETO DEL SISTEMA
// =====================================================
app.get('/status', (req, res) => {
    let health = "low";
    if (cache.length > 800)  health = "ok";
    else if (cache.length > 200) health = "medium";

    const pctRepetidos = stats.total_received > 0
        ? ((stats.total_repetidos / stats.total_received) * 100).toFixed(1)
        : 0;

    res.json({
        health,
        cache_jobs:             cache.length,
        cache_limit:            CACHE_LIMIT,
        jobs_assigned:          stats.jobs_assigned,
        total_received:         stats.total_received,
        total_unicos:           stats.total_unicos,
        total_repetidos:        stats.total_repetidos,
        total_cache_lleno:      stats.total_cache_lleno,
        total_confirmados:      stats.total_confirmados,
        total_fallidos:         stats.total_fallidos,
        total_descartados:      stats.total_descartados,
        pendientes_confirmar:   pendingIds.size,
        porcentaje_repetidos:   pctRepetidos + "%",
        bloqueados_activos:     seenIds.size,
        expiracion_seg:         EXPIRACION_MS / 1000,
        pending_timeout_seg:    PENDING_TIMEOUT_MS / 1000,
    });
});

app.get('/', (req, res) => res.send('🛰️ Aether Scan API - Optimizado para 600 bots'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`⚙️  Cache: ${CACHE_LIMIT} | Expiración: ${EXPIRACION_MS/1000}s | Pending: ${PENDING_TIMEOUT_MS/1000}s | Max fallos: ${MAX_FALLOS}`);
    console.log(`🔑 WEBHOOK_1: ${process.env.WEBHOOK_1 ? '✅' : '❌ FALTA'}`);
    console.log(`🔑 WEBHOOK_2: ${process.env.WEBHOOK_2 ? '✅' : '❌ FALTA'}`);
    console.log(`🔑 WEBHOOK_3: ${process.env.WEBHOOK_3 ? '✅' : '❌ FALTA'}`);
    console.log(`🔑 WEBHOOK_4: ${process.env.WEBHOOK_4 ? '✅' : '❌ FALTA'}`);
    console.log(`🔑 WEBHOOK_5: ${process.env.WEBHOOK_5 ? '✅' : '❌ FALTA'}`);
    console.log(`🔑 WEBHOOK_6: ${process.env.WEBHOOK_6 ? '✅' : '❌ FALTA'}`);
});
