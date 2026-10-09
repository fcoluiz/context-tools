// Testes dos parsers — a parte de MAIOR risco da ferramenta.
//
// Um parser errado não quebra: ele aponta para a linha errada em silêncio, e quem confia
// no número lê o trecho errado do arquivo. É exatamente o erro que a ferramenta existe para
// evitar, então é aqui que os testes precisam ser densos.
//
// Rodar: npm test    (ou: node --test tests/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  symbolsForCode, symbolsForPascal, symbolsForDfm, symbolsForMarkdown, symbolsForRust,
  symbolsForPython, symbolsForGo, symbolsForCSharp, symbolsForJava, symbolsForPhp, parserForExt, stripInlineRegexFlags,
} from '../scripts/outline.mjs';
import { bareName } from '../scripts/symbols.mjs';

const linhas = (s) => s.replace(/^\n/, '').split('\n');
/** Procura um símbolo pelo nome exato e devolve a linha — falha o teste se não achar. */
const linhaDe = (syms, nome) => {
  const s = syms.find((x) => x.name === nome);
  assert.ok(s, `símbolo não encontrado: "${nome}" (achados: ${syms.map((x) => x.name).join(' | ')})`);
  return s.line;
};

test('JS: caso de teste de topo vira símbolo; aninhado, não', () => {
  // Motivo medido: `comIntervalos` fecha um símbolo na linha anterior ao próximo de mesma
  // profundidade, e chamada `test(…)` não era símbolo nenhum. `tests/hooks-e2e.test.mjs` tinha
  // 4 símbolos em 847 linhas, com um helper de topo engolindo 401 — o que fazia o handoff
  // anunciar o HELPER como tocado quando o que mudou foi um teste no meio dele.
  const src = linhas(`
function ajuda() {}
test('faz a coisa certa', () => {
  test('subteste que NAO deve entrar', () => {});
});
it("tambem conta", () => {});
describe(\`crase tambem\`, () => {});
test.skip('variante com .skip', () => {});
const naoEhTeste = testeQualquer('nao casa', 1);
`);
  const syms = symbolsForCode(src);
  const nomes = syms.map((s) => s.name);

  assert.ok(nomes.includes('test faz a coisa certa'), `esperava o teste de topo, veio: ${nomes.join(' | ')}`);
  assert.ok(nomes.includes('test tambem conta'), 'it() conta');
  assert.ok(nomes.includes('test crase tambem'), 'crase conta');
  assert.ok(nomes.includes('test variante com .skip'), 'test.skip conta');

  // A coluna 0 é o que separa teste de subteste sem precisar de AST. Indexar o aninhado
  // devolveria o mesmo ruído que o índice evita em `.dfm` e em chave de config profunda.
  assert.ok(!nomes.includes('test subteste que NAO deve entrar'), 'aninhado não entra');
  // `testeQualquer(` começa com as mesmas letras e NÃO é caso de teste.
  assert.ok(!nomes.some((n) => n.includes('nao casa')), 'identificador que só começa com "test" não casa');
  assert.ok(nomes.includes('function ajuda'), 'o helper continua indexado');
});

test('bareName devolve a DESCRIÇÃO inteira do teste, sem limpeza de identificador', () => {
  // As limpezas genéricas são feitas para identificador e estragariam uma frase: o strip de
  // `^Ident.` cortaria "montar." e o de `()$` comeria a função citada no fim do nome.
  assert.equal(bareName('test montar.prompt preserva o bloco'), 'montar.prompt preserva o bloco');
  assert.equal(bareName('test cobre comandoDoPlugin()'), 'cobre comandoDoPlugin()');
  // Não pode ter quebrado os rótulos normais.
  assert.equal(bareName('function alpha'), 'alpha');
  assert.equal(bareName('key sessionTimeout'), 'sessionTimeout');
});

test('JS: pega function, class, const arrow e método de classe', () => {
  const src = linhas(`
export function alpha() {}
const beta = () => {};
export const gama = async (x) => x;
class Delta {
  metodo(a) {}
  async outro() {}
}
`);
  const s = symbolsForCode(src);
  assert.equal(linhaDe(s, 'function alpha'), 1);
  assert.equal(linhaDe(s, 'beta()'), 2);
  assert.equal(linhaDe(s, 'async gama()'), 3);
  assert.equal(linhaDe(s, 'class Delta'), 4);
  assert.equal(linhaDe(s, 'metodo()'), 5);
  assert.equal(linhaDe(s, 'async outro()'), 6);
});

