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
// VPS-1, VPS-2, VPS-3   → WEBHOOK_1
// VPS-4, VPS-5, VPS-6   → WEBHOOK_2
// VPS-7, VPS-8, VPS-9   → WEBHOOK_3
// VPS-10, VPS-11, VPS-12 → WEBHOOK_4
// VPS-13, VPS-14, VPS-15 → WEBHOOK_5
// VPS-16, VPS-17, VPS-18, VPS-19, VPS-20 → WEBHOOK_6
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
// El bot manda el vps_name y Railway decide el canal
// =====================================================
app.post('/notify', async (req, res) => {
    const { vps_name, job_id, player_count, highest_pet, other_pets } = req.body;
    if (!highest_pet) return res.json({ status: "error" });

    const webhook = getWebhookByVPS(vps_name);
    if (!webhook) return res.json({ status: "no_webhook" });

    const joinLink = `https://www.roblox.com/games/start?placeId=109983668079237&gameInstanceId=${job_id}`;
    const otherPetsText = other_pets && other_pets.length > 0 ? other_pets.join('\n') : 'None';
    const duelStatus = highest_pet.duel ? '```✅ Active```' : '```❌ Inactive```';

    const embed = {
        color: 3447003,
        fields: [
            { name: '💎 Highest Pet', value: '```' + `${highest_pet.name} ${highest_pet.gen}` + '```', inline: false },
            { name: '✨ Other Pets', value: '```' + otherPetsText + '```', inline: false },
            { name: '🆔 Server ID', value: '```' + job_id + '```', inline: false },
            { name: '🌐 Join Link', value: `[Click to Join](${joinLink})`, inline: true },
            { name: '👥 Players', value: `${player_count}/8`, inline: true },
            { name: '⚔️ Duel Mode', value: duelStatus, inline: true },
            { name: '🤖 Bot', value: vps_name || 'Unknown', inline: true },
        ],
        footer: { text: 'Aether Scan • MidJourney' },
        timestamp: new Date()
    };

    try {
        await axios.post(webhook, { embeds: [embed] });
        console.log(`📨 Notificación enviada → ${vps_name} → webhook canal`);
    } catch (e) {
        console.log(`❌ Error enviando a Discord: ${e.message}`);
    }

    res.json({ status: "ok" });
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
});
