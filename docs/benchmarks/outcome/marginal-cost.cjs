// Uso: node marginal-cost.cjs <pasta de resultados do benchmark-outcome> [...]  (lê results.json e os traces *.jsonl)
// Custo marginal por execução: tira o custo da PRIMEIRA requisição da sessão principal (a que grava o
// prefixo de ~140k tokens no cache), que numa sessão longa real já estaria pago. Preços Opus 5.5:
// entrada $4/M, saída $20/M, leitura de cache $0,20/M, gravação 5 min 1,25× e 1 h 2× a entrada.
const fs = require('fs');
const path = require('path');
const P = { in: 4, out: 20, cr: 0.20 };
const cost = (u) => ((u.input_tokens || 0) * P.in + (u.output_tokens || 0) * P.out + (u.cache_read_input_tokens || 0) * P.cr
  + ((u.cache_creation?.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens) || 0) * P.in * 1.25
  + (u.cache_creation?.ephemeral_1h_input_tokens || 0) * P.in * 2) / 1e6;
for (const dir of process.argv.slice(2)) {
  const results = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
  const agg = {};
  for (const r of results) {
    const trace = path.join(dir, `${r.case}.${r.arm}.${r.rep}.jsonl`);
    const msgs = new Map();
    for (const l of fs.readFileSync(trace, 'utf8').split('\n')) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.type !== 'assistant' || o.parent_tool_use_id || !o.message?.usage) continue;
      msgs.set(o.message.id, o.message.usage);
    }
    const first = [...msgs.values()][0];
    const firstCost = first ? cost(first) : 0;
    const marginal = r.costUsd - firstCost;
    const a = (agg[r.arm] ??= { n: 0, total: 0, marginal: 0, main: 0 });
    a.n++; a.total += r.costUsd; a.marginal += marginal; a.main += msgs.size;
    console.log(`${r.case.padEnd(30)} ${r.arm.padEnd(16)} total $${r.costUsd.toFixed(3)}  1ª req $${firstCost.toFixed(3)}  marginal $${marginal.toFixed(3)}  req principais ${msgs.size}`);
  }
  for (const [arm, a] of Object.entries(agg)) console.log(`  ${path.basename(dir)} ${arm.padEnd(16)} marginal médio $${(a.marginal / a.n).toFixed(3)}  req principais médias ${(a.main / a.n).toFixed(1)}`);
}
