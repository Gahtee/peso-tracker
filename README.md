# Peso Tracker

Painel web privado para acompanhamento de peso corporal, ingestão calórica e
evolução visual (foto/vídeo/gif por dia). Estima a **TMB (taxa metabólica
basal)** por regressão ponderada do peso × tempo, com **margem de erro (IC
95%)** que converge conforme você adiciona dias. Dias atípicos (muita água,
inchaço, jantar pesado…) entram no cálculo com peso menor em vez de serem
descartados.

Zero dependências — apenas **Node.js ≥ 22** (usa `node:sqlite` embutido).

## Funcionalidades

- Registro diário (convenção peso-manhã × calorias-véspera): **data = manhã
  da pesagem** (ao acordar, após a 1ª urina: peso + foto); **calorias e
  exercício = total do dia anterior**. De manhã você pesa e fecha as calorias
  de ontem — não dá para prever o que ainda vai comer hoje. Inclui fonte do
  exercício (estimativa/relógio/não sei), nota + flags de dia atípico (inclui ciclo)
- Estimativa de TMB/gasto por regressão ponderada sobre **calorias líquidas**
  (ingeridas − exercício), com faixa de confiança IC95%, tendência kg/sem, R²
- Janela de cálculo (tudo / 28d / 14d), média móvel 7d no gráfico, detecção de
  outliers com sugestão de marcar como atípico
- **Aba Meta**: peso-alvo + dia-alvo → projeção de chegada no ritmo atual e
  **kcal/dia necessárias** (com alerta se fora da faixa segura); fator de
  atividade configurável (1.2–1.725)
- **Aba Estimativa**: peso esperado dia a dia (reta ajustada) vs real, com
  diferença e fase do ciclo; projeção dos próximos 30 dias com faixa
- **Ciclo menstrual (opcional)**: ative e informe o 1º dia da última
  menstruação + duração; depois só clique em **"Começou hoje"** quando descer
  (histórico de inícios, o último vale). Fases estimadas
  (menstrual/folicular/ovulatória/lútea). Na lútea a TMB considerada sobe ~7%;
  em menstruação/TPM a retenção (+0.5 a +2 kg de água) pondera metade no
  cálculo, não gera alerta de outlier nem marca a meta como "fora do ritmo".
  Estimativas populacionais — não é previsão médica nem contraceptivo
- Margem de erro decomposta: balança (IC95%) + incerteza do exercício (~25%
  do treino estimado/chutado; medida de aparelho não infla)
- Mídia por dia (jpg/png/webp/gif/mp4/webm, até 15 MB, streaming com seek):
  thumbnails, lightbox, comparador Antes/Depois com delta de peso
- Gráfico de evolução (canvas próprio, sem CDN), export CSV
- Auth com senha (scrypt), lockout progressivo anti-bruteforce, rate-limit
  por IP, CSRF, sessões HttpOnly; **só admin cria perfis**
- Auditoria em tabela `audit` com rotação (últimos 5000 eventos)

## Como rodar

```bash
# 1. requer Node 22+
node --version

# 2. primeira vez: cria o usuário admin (senha gerada na tela, ou via env)
node server.js --init-admin
# ou: ADMIN_USER=admin ADMIN_PASSWORD='troque-por-uma-senha-forte' node server.js --init-admin

# 3. inicia
PORT=3000 BIND=127.0.0.1 node server.js
# abra http://127.0.0.1:3000
```

Modo serviço (background, estilo pm2 — sobrevive ao fim da sessão do terminal):

```bash
node server.js --daemon [porta]  # escolhe porta livre se omitida; gera senha admin se o banco estiver vazio
node server.js --status          # pid + endereço
node server.js --stop            # parar
# log: data/service.log
```

## Exposição via Cloudflare Tunnel

O app serve **HTTP puro** (sem TLS próprio). No painel do túnel, configure o
Public Hostname com **Service Type `HTTP`** apontando para o endereço local,
ex.: `http://127.0.0.1:3000`. Detalhes e endurecimento (WAF, Access, SSL Full
strict) em [`tunnel.md`](tunnel.md).

## Backup

```bash
cp data/tracker.db ./backup-$(date +%F).db
cp -r data/uploads ./backup-uploads-$(date +%F)
```

## Publicando no GitHub (sem vazar segredos)

O `.gitignore` já bloqueia `data/` (banco, uploads, pid/ports, logs), `.env`,
chaves e credenciais do tunnel. Antes de publicar, confira:

```bash
# 1. revise o que será commitado — NÃO pode aparecer data/, .env, *.pem, tunnel *.json
git status --short
git check-ignore -v data/tracker.db data/uploads .env 2>/dev/null || true

# 2. garanta que nenhum segredo está nos arquivos rastreados
# procure por chaves privadas ou tokens JWT que nunca deveriam estar no código
grep -rn "PRIVATE KEY" --exclude-dir=node_modules --exclude-dir=.git . || echo "limpo"

# 3. primeiro publish
git init -b main                                   # se ainda não for repo
git add server.js public package.json .gitignore README.md tunnel.md
git commit -m "Peso Tracker: painel privado de peso + TMB"
gh repo create peso-tracker --private --source=. --push   # requer gh autenticado
# sem gh: crie o repo no github.com e rode:
#   git remote add origin git@github.com:SEUUSER/peso-tracker.git
#   git push -u origin main
```

> Recomenda-se repo **privado**: embora não contenha segredos, o código expõe
> a superfície da API. Nunca commite `data/` — ele contém hashes de senha,
> sessões e fotos pessoais.
