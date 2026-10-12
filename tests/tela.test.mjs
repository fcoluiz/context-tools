// ui (onde fica na tela um texto) e refs --strings (menções em string, onde mora nome de campo de
// banco no Delphi), num formulário montado aqui: rótulo com acento em `#NNN`, rótulo sem
// FocusControl ao lado do controle, rótulo com FocusControl ligado a campo de dados, lista de itens
// e a unit que lê e grava o campo.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { localPath } from './paths.mjs';
import { findUiLabel, formatUiLabel, decodificarStringDfm, normalizar } from '../scripts/ui.mjs';
import { findReferences, formatReferences } from '../scripts/refs.mjs';
import { makeT } from '../scripts/lib/i18n.mjs';

const SCRIPTS = localPath('../scripts', import.meta.url);
const t = makeT('en');

const DFM = `object FrmCadCliente: TFrmCadCliente
  Caption = 'Cadastro de Cliente'
  object PageControl1: TPageControl
    object TabDados: TTabSheet
      Caption = 'Dados do Cliente'
      object GrpAdicionais: TGroupBox
        Left = 8
        Top = 8
        Caption = 'Dados Adicionais'
        object LblCodVend: TLabel
          Left = 16
          Top = 24
          Width = 120
          Height = 13
          Caption = 'C'#243'd. Vendedor Externo'
        end
        object EdtCodigoVendedor: TEdit
          Left = 16
          Top = 40
          Width = 100
          OnExit = EdtCodigoVendedorExit
        end
        object LblDesc: TLabel
          Left = 200
          Top = 24
          Caption = 'Descri'#231#227'o'
          FocusControl = EdtDescricao
        end
        object EdtDescricao: TDBEdit
          Left = 400
          Top = 400
          DataField = 'DESCRICAO'
          DataSource = DsCliente
        end
        object CbTipo: TComboBox
          Left = 16
          Top = 80
          Items.Strings = (
            'Isento'
            'Tributado')
        end
      end
    end
  end
end
`;

const PAS = `unit UCadCliente;

interface

type
  TFrmCadCliente = class(TForm)
    EdtCodigoVendedor: TEdit;
    procedure EdtCodigoVendedorExit(Sender: TObject);
  private
    procedure Gravar;
    procedure Carregar;
  end;

implementation

procedure TFrmCadCliente.Gravar;
begin
  Qry.FieldByName('COD_VEND').AsString := EdtCodigoVendedor.Text;
end;

procedure TFrmCadCliente.Carregar;
begin
  // carrega COD_VEND
  EdtCodigoVendedor.Text := Qry.FieldByName('COD_VEND').AsString;
end;

procedure TFrmCadCliente.EdtCodigoVendedorExit(Sender: TObject);
begin
end;

end.
`;

