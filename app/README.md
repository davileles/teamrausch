# Estúdio — check-in Wellhub + agendamento

Serviço Node.js que recebe os check-ins do Wellhub por webhook, mostra a fila
numa tela de recepção e libera a catraca por PIN ou QR. A confirmação é o que
gera o repasse do Wellhub, então nada é dado como validado sem resposta positiva
da API deles.

## Como funciona

```
Aluno faz check-in no app
        │
        ▼
Webhook do Wellhub ──► POST /wellhub/webhook/checkin   (assinatura conferida)
        │
        ├─► Recepção: painel em /  ──────┐
        └─► Catraca: POST /acesso  ──────┤
                                         ▼
                        POST /access/v1/validate no Wellhub
                                         │
                                  liberado / negado
```

Um check-in tem prazo de validade. Fora dele o Wellhub recusa, e o painel mostra
isso em vez de deixar a recepção liberar por conta própria.

## Antes de subir

Peça à Techsales do Wellhub (integrations@gympass.com, ou pelo seu gerente de
conta) três coisas:

1. **API Key** da Access Control API
2. **Secret** de assinatura do webhook
3. Cadastro da sua **URL de webhook** — será `https://SEU-APP.up.railway.app/wellhub/webhook/checkin`

Diga que é integração de parceiro único e informe seu Gym ID (Portal do Parceiro
→ ID das unidades). Esse pedido demora mais que o código: mande hoje.

Enquanto não chega, rode com `SIMULAR=true` — tudo funciona, só não conversa com
o Wellhub de verdade.

## Deploy

Este serviço vive na pasta `app/` do repositório `teamrausch`. As instruções de
deploy dos dois serviços estão no README da raiz.

Comece com `WELLHUB_API_BASE` apontando para o sandbox
(`https://apitesting.partners.gympass.com/access/v1`). Só troque para produção
depois que um check-in real passar de ponta a ponta.

## Telas

| Endereço | Para quem |
|---|---|
| `/` | Alunos: entram pelo telefone e reservam horário |
| `/recepcao.html` | Recepção: fila de check-ins do Wellhub, botão de liberar |
| `/totem.html` | Totem na entrada: teclado numérico e leitor de QR |

O totem manda o código para `POST /acesso`. Se sua catraca fala HTTP, aponte ela
para esse mesmo endpoint em vez de usar a tela — a resposta é
`{ "abrir": true|false, "mensagem": "..." }`.

---

# Agendamento de horários

Módulo separado do Wellhub, no mesmo serviço. O aluno entra com o telefone,
recebe um código, e reserva vaga nos horários que você cadastrou.

## Como o aluno entra

Telefone com DDD → código de 6 dígitos → sessão de 7 dias (configurável). Não há
senha. O código vence em 10 minutos, aceita 5 tentativas e o mesmo telefone pode
pedir 5 códigos por hora.

**O primeiro administrador vem da variável `ADMIN_INICIAL`.** Sem ele ninguém
consegue abrir a aba Configurações. Depois de entrar uma vez, gerencie a lista
pela própria tela — e note que o sistema não deixa você remover o seu próprio
telefone da lista.

## Como o código é enviado

Por padrão vai para o serviço `whatsapp/` deste mesmo repositório, pela rede
privada do Railway. O formato é um POST em JSON, editável na aba Configurações,
então trocar por um provedor de SMS depois é só mudar endereço, token e corpo.

Deixe o canal em **Só no log** enquanto testa: o código aparece nos logs do
Railway em vez de ser enviado.

## O que dá para configurar

Tudo pela aba Configurações, nada no código:

- **Estúdio**: nome, fuso horário, recado que aparece na tela dos alunos
- **Regras**: dias abertos além de hoje, capacidade padrão, minutos de
  antecedência para fechar o horário, quantos horários cada aluno pega por dia,
  se pode cancelar e até quando, datas fechadas
- **Horários da semana**: por dia da semana, com capacidade própria por horário
  quando ela difere da padrão
