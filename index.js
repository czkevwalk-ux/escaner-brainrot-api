const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const processedJobs = new Set();

// --- 🎯 ASIGNAR SERVIDOR (V3 ALEATORIO) ---
app.get('/get-server', async (req, res) => {
    // Forzamos a que no haya cache en la respuesta
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    
    const { data, error } = await supabase.rpc('entregar_servidor_v3');

    if (error) {
        console.error("Error DB:", error.message);
        return res.status(500).json({ job_id: null });
    }

    if (data && data.length > 0) {
        res.json({ job_id: data[0].id_servidor });
    } else {
        res.json({ job_id: null });
    }
});

// --- 📝 REPORTAR HALLAZGOS ---
app.post('/add-server', async (req, res) => {
    const { jobId, brainrots, vps_name, players } = req.body;
    if (processedJobs.has(jobId)) return res.json({ status: "ok" });

    if (brainrots && brainrots.length > 0) {
        await supabase.from('hallazgos').insert(brainrots.map(p => ({
            pet_name: p.name, valor_gen: p.gen, mutacion: p.mutation || "None", job_id: jobId, vps_name: vps_name
        })));

        const vpsNum = parseInt(vps_name.replace(/\D/g, '') || 0);
        let webhook = process.env.WEBHOOK_1;
        if (vpsNum >= 4 && vpsNum <= 6) webhook = process.env.WEBHOOK_2;
        if (vpsNum >= 7 && vpsNum <= 9) webhook = process.env.WEBHOOK_3;
        if (vpsNum >= 10 && vpsNum <= 12) webhook = process.env.WEBHOOK_4;
        if (vpsNum >= 13 && vpsNum <= 15) webhook = process.env.WEBHOOK_5;
        if (vpsNum >= 16) webhook = process.env.WEBHOOK_6;

        const highValue = brainrots.filter(p => {
            const v = parseFloat(p.gen.match(/\d+\.?\d*/) || 0);
            return p.gen.includes('B') ? v * 1000 >= 30 : v >= 30;
        });

        if (highValue.length > 0 && webhook) {
            processedJobs.add(jobId);
            setTimeout(() => processedJobs.delete(jobId), 300000);
            
            let petList = "";
            highValue.forEach(p => { petList += `💎 **${p.name}** ${p.gen}\n`; });

            const joinerUrl = `https://plsbrainrot.me/joiner?placeId=109983668079237&gameInstanceId=${jobId}`;
            const joinScript = `game:GetService("TeleportService"):TeleportToPlaceInstance(109983668079237, "${jobId}", game.Players.LocalPlayer)`;

            axios.post(webhook, {
                embeds: [{
                    author: { name: 'Brainrot Notify | MidJourney' },
                    title: `🔎 PET DETECTED (${highValue.length} Found)`,
                    description: `**DETECTED PETS**\n\n${petList}\n🆔 **Job ID (PC)**\n\`${jobId}\`\n\n🆔 **Job ID (Mobile)**\n\`${jobId}\`\n\n🎮 **Players Online**\n${players || 1}/8\n\n🤖 **Bot**\n${vps_name}\n\n🔗 **Quick Join**\n[Click to Join](${joinerUrl})\n\n📜 **Join Script**\n\`\`\`lua\n${joinScript}\n\`\`\``,
                    color: 5793266,
                    timestamp: new Date()
                }]
            }).catch(() => {});
        }
    }
    await supabase.from('servidores').update({ estado: 'completado' }).eq('job_id', jobId);
    res.json({ status: "ok" });
});

app.post('/add-servers-bulk', async (req, res) => {
    const { job_ids } = req.body;
    await supabase.from('servidores').upsert(job_ids.map(id => ({ job_id: id, estado: 'pendiente' })), { onConflict: 'job_id' });
    res.json({ status: "ok" });
});

app.get('/status', async (req, res) => {
    const { count } = await supabase.from('servidores').select('*', { count: 'exact', head: true }).eq('estado', 'pendiente');
    res.json({ servidores_pendientes: count });
});

app.listen(process.env.PORT || 8080);