test('JS: em arquivo SEM class, chamada indentada não vira definição', () => {
  // Regressão real: em componente React, `setForm(...)` indentado era capturado como
  // definição e mandava o Read para a linha errada.
  const src = linhas(`
export function Componente() {
  useEffect(() => {
    setForm({ a: 1 });
    fetchData(id);
  }, []);
}
`);
  const nomes = symbolsForCode(src).map((x) => x.name);
  assert.deepEqual(nomes, ['function Componente']);
});

test('JS: método indentado É capturado quando o arquivo tem class', () => {
  const src = linhas(`
class Servico {
  buscar(id) {}
}
`);
  const nomes = symbolsForCode(src).map((x) => x.name);
  assert.ok(nomes.includes('buscar()'), `esperava buscar(), veio: ${nomes.join(' | ')}`);
});

test('JS: palavra-chave de fluxo não vira método', () => {
  const src = linhas(`
class X {
  if (a) {}
  for (;;) {}
  metodoReal() {}
}
`);
  const nomes = symbolsForCode(src).map((x) => x.name);
  assert.ok(!nomes.includes('if()'), 'if não pode virar símbolo');
  assert.ok(!nomes.includes('for()'), 'for não pode virar símbolo');
  assert.ok(nomes.includes('metodoReal()'));
});

test('TS: interface, type e enum entram no índice', () => {
  // Regressão medida num repo de terceiro e no frontend do workspace de referência:
  // `symbolsForCode` não tinha branch nenhum para tipo, então 817 tipos exportados eram
  // invisíveis. Pior que invisível: perguntar por `Status` devolvia `function StatusBadge`
  // (match parcial) com cara de resposta certa.
  const s = symbolsForCode(linhas(`
export interface Column<T> {
export type ChartConfig = {
export type Status = "ativo" | "pago";
enum Direcao { Cima, Baixo }
export const enum Flag { A = 1 }
declare interface Global {}
`));
  assert.equal(linhaDe(s, 'interface Column'), 1);
  assert.equal(linhaDe(s, 'type ChartConfig'), 2);
  assert.equal(linhaDe(s, 'type Status'), 3);
  assert.equal(linhaDe(s, 'enum Direcao'), 4);
  assert.equal(linhaDe(s, 'enum Flag'), 5);
  assert.equal(linhaDe(s, 'interface Global'), 6);
});

test('TS: o branch de tipo não inventa símbolo', () => {
  // O risco de adicionar `type` é justamente falso positivo: `type` é nome de propriedade
  // comuníssimo em JS. Falso positivo em outline manda o Read para a linha errada.
  const nomes = symbolsForCode(linhas(`
export type { Apenas } from './x';
import type { Outro } from './y';
const config = {
type: 'texto',
type = 5;
typeof janela;
`)).map((x) => x.name);
  assert.ok(!nomes.some((n) => n.startsWith('type ')), `nenhum tipo deveria sair, veio: ${nomes.join(' | ')}`);
});

test('TS: bareName torna o tipo pesquisável pelo nome nu', () => {
  // Sem isto o símbolo entra no índice mas a consulta por `Status` não o encontra.
  assert.equal(bareName('type Status'), 'Status');
  assert.equal(bareName('interface Column'), 'Column');
  assert.equal(bareName('enum Direcao'), 'Direcao');
});

test('Python/Go: bareName torna os rótulos novos pesquisáveis', () => {
  // 3º passo da receita de adicionar linguagem, e o que já falhou em TypeScript e Rust:
  // sem ele o símbolo ENTRA no índice mas a consulta pelo nome nu não o acha — buraco que
  // nenhum teste de parser pega, só a consulta ponta a ponta.
  assert.equal(bareName('def send_file'), 'send_file');
  assert.equal(bareName('class Flask'), 'Flask');
  assert.equal(bareName('func NewHead'), 'NewHead');
  assert.equal(bareName('func Command.Execute'), 'Execute', 'receptor Go some, igual ao Pascal');
  assert.equal(bareName('struct Command'), 'Command');
  assert.equal(bareName('var appName'), 'appName');
  assert.equal(bareName('package cobra'), 'cobra');
});