- **Entrada**: duração da sessão, canal do código, validade, limite de pedidos,
  e se qualquer telefone entra ou só os já cadastrados
- **Administradores**: telefones que veem as abas de gestão

Alunos comuns veem só **Agendar** e **Meus horários**. As abas **Lista do dia**,
**Alunos** e **Configurações** só aparecem para administradores, e as rotas
correspondentes recusam quem não é — o esconde-esconde é só na tela, a trava é
no servidor.

## Endpoints do agendamento

| Método | Rota | O que faz |
|---|---|---|
| POST | `/agenda-api/auth/codigo` | Pede o código |
| POST | `/agenda-api/auth/entrar` | Troca o código por uma sessão |
| GET | `/agenda-api/auth/eu` | Quem está logado |
| GET | `/agenda-api/agenda` | Dias, horários e vagas |
| POST | `/agenda-api/agenda/reservar` | Reserva uma vaga |
| POST | `/agenda-api/agenda/cancelar` | Cancela |
| GET | `/agenda-api/admin/dia?data=` | Lista de presença |
| GET/PUT | `/agenda-api/admin/config` | Configurações |
| GET | `/agenda-api/admin/alunos` | Alunos cadastrados |

## Um limite que vale conhecer

A checagem de vagas e a gravação da reserva acontecem no mesmo passo síncrono,
então duas pessoas não pegam a mesma última vaga. **Isso vale enquanto o serviço
rodar em uma réplica.** Se um dia você escalar para duas no Railway, a garantia
cai e será preciso trocar o arquivo JSON por Postgres com transação.

---

## Endpoints

| Método | Rota | O que faz |
|---|---|---|
| POST | `/wellhub/webhook/checkin` | Recebe o check-in do Wellhub |
| POST | `/acesso` | Catraca/totem: valida por PIN, QR ou Wellhub ID |
| GET | `/api/checkins?situacao=aguardando` | Fila do painel |
| POST | `/api/checkins/:id/validar` | Libera um check-in da fila |
| POST | `/api/validar-por-id` | Libera digitando o Wellhub ID |
| GET | `/api/alunos` | Alunos já vistos, com PIN vinculado |
| PUT | `/api/alunos/:id/codigo` | Vincula PIN/QR aqui e no Wellhub |
| GET | `/saude` | Diagnóstico rápido da configuração |

As rotas `/api/*` pedem o cabeçalho `X-Panel-Token`. A rota `/acesso` pede
`X-Device-Token` se você configurar um.

## Testar sem credenciais

```bash
npm install
SIMULAR=true npm start
curl -X POST localhost:3000/dev/checkin-falso \
  -H 'Content-Type: application/json' \
  -d '{"gympassId":"12345678","nome":"Marina","sobrenome":"Prado"}'
```

Abra `localhost:3000` e o check-in estará na fila.

## Decisões que vale conhecer

- **Falha de rede não vira recusa.** Se o Wellhub não responde, o check-in
  continua na fila para nova tentativa. Recusa só quando eles recusam.
- **Reenvio não duplica.** O Wellhub reenvia webhooks em caso de timeout; o
  mesmo check-in é reconhecido e ignorado.
- **O webhook responde antes de validar.** Evita estourar o timeout deles.
- **`VALIDAR_AUTOMATICO=true`** libera sozinho ao receber o check-in, sem passar
  pela recepção. Útil se a catraca é o único ponto de entrada; ruim se alguém
  pode fazer check-in de casa e nunca aparecer.

## O que ainda precisa de conferência

`src/payload-map.js` traduz o payload do webhook para o formato interno. Os
nomes de campo seguem o que está publicado (`gympass_id`, `gym_id`) e o arquivo
lê variações comuns por segurança, mas o schema completo do webhook está em uma
página que só renderiza por JavaScript. Quando você tiver acesso às docs,
confira o exemplo de payload e ajuste **só esse arquivo**.

O formato da assinatura `X-Gympass-Signature` também não está publicado em texto:
o código aceita hex, base64 e o prefixo `sha256=`, e qualquer um deles fecha com
o segredo correto.
