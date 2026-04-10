const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 🛡️ MEMORIA ANTI-DUPLICADOS (Guarda los IDs ya enviados a Discord)
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
    const { jobId, brainrots, vps_name } = req.body;

    // 🛡️ FILTRO ANTI-CHOQUE: Si este servidor ya se reportó, ignoramos el segundo mensaje
    if (processedJobs.has(jobId)) {
        console.log(`🚫 Bloqueado reporte duplicado del server: ${jobId}`);
        return res.json({ status: "already_processed" });
    }

    if (brainrots && brainrots.length > 0) {
        // Guardar en Supabase
        await supabase.from('hallazgos').insert(brainrots.map(p => ({
            pet_name: p.name, valor_gen: p.gen, mutacion: p.mutation || "None", job_id: jobId, vps_name: vps_name
        })));

        const highValue = brainrots.filter(p => parseGenValue(p.gen) >= 30);

        if (highValue.length > 0) {
            const target = getWebhookByVPS(vps_name);
            if (target) {
                // Marcamos como procesado ANTES de enviar a Discord
                processedJobs.add(jobId);
                
                // Limpiamos el ID de la memoria después de 5 minutos para que pueda volver a ser escaneado en el futuro
                setTimeout(() => processedJobs.delete(jobId), 300000);

                let desc = "";
                highValue.forEach(p => { desc += `💎 **${p.name}** [${p.gen}]\n`; });

                axios.post(target, {
                    embeds: [{
                        title: `🚨 HALLAZGO EN ${vps_name}`,
                        description: desc + `\n🎮 **ID:** \`${jobId}\``,
                        color: 5793266,
                        timestamp: new Date()
                    }]
                }).catch(() => {});
            }
        }
    }
    
    await supabase.from('servidores').update({ estado: 'completado' }).eq('job_id', jobId);
    res.json({ status: "ok" });
});

// --- ASIGNAR SERVIDOR CON SKIP LOCKED ---
app.get('/get-server', async (req, res) => {
    // Usamos la función RPC que es más segura contra choques
    const { data, error } = await supabase.rpc('entregar_servidor_v2');

    if (data && data.length > 0) {
        res.json({ job_id: data[0].id_servidor });
    } else {
        res.json({ job_id: null });
    }
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