test('Rust: fn, struct, enum, trait, impl, type, mod, const e macro', () => {
  const s = symbolsForRust(linhas(`
pub type ClientTx = Sender<Msg>;
pub struct SignalingState {
pub(crate) enum Estado {
pub trait Transporte {
impl Default for SignalingState {
    fn default() -> Self {
impl SignalingState {
    pub async fn registrar(&mut self, id: u32) {
    pub(crate) unsafe fn baixo_nivel() {
mod interno {
pub const LIMITE: usize = 32;
static mut CONTADOR: u64 = 0;
macro_rules! tenta {
`));
  assert.equal(linhaDe(s, 'type ClientTx'), 1);
  assert.equal(linhaDe(s, 'struct SignalingState'), 2);
  assert.equal(linhaDe(s, 'enum Estado'), 3);
  assert.equal(linhaDe(s, 'trait Transporte'), 4);
  assert.equal(linhaDe(s, 'impl Default for SignalingState'), 5);
  assert.equal(linhaDe(s, 'fn default'), 6);
  assert.equal(linhaDe(s, 'impl SignalingState'), 7);
  assert.equal(linhaDe(s, 'fn registrar'), 8);
  assert.equal(linhaDe(s, 'fn baixo_nivel'), 9);
  assert.equal(linhaDe(s, 'mod interno'), 10);
  assert.equal(linhaDe(s, 'const LIMITE'), 11);
  assert.equal(linhaDe(s, 'static CONTADOR'), 12);
  assert.equal(linhaDe(s, 'macro tenta'), 13);
  // método dentro de impl é membro, não definição de topo
  assert.equal(s.find((x) => x.name === 'fn registrar').depth, 1);
  assert.equal(s.find((x) => x.name === 'struct SignalingState').depth, 0);
});

test('Rust: trait Fn maiúsculo NÃO vira símbolo, e "-> impl" continua sendo fn', () => {
  // NÃO medido em código real: o repo Rust que serviu de corpus (um app desktop privado, 29 arquivos)
  // não tem nenhuma ocorrência de `Fn`/`FnMut` nem de `-> impl`. As duas defesas são
  // raciocinadas — a distinção `fn`/`Fn` é só a caixa (por isso nada de flag `i` no parser)
  // e a ordem fn-antes-de-impl é o que impede o retorno `impl Trait` de virar um bloco impl.
  const nomes = symbolsForRust(linhas(`
pub fn processa<F>(f: F) where F: Fn(i32) -> bool {
pub fn iter_ativos(&self) -> impl Iterator<Item = &Endpoint> {
where T: FnMut() -> u32,
`)).map((x) => x.name);
  assert.ok(!nomes.some((n) => /Fn/.test(n)), `trait Fn não pode virar símbolo, veio: ${nomes.join(' | ')}`);
  assert.deepEqual(nomes, ['fn processa', 'fn iter_ativos'], 'ambas as linhas são fn, nenhuma é impl');
});

test('Rust: atributo e comentário não viram símbolo', () => {
  const nomes = symbolsForRust(linhas(`
#[derive(Debug, Clone)]
#![allow(dead_code)]
// fn comentada() {}
pub struct Real;
`)).map((x) => x.name);
  assert.deepEqual(nomes, ['struct Real']);
});

test('Rust: bareName procura pelo TIPO, não pelo trait', () => {
  // `impl Display for Endpoint` precisa ser encontrado buscando por Endpoint — é assim que
  // se procura "onde Endpoint está definido".
  assert.equal(bareName('impl Display for Endpoint'), 'Endpoint');
  assert.equal(bareName('impl SignalingState'), 'SignalingState');
  assert.equal(bareName('fn hp_register_host'), 'hp_register_host');
  assert.equal(bareName('struct Session'), 'Session');
  assert.equal(bareName('macro tenta'), 'tenta');
});