function projeto({ formulario = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-tela-'));
  const w = (rel, content) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), content); };
  w('src/UCadCliente.pas', PAS);
  if (formulario) w('src/UCadCliente.dfm', DFM.replace(/\n/g, '\r\n'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function comEstado(dir, fn) {
  const antes = process.env.CONTEXT_TOOLS_STATE_DIR;
  process.env.CONTEXT_TOOLS_STATE_DIR = join(dir, '.state');
  try { return fn(); } finally {
    if (antes === undefined) delete process.env.CONTEXT_TOOLS_STATE_DIR; else process.env.CONTEXT_TOOLS_STATE_DIR = antes;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ui: string de formulário Delphi com #NNN, aspa dobrada e concatenação vira texto', () => {
  assert.equal(decodificarStringDfm("'C'#243'd. Vendedor'"), 'Cód. Vendedor');
  assert.equal(decodificarStringDfm("'D''Agua' + ' azul'"), "D'Agua azul");
  assert.equal(decodificarStringDfm('#$41#66'), 'AB');
  assert.equal(decodificarStringDfm('16'), null, 'número não é string');
  assert.equal(normalizar('Cód. Vendedor Externo'), 'cod vendedor externo');
});

test('ui: do texto da tela (com abreviação e sem acento) ao controle, à aba e ao código que grava o campo', () => {
  const dir = projeto();
  comEstado(dir, () => {
    const r = findUiLabel(dir, 'onde informo o codigo do vendedor');
    assert.equal(r.status, 'ok');
    assert.equal(r.partial, false, 'palavra que não está em tela nenhuma não rebaixa o resultado');
    assert.deepEqual(r.ignored, ['informo']);
    const h = r.hits[0];
    assert.equal(h.text, 'Cód. Vendedor Externo');
    assert.equal(h.file, 'src/UCadCliente.dfm');
    assert.deepEqual(h.component, { name: 'LblCodVend', type: 'TLabel' });
    assert.equal(h.control.name, 'EdtCodigoVendedor');
    assert.equal(h.control.how, 'likely', 'sem FocusControl é posição, e a saída diz');
    assert.deepEqual(h.path, ['Dados do Cliente', 'Dados Adicionais']);
    assert.equal(h.form.caption, 'Cadastro de Cliente');
    assert.deepEqual(h.events, ['OnExit=EdtCodigoVendedorExit']);
    assert.equal(h.unit, 'src/UCadCliente.pas');
    assert.equal(h.unitUses.total, 2, 'a declaração no type e o nome do evento não são uso');
    assert.ok(h.unitUses.uses.every((u) => /Gravar|Carregar/.test(u.in)), JSON.stringify(h.unitUses));
    assert.ok(h.unitUses.uses.some((u) => u.code.includes("FieldByName('COD_VEND')")), 'a linha mostra o campo do banco');
    const texto = formatUiLabel(r, t).join('\n');
    assert.match(texto, /on screen: Cadastro de Cliente › Dados do Cliente › Dados Adicionais/);
    assert.match(texto, /likely control \(by position, no FocusControl\): EdtCodigoVendedor: TEdit/);
    assert.match(texto, /controls created in code/, 'a saída diz o que não vê');
  });
});

test('ui: FocusControl declarado, campo de dados e item de lista', () => {
  const dir = projeto();
  comEstado(dir, () => {
    const desc = findUiLabel(dir, 'descrição').hits[0];
    assert.equal(desc.control.name, 'EdtDescricao');
    assert.equal(desc.control.how, 'focus', 'FocusControl vale mesmo longe na posição');
    assert.equal(desc.dataField, 'DESCRICAO');
    assert.equal(desc.dataSource, 'DsCliente');
    const item = findUiLabel(dir, 'tributado').hits[0];
    assert.equal(item.component.name, 'CbTipo');
    assert.equal(item.prop, 'Items.Strings');
  });
});

test('ui: nada casa, ou não há formulário — diz isso em vez de inventar', () => {
  const dir = projeto();
  comEstado(dir, () => {
    const r = findUiLabel(dir, 'xyzw qwerty');
    assert.equal(r.hits.length, 0);
    assert.match(formatUiLabel(r, t).join('\n'), /no caption, hint or item/);
  });
  const sem = projeto({ formulario: false });
  comEstado(sem, () => {
    assert.equal(findUiLabel(sem, 'codigo').status, 'no-forms');
  });
  const out = spawnSync(process.execPath, [join(SCRIPTS, 'ct.mjs'), 'help'], { encoding: 'utf8', env: { ...process.env, CONTEXT_TOOLS_LANG: 'en' } }).stdout;
  assert.match(out, /\bui\s+which form control shows this text/);
});

test('refs --strings: o nome de campo que só existe em string aparece, com o método; sem a opção nada muda', () => {
  const dir = projeto();
  comEstado(dir, () => {
    const padrao = findReferences(dir, 'COD_VEND');
    assert.equal(padrao.total, 0);
    assert.equal(padrao.inText, 3);
    assert.equal(padrao.inTextRefs, undefined, 'sem --strings o resultado é o de antes');
    assert.match(formatReferences(padrao, t).join('\n'), /no use outside its definition/);

    const r = findReferences(dir, 'COD_VEND', { strings: true });
    assert.equal(r.total, 0, 'menção em string continua fora da contagem de usos');
    const pas = r.inTextRefs.find((x) => x.file === 'src/UCadCliente.pas');
    assert.deepEqual(pas.uses.map((u) => u.line), [18, 23, 24]);
    assert.ok(pas.uses.every((u) => /Gravar|Carregar/.test(u.in)));
    const texto = formatReferences(r, t).join('\n');
    assert.match(texto, /in comments\/strings \(--strings\)/);
    assert.match(texto, /FieldByName\('COD_VEND'\)\.AsString := EdtCodigoVendedor\.Text/);
  });
});

// Vários formulários com a mesma palavra: ordem pela frase inteira e por palavra inteira antes da
// abreviação, resumo por formulário quando há resultado demais, e `--in` para estreitar.
function projetoAmplo() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-tela-amplo-'));
  const rotulo = (nome, texto, top) => `  object ${nome}: TLabel\n    Left = 8\n    Top = ${top}\n    Caption = '${texto}'\n  end\n`;
  const form = (nome, legenda, rotulos) => `object ${nome}: T${nome}\n  Caption = '${legenda}'\n${rotulos.map(([n, tx], i) => rotulo(n, tx, i * 30)).join('')}end\n`;
  const w = (rel, content) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), content); };
  w('src/UCadTributo.dfm', form('FrmCadTributo', 'Cadastro de Tributo', [
    ['LblA', 'Tributo CST Entrada'], ['LblB', 'CST Tributo Sa'], ['LblC', 'Trib. Federal'], ['LblD', 'Tributo Estadual X'],
  ]));
  w('src/UCadProduto.dfm', form('FrmCadProduto', 'Cadastro de Produto', [
    ['LblE', 'Tributo'], ['LblF', 'Grupo de Tributo'], ['LblG', 'Tributo Municipal'],
  ]));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

