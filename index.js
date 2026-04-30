const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// =====================================================
// 💾 CACHE EN MEMORIA RAM
// =====================================================
const CACHE_LIMIT = 250;
let cache = [];

// =====================================================
// 📊 ESTADÍSTICAS
// =====================================================
let stats = {
    jobs_assigned: 0,
    total_received: 0,
    active_bots: 0,
};

// =====================================================
// 🎯 ENRUTADOR: 3 VPS POR CANAL
// =====================================================
function getWebhookByVPS(vpsName) {
    if (!vpsName) {
        console.log('⚠️ vpsName vacío, usando WEBHOOK_1');
        return process.env.WEBHOOK_1;
    }
    const num = parseInt(vpsName.replace(/\D/g, '') || 0);
    console.log(`🎯 VPS: ${vpsName} → número: ${num}`);
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
        servers.push({ job_id: cache.shift() });
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

    let added = 0;
    for (const id of job_ids) {
        if (cache.length < CACHE_LIMIT) {
            cache.push(id);
            added++;
        }
    }

    stats.total_received += job_ids.length;
    console.log(`📥 Recibidos ${job_ids.length} → agregados ${added} → cache: ${cache.length}/${CACHE_LIMIT}`);
    res.json({ status: "ok", added, cache: cache.length });
});

// =====================================================
// 🔔 RUTA: NOTIFICAR HALLAZGO → ENRUTA A DISCORD
// =====================================================
app.post('/notify', async (req, res) => {
    console.log('📩 /notify recibido');
    console.log('📦 Body:', JSON.stringify(req.body).slice(0, 200));

    const { vps_name, payload } = req.body;

    if (!payload) {
        console.log('❌ No hay payload');
        return res.json({ status: "error", reason: "no payload" });
    }

    const webhook = getWebhookByVPS(vps_name);

    if (!webhook) {
        console.log('❌ Webhook no encontrado para VPS:', vps_name);
        console.log('🔑 WEBHOOK_1 existe:', !!process.env.WEBHOOK_1);
        console.log('🔑 WEBHOOK_2 existe:', !!process.env.WEBHOOK_2);
        return res.json({ status: "error", reason: "no webhook" });
    }

    console.log('✅ Webhook encontrado, enviando a Discord...');

    try {
        await axios.post(webhook, payload);
        console.log(`📨 Enviado exitosamente → ${vps_name}`);
        res.json({ status: "ok" });
    } catch (e) {
        console.log(`❌ Error enviando a Discord: ${e.message}`);
        if (e.response) {
            console.log(`❌ Discord respondió: ${e.response.status} - ${JSON.stringify(e.response.data)}`);
        }
        res.json({ status: "error", reason: e.message });
    }
});

// =====================================================
// 📊 RUTA: ESTADO DEL SISTEMA
// =====================================================
app.get('/status', (req, res) => {
    let health = "low";
    if (cache.length > 100) health = "ok";
    else if (cache.length > 30) health = "medium";

    res.json({
        health,
        cache_jobs: cache.length,
        cache_limit: CACHE_LIMIT,
        jobs_assigned: stats.jobs_assigned,
        total_received: stats.total_received,
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