test('Pascal: case-insensitive — PROCEDURE maiúsculo é reconhecido', () => {
  // Comum em código Delphi legado.
  const s = symbolsForPascal(linhas(`
PROCEDURE RotinaAntiga;
Function OutraForma: Integer;
procedure minuscula;
`));
  assert.equal(linhaDe(s, 'procedure RotinaAntiga'), 1);
  assert.equal(linhaDe(s, 'function OutraForma'), 2);
  assert.equal(linhaDe(s, 'procedure minuscula'), 3);
});

test('Pascal: separa DECLARAÇÃO (interface) de DEFINIÇÃO (implementation)', () => {
  const s = symbolsForPascal(linhas(`
unit uTeste;
interface
type
  TPedido = class(TObject)
    procedure Confirmar;
  end;
implementation
procedure TPedido.Confirmar;
begin
end;
`));
  assert.equal(linhaDe(s, 'unit uTeste'), 1);
  assert.equal(linhaDe(s, 'class TPedido'), 4);
  // declaração: indentada, sem qualificador
  assert.equal(linhaDe(s, 'procedure Confirmar'), 5);
  // definição: qualificada pela classe
  assert.equal(linhaDe(s, 'procedure TPedido.Confirmar'), 8);
});

test('Pascal: record, interface, property e destructor', () => {
  const s = symbolsForPascal(linhas(`
type
  TEndereco = record
  IRepo = interface
  TFoo = class
    destructor Destroy; override;
    property Total: Currency read FTotal;
`));
  assert.equal(linhaDe(s, 'record TEndereco'), 2);
  assert.equal(linhaDe(s, 'interface IRepo'), 3);
  assert.equal(linhaDe(s, 'destructor Destroy'), 5);
  assert.equal(linhaDe(s, 'property Total'), 6);
});

test('Pascal: comentário de linha é ignorado', () => {
  const s = symbolsForPascal(linhas(`
// procedure Comentada;
procedure DeVerdade;
`));
  const nomes = s.map((x) => x.name);
  assert.deepEqual(nomes, ['procedure DeVerdade']);
});

// Os quatro testes abaixo vieram de medicao em corpus real (HeidiSQL + Double Commander,
// 1.164 arquivos): o parser so pulava `//` e inventava 168 simbolos a partir de comentario.
test('Pascal: comentário de bloco { } atravessa linhas e não vira símbolo', () => {
  const s = symbolsForPascal(linhas(`
{ Este bloco documenta a unit.
  function Add(Text: String): Integer;
  procedure Delete(Index: Integer); }
procedure DeVerdade;
`));
  assert.deepEqual(s.map((x) => x.name), ['procedure DeVerdade']);
});

test('Pascal: comentário de bloco (* *) também atravessa linhas', () => {
  const s = symbolsForPascal(linhas(`
(* function Fantasma: Integer;
   property Some: String; *)
function Real: Integer;
`));
  assert.deepEqual(s.map((x) => x.name), ['function Real']);
});

// {$IFDEF} guarda codigo que COMPILA. Trata-lo como comentario apagaria simbolo real —
// o erro pior dos dois, porque some em silencio em vez de aparecer como lixo.
test('Pascal: {$IFDEF} é diretiva, não comentário — o código dentro segue indexado', () => {
  const s = symbolsForPascal(linhas(`
{$IFDEF MSWINDOWS}
procedure SoNoWindows;
{$ENDIF}
procedure Sempre;
`));
  assert.deepEqual(s.map((x) => x.name), ['procedure SoNoWindows', 'procedure Sempre']);
});

// Caso real do corpus (Img32.SVG.Core.pas): sem tratar string, esta `{` abriria comentario
// e engoliria o resto do arquivo ate a proxima `}`.
test('Pascal: chave dentro de string não abre comentário', () => {
  const s = symbolsForPascal(linhas(`
procedure Antes;
begin
  if (c^ <> '{') then Break;
end;
procedure Depois;
`));
  assert.deepEqual(s.map((x) => x.name), ['procedure Antes', 'procedure Depois']);
});

