// Aviso diário de ASOs vencidos e em atenção — roda no GitHub Actions
const { Firestore } = require('@google-cloud/firestore');
const nodemailer = require('nodemailer');

const MESES_PADRAO = 12;
const DIAS_ATENCAO = 30;

const firestore = new Firestore({
  projectId: process.env.FIREBASE_PROJECT_ID,
  credentials: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
});

// ===== Detecção de campos (mesma lógica do site) =====
function normalizar(texto) {
  return String(texto).toLowerCase()
    .replace(/[áàâãä]/g, 'a').replace(/[éèêë]/g, 'e')
    .replace(/[íìîï]/g, 'i').replace(/[óòôõö]/g, 'o')
    .replace(/[úùûü]/g, 'u').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]/g, '');
}
function chaveCampo(registro, palavras) {
  const chaves = Object.keys(registro);
  for (const chave of chaves) {
    const cn = normalizar(chave);
    if (cn === '__id') continue;
    for (const palavra of palavras) {
      if (cn.includes(normalizar(palavra))) return chave;
    }
  }
  return null;
}
function lerCampo(registro, palavras) {
  const chave = chaveCampo(registro, palavras);
  return chave ? registro[chave] : null;
}
function paraData(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor;
  if (typeof valor.toDate === 'function') return valor.toDate();
  if (typeof valor === 'string' && valor !== '') {
    const d = new Date(valor);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}
const lerNome = reg => { const v = lerCampo(reg, ['nome', 'funcionario', 'colaborador', 'empregado', 'servidor']); return v ? String(v) : ''; };
const lerSetor = reg => { const v = lerCampo(reg, ['setor', 'departamento', 'area']); return v ? String(v) : ''; };
const lerCodigo = reg => { const v = lerCampo(reg, ['codigo', 'matricula', 'matr', 'chapa', 'registro', 'cracha', 'cod']); return v ? String(v) : ''; };
const lerTipo = reg => { const v = lerCampo(reg, ['tipo', 'tipaso', 'tipodeaso', 'tipoaso']); return v ? String(v) : ''; };
const lerDataExame = reg => paraData(lerCampo(reg, ['ultimoexame', 'ultimaexame', 'dataexame', 'dataaso', 'exame', 'aso', 'data']));
const lerVenceEm = reg => paraData(lerCampo(reg, ['venceem', 'vencimento', 'proximoexame', 'validade', 'vence', 'venc', 'datavencimento']));

// ===== Lógica de status (mesma do site) =====
function mesesDoSetor(nomeSetor, setores) {
  for (const s of setores) {
    const nome = lerCampo(s, ['nome', 'setor']);
    if (nome === nomeSetor && s.validadeMeses) return Number(s.validadeMeses);
  }
  return null;
}
function mesesValidade(aso, funcionario, setores) {
  if (aso && aso.validadeMeses) return Number(aso.validadeMeses);
  if (funcionario) {
    const m = mesesDoSetor(lerSetor(funcionario), setores);
    if (m) return m;
  }
  return MESES_PADRAO;
}
function acharAsoDoFuncionario(funcionario, historico) {
  const codigo = normalizar(lerCodigo(funcionario));
  const nome = normalizar(lerNome(funcionario));
  const fid = funcionario.__id;
  const achados = [];
  for (const aso of historico) {
    if (fid && (aso.funcionarioId === fid || aso.funcionario_id === fid)) { achados.push(aso); continue; }
    const codAso = normalizar(lerCodigo(aso));
    const nomeAso = normalizar(aso.funcionarioNome || lerNome(aso));
    if (codigo && codAso && codigo === codAso) { achados.push(aso); continue; }
    if (nome && nomeAso && nome === nomeAso) { achados.push(aso); continue; }
  }
  if (!achados.length) return null;
  achados.sort((a, b) => {
    const da = lerDataExame(a), db = lerDataExame(b);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return db.getTime() - da.getTime();
  });
  return achados[0];
}
function statusDoFuncionario(funcionario, historico, setores) {
  const aso = acharAsoDoFuncionario(funcionario, historico);
  if (!aso) return { status: 'Sem periódico' };
  const tipo = normalizar(lerTipo(aso));
  if (tipo.includes('demiss')) return { status: 'Sem periódico' };
  const dataExame = lerDataExame(aso);
  if (!dataExame) return { status: 'Sem periódico' };
  let vence = lerVenceEm(aso);
  if (!vence) {
    vence = new Date(dataExame);
    vence.setMonth(vence.getMonth() + mesesValidade(aso, funcionario, setores));
  }
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const diff = Math.ceil((vence.getTime() - hoje.getTime()) / 86400000);
  if (diff < 0) return { status: 'Atrasado', vence, diff, dataExame };
  if (diff <= DIAS_ATENCAO) return { status: 'Atenção', vence, diff, dataExame };
  return { status: 'Em dia', vence, diff, dataExame };
}

// ===== E-mail =====
function formatarData(d) { return d ? d.toLocaleDateString('pt-BR') : ''; }

function montarHtml(pendentes) {
  const linhas = pendentes.map(p => {
    const classe = p.status === 'Atrasado' ? 'color:#dc2626;' : 'color:#d97706;';
    const dias = p.diff < 0 ? ('Vencido há ' + Math.abs(p.diff) + 'd') : (p.diff === 0 ? 'Vence hoje' : p.diff + ' dias');
    return '<tr>' +
      '<td>' + p.codigo + '</td>' +
      '<td>' + p.nome + '</td>' +
      '<td>' + p.setor + '</td>' +
      '<td style="' + classe + 'font-weight:bold;">' + p.status.toUpperCase() + '</td>' +
      '<td>' + formatarData(p.dataExame) + '</td>' +
      '<td>' + formatarData(p.vence) + '</td>' +
      '<td>' + dias + '</td>' +
      '</tr>';
  }).join('');
  return '<h2 style="color:#0057a8;">Aviso de ASO — NSF</h2>' +
    '<p>Funcionários com ASO <b>vencido</b> ou <b>em atenção</b> (vencendo em até ' + DIAS_ATENCAO + ' dias):</p>' +
    '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">' +
    '<thead><tr style="background:#f1f5f9;">' +
    '<th>Código</th><th>Nome</th><th>Setor</th><th>Status</th><th>Último exame</th><th>Vence em</th><th>Dias</th>' +
    '</tr></thead><tbody>' + linhas + '</tbody></table>' +
    '<p style="color:#64748b;font-size:12px;">Gerado automaticamente pelo sistema de RH.</p>';
}

async function main() {
  console.log('Buscando dados no Firestore...');
  const [ativosSnap, historicoSnap, setoresSnap] = await Promise.all([
    firestore.collection('ativos').get(),
    firestore.collection('historico').get(),
    firestore.collection('setores').get()
  ]);
  const ativos = ativosSnap.docs.map(d => { const x = d.data(); x.__id = d.id; return x; });
  const historico = historicoSnap.docs.map(d => { const x = d.data(); x.__id = d.id; return x; });
  const setores = setoresSnap.docs.map(d => { const x = d.data(); x.__id = d.id; return x; });

  const pendentes = [];
  for (const f of ativos) {
    const r = statusDoFuncionario(f, historico, setores);
    if (r.status === 'Atrasado' || r.status === 'Atenção') {
      pendentes.push({ nome: lerNome(f), setor: lerSetor(f), codigo: lerCodigo(f), ...r });
    }
  }

  const vencidos = pendentes.filter(p => p.status === 'Atrasado').length;
  const atencao = pendentes.filter(p => p.status === 'Atenção').length;
  console.log('Ativos: ' + ativos.length + ' | Vencidos: ' + vencidos + ' | Atenção: ' + atencao);

  if (pendentes.length === 0) {
    console.log('Nenhuma pendência. E-mail não enviado.');
    return;
  }

  const destinatarios = (process.env.EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!destinatarios.length) throw new Error('EMAIL_TO não configurado.');

  const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: destinatarios.join(', '),
    subject: '[ASO] ' + vencidos + ' vencido(s) e ' + atencao + ' em atenção',
    html: montarHtml(pendentes)
  });
  console.log('E-mail enviado para: ' + destinatarios.join(', '));
}

main().catch(function(erro) {
  console.error('Falha:', erro);
  process.exit(1);
});
