// 🤝 O lado do agente na dupla: o que cada hook diz a ele e o que o `wait` imprime.
//
// Os três hooks (prompt, edição, Stop) são os mesmos para Claude e Codex; muda só quem chama. No
// Claude, `pair.mjs --hook=…` tem entrada própria em `hooks/hooks.json`. No Codex, eles rodam
// DENTRO de hooks que já existiam (`codex-hook.mjs`): o Codex Desktop ignora em silêncio hook novo
// que o usuário ainda não aprovou em /hooks, e uma dupla que some sem aviso é pior que nenhuma.
//
// Os comandos entregues ao agente levam caminho absoluto e `--pair`/`--role` explícitos: o shell
// do agente não herda a variável do plugin nem o id da sessão do hook.

import { dirname, join } from 'node:path';
import { loadConfig, safe, scriptDir } from './roots.mjs';
import { detectLang } from './i18n.mjs';
import {
  draftDir, editTargets, expireIfIdle, findPairForSession, lastMessage, MAX_STOP_BLOCKS, mayWrite, onlyDrafts,
  registerSession, turnOf, updatePair,
} from './pair.mjs';

const ROLE_NAME = {
  pt: { planner: 'PLANEJADOR (planeja e valida; não edita o projeto)', builder: 'EXECUTOR (implementa o plano)' },
  en: { planner: 'PLANNER (plans and reviews; does not edit the project)', builder: 'BUILDER (implements the plan)' },
};
const HOST_NAME = { claude: 'Claude', codex: 'Codex' };
const STAGE_NAME = {
  pt: { task: 'aguardando a tarefa', plan: 'planejamento', build: 'construção', review: 'validação', done: 'encerrada' },
  en: { task: 'waiting for the task', plan: 'planning', build: 'building', review: 'review', done: 'over' },
};

export function pairLang(pair) {
  return safe(() => detectLang(pair?.project ? loadConfig(pair.project) : {}), 'en') === 'pt' ? 'pt' : 'en';
}

export function pairCommand(verb, pair, role) {
  const script = join(scriptDir(), 'pair.mjs').replace(/\\/g, '/');
  return `node "${script}" ${verb} --pair=${pair.id} --role=${role}`;
}

const draft = (pair, name) => join(draftDir(pair.id), name).replace(/\\/g, '/');
const other = (role) => role === 'planner' ? 'builder' : 'planner';
const quote = (text) => String(text || '').split('\n').map((line) => `> ${line}`).join('\n');