// Diretiva inline do FPC: some da linha e revela a property que ela escondia.
test('Pascal: {%H-} inline não impede o símbolo de ser achado', () => {
  const s = symbolsForPascal(linhas(`
    property {%H-}Commands: TFormCommands read FCommands;
`));
  assert.deepEqual(s.map((x) => x.name), ['property Commands']);
});

test('DFM: hierarquia de componentes com profundidade por indentação', () => {
  const s = symbolsForDfm(linhas(`
object FrmA: TFrmA
  object PnlB: TPanel
    object BtnC: TButton
    end
  end
end
`));
  assert.equal(linhaDe(s, 'FrmA: TFrmA'), 1);
  assert.equal(linhaDe(s, 'PnlB: TPanel'), 2);
  assert.equal(linhaDe(s, 'BtnC: TButton'), 3);
  assert.equal(s.find((x) => x.name === 'FrmA: TFrmA').depth, 0);
  assert.ok(s.find((x) => x.name === 'BtnC: TButton').depth > 0, 'aninhado precisa ter depth maior');
});

test('Markdown: headings viram seções, mas não dentro de bloco de código', () => {
  // Regressão real: `# comentário` dentro de ``` era listado como seção.
  const s = symbolsForMarkdown(linhas(`
# Titulo
\`\`\`bash
# isto e comentario shell, nao secao
\`\`\`
## Real
`));
  const nomes = s.map((x) => x.name);
  assert.deepEqual(nomes, ['Titulo', 'Real']);
});

test('Markdown: arquivo com CRLF ainda encontra headings', () => {
  // Regressão real: em JS `.` não casa `\r`, então CRLF devolvia "nenhum símbolo".
  const s = symbolsForMarkdown('# Um\r\n## Dois\r\n'.split('\n'));
  assert.deepEqual(s.map((x) => x.name), ['Um', 'Dois']);
});

// ---- Python. A armadilha é a docstring: em Python o exemplo de código dentro de `"""` é
// o estilo dominante de documentação, então ignorá-la enche o índice de definição fantasma.
// Medido em flask+requests+django (3.047 arquivos): 92 fantasmas evitados, 0 perdidos.
test('Python: def e class, com método indentado em depth 1', () => {
  const s = symbolsForPython(linhas(`
class Api:
    def get(self):
        pass
    async def post(self):
        pass
def solto():
    pass
`));
  assert.deepEqual(s.map((x) => x.name), ['class Api', 'def get', 'def post', 'def solto']);
  assert.deepEqual(s.map((x) => x.depth), [0, 1, 1, 0]);
});

test('Python: def dentro de docstring NÃO vira símbolo', () => {
  // Caso real do flask (ctx.py): o docstring documenta uma rota com `def index():`.
  const s = symbolsForPython(linhas(`
def real():
    """Exemplo de uso:

    @app.route("/")
    def index():
        return "oi"
    """
    pass
`));
  assert.deepEqual(s.map((x) => x.name), ['def real']);
});

test('Python: docstring com prefixo f/r fecha corretamente', () => {
  // Se `f"""` não abrisse docstring, o parser não veria o fechamento e engoliria o resto.
  const s = symbolsForPython(linhas(`
x = f"""
def fantasma():
"""
def depois():
    pass
`));
  assert.deepEqual(s.map((x) => x.name), ['def depois']);
});

// ---- Go
test('Go: func, método com receptor e receptor genérico', () => {
  const s = symbolsForGo(linhas(`
func Solta() {}
func (s *Server) Start() {}
func (b Bucket[BC]) String() string {}
`));
  assert.deepEqual(s.map((x) => x.name), ['func Solta', 'func Server.Start', 'func Bucket.String']);
});

test('Go: bloco agrupado não confunde literal aninhado com declaração', () => {
  // Caso real (prometheus/main.go): sem contar aninhamento, `Name:` e `Help:` do literal
  // viravam `var Name`/`var Help` — 613 símbolos falsos no corpus medido.
  const s = symbolsForGo(linhas(`
var (
	appName = "prometheus"

	configSuccess = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "algo",
		Help: "outra coisa",
	})
)
`));
  assert.deepEqual(s.map((x) => x.name), ['var appName', 'var configSuccess']);
});

