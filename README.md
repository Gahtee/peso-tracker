# Peso Tracker

Painel web privado para acompanhamento de peso corporal, ingestão calórica e
evolução visual (foto/vídeo/gif por dia). Estima a **TMB (taxa metabólica
basal)** por regressão ponderada do peso × tempo, com **margem de erro (IC
95%)** que converge conforme você adiciona dias. Dias atípicos (muita água,
inchaço, jantar pesado…) entram no cálculo com peso menor em vez de serem
descartados.

Zero dependências — apenas **Node.js ≥ 22** (usa `node:sqlite` embutido).

## Funcionalidades

- Registro diário: data, peso, calorias, nota + flags de dia atípico
- Estimativa de TMB/gasto com faixa de confiança, tendência kg/sem, R²
- Mídia por dia (jpg/png/webp/gif/mp4/webm, até 15 MB): thumbnails, lightbox,
  comparador Antes/Depois com delta de peso
- Gráfico de evolução (canvas próprio, sem CDN)
- Auth com senha (scrypt), lockout progressivo anti-bruteforce, rate-limit
  por IP, CSRF, sessões HttpOnly; **só admin cria perfis**
- Auditoria em tabela `audit` (logins, bloqueios, criação de usuários…)

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