test('ui: frase inteira e palavra inteira vêm antes; muitos resultados mostram onde estão; --in estreita', () => {
  const dir = projetoAmplo();
  comEstado(dir, () => {
    const cst = findUiLabel(dir, 'cst tributo');
    assert.deepEqual(cst.hits.map((h) => h.text), ['CST Tributo Sa', 'Tributo CST Entrada'], 'a frase seguida ganha do texto mais curto');

    const trib = findUiLabel(dir, 'tributo');
    const ordem = trib.hits.map((h) => h.text);
    assert.ok(ordem.indexOf('Tributo Estadual X') < ordem.indexOf('Trib. Federal'), `palavra inteira antes da abreviação: ${ordem}`);
    assert.equal(trib.total, 8, 'a legenda do formulário também é texto da tela');
    assert.deepEqual(trib.byForm.map((f) => [f.file, f.n]), [['src/UCadTributo.dfm', 5], ['src/UCadProduto.dfm', 3]]);
    const texto = formatUiLabel(trib, t).join('\n');
    assert.match(texto, /spread over 2 forms/);
    assert.match(texto, /src\/UCadTributo\.dfm \(5\) — Cadastro de Tributo/);
    assert.match(texto, /--in=<form file name>/);
    assert.doesNotMatch(formatUiLabel(trib, t, { all: true }).join('\n'), /spread over/, 'com --all cabe tudo: sem resumo');

    const so = findUiLabel(dir, 'tributo', { in: 'ucadproduto' });
    assert.equal(so.total, 3);
    assert.ok(so.hits.every((h) => h.file === 'src/UCadProduto.dfm'));
    assert.match(formatUiLabel(so, t).join('\n'), /only forms whose path contains "ucadproduto"/);

    const nada = findUiLabel(dir, 'tributo', { in: 'naoexiste' });
    assert.equal(nada.status, 'no-forms-in');
    assert.match(formatUiLabel(nada, t).join('\n'), /no form path contains "naoexiste" \(of 2\)/);
  });
});