/** O que o agente deve fazer agora, dado o papel. Usado pelo `wait` e pela ativação. */
export function turnInstructions(pair, role, lang = pairLang(pair)) {
  const pt = lang === 'pt';
  const wait = pairCommand('wait', pair, role);
  const sendCmd = (kind, file) => `${pairCommand(`send ${kind}`, pair, role)} --file="${file}"`;
  const rounds = pt ? `rodada ${pair.round} de ${pair.maxRounds}` : `round ${pair.round} of ${pair.maxRounds}`;

  if (pair.status !== 'active') {
    const reasons = lastMessage(pair, ['reject'])?.text;
    const why = {
      approved: pt ? 'o planejador APROVOU a entrega.' : 'the planner APPROVED the work.',
      'round-limit': pt ? `o limite de ${pair.maxRounds} rodada(s) acabou sem aprovação.` : `the ${pair.maxRounds}-round limit ran out without approval.`,
      stopped: pt ? 'a dupla foi parada.' : 'the pair was stopped.',
      idle: pt ? `ficou ${pair.idleMinutes} min sem progresso.` : `there was no progress for ${pair.idleMinutes} min.`,
    }[pair.outcome] || '';
    return [
      pt ? `🤝 Dupla ${pair.id} encerrada: ${why}` : `🤝 Pair ${pair.id} is over: ${why}`,
      pair.outcome === 'round-limit' && reasons ? (pt ? `Últimos motivos do planejador:\n${quote(reasons)}` : `Planner's last reasons:\n${quote(reasons)}`) : '',
      pt ? 'Volte ao modo normal: não rode mais comandos da dupla. Resuma para o usuário o que aconteceu.'
        : 'Back to normal mode: run no more pair commands. Summarize for the user what happened.',
    ].filter(Boolean).join('\n');
  }

  const turn = turnOf(pair.stage);
  // A tarefa vem do usuário, pela sessão do planejador. Sem ela, o planejador encerra o turno e
  // pergunta (um `wait` aqui voltaria na hora, em laço); o executor só espera.
  if (pair.stage === 'task' && role === 'planner') {
    return pt
      ? `Se a mensagem do usuário é a tarefa da dupla, grave-a e entregue: escreva o texto em ${draft(pair, 'tarefa.md')} e rode \`${sendCmd('task', draft(pair, 'tarefa.md'))}\`; depois siga o que ele imprimir. Senão, pergunte ao usuário qual é a tarefa da dupla.`
      : `If the user's message is the pair's task, record it: write it to ${draft(pair, 'task.md')} and run \`${sendCmd('task', draft(pair, 'task.md'))}\`; then follow what it prints. Otherwise ask the user what the pair's task is.`;
  }
  if (pair.stage === 'task') {
    const planner = HOST_NAME[pair.roles.planner.host];
    return pt
      ? `A tarefa da dupla é dada na sessão do planejador (${planner}), não nesta. Se o usuário te passou a tarefa aqui, diga a ele para mandá-la ao planejador. Rode \`${wait}\` e siga o que ele imprimir; se ele disser que ainda está esperando, rode de novo.`
      : `The pair's task is given in the planner's session (${planner}), not this one. If the user gave you the task here, tell them to send it to the planner. Run \`${wait}\` and follow what it prints; if it says it is still waiting, run it again.`;
  }
  if (turn !== role) {
    return pt
      ? `Agora é a vez do ${HOST_NAME[pair.roles[other(role)].host]} (${STAGE_NAME.pt[pair.stage]}). Rode \`${wait}\` e siga o que ele imprimir; se ele disser que ainda está esperando, rode de novo.`
      : `It is ${HOST_NAME[pair.roles[other(role)].host]}'s turn (${STAGE_NAME.en[pair.stage]}). Run \`${wait}\` and follow what it prints; if it says it is still waiting, run it again.`;
  }
  if (pair.stage === 'plan') {
    const file = draft(pair, pt ? 'plano.md' : 'plan.md');
    return [
      pt ? '🤝 Sua vez: PLANEJAR.' : '🤝 Your turn: PLAN.',
      pt ? `Tarefa:\n${quote(pair.task)}` : `Task:\n${quote(pair.task)}`,
      pt ? `Leia o código que precisar, sem editar o projeto. Escreva um plano que o executor consiga seguir sozinho (arquivos, passos, como verificar) em ${file} e rode \`${sendCmd('plan', file)}\`. Depois rode \`${wait}\`.`
        : `Read whatever code you need, without editing the project. Write a plan the builder can follow alone (files, steps, how to verify) to ${file} and run \`${sendCmd('plan', file)}\`. Then run \`${wait}\`.`,
    ].join('\n');
  }
  if (pair.stage === 'build') {
    const file = draft(pair, pt ? 'entrega.md' : 'delivery.md');
    const plan = lastMessage(pair, ['plan'])?.text;
    const rejection = pair.round > 1 ? lastMessage(pair, ['reject'])?.text : null;
    return [
      pt ? `🤝 Sua vez: CONSTRUIR (${rounds}).` : `🤝 Your turn: BUILD (${rounds}).`,
      pt ? `Tarefa:\n${quote(pair.task)}` : `Task:\n${quote(pair.task)}`,
      plan ? (pt ? `Plano do planejador:\n${quote(plan)}` : `Planner's plan:\n${quote(plan)}`) : '',
      rejection ? (pt ? `A validação anterior REPROVOU. Corrija isto:\n${quote(rejection)}` : `The previous review REJECTED it. Fix this:\n${quote(rejection)}`) : '',
      pt ? `Implemente e verifique. Ao terminar, escreva em ${file} o que mudou e como verificou, e rode \`${sendCmd('built', file)}\`. Depois rode \`${wait}\`.`
        : `Implement and verify. When done, write to ${file} what changed and how you verified it, and run \`${sendCmd('built', file)}\`. Then run \`${wait}\`.`,
    ].filter(Boolean).join('\n');
  }
  // review
  const file = draft(pair, pt ? 'parecer.md' : 'verdict.md');
  const delivery = lastMessage(pair, ['built'])?.text;
  return [
    pt ? `🤝 Sua vez: VALIDAR (${rounds}).` : `🤝 Your turn: REVIEW (${rounds}).`,
    delivery ? (pt ? `Entrega do executor:\n${quote(delivery)}` : `Builder's delivery:\n${quote(delivery)}`) : '',
    pt ? `Confira o que mudou (git diff, testes) contra a tarefa e o plano, sem editar o projeto. Escreva o parecer em ${file}. Aprovado: \`${sendCmd('approve', file)}\`. Reprovado, com motivos objetivos: \`${sendCmd('reject', file)}\`${pair.round >= pair.maxRounds ? ' (é a última rodada: reprovar encerra a dupla)' : ''}. Depois rode \`${wait}\`.`
      : `Check what changed (git diff, tests) against the task and the plan, without editing the project. Write the verdict to ${file}. Approved: \`${sendCmd('approve', file)}\`. Rejected, with concrete reasons: \`${sendCmd('reject', file)}\`${pair.round >= pair.maxRounds ? ' (last round: rejecting ends the pair)' : ''}. Then run \`${wait}\`.`,
  ].filter(Boolean).join('\n');
}

