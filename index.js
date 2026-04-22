const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// 🔌 CONEXIÓN CON SUPABASE
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 🧠 CACHÉ PARA EVITAR DUPLICADOS EN DISCORD (5 MINUTOS)
const processedJobs = new Set();

// 🛠️ UTILIDAD: CONVERTIR VALORES (Ej: 1B -> 1000M) PARA FILTRADO
function parseGenValue(text) {
    if (!text) return 0;
    const clean = text.toUpperCase().replace(/\s/g, '');
    const num = parseFloat(clean.match(/\d+\.?\d*/) || 0);
    if (clean.includes('B')) return num * 1000;
    return num;
}

// 🎯 ENRUTADOR: 3 VPS POR CANAL (Soporta hasta 20 VPS)
function getWebhookByVPS(vpsName) {
    const num = parseInt(vpsName.replace(/\D/g, '') || 0);
    if (num >= 1 && num <= 3) return process.env.WEBHOOK_1;
    if (num >= 4 && num <= 6) return process.env.WEBHOOK_2;
    if (num >= 7 && num <= 9) return process.env.WEBHOOK_3;
    if (num >= 10 && num <= 12) return process.env.WEBHOOK_4;
    if (num >= 13 && num <= 15) return process.env.WEBHOOK_5;
    if (num >= 16) return process.env.WEBHOOK_6;
    return process.env.WEBHOOK_1;
}

// =====================================================
// 📥 RUTA: RECIBIR HALLAZGO DESDE LOS BOTS
// =====================================================
app.post('/add-server', async (req, res) => {
    const { jobId, brainrots, vps_name, players } = req.body;

    if (processedJobs.has(jobId)) return res.json({ status: "skipped" });

    if (brainrots && brainrots.length > 0) {
        // 1. Guardar en Supabase — 1 SOLA FILA por servidor con todos los brainrots
        const petNames = brainrots.map(p => p.name).join(', ');
        const topPet = brainrots[0]; // El de mayor valor (ya vienen ordenados)
        await supabase.from('hallazgos').insert({
            pet_name: petNames,
            valor_gen: topPet.gen || topPet.value,
            mutacion: topPet.mutation || "None",
            job_id: jobId,
            vps_name: vps_name
        });

        // 2. Filtrar calidad (+30M) para Discord
        const highValue = brainrots.filter(p => parseGenValue(p.gen || p.value) >= 30);

        if (highValue.length > 0) {
            const target = getWebhookByVPS(vps_name);
            if (target) {
                processedJobs.add(jobId);
                setTimeout(() => processedJobs.delete(jobId), 300000);

                let petList = "";
                highValue.forEach(p => {
                    const price = p.gen || p.value;
                    const mutationText = (p.mutation && p.mutation !== "None") ? ` (${p.mutation})` : "";
                    petList += `💎 **${p.name}${mutationText}** ${price}\n`;
                    if (p.inDuel) {
                        petList += `⚠️ **EN DUELO**\n`;
                    }
                });

                const joinerUrl = `https://plsbrainrot.me/joiner?placeId=109983668079237&gameInstanceId=${jobId}`;
                const joinScript = `game:GetService("TeleportService"):TeleportToPlaceInstance(109983668079237, "${jobId}", game.Players.LocalPlayer)`;

                const payload = {
                    embeds: [{
                        author: { name: 'Brainrot Notify | MidJourney' },
                        title: `🔎 PET DETECTED (${highValue.length} Found)`,
                        description: `**DETECTED PETS**\n\n${petList}\n` +
                                     `🆔 **Job ID (PC)**\n\`${jobId}\`\n\n` +
                                     `🆔 **Job ID (Mobile)**\n\`${jobId}\`\n\n` +
                                     `🎮 **Players Online**\n${players || 1}/8\n\n` +
                                     `🤖 **Bot**\n${vps_name}\n\n` +
                                     `🔗 **Quick Join**\n[Click to Join](${joinerUrl})\n\n` +
                                     `📜 **Join Script**\n\`\`\`lua\n${joinScript}\n\`\`\``,
                        color: 5793266,
                        timestamp: new Date()
                    }]
                };

                axios.post(target, payload).catch(e => console.log("Error Discord"));
            }
        }
    }

    await supabase.from('servidores').update({ estado: 'completado' }).eq('job_id', jobId);
    res.json({ status: "ok" });
});

// =====================================================
// 📤 RUTA: ENTREGAR SERVIDOR ÚNICO (GET-SERVER)
// =====================================================
app.get('/get-server', async (req, res) => {
    try {
        const { data, error } = await supabase.rpc('entregar_servidor_v3');
        if (error) throw error;
        if (data && data.length > 0) {
            res.json({ job_id: data[0].id_servidor });
        } else {
            res.json({ job_id: null });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =====================================================
// ⚡ RUTA: INYECTAR SERVIDORES (ADD-BULK)
// =====================================================
app.post('/add-servers-bulk', async (req, res) => {
    const { job_ids } = req.body;
    if (!job_ids || job_ids.length === 0) return res.json({ status: "empty" });

    const { error } = await supabase
        .from('servidores')
        .upsert(
            job_ids.map(id => ({ job_id: id, estado: 'pendiente' })),
            { onConflict: 'job_id' }
        );

    if (error) return res.status(500).json(error);
    res.json({ status: "ok", added: job_ids.length });
});

// =====================================================
// 📊 RUTA: VER ESTADO DE LA COLA
// =====================================================
app.get('/status', async (req, res) => {
    const { count, error } = await supabase
        .from('servidores')
        .select('*', { count: 'exact', head: true })
        .eq('estado', 'pendiente');

    if (error) return res.status(500).json(error);
    res.json({ servidores_pendientes: count });
});

app.get('/', (req, res) => {
    res.send('🛰️ Sistema de Escaneo Industrial Activo');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
