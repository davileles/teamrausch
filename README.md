# teamrausch

Dois serviços independentes para o estúdio, no mesmo repositório.

```
teamrausch/
├── app/          Check-in Wellhub + agendamento de horários
└── whatsapp/     Envio de mensagens por WhatsApp (Baileys)
```

Eles conversam por HTTP dentro da rede privada do Railway. Nenhum dos dois toca
nas integrações do CDV ou do TSP: sessão própria, número próprio, volume próprio,
token próprio. Se o número deste estúdio for bloqueado, nada mais é afetado.

## Por que dois serviços e não um

O Baileys mantém uma conexão viva com o WhatsApp e reconecta sozinho. Se ele
morasse junto do app, todo deploy do agendamento derrubaria a conexão e às vezes
pediria QR de novo. Separado, você mexe no agendamento à vontade e o WhatsApp
segue conectado.

---

## Deploy no Railway

Um projeto, dois serviços, mesmo repositório. O Railway distingue os dois pelo
**Root Directory**.

### 1. Suba o repositório

Crie o repositório `teamrausch` no GitHub e mande estes arquivos.

### 2. Serviço `whatsapp`

1. **New Project → Deploy from GitHub repo** → escolha `teamrausch`
2. **Settings → Root Directory**: `whatsapp`
3. **Settings → Volumes**: monte um volume em `/data`
4. **Variables**: copie de `whatsapp/.env.example`. Gere um `WHATSAPP_TOKEN`
   longo e aleatório — anote, o outro serviço vai precisar do mesmo valor.
5. **Settings → Networking**: gere o domínio público **só para ler o QR**.
   Depois de conectado, você pode removê-lo; a rede privada continua funcionando.
6. Abra `https://SEU-WHATSAPP.up.railway.app/qr` e leia o código no celular
   (WhatsApp → Aparelhos conectados → Conectar aparelho).
7. Confira em `/status` que aparece `"situacao": "conectado"`.

### 3. Serviço `app`

1. No **mesmo projeto**: **New → GitHub Repo** → `teamrausch` de novo
2. **Settings → Root Directory**: `app`
3. **Settings → Volumes**: monte outro volume em `/data`
4. **Variables**: copie de `app/.env.example`. O `WHATSAPP_TOKEN` precisa ser
   idêntico ao do outro serviço. `ADMIN_INICIAL` já vem com `31991444886`.
5. **Settings → Networking**: gere o domínio público. Este é o endereço que
   você compartilha com os alunos.

### 4. Ligue o WhatsApp no agendamento

Entre no app pelo telefone de administrador, vá em **Configurações → Entrada dos
alunos** e mude o canal de **Só no log** para **WhatsApp**. Salve e peça um
código para o seu próprio número para conferir.

Enquanto estiver testando, deixe em **Só no log** — o código aparece nos logs do
Railway em vez de ser enviado.

---

## Sobre o número do WhatsApp

**Use um chip dedicado ao estúdio, não o número pessoal de ninguém.** O Baileys
não é oficial: o WhatsApp pode bloquear o número, e quem faz esse tipo de envio
automatizado corre esse risco. Com número separado, um bloqueio custa um chip
novo e um QR novo — não a conta pessoal do seu amigo.

O serviço manda uma mensagem por vez com pausa entre elas, justamente porque
rajada é o que mais derruba número.

Se em algum momento o volume crescer ou o risco incomodar, a troca para a API
oficial do WhatsApp ou para SMS é só mudar três campos na aba Configurações — o
formato de envio é o mesmo POST em JSON.

---

## Rotas do serviço `whatsapp`

| Método | Rota | O que faz |
|---|---|---|
| GET | `/status` | Situação da conexão e tamanho da fila |
| GET | `/qr` | Página com o QR para conectar |
| POST | `/enviar` | `{ "telefone": "...", "mensagem": "..." }` |

`/qr` e `/enviar` pedem o `WHATSAPP_TOKEN` em `Authorization: Bearer ...`.

## Documentação de cada serviço

- `app/README.md` — check-in Wellhub, agendamento, telas e configurações
- `whatsapp/.env.example` — variáveis do serviço de WhatsApp
