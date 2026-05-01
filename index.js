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
// 🧠 SET GLOBAL CON EXPIRACIÓN DE 3 MINUTOS
// job_id usado → bloqueado 3 min → luego vuelve a ser nuevo
// =====================================================
const EXPIRACION_MS = 3 * 60 * 1000; // 3 minutos
const seenIds = new Map();

// Limpieza automática cada 2 minutos
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
}, 2 * 60 * 1000);

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
    seenIds.set(job_id, Date.now());
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
        seenIds.set(job_id, Date.now());
        servers.push({ job_id });
        stats.jobs_assigned++;
    }
    res.json({ servers });
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

        if (estaEnCache) {
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

    console.log(`📥 Recibidos ${job_ids.length} → aceptados: ${unicos} | bloqueados: ${repetidos} | cache lleno: ${cacheLleno} | cache: ${cache.length}/${CACHE_LIMIT} | bloqueados activos: ${seenIds.size}`);
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
