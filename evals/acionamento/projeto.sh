#!/usr/bin/env bash
# Projeto de exemplo para os casos de acionamento: o pedido precisa de código para navegar, senão
# o agente responde de cabeça e o caso mede pasta vazia, não a descrição da skill.
set -euo pipefail

mkdir -p src/routes src/services src/workers src/jobs src/db/migrations web/components web/pages \
  src/legacy .github/workflows .claude/context

cat > package.json <<'EOF'
{ "name": "loja", "private": true, "type": "module",
  "scripts": { "start": "node src/server.js", "test": "node --test" },
  "dependencies": { "express": "^4.19.2", "bullmq": "^5.7.0", "pg": "^8.11.0" } }
EOF
cat > src/server.js <<'EOF'
import express from 'express';
import { pedidos } from './routes/pedidos.js';
import { login } from './routes/auth.js';
import { upload } from './routes/upload.js';
const app = express();
app.use(express.json());
app.use('/pedidos', pedidos);
app.use('/login', login);
app.use('/upload', upload);
app.listen(process.env.PORT || 3000);
EOF
cat > src/routes/pedidos.js <<'EOF'
import { Router } from 'express';
import { salvarPedido, calcularTotal } from '../services/pedidos.js';
export const pedidos = Router();
pedidos.get('/:id/total', async (req, res) => res.json({ total: await calcularTotal(req.params.id) }));
pedidos.put('/:id', async (req, res) => res.json(await salvarPedido(req.params.id, req.body)));
EOF
cat > src/services/pedidos.js <<'EOF'
import { db } from '../db/index.js';
import { filaEmail } from '../workers/fila.js';
export async function calcularTotal(id) {
  const { rows } = await db.query('select sum(preco * qtd) as total from itens where pedido_id = $1', [id]);
  return Number(rows[0].total || 0);
}
export async function salvarPedido(id, dados) {
  await db.query('update pedidos set cliente_id = $1 where id = $2', [dados.clienteId, id]);
  await filaEmail.add('confirmacao', { id });
  return { id, ...dados };
}
EOF
cat > src/services/relatorios.js <<'EOF'
import { db } from '../db/index.js';
export async function vendasPorMes() {
  const { rows } = await db.query('select * from pedidos p join itens i on i.pedido_id = p.id');
  const meses = {};
  for (const r of rows) meses[r.criado_em.slice(0, 7)] = (meses[r.criado_em.slice(0, 7)] || 0) + r.preco * r.qtd;
  return meses;
}
EOF
cat > src/routes/auth.js <<'EOF'
import { Router } from 'express';
import { db } from '../db/index.js';
export const login = Router();
login.post('/', async (req, res) => {
  const { rows } = await db.query(`select * from usuarios where email = '${req.body.email}'`);
  res.json({ ok: rows.length > 0 && rows[0].senha === req.body.senha });
});
EOF
cat > src/routes/upload.js <<'EOF'
import { Router } from 'express';
import { writeFileSync } from 'node:fs';
export const upload = Router();
upload.post('/:nome', (req, res) => { writeFileSync(`uploads/${req.params.nome}`, req.body.conteudo); res.sendStatus(201); });
EOF
cat > src/db/index.js <<'EOF'
import pg from 'pg';
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
EOF
cat > src/db/migrations/001_clientes.sql <<'EOF'
create table clientes (id serial primary key, nome text not null);
EOF
cat > src/workers/fila.js <<'EOF'
import { Queue } from 'bullmq';
export const filaEmail = new Queue('email', { connection: { host: process.env.REDIS_HOST } });
EOF
cat > src/jobs/faturamento.js <<'EOF'
import { db } from '../db/index.js';
setInterval(async () => { await db.query("update pedidos set faturado = true where faturado = false"); }, 60 * 60 * 1000);
EOF
cat > web/components/Tabela.jsx <<'EOF'
export function Tabela({ linhas }) {
  return <table><tbody>{linhas.map((l) => <tr key={l.id}><td>{l.nome}</td></tr>)}</tbody></table>;
}
EOF
cat > web/pages/Clientes.jsx <<'EOF'
import { Tabela } from '../components/Tabela.jsx';
export default function Clientes({ clientes }) { return <Tabela linhas={clientes} />; }
EOF
cat > Dockerfile <<'EOF'
FROM node:latest
WORKDIR /app
COPY . .
RUN npm install
CMD ["npm", "start"]
EOF
cat > .github/workflows/ci.yml <<'EOF'
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
EOF
{
  echo 'unit Relatorios;'; echo 'interface'; echo 'implementation'
  for i in $(seq 1 400); do
    printf 'procedure TRelatorios.Secao%d;\nbegin\n  Total := Total + Linha%d;\nend;\n\n' "$i" "$i"
  done
  printf 'function TRelatorios.CalcularImposto(Base: Currency): Currency;\nbegin\n  Result := Base * Aliquota;\nend;\n\n'
  for i in $(seq 401 800); do
    printf 'procedure TRelatorios.Secao%d;\nbegin\n  Total := Total + Linha%d;\nend;\n\n' "$i" "$i"
  done
  echo 'end.'
} > src/legacy/Relatorios.pas
cat > .claude/context/pedidos.md <<'EOF'
---
status: live
sources: [src/services/pedidos.js, src/routes/pedidos.js]
verified_at: 2026-01-10
---
# Pedidos
`salvarPedido` grava o pedido e enfileira o e-mail de confirmação.
EOF

git init -q
git -c user.name=eval -c user.email=eval@example.com add -A
git -c user.name=eval -c user.email=eval@example.com commit -q -m "projeto inicial"
git checkout -q -b feat/desconto
cat >> src/services/pedidos.js <<'EOF'
export async function aplicarDesconto(id, pct) {
  await db.query(`update itens set preco = preco * ${1 - pct / 100} where pedido_id = ${id}`);
}
EOF
git -c user.name=eval -c user.email=eval@example.com commit -q -am "desconto por pedido"