test('Go: várias declarações numa linha entram todas no índice', () => {
  const s = symbolsForGo(linhas(`
var (
	ctxWeb, cancelWeb = context.WithCancel(ctx)
)
`));
  assert.deepEqual(s.map((x) => x.name), ['var ctxWeb', 'var cancelWeb']);
});

test('Go: raw string com crase não vira símbolo', () => {
  const s = symbolsForGo(linhas(`
var tpl = ` + '`' + `
func fantasma() {}
` + '`' + `
func real() {}
`));
  assert.deepEqual(s.map((x) => x.name), ['var tpl', 'func real']);
});

test('Go: bloco /* */ esconde código de exemplo', () => {
  // Caso real (gin_integration_test.go): "/* legacy tests" com 5 funcs dentro.
  const s = symbolsForGo(linhas(`
/* legacy
func TestAntigo(t *testing.T) {}
*/
func TestNovo(t *testing.T) {}
`));
  assert.deepEqual(s.map((x) => x.name), ['func TestNovo']);
});

test('parserForExt: despacha certo e devolve null no desconhecido', () => {
  assert.equal(parserForExt('.ts'), symbolsForCode);
  assert.equal(parserForExt('.TSX'), symbolsForCode, 'extensão maiúscula precisa funcionar');
  assert.equal(parserForExt('.pas'), symbolsForPascal);
  assert.equal(parserForExt('.dpr'), symbolsForPascal);
  assert.equal(parserForExt('.dfm'), symbolsForDfm);
  assert.equal(parserForExt('.rs'), symbolsForRust);
  assert.equal(parserForExt('.RS'), symbolsForRust, 'extensão maiúscula precisa funcionar');
  assert.equal(parserForExt('.py'), symbolsForPython);
  assert.equal(parserForExt('.pyi'), symbolsForPython);
  assert.equal(parserForExt('.go'), symbolsForGo);
  assert.equal(parserForExt('.md'), symbolsForMarkdown);
  // Ver a nota em hooks-e2e: ao adicionar linguagem, troque por outra ainda não suportada.
  assert.equal(parserForExt('.rb'), null, 'não suportado precisa devolver null, não um parser errado');
  assert.equal(parserForExt(''), null);
});

test('todo parser devolve linha 1-based e crescente', () => {
  // Invariante transversal: o número é usado como offset de Read. Zero-based mandaria
  // sempre uma linha antes, em silêncio.
  const casos = [
    [symbolsForCode, linhas('function a() {}\nfunction b() {}')],
    [symbolsForPascal, linhas('procedure A;\nprocedure B;')],
    [symbolsForMarkdown, linhas('# A\n# B')],
  ];
  for (const [parser, src] of casos) {
    const s = parser(src);
    assert.ok(s.length >= 2, 'esperava ao menos 2 símbolos');
    assert.equal(s[0].line, 1, 'primeira linha precisa ser 1, não 0');
    assert.ok(s[1].line > s[0].line, 'linhas precisam ser crescentes');
  }
});

// ---- Chaves de configuração. A regra é estreita de propósito: literal de objeto aberto no
// TOPO do arquivo, só filhos DIRETOS. A regra larga daria 75.454 chaves no workspace de referência contra
// 1.329 desta — e afogaria a busca, que é o motivo de `.dfm` estar fora do índice.
test('config: filhos diretos de objeto de topo viram chave', () => {
  const s = symbolsForCode(linhas(`
export const config = {
  sessionTimeoutMinutes: 30,
  enableFallback: true,
};
`));
  assert.deepEqual(s.map((x) => x.name), ['const config', 'key sessionTimeoutMinutes', 'key enableFallback']);
  assert.deepEqual(s.map((x) => x.depth), [0, 1, 1]);
});

test('config: filho ANINHADO não vira chave', () => {
  // Sem contar aninhamento, `host` e `port` entrariam junto e o índice encheria de ruído.
  const s = symbolsForCode(linhas(`
const config = {
  banco: {
    host: 'x',
    port: 5432,
  },
  depois: 1,
};
`));
  assert.deepEqual(s.map((x) => x.name), ['const config', 'key banco', 'key depois']);
});

