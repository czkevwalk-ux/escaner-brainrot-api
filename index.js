const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// =====================================================
// 💾 CACHE EN MEMORIA RAM
// =====================================================
const CACHE_LIMIT = 800;
let cache = [];

// =====================================================
// 🧠 ESTADOS DE JOB_IDS
// seenIds → bloqueados 1 min (ya visitados)
// pendingIds → entregados pero sin confirmar
// failCount → cuántas veces falló un jobId (máx 5)
// =====================================================
const EXPIRACION_MS = 1 * 60 * 1000; // 1 minuto
const PENDING_TIMEOUT_MS = 30 * 1000; // 30 segundos para confirmar
const MAX_FALLOS = 5;
const seenIds = new Map();
const pendingIds = new Map();
const failCount = new Map();

// Limpieza automática cada 1 minuto
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

    // Limpiar pendientes que nunca confirmaron → devolver al cache
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
    if (recuperados > 0) console.log(`♻️ Recuperados ${recuperados} job_ids sin confirmar → cache`);
}, 60 * 1000);

// =====================================================
// 📊 ESTADÍSTICAS
// =====================================================
let stats = {
    jobs_assigned: 0,
    total_received: 0,
    active_bots: 0,
    total_unicos: 0,
    total_repetidos: 0,
    total_cache_lleno: 0,
    total_confirmados: 0,
    total_fallidos: 0,
    total_descartados: 0,
};

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
    if (cache.length === 0) {
        return res.json({ job_id: null });
    }
    const job_id = cache.shift();
    pendingIds.set(job_id, Date.now());
    stats.jobs_assigned++;
    res.json({ job_id });
});

// =====================================================
// 📦 RUTA: ENTREGAR BATCH DE SERVIDORES
// =====================================================
app.get('/get-batch', (req, res) => {
    const count = parseInt(req.query.count) || 1;
    const servers = [];
    for (let i = 0; i < count && cache.length > 0; i++) {
        const job_id = cache.shift();
        pendingIds.set(job_id, Date.now());
        servers.push({ job_id });
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
    failCount.delete(job_id); // resetear contador de fallos
    seenIds.set(job_id, Date.now());
    stats.total_confirmados++;

    console.log(`✅ Confirmado: ${job_id} | bloqueado 1 min`);
    res.json({ status: "ok" });
});

// =====================================================
// ❌ RUTA: CONFIRMAR FALLO
// Máximo 5 fallos → después se descarta
// =====================================================
app.post('/confirm-fail', (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.json({ status: "error", reason: "no job_id" });

    pendingIds.delete(job_id);
    stats.total_fallidos++;

    const fallos = (failCount.get(job_id) || 0) + 1;

    if (fallos >= MAX_FALLOS) {
        // Descartar definitivamente
        failCount.delete(job_id);
        stats.total_descartados++;
        console.log(`🗑️ Descartado: ${job_id} | falló ${fallos} veces`);
    } else {
        // Devolver al cache con contador actualizado
        failCount.set(job_id, fallos);
        if (cache.length < CACHE_LIMIT) {
            cache.push(job_id);
            console.log(`❌ Fallido: ${job_id} | fallo ${fallos}/${MAX_FALLOS} → devuelto al cache`);
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

    const ahora = Date.now();
    let unicos = 0;
    let repetidos = 0;
    let cacheLleno = 0;
    const cacheSet = new Set(cache);

    for (const id of job_ids) {
        const usadoEn = seenIds.get(id);
        const estaEnCache = cacheSet.has(id);
        const estaPendiente = pendingIds.has(id);

        if (estaEnCache || estaPendiente) {
            repetidos++;
            continue;
        }

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

    stats.total_received += job_ids.length;
    stats.total_unicos += unicos;
    stats.total_repetidos += repetidos;
    stats.total_cache_lleno += cacheLleno;

    console.log(`📥 Recibidos ${job_ids.length} → aceptados: ${unicos} | bloqueados: ${repetidos} | cache lleno: ${cacheLleno} | cache: ${cache.length}/${CACHE_LIMIT}`);
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
        await axios.post(webhook, payload);
        console.log(`📨 Enviado → ${vps_name}`);
        res.json({ status: "ok" });
    } catch (e) {
        console.log(`❌ Error Discord: ${e.message}`);
        res.json({ status: "error", reason: e.message });
    }
});

// =====================================================
// 📊 RUTA: ESTADO DEL SISTEMA
// =====================================================
app.get('/status', (req, res) => {
    let health = "low";
    if (cache.length > 400) health = "ok";
    else if (cache.length > 100) health = "medium";

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
        total_cache_lleno: stats.total_cache_lleno,
        total_confirmados: stats.total_confirmados,
        total_fallidos: stats.total_fallidos,
        total_descartados: stats.total_descartados,
        pendientes_confirmar: pendingIds.size,
        porcentaje_repetidos: porcentajeRepetidos + "%",
        bloqueados_activos: seenIds.size,
        active_bots: stats.active_bots,
    });
});

app.get('/', (req, res) => res.send('🛰️ Aether Scan API - Online'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`🔑 WEBHOOK_1: ${process.env.WEBHOOK_1 ? 'configurado' : 'FALTA'}`);
    console.log(`🔑 WEBHOOK_2: ${process.env.WEBHOOK_2 ? 'configurado' : 'FALTA'}`);
    console.log(`🔑 WEBHOOK_3: ${process.env.WEBHOOK_3 ? 'configurado' : 'FALTA'}`);
    console.log(`🔑 WEBHOOK_4: ${process.env.WEBHOOK_4 ? 'configurado' : 'FALTA'}`);
    console.log(`🔑 WEBHOOK_5: ${process.env.WEBHOOK_5 ? 'configurado' : 'FALTA'}`);
    console.log(`🔑 WEBHOOK_6: ${process.env.WEBHOOK_6 ? 'configurado' : 'FALTA'}`);
});
