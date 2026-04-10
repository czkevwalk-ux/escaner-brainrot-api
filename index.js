const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- ASIGNAR SERVIDOR (SIN CHOCAR) ---
app.get('/get-server', async (req, res) => {
    // 1. Buscamos el primer servidor que esté libre
    const { data, error } = await supabase
        .from('servidores')
        .select('job_id')
        .eq('estado', 'pendiente')
        .limit(1);

    if (data && data.length > 0) {
        const targetId = data[0].job_id;
        // 2. LO MARCAMOS COMO COMPLETADO AL INSTANTE 
        // Esto evita que otro bot lo agarre en el mismo segundo
        await supabase.from('servidores').update({ estado: 'completado' }).eq('job_id', targetId);
        
        res.json({ job_id: targetId });
    } else {
        res.json({ job_id: null });
    }
});

// --- REPORTAR HALLAZGOS ---
app.post('/add-server', async (req, res) => {
    const { jobId, brainrots, vps_name } = req.body;
    if (brainrots && brainrots.length > 0) {
        // Guardar en base de datos
        await supabase.from('hallazgos').insert(brainrots.map(p => ({
            pet_name: p.name, valor_gen: p.gen, mutacion: p.mutation || "None", job_id: jobId, vps_name: vps_name
        })));

        // Enrutar a Discord (GRUPOS DE 3 VPS POR CANAL)
        const num = parseInt(vps_name.replace(/\D/g, '') || 0);
        let webhook = process.env.WEBHOOK_1;
        if (num >= 4 && num <= 6) webhook = process.env.WEBHOOK_2;
        if (num >= 7 && num <= 9) webhook = process.env.WEBHOOK_3;
        if (num >= 10 && num <= 12) webhook = process.env.WEBHOOK_4;
        if (num >= 13 && num <= 15) webhook = process.env.WEBHOOK_5;
        if (num >= 16) webhook = process.env.WEBHOOK_6;

        // Filtro de 30M para Discord
        const valNum = (text) => parseFloat(text.match(/\d+\.?\d*/) || 0);
        const vip = brainrots.filter(p => valNum(p.gen) >= 30);

        if (vip.length > 0 && webhook) {
            let desc = "";
            vip.forEach(p => { desc += `💎 **${p.name}** [${p.gen}]\n`; });
            axios.post(webhook, { embeds: [{ title: `🚨 HALLAZGO ${vps_name}`, description: desc + `\n🎮 **JobId:** \`${jobId}\``, color: 5793266 }] }).catch(e => {});
        }
    }
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
