\#  Bot WhatsApp – Gerenciamento Seguro de Containers Docker (Evolution)



Solução determinística (sem IA) para gerenciar containers Docker via WhatsApp, usando Evolution API como gateway.



\##  Funcionalidades (Escopo do Desafio)

1\) \*\*Listar containers\*\*

\- Comando: `docker containers`

\- Retorna: Nome, Status, ID curto



2\) \*\*Visualizar logs\*\*

\- Comando: `docker logs <container> <linhas>`

\- Retorna últimas N linhas (limitado por `MAX\\\_LOG\\\_LINES`)



3\) \*\*Gerenciar containers\*\*

\- `docker start <container>`

\- `docker stop <container>`

\- `docker restart <container>`



---



\##  Segurança (Obrigatório)

Medidas aplicadas:

\-  Apenas comandos pré-definidos (`help/containers/logs/start/stop/restart`)

\-  Validação de parâmetros:

  - nome do container (regex + lista permitida)

  - limite máximo de logs (`MAX\\\_LOG\\\_LINES`)

\-  Não executa comandos arbitrários (sem shell/terminal)

\-  Whitelist de usuários (`ALLOWED\\\_NUMBERS`)

\-  Lista de containers permitidos (`ALLOWED\\\_CONTAINERS`)

\-  Rate limit por usuário (evita flood)

\-  Auditoria em arquivo (`audit.log`)

\-  Anti-loop / deduplicação (evita reprocessar eventos e loops após restart)



---



\##  Arquitetura

WhatsApp -> Evolution API (webhook `MESSAGES\\\_UPSERT`) -> Bot (Node/Express) -> Docker Engine (Dockerode via TCP 2375) -> Evolution API (sendText) -> WhatsApp



---



\##  Requisitos

\- Windows 10/11

\- Node.js 18+ (recomendado)

\- Docker Desktop instalado

\- Evolution API rodando via Docker Compose



---



\## 1) Docker Desktop – habilitar TCP 2375

No Docker Desktop:

\- Settings -> General

\- Ativar: \*\*Expose daemon on tcp://localhost:2375 without TLS\*\*

\- Apply \& Restart



Teste:

```powershell

curl http://localhost:2375/version




