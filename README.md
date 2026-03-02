#  Bot WhatsApp para Gerenciamento de Containers Docker

##  Objetivo

Permitir, via WhatsApp, executar operações seguras e controladas em containers Docker.

A solução é determinística (sem IA) e responde apenas a comandos pré-definidos.

---

##  Arquitetura

WhatsApp → Evolution API → Webhook → Node.js API → Docker Engine (TCP 2375)

A aplicação se comunica com o Docker via Docker SDK (dockerode).

---

##  Tecnologias

- Node.js
- Express
- Dockerode
- Docker Desktop
- Evolution API
- Docker Compose

---

##  Funcionalidades

###  Listar containers

Comando:

```bash
docker containers
```

Retorna:
- Nome
- Status
- ID curto

---

###  Visualizar logs

Comando:

```bash
docker logs <container> <linhas>
```

Retorna últimas N linhas (limitado por `MAX_LOG_LINES`).

---

###  Gerenciar containers

```bash
docker start <container>
docker stop <container>
docker restart <container>
```

---

##  Segurança Implementada

- Apenas comandos pré-definidos (`help`, `containers`, `logs`, `start`, `stop`, `restart`)
- Validação de parâmetros (regex + lista permitida)
- Limite máximo de logs (`MAX_LOG_LINES`)
- Whitelist de usuários (`ALLOWED_NUMBERS`)
- Lista de containers permitidos (`ALLOWED_CONTAINERS`)
- Rate limit por usuário
- Auditoria em arquivo (`audit.log`)
- Prefixo obrigatório (`docker`)
- Anti-loop (ignora mensagens enviadas pelo próprio bot)
- Deduplicação de eventos (evita reprocessamento após restart)
- Não executa comandos arbitrários ou shell

---

##  Como Configurar

###  Instalar dependências

```bash
npm install
```

---

###  Habilitar Docker TCP 2375 (Windows)

No Docker Desktop:

Settings → General  
Ativar:

```
Expose daemon on tcp://localhost:2375 without TLS
```

Apply & Restart.

Testar:

```powershell
curl http://localhost:2375/version
```

---

###  Subir Evolution via Docker Compose

Crie o arquivo `docker-compose.yml`:

```yaml
version: "3.8"

services:
  evolution:
    image: atendai/evolution-api:latest
    container_name: evolution_api
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - SERVER_TYPE=http
      - SERVER_PORT=8080
      - AUTHENTICATION_API_KEY=MINHA_APIKEY_FORTE_123
      - LOG_LEVEL=ERROR
    volumes:
      - evolution_data:/evolution

volumes:
  evolution_data:
```

Subir:

```bash
docker compose up -d
```

---

###  Criar instância na Evolution

```powershell
$APIKEY="MINHA_APIKEY_FORTE_123"

curl -Method POST "http://localhost:8080/instance/create" `
  -Headers @{ apikey = $APIKEY; "Content-Type"="application/json" } `
  -Body '{
    "instanceName":"botdocker",
    "integration":"WHATSAPP-BAILEYS",
    "qrcode": true
  }'
```

Caso retorne:

```
"This name 'botdocker' is already in use."
```

Execute:

```powershell
curl -Method GET "http://localhost:8080/instance/connect/botdocker" `
  -Headers @{ apikey = $APIKEY }
```

---

###  Configurar Webhook

```powershell
curl -Method POST "http://localhost:8080/webhook/set/botdocker" `
  -Headers @{ apikey = $APIKEY; "Content-Type"="application/json" } `
  -Body '{
    "webhook": {
      "enabled": true,
      "url": "http://host.docker.internal:3000/webhook",
      "events": ["MESSAGES_UPSERT"]
    }
  }'
```

---

###  Criar arquivo `.env`

Baseado em `.env.example`:

```env
PORT=3000

COMMAND_PREFIX=docker

ALLOWED_NUMBERS=556599596410
ALLOWED_CONTAINERS=teste-nginx

MAX_LOG_LINES=50
RATE_LIMIT_MAX=10
RATE_LIMIT_WINDOW_SEC=60
AUDIT_LOG_FILE=audit.log

EVOLUTION_URL=http://localhost:8080
EVOLUTION_INSTANCE=botdocker
EVOLUTION_APIKEY=MINHA_APIKEY_FORTE_123
```

---

###  Iniciar o Bot

```bash
node server.js
```

Saída esperada:

```
Servidor rodando na porta 3000
Prefixo obrigatório: "docker"
Evolution: http://localhost:8080 | instance: botdocker
```

---

##  Uso

O bot responde apenas mensagens que começam com:

```bash
docker
```

Exemplo:

```bash
docker containers
```

Mensagens sem prefixo são ignoradas.

---

##  Estrutura do Projeto

```text
docker-whatsapp-bot/
│
├── server.js
├── docker-compose.yml
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

---

##  Publicação no GitHub

Crie `.gitignore`:

```gitignore
node_modules/
.env
audit.log
```

Nunca subir o `.env` real.