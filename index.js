const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const processedJobs = new Set();

function parseGenValue(text) {
    if (!text) return 0;
    const clean = text.toUpperCase().replace(/\s/g, '');
    const num = parseFloat(clean.match(/\d+\.?\d*/) || 0);
    if (clean.includes('B')) return num * 1000;
    return num;
}

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

app.post('/add-server', async (req, res) => {
    const { jobId, brainrots, vps_name, players } = req.body;

    if (processedJobs.has(jobId)) return res.json({ status: "skipped" });

    if (brainrots && brainrots.length > 0) {
        // Guardar en Supabase
        await supabase.from('hallazgos').insert(brainrots.map(p => ({
            pet_name: p.name, valor_gen: p.gen, mutacion: p.mutation || "None", job_id: jobId, vps_name: vps_name
        })));

        const highValue = brainrots.filter(p => parseGenValue(p.gen) >= 30);

        if (highValue.length > 0) {
            const target = getWebhookByVPS(vps_name);
            if (target) {
                processedJobs.add(jobId);
                setTimeout(() => processedJobs.delete(jobId), 300000);

                // --- 🎨 DISEÑO TIPO IMAGEN 2 ---
                let petList = "";
                highValue.forEach(p => {
                    petList += `💎 **${p.name}** ${p.gen}\n`;
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
                        color: 5793266, // Color morado/azul de la imagen
                        timestamp: new Date()
                    }]
                };

                axios.post(target, payload).catch(e => console.log("Error DC"));
            }
        }
    }
    
    await supabase.from('servidores').update({ estado: 'completado' }).eq('job_id', jobId);
    res.json({ status: "ok" });
});

app.get('/get-server', async (req, res) => {
    const { data } = await supabase.rpc('entregar_servidor_v2');
    if (data && data.length > 0) res.json({ job_id: data[0].id_servidor });
    else res.json({ job_id: null });
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