/** Primeira mensagem da sessão depois de entrar na dupla: quem ela é e o que fazer. */
function briefing(pair, role, lang) {
  const pt = lang === 'pt';
  const partner = HOST_NAME[pair.roles[other(role)].host];
  return [
    pt ? `🤝 Esta sessão está numa DUPLA (${pair.id}) como ${ROLE_NAME.pt[role]}, com o ${partner} como ${role === 'planner' ? 'executor' : 'planejador'}.`
      : `🤝 This session is in a PAIR (${pair.id}) as ${ROLE_NAME.en[role]}, with ${partner} as the ${role === 'planner' ? 'builder' : 'planner'}.`,
    pt ? `Fluxo: tarefa → plano → construção → validação, até ${pair.maxRounds} rodada(s). Um espera o outro com o comando \`wait\`; só o executor edita o projeto, e só na construção. Rascunhos vão em ${draftDir(pair.id).replace(/\\/g, '/')}.`
      : `Flow: task → plan → build → review, up to ${pair.maxRounds} round(s). Each waits for the other with the \`wait\` command; only the builder edits the project, and only while building. Drafts go in ${draftDir(pair.id).replace(/\\/g, '/')}.`,
    // O Codex pede justificativa quando um comando sai do sandbox, e a revisão automática recusa o
    // que parece envio a destino desconhecido: o agente precisa saber o que esses comandos fazem.
    pt ? `Os comandos da dupla (\`node …/pair.mjs\`) são locais: não usam rede e só gravam em ${dirname(draftDir(pair.id)).replace(/\\/g, '/')}. Se precisar justificar a execução de um deles, diga isso.`
      : `The pair commands (\`node …/pair.mjs\`) are local: they use no network and only write to ${dirname(draftDir(pair.id)).replace(/\\/g, '/')}. If you have to justify running one, say so.`,
    turnInstructions(pair, role, lang),
  ].join('\n');
}

/**
 * UserPromptSubmit: registra a sessão e, se ela estiver numa dupla ativa, diz o que fazer. Na
 * primeira vez, o briefing inteiro; depois, só uma linha de estado — o agente já recebeu o resto.
 */
export function pairPromptContext({ host, sessionId, cwd, prompt, register = true, now = Date.now(), env = process.env }) {
  if (register) registerSession({ host, sessionId, project: cwd, prompt, now, env });
  const found = findPairForSession(host, sessionId, env);
  if (!found) return null;
  const pair = expireIfIdle(found.pair, { now, env });
  const { role } = found;
  const lang = pairLang(pair);
  if (pair.status !== 'active') return turnInstructions(pair, role, lang);
  if (!pair.roles[role].joinedAt) {
    updatePair(pair.id, (p) => { p.roles[role].joinedAt = now; }, { now, env });
    return briefing(pair, role, lang);
  }
  const state = lang === 'pt'
    ? `🤝 Dupla ${pair.id} ativa: você é o ${role === 'planner' ? 'planejador' : 'executor'}; etapa: ${STAGE_NAME.pt[pair.stage]}.`
    : `🤝 Pair ${pair.id} is active: you are the ${role}; stage: ${STAGE_NAME.en[pair.stage]}.`;
  return `${state}\n${turnInstructions(pair, role, lang)}`;
}

/** PreToolUse de edição: texto da recusa, ou `null` quando a edição pode seguir. */
export function pairEditDenial({ host, sessionId, cwd, event, env = process.env }) {
  const found = findPairForSession(host, sessionId, env);
  if (!found || mayWrite(found.pair, found.role)) return null;
  if (onlyDrafts(found.pair, editTargets(event, cwd), env)) return null;
  const { pair, role } = found;
  return pairLang(pair) === 'pt'
    ? `🤝 Dupla ${pair.id}: só o executor edita o projeto, e só na construção (etapa atual: ${STAGE_NAME.pt[pair.stage]}). Rascunhos podem ir em ${draftDir(pair.id).replace(/\\/g, '/')}. ${turnInstructions(pair, role, 'pt')}`
    : `🤝 Pair ${pair.id}: only the builder edits the project, and only while building (current stage: ${STAGE_NAME.en[pair.stage]}). Drafts may go in ${draftDir(pair.id).replace(/\\/g, '/')}. ${turnInstructions(pair, role, 'en')}`;
}

/**
 * Stop: quando é a vez do OUTRO, o agente não pode encerrar o turno — ele precisa voltar ao
 * `wait`. Na própria vez, encerrar é legítimo (pode estar perguntando algo ao usuário).
 */
export function pairStopReason({ host, sessionId, now = Date.now(), env = process.env }) {
  const found = findPairForSession(host, sessionId, env);
  if (!found) return null;
  const pair = expireIfIdle(found.pair, { now, env });
  const { role } = found;
  if (pair.status !== 'active' || turnOf(pair.stage) === role) return null;
  let allowed = false;
  updatePair(pair.id, (p) => {
    if ((p.roles[role].stopBlocks || 0) >= MAX_STOP_BLOCKS) return false;
    p.roles[role].stopBlocks = (p.roles[role].stopBlocks || 0) + 1;
    allowed = true;
  }, { now, env });
  return allowed ? turnInstructions(pair, role) : null;
}