test('config: template literal dentro do objeto não gera chave fantasma', () => {
  // Mesma armadilha do Pascal com outra roupa: texto que parece código.
  const s = symbolsForCode(linhas(`
const config = {
  template: ` + '`' + `
    naoSouChave: valor
  ` + '`' + `,
  real: 1,
};
`));
  assert.deepEqual(s.map((x) => x.name), ['const config', 'key template', 'key real']);
});

test('config: objeto inline NÃO abre modo de chave', () => {
  const s = symbolsForCode(linhas(`
const inline = { a: 1, b: 2 };
const depois = 2;
`));
  assert.deepEqual(s.map((x) => x.name), ['const inline', 'const depois']);
});

test('config: module.exports e export default também abrem', () => {
  const a = symbolsForCode(linhas(`
module.exports = {
  apiKey: 'x',
};
`));
  assert.deepEqual(a.map((x) => x.name), ['key apiKey']);
  const b = symbolsForCode(linhas(`
export default {
  outra: 'y',
};
`));
  assert.deepEqual(b.map((x) => x.name), ['key outra']);
});

test('config: método abreviado dentro do objeto continua sendo capturado', () => {
  // Regressão: o modo de chave não pode "engolir" a linha e impedir as regras existentes.
  const s = symbolsForCode(linhas(`
class Alguma {}
const handlers = {
  aoTocar() {
    return 1;
  },
};
`));
  assert.ok(s.some((x) => x.name === 'aoTocar()'), `método abreviado sumiu: ${JSON.stringify(s.map(x=>x.name))}`);
});

test('config: bareName torna a chave pesquisável pelo nome nu', () => {
  assert.equal(bareName('key sessionTimeoutMinutes'), 'sessionTimeoutMinutes');
});

test('outline: filtro com modificador inline (?i) de Python/PCRE não quebra o RegExp de JS', () => {
  // Achado real: alguém (ou um LLM treinado noutro dialeto de regex) passou `(?i)pedido` como
  // filtro — sintaxe válida em Python/PCRE, inválida em JS — e o outline recusava o filtro
  // inteiro com "inválido", mesmo com o resto do padrão perfeitamente correto.
  assert.equal(stripInlineRegexFlags('(?i)pedido'), 'pedido');
  assert.equal(stripInlineRegexFlags('(?i)pedido|item|total'), 'pedido|item|total');
  assert.equal(stripInlineRegexFlags('(?-i)Foo'), 'Foo');
  // Sem o prefixo, o filtro passa intacto — a função não pode alterar um padrão já válido.
  assert.equal(stripInlineRegexFlags('pedido'), 'pedido');
  assert.equal(stripInlineRegexFlags('^get[A-Z]'), '^get[A-Z]');
});

// ---------------------------------------------------------------------------------------------
// C#, Java e PHP. Cada caso abaixo é uma armadilha que apareceu no corpus de verificação
// (Newtonsoft.Json, serilog, Dapper, gson, commons-lang, jsoup, monolog, guzzle, Slim).

test('C#: tipos, membros qualificados pela classe e fim pela chave que fecha', () => {
  const src = linhas(`
namespace Loja.Pedidos
{
    [Serializable]
    public sealed partial class Pedido : Base, IPedido
    {
        public const int Limite = 10;
        public event EventHandler? Mudou;
        public string Nome { get; set; }
        public decimal Total => Itens.Sum(i => i.Valor);
        public Pedido(int id)
        {
            var x = Calcular(id);
        }
        public async Task<IList<Item>> CarregarAsync<T>(int id,
            CancellationToken ct) where T : class
        {
            return await Repo.Buscar(id, ct);
        }
        object? IPedido.Validar(Type t) => null;
        public static explicit operator int(Pedido p) => p.Id;
        public override global::System.String ToString() => "";
    }
    public delegate void Avisar(string m);
    public record Item(string Nome, decimal Valor);
}
`);
  const syms = symbolsForCSharp(src);
  const nomes = syms.map((s) => s.name);
  assert.deepEqual(nomes, [
    'class Pedido', 'const Limite', 'event Mudou', 'property Nome', 'property Total',
    'Pedido.Pedido()', 'Pedido.CarregarAsync()', 'Pedido.Validar()', 'Pedido.ToString()',
    'delegate Avisar', 'record Item',
  ], 'operador fica de fora; chamada dentro de corpo (Calcular, Buscar) nunca vira símbolo');
  const classe = syms.find((s) => s.name === 'class Pedido');
  assert.equal(classe.end, linhaDe(syms, 'delegate Avisar') - 1, 'o fim da classe é a chave que a fecha');
  assert.equal(bareName('Pedido.CarregarAsync()'), 'CarregarAsync');
  assert.equal(bareName('event Mudou'), 'Mudou');
  assert.equal(bareName('delegate Avisar'), 'Avisar');
});

test('C#: verbatim que começa com aspa escapada (@""") e caractere "{" não desalinham as chaves', () => {
  // Caso real: `@""","` era lido como raw string e o resto do arquivo virava texto — todos os
  // métodos seguintes sumiam do índice.
  const src = linhas(`
class T
{
    void A()
    {
        var s = @"[
  ""x"": """ + nome + @""",
]";
        var c = '{';
        var r = """
           { não é chave }
           """;
    }
    void B() { }
}
`);
  assert.deepEqual(symbolsForCSharp(src).map((s) => s.name), ['class T', 'T.A()', 'T.B()']);
});

test('C#: assinatura quebrada em linhas não vira membro fantasma', () => {
  const src = linhas(`
class T
{
    public void Longo(string primeiro,
        string segundo,
        int terceiro)
    {
    }
}
`);
  assert.deepEqual(symbolsForCSharp(src).map((s) => s.name), ['class T', 'T.Longo()']);
});

test('Java: anotação de tipo no meio da assinatura, construtor e constante static final', () => {
  const src = linhas(`
@Deprecated
public final class Parser<T> extends Base {
    public static final int MAX = 64;
    private int contador = 0;
    public Parser() { this(1); }
    private @Nullable static String validar(@Nullable String cs) { return cs; }
    public Connection.@Nullable KeyVal data(String key) { return null; }
    public <R> List<R> mapear(Function<T, R> f) {
        Iterator<R> it = new Iterator<>() {
            public boolean hasNext() { return false; }
        };
        return null;
    }
}
enum Estado {
    ABERTO { void fechar() {} },
    FECHADO;
    abstract void fechar();
}
@interface Marca {
    String valor() default "";
}
`);
  assert.deepEqual(symbolsForJava(src).map((s) => s.name), [
    'class Parser', 'const MAX', 'Parser.Parser()', 'Parser.validar()', 'Parser.data()', 'Parser.mapear()',
    'enum Estado', 'Estado.fechar()', 'annotation Marca', 'Marca.valor()',
  ], 'campo de instância, classe anônima e corpo de constante do enum ficam de fora');
});

test('Java: text block não abre chave', () => {
  const src = linhas(`
class T {
    String s = """
        { "a": 1
        """;
    void depois() {}
}
`);
  assert.deepEqual(symbolsForJava(src).map((s) => s.name), ['class T', 'T.depois()']);
});

test('PHP: métodos, constantes, helper em function_exists, heredoc e HTML fora da tag', () => {
  const src = linhas(`
<html>{ isto é HTML }</html>
<?php
namespace App\Http;

#[Attribute]
final class Rota implements RotaInterface
{
    public const GET = 'GET';
    private string $nome;
    public function __construct(private string $p) {}
    public static function &criar(string $n): self
    {
        $html = <<<HTML
            <div>{ não é chave }</div>
        HTML;
        $f = function ($x) { return $x; };
        return new class { public function anonimo() {} };
    }
}
if (!function_exists('ajuda')) {
    function ajuda($x) { return $x; }
}
?>
<p>{ fim }</p>
`);
  assert.deepEqual(symbolsForPhp(src).map((s) => s.name), [
    'class Rota', 'const GET', 'Rota.__construct()', 'Rota.criar()', 'function ajuda',
  ]);
});

test('parserForExt reconhece .cs, .java e .php', () => {
  assert.equal(parserForExt('.cs'), symbolsForCSharp);
  assert.equal(parserForExt('.JAVA'), symbolsForJava);
  assert.equal(parserForExt('.php'), symbolsForPhp);
});
